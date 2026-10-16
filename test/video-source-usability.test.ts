import { beforeEach, afterEach, it, expect } from 'vitest';
import { initDurableStore, resetDurableForTests, writeStrictDurableNow } from '../src/main/durable.js';
import { VideoEditingStore } from '../src/main/video-editing/store.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import { sourceUsabilityFixture } from './fixtures/video-source-usability.js';
import { sourceUsabilityBinding, validateSourceUsabilityInput, assertSourceUsabilityMutable } from '../src/main/video-editing/source-usability.js';
import { validateDocument, validatePlan } from '../src/main/video-editing/validation.js';
import { requestFingerprint } from '../src/main/video-editing/workflow-planning.js';
import { VideoWorkflowCoordinator } from '../src/main/video-editing/workflow.js';
import { workflowTarget, workflowCapabilities } from './fixtures/video-workflow-runtime.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { VideoEditingDocument } from '../src/shared/video-editing.js';

let dir: string;
beforeEach(async () => { dir = await makeTempDir('cos-source-usability-'); initDurableStore(dir); });
afterEach(async () => { resetDurableForTests(); await removeTempDir(dir); });
function decision(job: VideoEditingDocument, assetId = 'source-a', ranges = [{ start: 0, end: 24 }]) {
  return { binding: sourceUsabilityBinding(job, assetId), expectedRevision: job.workflow!.revision, ranges };
}
it('recovers the same candidates-ready standalone job with explicit decisions, unchanged request and cold restart', async () => {
  const f = await sourceUsabilityFixture(dir), job = await f.coordinator.plan(f.request.id);
  const requestBytes = JSON.stringify(job.workflow!.request), ids = job.candidates.map(row => row.id);
  expect(job.workflow!.comparison.every(row => row.score === null && row.blockers.length === 2)).toBe(true);
  expect(job.workflow!.comparison[0]!.blockers).toEqual(expect.arrayContaining(['SOURCE_NOT_USABLE:clip-source-a', 'SOURCE_NOT_USABLE:clip-source-b']));
  const hash = requestFingerprint(job.workflow!.request), originalMedia = structuredClone(job.media);
  const fixed = await f.coordinator.setUsableRanges(job.id, decision(job));
  expect(fixed.workflow!.comparison.every(row => row.blockers.length === 1 && row.blockers[0] === 'SOURCE_NOT_USABLE:clip-source-b')).toBe(true);
  expect(JSON.stringify(fixed.workflow!.request)).toBe(requestBytes);
  expect(fixed.candidates.map(row => row.id)).toEqual(ids);
  const restored = new VideoEditingStore(); await restored.restore(); expect(restored.get(job.id)).toEqual(fixed);
  const resumed = new VideoWorkflowCoordinator(restored, { ingestor: f.ingestor, capabilities: workflowCapabilities });
  const green = await resumed.setUsableRanges(job.id, decision(fixed, 'source-b'));
  expect(green.workflow!.comparison.every(row => row.score === 1 && row.blockers.length === 0)).toBe(true);
  expect(validatePlan(green.candidates[0]!.plan, green)).toEqual([]);
  expect(green.media).toEqual(originalMedia); expect(green.candidates).toEqual(job.candidates);
  expect(requestFingerprint(green.workflow!.request)).toBe(hash); expect(JSON.stringify(green.workflow!.request)).toBe(requestBytes);
  expect(green.checkpoints).toEqual([]); expect(green.operatorAuthorizations).toBeUndefined();
  const cold = new VideoEditingStore(); await cold.restore(); expect(cold.get(job.id)).toEqual(green);
  const selection = await resumed.select(job.id, ids[0]!, 'operator-ipc'); expect(selection.workflow!.phase).toBe('selected');
  await expect(resumed.setUsableRanges(job.id, decision(selection))).rejects.toThrow(/pre-selection/);
  expect((await resumed.prepare(job.id, workflowTarget())).document.workflow!.phase).toBe('prepared');
  await expect(resumed.setUsableRanges(job.id, decision(restored.get(job.id)!))).rejects.toThrow(/pre-selection/);
});

it.each([
  [{ start: 0, end: 25 }], [{ start: -1, end: 24 }], [{ start: 24, end: 24 }],
  [{ start: 0.5, end: 24 }], [{ start: 0, end: Infinity }],
  [{ start: 0, end: 12 }, { start: 10, end: 24 }], [{ start: 0, end: 24 }, { start: 0, end: 24 }],
  Array.from({ length: 101 }, () => ({ start: 0, end: 1 })),
].map(ranges => ({ ranges })))('rejects invalid/beyond-measured/overlapping/bounded ranges %#', async ({ ranges }) => {
  const f = await sourceUsabilityFixture(dir), job = f.store.get(f.request.id)!;
  await expect(f.coordinator.setUsableRanges(job.id, decision(job, 'source-a', ranges))).rejects.toThrow();
  expect(f.store.get(job.id)).toEqual(job);
});

it.each(['jobId', 'assetId', 'resolveMediaId', 'path', 'sha256', 'evidenceHash', 'frameCount'] as const)('rejects changed exact binding %s', async field => {
  const f = await sourceUsabilityFixture(dir), job = f.store.get(f.request.id)!, input = decision(job);
  (input.binding as any)[field] = field === 'frameCount' ? 25 : ['sha256', 'evidenceHash'].includes(field) ? '0'.repeat(64) : 'foreign';
  await expect(f.coordinator.setUsableRanges(job.id, input)).rejects.toThrow(); expect(f.store.get(job.id)).toEqual(job);
});

it('canonicalizes ordering, retries identical intent without writing, and fences conflicting revisions', async () => {
  const f = await sourceUsabilityFixture(dir), job = await f.coordinator.plan(f.request.id);
  const input = decision(job, 'source-a', [{ start: 12, end: 24 }, { start: 0, end: 12 }]);
  const first = await f.coordinator.setUsableRanges(job.id, input);
  expect(first.workflow!.sourceUsability![0]!.ranges).toEqual([{ start: 0, end: 12 }, { start: 12, end: 24 }]);
  const disk = await fs.readFile(path.join(dir, 'state/video-editing-jobs.json'));
  expect(await f.coordinator.setUsableRanges(job.id, input)).toEqual(first);
  expect(await fs.readFile(path.join(dir, 'state/video-editing-jobs.json'))).toEqual(disk);
  await expect(f.coordinator.setUsableRanges(job.id, { ...input, ranges: [{ start: 0, end: 12 }] })).rejects.toThrow(/revision/);
  await expect(f.coordinator.setUsableRanges(job.id, { ...input, expectedRevision: 999 })).rejects.toThrow(/revision/);
  const changed = await f.coordinator.setUsableRanges(job.id, decision(first, 'source-a', [{ start: 0, end: 12 }]));
  expect(changed.workflow!.sourceUsability).toHaveLength(1); expect(changed.workflow!.comparison[0]!.blockers).toContain('SOURCE_NOT_USABLE:clip-source-a');
});

it('keeps create-time ranges and refuses mutable widening of immutable bounds', async () => {
  const f = await sourceUsabilityFixture(dir, true), job = await f.coordinator.plan(f.request.id);
  expect(job.media[0]!.usableRanges.map(({ start, end }) => ({ start, end }))).toEqual([{ start: 0, end: 12 }]);
  await expect(f.coordinator.setUsableRanges(job.id, decision(job))).rejects.toThrow(/immutable request/);
  const narrowed = await f.coordinator.setUsableRanges(job.id, decision(job, 'source-a', [{ start: 0, end: 6 }]));
  expect(requestFingerprint(narrowed.workflow!.request)).toBe(job.workflow!.requestHash);
  expect(validatePlan(narrowed.candidates[0]!.plan, narrowed)).toContain('SOURCE_NOT_USABLE:clip-source-a');
});

it.each(['path', 'sha256', 'resolveMediaId', 'durationFrames', 'evidence', 'probe'] as const)('fails closed for stale durable source %s including restore', async field => {
  const f = await sourceUsabilityFixture(dir), job = f.store.get(f.request.id)!;
  const accepted = await f.coordinator.setUsableRanges(job.id, decision(job));
  const changed = structuredClone(accepted), asset = changed.media[0]!;
  if (field === 'path') asset.path += '.changed';
  if (field === 'sha256') asset.sha256 = '0'.repeat(64);
  if (field === 'resolveMediaId') asset.resolveMediaId = 'other';
  if (field === 'durationFrames') asset.durationFrames = 25;
  if (field === 'evidence') changed.evidence.find(row => row.id === asset.evidenceIds[0])!.observedAt++;
  if (field === 'probe') asset.technical!.streams[0]!.frameCount = 25;
  expect(validatePlan(accepted.candidates[0]?.plan ?? (await f.coordinator.plan(job.id)).candidates[0]!.plan, changed)).toContain('SOURCE_NOT_USABLE:clip-source-a');
  expect(() => validateDocument(changed)).toThrow();
  const poisoned = new VideoEditingStore({ read: async () => ({ kind: 'valid', value: { version: 1, jobs: [changed] } }) });
  await expect(poisoned.restore()).rejects.toThrow();
});

it('supports evidence-ready and planning-blocked jobs and rejects missing measured source evidence', async () => {
  const f = await sourceUsabilityFixture(dir), job = f.store.get(f.request.id)!;
  const blocked = await new VideoWorkflowCoordinator(f.store, { ingestor: f.ingestor, capabilities: workflowCapabilities }).plan(job.id);
  expect(blocked.workflow!.blockedAt).toBe('planning');
  const accepted = await f.coordinator.setUsableRanges(job.id, decision(blocked));
  expect(accepted.workflow!.phase).toBe('blocked');
  expect((await f.coordinator.plan(job.id)).workflow!.phase).toBe('candidates-ready');
  const missing = structuredClone(job); missing.media[0]!.technical = undefined;
  expect(() => validateSourceUsabilityInput(missing, decision(job))).toThrow(/probe evidence/);
  await expect(f.coordinator.setUsableRanges('wrong-job', decision(job))).rejects.toThrow();
});

it.each(['selection', 'prepared', 'operatorAuthorizations', 'checkpoints', 'reviews', 'revisions', 'phase'] as const)('refuses source decision after %s custody', async field => {
  const f = await sourceUsabilityFixture(dir), job = f.store.get(f.request.id)!;
  if (field === 'phase') job.workflow!.phase = 'planning';
  else if (field === 'selection' || field === 'prepared') (job.workflow as any)[field] = {};
  else (job as any)[field] = [{}];
  expect(() => assertSourceUsabilityMutable(job)).toThrow(/pre-selection/);
});

it('rejects injected decision/comparison through generic publication and stale comparison at selection', async () => {
  const f = await sourceUsabilityFixture(dir), job = await f.coordinator.plan(f.request.id);
  const accepted = await f.coordinator.setUsableRanges(job.id, decision(job));
  await expect(f.store.put({ ...accepted, workflow: { ...accepted.workflow!, sourceUsability: [] } })).rejects.toThrow(/owner/);
  await expect(f.store.advanceWorkflow({ ...accepted, workflow: { ...accepted.workflow!, sourceUsability: [], revision: accepted.workflow!.revision + 1, phase: 'selected' } }, accepted.workflow!.revision)).rejects.toThrow(/usability/);
  const stale = structuredClone(accepted); stale.workflow!.comparison = stale.workflow!.comparison.map(row => ({ ...row, score: 1, blockers: [] }));
  const fake = { get: () => stale } as unknown as VideoEditingStore;
  const coordinator = new VideoWorkflowCoordinator(fake, { ingestor: f.ingestor, capabilities: workflowCapabilities });
  await expect(coordinator.select(job.id, stale.candidates[0]!.id, 'operator-ipc')).rejects.toThrow(/stale/);
});

it('recovers an acknowledged disk publication with lost response without repeating or losing source decision', async () => {
  const f = await sourceUsabilityFixture(dir), before = await f.coordinator.plan(f.request.id);
  let fail = true;
  const store = new VideoEditingStore({ write: async value => {
    await writeStrictDurableNow('video-editing-jobs', value, 1024 * 1024);
    if (fail) { fail = false; throw Error('response lost after durable write'); }
  } }); await store.restore();
  const input = decision(before);
  await expect(store.setSourceUsability(before.id, input)).rejects.toThrow(/response lost/);
  expect(store.get(before.id)).toEqual(before);
  await store.restore(); const committed = store.get(before.id)!;
  expect(committed.workflow!.revision).toBe(before.workflow!.revision + 1);
  expect(await store.setSourceUsability(before.id, input)).toEqual(committed);
  expect(committed.workflow!.comparison.every(row => row.blockers.length === 1)).toBe(true);
});

it('serializes competing source decisions and keeps uncommitted state invisible', async () => {
  const f = await sourceUsabilityFixture(dir), before = await f.coordinator.plan(f.request.id);
  let release!: () => void, started!: () => void;
  const paused = new Promise<void>(resolve => { started = resolve; });
  const store = new VideoEditingStore({ write: async value => {
    started(); await new Promise<void>(resolve => { release = resolve; });
    await writeStrictDurableNow('video-editing-jobs', value, 1024 * 1024);
  } }); await store.restore();
  const a = store.setSourceUsability(before.id, decision(before));
  await paused;
  expect(store.get(before.id)).toEqual(before);
  const b = store.setSourceUsability(before.id, decision(before, 'source-b'));
  const rejected = expect(b).rejects.toThrow(/revision/);
  release(); const published = await a; await rejected;
  expect(store.get(before.id)).toEqual(published); expect(published.workflow!.sourceUsability).toHaveLength(1);
});
