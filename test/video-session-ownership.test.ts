import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import { workRequest } from './fixtures/video-workflow.js';
import { operatorFixture } from './fixtures/video-operator-execution.js';
import { VideoEditingStore } from '../src/main/video-editing/store.js';

const state = vi.hoisted(() => ({ parent: null as any, session: null as any }));
vi.mock('../src/main/mcp/call-context.js', () => ({ currentCall: () => state.parent }));
vi.mock('../src/main/session/store.js', () => ({ getSession: async () => state.session }));
vi.mock('../src/main/app-identity.js', () => ({ resolveCustomUserData: () => dir }));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({ readOnly: false, mediaRuntime: null }), effectiveCapabilities: () => ({ read: true }) }));
vi.mock('../src/main/video-editing/runtime-inspection.js', () => ({
  readAdmittedWorkflowEpoch: () => 'curated:1',
  readAdmittedWorkflowCapabilities: () => ({ tools: ['resolve_inspect', 'resolve_assemble_rough_cut'], sourceEnd: 'inclusive', acceptance: 'unverified' }),
  approvedVideoArtifactAccess: () => async (p: string) => p,
  createGuardedResolveReader: () => { throw new Error('Resolve must not be contacted'); },
}));
let dir: string;
beforeEach(async () => {
  vi.resetModules(); dir = await makeTempDir('cos-video-owner-'); initDurableStore(dir);
  (await import('../src/main/durable.js')).initDurableStore(dir);
  state.parent = { caller: { sessionId: 'session-1', conversationId: 'chat-A' } };
  state.session = { id: 'session-1', projectId: null, conversationId: 'chat-A', chatIds: ['chat-A'] };
});
afterEach(async () => { (await import('../src/main/durable.js')).resetDurableForTests(); resetDurableForTests(); await removeTempDir(dir); });

const sessionScopes = ['absent', 'undefined', 'null', 'project'] as const;
function trustedSession(scope: typeof sessionScopes[number]) {
  const session: any = { id: 'session-1', conversationId: 'chat-A', chatIds: ['chat-A'] };
  if (scope !== 'absent') session.projectId = scope === 'project' ? 'project-1' : scope === 'null' ? null : undefined;
  expect('projectId' in session).toBe(scope !== 'absent');
  return session;
}
it.each(sessionScopes.flatMap(scope => ['omitted', 'null', 'exact', 'wrong', 'empty'].map(request => [scope, request] as const)))('validates trusted %s scope against request %s', async (scope, claimed) => {
  state.session = trustedSession(scope);
  const { videoAction, videoStore } = await import('../src/main/video-editing/service.js');
  const request: any = workRequest(dir);
  if (claimed === 'omitted') delete request.localProjectId;
  else request.localProjectId = claimed === 'null' ? null : claimed === 'exact' ? 'project-1' : claimed === 'empty' ? '' : 'foreign';
  const accepted = scope === 'project' ? claimed === 'exact' : claimed === 'omitted' || claimed === 'null';
  if (accepted) {
    const job: any = await videoAction({ action: 'create', request }, async () => true);
    expect(job.localProjectId).toBe(scope === 'project' ? 'project-1' : null);
    expect(job.workflow.request.localProjectId).toBe(job.localProjectId);
  } else {
    await expect(videoAction({ action: 'create', request }, async () => true)).rejects.toThrow();
    expect((await videoStore()).get(request.id)).toBeUndefined();
  }
});
it.each(sessionScopes)('accesses persisted exact job after service restart with trusted %s scope', async scope => {
  state.session = trustedSession(scope);
  const project = scope === 'project' ? 'project-1' : null;
  const f = await operatorFixture(dir, { localProjectId: project });
  const persisted = f.store.get(f.job.id)!;
  vi.resetModules();
  (await import('../src/main/durable.js')).initDurableStore(dir);
  const restarted = await import('../src/main/video-editing/service.js');
  expect(await restarted.videoAction({ action: 'inspect', jobId: f.job.id }, async () => true)).toEqual(persisted);
  state.session.id = 'another-session'; state.parent.caller.sessionId = 'another-session';
  await expect(restarted.videoAction({ action: 'inspect', jobId: f.job.id }, async () => true)).rejects.toThrow(/mismatch/);
});
it.each(sessionScopes)('creates and restores an exact session owner with trusted project scope %s', async scope => {
  const { videoAction } = await import('../src/main/video-editing/service.js');
  const request: any = workRequest(dir);
  state.session = trustedSession(scope);
  const project = scope === 'project' ? 'project-1' : null;
  request.localProjectId = project;
  const job: any = await videoAction({ action: 'create', request }, async () => true);
  expect(job).toMatchObject({ sessionId: state.session.id, localProjectId: project ?? null });
  const restored = new VideoEditingStore(); await restored.restore();
  expect(restored.get(job.id)).toEqual(job);
  expect(await videoAction({ action: 'inspect', jobId: job.id }, async () => true)).toEqual(job);
  state.parent.caller.conversationId = 'chat-B';
  state.session.conversationId = 'chat-B'; state.session.chatIds.push('chat-B');
  expect(await videoAction({ action: 'inspect', jobId: job.id }, async () => true)).toEqual(job);
  state.parent.caller.conversationId = 'chat-A';
  await expect(videoAction({ action: 'inspect', jobId: job.id }, async () => true)).rejects.toThrow(/mismatch/);
});
it.each([
  ['wrong project', 'project-1', 'foreign', 'session-1', 'chat-A'],
  ['omitted project', 'project-1', undefined, 'session-1', 'chat-A'],
  ['injected project', null, 'foreign', 'session-1', 'chat-A'],
  ['wrong session', null, null, 'foreign', 'chat-A'],
  ['wrong conversation', null, null, 'session-1', 'foreign'],
  ['malformed project', null, '', 'session-1', 'chat-A'],
])('rejects create with %s before persistence', async (_label, project, claimedProject, claimedSession, conversation) => {
  const { videoAction, videoStore } = await import('../src/main/video-editing/service.js');
  const request: any = workRequest(dir); state.session.projectId = project;
  request.localProjectId = claimedProject; request.sessionId = claimedSession;
  state.parent.caller.conversationId = conversation;
  await expect(videoAction({ action: 'create', request }, async () => true)).rejects.toThrow();
  expect((await videoStore()).get(request.id)).toBeUndefined();
});
it.each(['inspect', 'sample', 'ingest', 'submit', 'select', 'prepare', 'preview', 'preflight', 'collect-output', 'live-manifest', 'execute', 'reconcile', 'technical-acceptance'].flatMap(action => [null, 'project-1'].map(project => [action, project] as const)))('fences %s with scope %s against foreign session, conversation and changed project after restore', async (action, project) => {
  const f = await operatorFixture(dir, {localProjectId:project});
  state.session = { id: f.job.sessionId, projectId: f.job.localProjectId, conversationId: 'chat-A', chatIds: ['chat-A'] };
  if (project === null) { delete state.session.projectId; expect('projectId' in state.session).toBe(false); }
  state.parent.caller.sessionId = f.job.sessionId;
  const { videoAction } = await import('../src/main/video-editing/service.js');
  const raw = { action, jobId: f.job.id, designs: [{}, {}], provider: { id: 'operator', version: '1', configuration: {} },
    candidateId: f.job.candidates[0]!.id, timelineId: f.prepared.request.timelineId, authorizationId: f.authority.id,
    manifestHash: 'a'.repeat(64), operationId: f.prepared.request.operationId, evidenceId: 'sample-evidence', renderId: 'render-1' };
  const { videoActionSchema } = await import('../src/main/video-editing/service.js');
  const shape: any = videoActionSchema.options.find((schema: any) => schema.shape.action.value === action);
  const input = Object.fromEntries(Object.entries(raw).filter(([key]) => key in shape.shape));
  for (const field of ['session', 'conversation', 'project', 'scope']) {
    const saved = structuredClone({ session: state.session, parent: state.parent });
    if (field === 'session') { state.session.id = 'foreign'; state.parent.caller.sessionId = 'foreign'; }
    if (field === 'conversation') state.parent.caller.conversationId = 'foreign';
    if (field === 'project') state.session.projectId = 'foreign';
    if (field === 'scope') state.session.projectId = project === null ? 'project-1' : null;
    await expect(videoAction(input, async () => true)).rejects.toThrow(/mismatch/);
    state.session = saved.session; state.parent = saved.parent;
  }
});
it.each([null, 'foreign'])('keeps async owner binding canonical while rejecting scope change to %s', async nextScope => {
  const f = await operatorFixture(dir, { localProjectId: null });
  state.session = trustedSession('absent');
  const { videoAction, videoStore } = await import('../src/main/video-editing/service.js');
  const before = (await videoStore()).get(f.job.id)!;
  const selected = videoAction({ action: 'select', jobId: f.job.id, candidateId: f.job.candidates[0]!.id }, async () => {
    state.session.projectId = nextScope; return true;
  });
  if (nextScope === null) expect(await selected).toEqual(before);
  else await expect(selected).rejects.toThrow(/owner\/epoch/);
  expect((await videoStore()).get(f.job.id)).toEqual(before);
});
