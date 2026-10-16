import { beforeEach, afterEach, expect, it } from 'vitest';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { evaluateWorkflowAuthorization } from '../src/main/video-editing/workflow-guards.js';
import { preparedFixture, workflowCapabilities } from './fixtures/video-workflow-runtime.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;
beforeEach(async () => { dir = await makeTempDir('cos-workflow-guards-'); initDurableStore(dir); });
afterEach(async () => { resetDurableForTests(); await removeTempDir(dir); });
async function setup() {
  const fixture = await preparedFixture(dir), job = fixture.document;
  return { ...fixture, context: { jobId: job.id, sessionId: job.sessionId, localProjectId: job.localProjectId,
    resolveProjectId: job.resolveProjectId, timeline: job.evidence.find(row => row.id === 'before')!,
    media: job.media, capabilities: workflowCapabilities }, authority: { kind: 'fixture', preparedHash: fixture.prepared.preparedHash } };
}
it('permits fixture authority only when every independent guard passes', async () => {
  const { store, request, prepared, context, authority } = await setup();
  const result = evaluateWorkflowAuthorization(store, request.id, prepared, context, authority);
  expect(result.allowed).toBe(true); expect(result.failed).toEqual([]);
});
it('returns all failed target, ownership, media and capability guards together', async () => {
  const { store, request, prepared, context, authority } = await setup();
  context.jobId = 'other'; context.resolveProjectId = 'other'; context.timeline.subjectId = 'personal';
  delete context.timeline.timelineState!.ownership; context.media[0]!.sha256 = 'd'.repeat(64); context.capabilities = { ...workflowCapabilities, tools: [] };
  const result = evaluateWorkflowAuthorization(store, request.id, prepared, context, authority);
  expect(result.failed).toEqual(expect.arrayContaining(['WORK_IDENTITY', 'TARGET_IDENTITY', 'TARGET_OWNERSHIP', 'CURRENT_MEDIA', 'ADAPTER_CAPABILITIES']));
  expect(result.allowed).toBe(false);
});
it('vetoes tampered prepared operations and consumed/ambiguous assembly targets', async () => {
  const { store, request, prepared, context, authority } = await setup();
  const altered = structuredClone(prepared); altered.operations[0]!.arguments.segments[0]!.end_frame = 1;
  expect(evaluateWorkflowAuthorization(store, request.id, altered, context, authority).failed).toContain('PREPARED_FINGERPRINT');
  await store.claim({ jobId: request.id, ...prepared.request, step: 'assemble' });
  await store.settle(request.id, prepared.request.operationId, 'ambiguous', []);
  expect(evaluateWorkflowAuthorization(store, request.id, prepared, context, authority).failed).toContain('TARGET_CUSTODY_CONSUMED');
});
it('keeps operator and S7 authority defined but production closed, even inside Vitest', async () => {
  const { store, request, prepared, context } = await setup();
  expect(evaluateWorkflowAuthorization(store, request.id, prepared, context,
    { kind: 'operator', operatorId: 'editor-1', preparedHash: prepared.preparedHash }).failed).toContain('OPERATOR_LIVE_EXECUTION_UNAVAILABLE');
  const result = evaluateWorkflowAuthorization(store, request.id, prepared, context, { kind: 's7', preparedHash: prepared.preparedHash,
    proof: { sessionId: request.sessionId, commandId: 'cmd_s7_11111111-1111-4111-8111-111111111111',
      conversationId: 'chat-1', nativeMessageId: 'native-1', proofLevel: 'STRONG_COMMIT' } });
  expect(result.allowed).toBe(false); expect(result.failed).toContain('S7_FINAL_LIVE_CANARY_DEFERRED');
});
it('does not treat fixture authority as a production runtime option', async () => {
  const { store, request, prepared, context, authority } = await setup();
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    expect(evaluateWorkflowAuthorization(store, request.id, prepared, context, authority).failed).toContain('FIXTURE_AUTHORITY_UNAVAILABLE');
  } finally { process.env.NODE_ENV = previous; }
});
