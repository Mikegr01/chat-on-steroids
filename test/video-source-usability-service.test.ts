import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { sourceUsabilityFixture } from './fixtures/video-source-usability.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const state = vi.hoisted(() => ({ parent: { caller: { sessionId: 'session-1', conversationId: 'chat-A' } } as any,
  session: { id: 'session-1', conversationId: 'chat-A', chatIds: ['chat-A'] } as any, readOnly: false, read: true,
  confirm: vi.fn(async (_options: unknown) => ({ response: 0 })) }));
vi.mock('electron', () => ({ dialog: { showMessageBox: state.confirm } }));
vi.mock('../src/main/mcp/call-context.js', () => ({ currentCall: () => state.parent, currentAgent: () => undefined }));
vi.mock('../src/main/session/store.js', () => ({ getSession: async () => state.session }));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({ readOnly: state.readOnly }), effectiveCapabilities: () => ({ read: state.read }) }));
vi.mock('../src/main/video-editing/runtime-inspection.js', () => ({
  createGuardedResolveReader: () => { throw Error('No Resolve access allowed'); },
  createGuardedResolveDispatch: () => { throw Error('No Resolve mutation allowed'); },
  approvedVideoArtifactAccess: () => { throw Error('No source/media changes allowed'); },
}));
let dir: string;
beforeEach(async () => {
  vi.resetModules(); dir = await makeTempDir('cos-usability-service-'); initDurableStore(dir);
  (await import('../src/main/durable.js')).initDurableStore(dir);
  state.parent = { caller: { sessionId: 'session-1', conversationId: 'chat-A' } };
  state.session = { id: 'session-1', conversationId: 'chat-A', chatIds: ['chat-A'] };
  state.readOnly = false; state.read = true; vi.clearAllMocks();
});
afterEach(async () => { (await import('../src/main/durable.js')).resetDurableForTests(); resetDurableForTests(); await removeTempDir(dir); });

async function fixture() {
  const f = await sourceUsabilityFixture(dir); await f.coordinator.plan(f.request.id);
  const service = await import('../src/main/video-editing/service.js');
  const context: any = await service.videoAction({ action: 'source-usability', jobId: f.request.id }, async () => true);
  const input = { action: 'set-usable-ranges', jobId: f.request.id, binding: context.sources[0].binding,
    expectedRevision: context.revision, ranges: [{ start: 0, end: 24 }] };
  return { ...f, ...service, context, input };
}

it('uses Core discovery and existing native confirmation without IPC expansion or adapter access', async () => {
  const f = await fixture(); let handler!: (raw: any) => Promise<any>, schema: any;
  const { registerVideoEditingTool } = await import('../src/main/mcp/video-editing-tool.js');
  registerVideoEditingTool({ exposedCaps: { read: true }, ctx: { readOnly: false }, register(name: string, declaration: any, fn: any) {
    expect(name).toBe('video_editing'); schema = declaration.inputSchema; handler = fn;
  }, guarded: (_cap: string, _tool: string, work: () => unknown) => work() } as any);
  expect(schema.safeParse(f.input).success).toBe(true);
  // Service's fixed native confirmation route is shared by direct Core and composed calls.
  const confirm = vi.fn(async (detail: string) => { expect(detail).toContain(f.input.binding.evidenceHash); expect(detail).toContain('[{"start":0,"end":24}]'); return true; });
  const accepted: any = await f.videoAction(f.input, confirm);
  expect(confirm).toHaveBeenCalledOnce(); expect(accepted.workflow.sourceUsability[0].provenance).toBe('native-operator');
  expect(accepted.workflow.requestHash).toBe(f.context.requestHash); expect(accepted.checkpoints).toEqual([]);
  expect(handler).toBeTypeOf('function');
  const result = await handler({ ...f.input, binding: f.context.sources[1].binding, expectedRevision: accepted.workflow.revision });
  expect(result.isError).not.toBe(true); expect(state.confirm).toHaveBeenCalledOnce();
  const green = JSON.parse(result.content[0].text);
  expect(green.workflow.comparison.every((row: any) => row.score === 1 && row.blockers.length === 0)).toBe(true);
  expect(state.confirm.mock.calls[0]![0]).toMatchObject({ title: 'S7.5 operator control', defaultId: 1, cancelId: 1 });
  const restarted = await f.videoStore(); await restarted.restore(); expect(restarted.get(f.request.id)).toEqual(green);
});

it('cancellation retains exact job and stale conflicting input is refused before confirmation', async () => {
  const f = await fixture(), before = (await f.videoStore()).get(f.request.id)!;
  expect(await f.videoAction(f.input, async () => false)).toEqual({ cancelled: true });
  expect((await f.videoStore()).get(f.request.id)).toEqual(before);
  await f.videoAction(f.input, async () => true);
  const confirm = vi.fn(async () => true);
  await expect(f.videoAction({ ...f.input, ranges: [{ start: 0, end: 12 }] }, confirm)).rejects.toThrow(/revision/);
  expect(confirm).not.toHaveBeenCalled();
  expect(await f.videoAction(f.input, confirm)).toEqual((await f.videoStore()).get(f.request.id));
});

it.each(['session', 'conversation', 'project', 'unattributed', 'job'] as const)('rejects wrong %s owner without confirmation', async field => {
  const f = await fixture(), confirm = vi.fn(async () => true);
  if (field === 'session') { state.session.id = 'foreign'; state.parent.caller.sessionId = 'foreign'; }
  if (field === 'conversation') state.parent.caller.conversationId = 'foreign';
  if (field === 'project') state.session.projectId = 'foreign';
  if (field === 'unattributed') state.parent = null;
  if (field === 'job') f.input.jobId = 'foreign';
  await expect(f.videoAction(f.input, confirm)).rejects.toThrow(); expect(confirm).not.toHaveBeenCalled();
});

it.each(['session', 'conversation', 'project', 'readOnly', 'read', 'revision'] as const)('rejects %s change during native confirmation', async field => {
  const f = await fixture(), before = (await f.videoStore()).get(f.request.id)!;
  await expect(f.videoAction(f.input, async () => {
    if (field === 'session') state.parent = { caller: { sessionId: 'other', conversationId: 'chat-A' } };
    if (field === 'conversation') state.session.conversationId = 'other';
    if (field === 'project') state.session.projectId = 'other';
    if (field === 'readOnly') state.readOnly = true;
    if (field === 'read') state.read = false;
    if (field === 'revision') await (await f.videoStore()).setSourceUsability(before.id, {
      expectedRevision: f.input.expectedRevision, ranges: f.input.ranges, binding: f.context.sources[1].binding });
    return true;
  })).rejects.toThrow();
  if (field !== 'revision') expect((await f.videoStore()).get(f.request.id)).toEqual(before);
  else expect((await f.videoStore()).get(f.request.id)!.workflow!.sourceUsability!.map(row => row.binding.assetId)).toEqual(['source-b']);
});
