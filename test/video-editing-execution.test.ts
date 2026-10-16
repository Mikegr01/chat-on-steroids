import { beforeEach, afterEach, expect, it } from 'vitest';
import { prepareExecution, preparedPreview, verifyExecution, VideoExecutionCoordinator } from '../src/main/video-editing/execution.js';
import { VideoEditingStore } from '../src/main/video-editing/store.js';
import { reviewedDocument } from './fixtures/video-editing.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;
beforeEach(async () => { dir = await makeTempDir('cos-video-execution-'); initDurableStore(dir); });
afterEach(async () => { resetDurableForTests(); await removeTempDir(dir); });
const operationId = '11111111-1111-4111-8111-111111111111';
const request = { planId: 'plan-1', timelineId: 'owned-timeline-1', beforeEvidenceIds: ['before'], operationId };
const capabilities = { tools: ['resolve_inspect', 'resolve_assemble_rough_cut'], sourceEnd: 'inclusive' as const, acceptance: 'fixture' as const };
function job() {
  const job = reviewedDocument(); job.checkpoints = []; job.reviews = [];
  const before = job.evidence.find(row => row.id === 'before')!.timelineState!;
  before.startFrame = 86400; before.ownership = { creationOperationId: 'prepare-1', sourceTimelineId: null };
  const after = job.evidence.find(row => row.id === 'after')!.timelineState!;
  after.startFrame = 86400; after.ownership = { creationOperationId: 'prepare-1', sourceTimelineId: null };
  return job;
}
async function setup() { const store = new VideoEditingStore(); await store.restore(); await store.put(job()); return store; }
it('compiles deterministic explicit ranges and record frames without mutating or consuming custody', async () => {
  const store = await setup(); const prepared = prepareExecution(store.get('job-1')!, request, capabilities);
  expect(prepared).toEqual(prepareExecution(store.get('job-1')!, request, capabilities));
  expect(prepared.operations).toEqual([{ operationId, name: 'resolve_assemble_rough_cut', arguments: {
    timeline_unique_id: 'owned-timeline-1', segments: [{ media_unique_id: 'pool-1', start_frame: 0,
      end_frame: 239, record_frame: 86400, track_index: 1, media_type: 'video' }] } }]);
  expect(prepared.state).toBe('ready'); expect(prepared.productionBlockers).toContain('FRAME_END_LIVE_ACCEPTANCE_PENDING');
  expect(store.get('job-1')!.checkpoints).toEqual([]);
});
it('rejects unsupported features, missing capabilities and unknown frame conventions', () => {
  const document = job(); document.candidates[0]!.plan.features.push('title');
  expect(prepareExecution(document, request, capabilities)).toMatchObject({ state: 'blocked', blockers: ['UNSUPPORTED_FEATURE:title'] });
  document.candidates[0]!.plan.features = ['cut'];
  expect(prepareExecution(document, request, { ...capabilities, tools: [] }).blockers).toContain('ADAPTER_CAPABILITY_MISSING:resolve_assemble_rough_cut');
  expect(prepareExecution(document, request, { ...capabilities, sourceEnd: 'unknown' }).blockers).toContain('SOURCE_END_CONVENTION_UNVERIFIED');
});
it('rejects unowned, duplicated nonempty and ambiguously imported targets', () => {
  const document = job(); delete document.evidence.find(row => row.id === 'before')!.timelineState!.ownership;
  expect(prepareExecution(document, request, capabilities).blockers).toContain('TARGET_OWNERSHIP_UNVERIFIED');
  const duplicated = job(); duplicated.evidence.find(row => row.id === 'before')!.timelineState!.ownership!.sourceTimelineId = 'personal';
  expect(prepareExecution(duplicated, request, capabilities).blockers).toContain('TARGET_NOT_FRESH_VERSION');
  const ambiguous = job(); ambiguous.media.push({ ...ambiguous.media[0]!, id: 'duplicate', evidenceIds: ['duplicate-proof'],
    usableRanges: [{ start: 0, end: 480, evidenceIds: ['duplicate-proof'] }] });
  ambiguous.evidence.push({ ...ambiguous.evidence[1]!, id: 'duplicate-proof', subjectId: 'duplicate' });
  expect(prepareExecution(ambiguous, request, capabilities).blockers).toContain('AMBIGUOUS_MEDIA_ID:pool-1');
});
it('verifies exact observed state and distinguishes deviation, missing and lost ownership', async () => {
  const store = await setup(); const claimed = (await store.claim({ jobId: 'job-1', ...request, step: 'assemble' })).checkpoint;
  const document = store.get('job-1')!;
  expect(verifyExecution(document, claimed, ['after']).status).toBe('VERIFIED');
  expect(verifyExecution(document, claimed, []).status).toBe('UNVERIFIED');
  document.evidence.find(row => row.id === 'after')!.timelineState!.items[0]!.source.start = 1;
  expect(verifyExecution(document, claimed, ['after']).status).toBe('DEVIATED');
  delete document.evidence.find(row => row.id === 'after')!.timelineState!.ownership;
  expect(verifyExecution(document, claimed, ['after']).status).toBe('UNVERIFIED');
});
it('moves through durable claim and verification, never completes from RPC success alone', async () => {
  const store = await setup(); let mutations = 0;
  const coordinator = new VideoExecutionCoordinator(store, { mode: 'fixture', guard: async () => 'epoch-1',
    call: async () => { mutations++; return { requested: true, executed: true, verified: true, error: null }; },
    observe: async () => [] });
  const prepared = prepareExecution(store.get('job-1')!, request, capabilities);
  expect(await coordinator.execute(prepared)).toMatchObject({ state: 'ambiguous', verification: { status: 'UNVERIFIED' } });
  expect(mutations).toBe(1);
  expect(store.get('job-1')!.checkpoints[0]!.receipt!.status).toBe('acknowledged');
  expect(store.get('job-1')!.checkpoints[0]!.state).toBe('ambiguous');
});
it('completes only after receipt and exact observed state, then never repeats across restart', async () => {
  const store = await setup(); let mutations = 0;
  const boundary = { mode: 'fixture' as const, guard: async () => 'epoch-1',
    call: async () => { mutations++; return { requested: true, executed: true, verified: true, error: null }; },
    observe: async () => ['after'] };
  const prepared = prepareExecution(store.get('job-1')!, request, capabilities);
  expect((await new VideoExecutionCoordinator(store, boundary).execute(prepared)).state).toBe('completed');
  const restored = new VideoEditingStore(); await restored.restore();
  expect((await new VideoExecutionCoordinator(restored, boundary).execute(prepared)).state).toBe('completed');
  expect(mutations).toBe(1);
});
it('persists uncertainty after dispatch exception and never retries with either the same or a new UUID', async () => {
  const store = await setup(); let mutations = 0;
  const boundary = { mode: 'fixture' as const, guard: async () => 'epoch-1',
    call: async () => { mutations++; throw new Error('lost response'); }, observe: async () => ['after'] };
  const prepared = prepareExecution(store.get('job-1')!, request, capabilities);
  expect((await new VideoExecutionCoordinator(store, boundary).execute(prepared)).state).toBe('ambiguous');
  const restored = new VideoEditingStore(); await restored.restore();
  expect((await new VideoExecutionCoordinator(restored, boundary).execute(prepared)).state).toBe('ambiguous');
  const other = prepareExecution(restored.get('job-1')!, { ...request, operationId: '22222222-2222-4222-8222-222222222222' }, capabilities);
  await expect(new VideoExecutionCoordinator(restored, boundary).execute(other)).rejects.toThrow(/consumed/i);
  expect(mutations).toBe(1);
});
it('reconciles acknowledged consumed claims by observation only and leaves unacknowledged claims ambiguous', async () => {
  const store = await setup(); await store.claim({ jobId: 'job-1', ...request, step: 'assemble' });
  const prepared = prepareExecution(store.get('job-1')!, request, capabilities);
  let mutations = 0;
  const boundary = { mode: 'fixture' as const, guard: async () => 'epoch-1', call: async () => { mutations++; return {}; }, observe: async () => ['after'] };
  expect((await new VideoExecutionCoordinator(store, boundary).execute(prepared)).state).toBe('ambiguous');
  expect(mutations).toBe(0);
});
it('freezes prepared intent and rejects tampering before dispatch', async () => {
  const store = await setup(); let mutations = 0;
  const prepared = prepareExecution(store.get('job-1')!, request, capabilities);
  prepared.operations[0]!.arguments.segments[0]!.end_frame = 99;
  await expect(new VideoExecutionCoordinator(store, { mode: 'fixture', guard: async () => 'epoch-1',
    call: async () => { mutations++; return {}; }, observe: async () => [] }).execute(prepared)).rejects.toThrow(/prepared intent/i);
  expect(mutations).toBe(0);
});
it('closes production admission even for fixture capabilities and valid Category C proof', async () => {
  const store = await setup(); let calls = 0;
  const coordinator = new VideoExecutionCoordinator(store, { mode: 'production', guard: async () => { calls++; return 'epoch-1'; },
    call: async () => { calls++; return {}; }, observe: async () => { calls++; return []; } });
  expect(await coordinator.execute(prepareExecution(store.get('job-1')!, request, capabilities))).toMatchObject({
    state: 'blocked', blockers: ['S7_FINAL_LIVE_CANARY_DEFERRED'] });
  expect(calls).toBe(0); expect(store.get('job-1')!.checkpoints).toHaveLength(0);
});
it('vetoes an epoch replacement after the durable claim and before dispatch', async () => {
  const store = await setup(); let guards = 0, mutations = 0;
  const result = await new VideoExecutionCoordinator(store, { mode: 'fixture', guard: async () => ++guards === 1 ? 'epoch-1' : 'epoch-2',
    call: async () => { mutations++; return {}; }, observe: async () => [] }).execute(prepareExecution(store.get('job-1')!, request, capabilities));
  expect(result.state).toBe('ambiguous'); expect(mutations).toBe(0);
});
it('coalesces concurrent consumers without settling an active operation prematurely', async () => {
  const store = await setup(); let mutations = 0, release!: () => void, started!: () => void;
  const dispatched = new Promise<void>(resolve => { started = resolve; });
  const boundary = { mode: 'fixture' as const, guard: async () => 'epoch-1',
    call: async () => { mutations++; started(); await new Promise<void>(resolve => { release = resolve; });
      return { requested: true, executed: true, verified: true, error: null }; }, observe: async () => ['after'] };
  const prepared = prepareExecution(store.get('job-1')!, request, capabilities);
  const first = new VideoExecutionCoordinator(store, boundary).execute(prepared); await dispatched;
  const second = new VideoExecutionCoordinator(store, boundary).execute(prepared);
  release(); expect((await first).state).toBe('completed'); expect((await second).state).toBe('completed');
  expect(mutations).toBe(1);
});
it('restarts an acknowledged checkpoint in verification without dispatching it again', async () => {
  const store = await setup(); await store.claim({ jobId: 'job-1', ...request, step: 'assemble' });
  await store.recordReceipt('job-1', operationId, { status: 'acknowledged', resultSha256: 'a'.repeat(64) });
  const restored = new VideoEditingStore(); await restored.restore(); let mutations = 0;
  const result = await new VideoExecutionCoordinator(restored, { mode: 'fixture', guard: async () => 'epoch-1',
    call: async () => { mutations++; return {}; }, observe: async () => ['after'] })
    .execute(prepareExecution(restored.get('job-1')!, request, capabilities));
  expect(result.state).toBe('completed'); expect(mutations).toBe(0);
});
it('does not erase an acknowledged receipt during warm restore or rewrite it', async () => {
  const store = await setup(); await store.claim({ jobId: 'job-1', ...request, step: 'assemble' });
  await store.recordReceipt('job-1', operationId, { status: 'acknowledged', resultSha256: 'a'.repeat(64) });
  await expect(store.recordReceipt('job-1', operationId, { status: 'uncertain' })).rejects.toThrow(/immutable/i);
  const restored = new VideoEditingStore(); await restored.restore();
  expect(restored.get('job-1')!.checkpoints[0]!.receipt).toMatchObject({ status: 'acknowledged' });
});
it('keeps a save-failure response ambiguous even when matching items can be observed', async () => {
  const store = await setup(); let observations = 0;
  const result = await new VideoExecutionCoordinator(store, { mode: 'fixture', guard: async () => 'epoch-1',
    call: async () => ({ requested: true, executed: true, verified: false, error: { code: 'AMBIGUOUS_MUTATION' } }),
    observe: async () => { observations++; return ['after']; } }).execute(prepareExecution(store.get('job-1')!, request, capabilities));
  expect(result.state).toBe('ambiguous'); expect(observations).toBe(0);
});
it('consumes assembly of an exact target across alternative plans and jobs', async () => {
  const store = await setup();
  const document = store.get('job-1')!; const candidate = structuredClone(document.candidates[0]!);
  candidate.id = 'candidate-2'; candidate.plan.id = 'plan-2'; candidate.plan.rootPlanId = 'plan-2'; document.candidates.push(candidate);
  await store.put(document); await store.claim({ jobId: 'job-1', ...request, step: 'assemble' });
  await expect(store.claim({ jobId: 'job-1', ...request, planId: 'plan-2', step: 'assemble',
    operationId: '22222222-2222-4222-8222-222222222222' })).rejects.toThrow(/target.*consumed/i);
  const other = job(); other.id = 'job-2'; await store.put(other);
  await expect(store.claim({ jobId: 'job-2', ...request, step: 'assemble',
    operationId: '33333333-3333-4333-8333-333333333333' })).rejects.toThrow(/target.*consumed/i);
});
it('renders a user-reviewable non-mutating preview with gates and exact ordered operations', () => {
  const prepared = prepareExecution(job(), request, capabilities);
  const preview = preparedPreview(prepared);
  expect(preview).toContain('owned-timeline-1'); expect(preview).toContain('239');
  expect(preview).toContain('FRAME_END_LIVE_ACCEPTANCE_PENDING'); expect(preview).toContain('No automatic rollback or replay');
  prepared.operations[0]!.arguments.segments[0]!.end_frame = 20;
  expect(() => preparedPreview(prepared)).toThrow(/fingerprint/i);
});
