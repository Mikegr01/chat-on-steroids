import { expect, it, vi, beforeEach } from 'vitest';
import { timelinePage } from './fixtures/video-observation.js';
import { workRequest } from './fixtures/video-workflow.js';
import { createGuardedResolveReader, approvedVideoArtifactAccess, createAdmittedAssetIngestor, readAdmittedWorkflowCapabilities,createGuardedResolveDispatch } from '../src/main/video-editing/runtime-inspection.js';

const state = vi.hoisted(() => ({ parent: { caller: { sessionId: 'session-1' } } as { caller: { sessionId: string } } | null,
  catalogId: 'davinci-resolve', revision: 1, published: true, read: true, dispatch: vi.fn(), resolve: vi.fn() }));
vi.mock('../src/main/mcp/call-context.js', () => ({ currentCall: () => state.parent }));
vi.mock('../src/main/mcp/tools-plugins.js', () => ({ dispatchRegisteredPluginTool: (...args: unknown[]) => state.dispatch(...args) }));
vi.mock('../src/main/plugins/manager.js', () => ({ pluginManager: { snapshot: () => ({ schemaRevision: state.revision,
  plugins: [{ id: 'plugin-1', catalogId: state.catalogId, enabled: true, status: 'ready',
    tools: ['resolve_inspect','resolve_assemble_rough_cut'].map(name=>({name,enabled:true,published:state.published})) }] }) } }));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({ roots: [] }), effectiveCapabilities: () => ({ read: state.read }) }));
vi.mock('../src/main/sandbox.js', () => ({ resolvePath: (...args: unknown[]) => state.resolve(...args) }));
beforeEach(() => { state.parent = { caller: { sessionId: 'session-1' } }; state.catalogId = 'davinci-resolve';
  state.revision = 1; state.published = true; state.read = true; state.dispatch.mockReset(); state.resolve.mockReset(); });

it('requires admitted exact session and curated published tool ownership', async () => {
  state.parent = null; expect(() => createGuardedResolveReader()).toThrow(/session/i);
  state.parent = { caller: { sessionId: 'session-1' } };
  const reader = createGuardedResolveReader(); state.catalogId = 'unreviewed';
  await expect(reader.timeline('owned-timeline-1', { id: 'observed', observedAt: 10 })).rejects.toThrow(/curated/i);
  expect(state.dispatch).not.toHaveBeenCalled();
});
it('uses the registered dispatcher for read-only acquisition and rejects replaced owners after awaits', async () => {
  state.dispatch.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(timelinePage()) }] });
  const reader = createGuardedResolveReader();
  expect((await reader.timeline('owned-timeline-1', { id: 'observed', observedAt: 10 })).status).toBe('VERIFIED');
  expect(state.dispatch.mock.calls[0]![0]).toBe('resolve_inspect');
  state.dispatch.mockImplementation(async () => { state.revision++; return { content: [] }; });
  await expect(reader.timeline('owned-timeline-1', { id: 'next', observedAt: 11 })).rejects.toThrow(/owner changed/i);
});
it('rechecks read capability and root/path identity after asynchronous resolution', async () => {
  const access = approvedVideoArtifactAccess();
  state.resolve.mockImplementation(async () => { state.read = false; return { real: 'D:/source.mov' }; });
  await expect(access('D:/source.mov')).rejects.toThrow(/revoked/i);
  state.read = true; state.resolve.mockResolvedValueOnce({ real: 'D:/source.mov' }).mockResolvedValueOnce({ real: 'D:/changed.mov' });
  await expect(access('D:/source.mov')).rejects.toThrow(/path changed/i);
});
it('wires workflow ingestion/capability discovery only through exact admitted current exposure', () => {
  state.parent = null;
  expect(() => createAdmittedAssetIngestor()).toThrow(/session/i);
  expect(() => readAdmittedWorkflowCapabilities()).toThrow(/session/i);
  state.parent = { caller: { sessionId: 'session-1' } };
  expect(readAdmittedWorkflowCapabilities()).toEqual({ tools: ['resolve_inspect','resolve_assemble_rough_cut'], sourceEnd: 'unknown', acceptance: 'unverified' });
  state.published = false; expect(readAdmittedWorkflowCapabilities().tools).toEqual([]);
  state.catalogId = 'other'; expect(() => readAdmittedWorkflowCapabilities()).toThrow(/curated/i);
  expect(state.dispatch).not.toHaveBeenCalled();
});
it('refuses ingestion for another local session before acquiring any files or Resolve observations', async () => {
  const ingestor = createAdmittedAssetIngestor(), request = workRequest(); request.sessionId = 'other-session';
  await expect(ingestor.ingest(request)).rejects.toThrow(/work.*session/i);
  expect(state.resolve).not.toHaveBeenCalled(); expect(state.dispatch).not.toHaveBeenCalled();
});

it('routes guarded production assembly through the existing curated dispatcher, retaining exact arguments and epoch enforcement',async()=>{
 state.dispatch.mockResolvedValue({content:[{type:'text',text:'{"requested":true,"executed":true,"verified":true,"error":null}'}]});
 const dispatch=createGuardedResolveDispatch(),op={operationId:'11111111-1111-4111-8111-111111111111',name:'resolve_assemble_rough_cut' as const,
  arguments:{timeline_unique_id:'owned',segments:[{media_unique_id:'pool',start_frame:0,end_frame:23,record_frame:0,track_index:1,media_type:'video' as const}]}};
 await dispatch(op,{projectId:'project',snapshotSha256:'a'.repeat(64)});
 expect(state.dispatch.mock.calls[0]).toEqual(['resolve_assemble_rough_cut',{...op.arguments,guard_version:2,expected_project_unique_id:'project',expected_snapshot_sha256:'a'.repeat(64)}]);
 state.dispatch.mockImplementation(async()=>{state.revision++;return {content:[]};});
 await expect(dispatch(op,{projectId:'project',snapshotSha256:'a'.repeat(64)})).rejects.toThrow(/owner changed/);
});
