import { beforeEach, afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { initDurableStore, resetDurableForTests, writeStrictDurableNow } from '../src/main/durable.js';
import { VideoEditingStore } from '../src/main/video-editing/store.js';
import { VideoWorkflowCoordinator } from '../src/main/video-editing/workflow.js';
import { createAssetIngestor } from '../src/main/video-editing/workflow-ingestion.js';
import { serializeWorkflowPreview } from '../src/main/video-editing/workflow-preview.js';
import { createOperatorPlanner } from '../src/main/video-editing/workflow-planning.js';
import { fixturePlanner } from './fixtures/video-workflow.js';
import { setupWorkflow, workflowTarget as target, workflowCapabilities as capabilities, preparedFixture } from './fixtures/video-workflow-runtime.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;
beforeEach(async () => { dir = await makeTempDir('cos-workflow-'); initDurableStore(dir); });
afterEach(async () => { resetDurableForTests(); await removeTempDir(dir); });
const setup = (planner = fixturePlanner) => setupWorkflow(dir, planner);
it('joins a realistic source-only job through ingestion, alternatives, explicit selection and stable preparation', async () => {
  const { store, coordinator, request, calls, ingestor } = await setup();
  expect((await coordinator.request(request)).workflow!.phase).toBe('requested');
  expect((await coordinator.ingest(request.id)).workflow!.phase).toBe('evidence-ready');
  const candidates = await coordinator.plan(request.id);
  expect(candidates.candidates).toHaveLength(2); expect(candidates.workflow!.phase).toBe('candidates-ready');
  const preferred = candidates.workflow!.comparison[0]!.candidateId;
  await coordinator.select(request.id, preferred, 'editor-1');
  const result = await coordinator.prepare(request.id, target());
  expect(result.document.workflow!.phase).toBe('prepared'); expect(result.prepared.operations[0]!.arguments.segments).toHaveLength(3);
  expect(result.preview.summary.durationFrames).toBe(240); expect(result.preview.warnings).toContain('CREATIVE_REVIEW_UNAVAILABLE');
  expect(result.preview.outputEvidence.samples).toEqual([0, 120, 239]);
  expect(result.preview.outputEvidence.frameProducer).toBe('REQUIRES_ADMITTED_EXTERNAL_MEDIA_RUNTIME');
  expect(result.preview.warnings).toContain('POSITIONED_RENDER_OUTPUT_EVIDENCE_REQUIRED');
  expect(result.preview.clips.map(row => row.mediaId)).toEqual(['source-b', 'source-a', 'music']);
  expect(result.preview.clips.every(row => row.evidenceIds.length)).toBe(true);
  expect(store.get(request.id)!.checkpoints).toEqual([]); expect(calls.every(name => name === 'resolve_inspect')).toBe(true);
  const restored = new VideoEditingStore(); await restored.restore();
  const resumed = new VideoWorkflowCoordinator(restored, { ingestor, planner: fixturePlanner, capabilities });
  expect(resumed.preview(request.id)).toEqual(result.preview);
  expect(restored.get(request.id)!.workflow!.prepared!.preparedHash).toBe(result.prepared.preparedHash);
  expect(restored.get(request.id)!.workflow!.selection!.candidateId).toBe(preferred);
});
it('persists missing planner as blocked instead of inventing production intelligence', async () => {
  const { coordinator, request, ingestor, store } = await setup();
  await coordinator.request(request); await coordinator.ingest(request.id);
  const unwired = new VideoWorkflowCoordinator(store, { ingestor, capabilities });
  expect((await unwired.plan(request.id)).workflow!.blockers).toContain('PLANNER_UNAVAILABLE');
  expect(store.get(request.id)!.candidates).toEqual([]);
});
it('never publishes an active planning stage when no provider is bound', async () => {
  const { request, ingestor } = await setup(); const stages: string[] = [];
  const store = new VideoEditingStore({ write: async value => {
    stages.push(value.jobs[0]!.workflow!.phase); await writeStrictDurableNow('video-editing-jobs', value, 1024 * 1024);
  } }); await store.restore();
  const coordinator = new VideoWorkflowCoordinator(store, { ingestor, capabilities });
  await coordinator.request(request); await coordinator.ingest(request.id); await coordinator.plan(request.id);
  expect(stages).not.toContain('planning'); expect(stages.at(-1)).toBe('blocked');
});
it('rejects impossible state transitions and overwriting the accepted work request', async () => {
  const { coordinator, request } = await setup(); await coordinator.request(request);
  await expect(coordinator.select(request.id, 'missing', 'editor-1')).rejects.toThrow();
  await expect(coordinator.request({ ...request, objective: 'changed brief' })).rejects.toThrow(/immutable|conflict/i);
});
it('keeps partial filesystem-only evidence from becoming an executable plan', async () => {
  const { coordinator, request, store } = await setup(); await coordinator.request(request);
  const local = new VideoWorkflowCoordinator(store, { ingestor: createAssetIngestor({ access: p => fs.realpath(p), now: () => 10 }), planner: fixturePlanner, capabilities });
  await local.ingest(request.id); const result = await local.plan(request.id);
  expect(result.workflow!.comparison.every(row => row.score === null)).toBe(true);
  await expect(local.select(request.id, result.candidates[0]!.id, 'editor-1')).rejects.toThrow(/infeasible/i);
});
it('admits one planner design without claiming alternative comparison or selecting it automatically', async () => {
  const planner = { ...fixturePlanner, async plan(input: Parameters<typeof fixturePlanner.plan>[0]) { return (await fixturePlanner.plan(input)).slice(0, 1); } };
  const { coordinator, request } = await setup(planner);
  await coordinator.request(request); await coordinator.ingest(request.id);
  const job = await coordinator.plan(request.id);
  expect(job.candidates).toHaveLength(1); expect(job.workflow!.comparison).toHaveLength(1); expect(job.workflow!.selection).toBeUndefined();
});
it('rejects unsupported titles, duration changes, content omission and absent render capabilities explicitly', async () => {
  const { ingestor, request } = await setup(); request.titles = ['Location']; request.content.requiredAssetIds.push('music');
  request.target.durationFrames = 250;
  const store = new VideoEditingStore(); await store.restore();
  const withoutRender = new VideoWorkflowCoordinator(store, { ingestor, planner: fixturePlanner,
    capabilities: { ...capabilities, tools: ['resolve_inspect', 'resolve_assemble_rough_cut'] } });
  await withoutRender.request(request); await withoutRender.ingest(request.id);
  const job = await withoutRender.plan(request.id);
  expect(job.workflow!.comparison.every(row => row.score === null)).toBe(true);
  expect(job.workflow!.comparison[0]!.blockers).toEqual(expect.arrayContaining(['UNSUPPORTED_REQUEST:title', 'ADAPTER_CAPABILITY_MISSING:resolve_render_review', 'VISUAL_COVERAGE']));
  expect(store.get(request.id)!.workflow!.phase).toBe('candidates-ready');
});
it('does not admit a planner result after its configuration changes during an await', async () => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { started = resolve; });
  const planner = { ...fixturePlanner, descriptor: structuredClone(fixturePlanner.descriptor),
    async plan(input: Parameters<typeof fixturePlanner.plan>[0]) { started(); await new Promise<void>(resolve => { release = resolve; }); return fixturePlanner.plan(input); } };
  const { coordinator, request } = await setup(planner); await coordinator.request(request); await coordinator.ingest(request.id);
  const planning = coordinator.plan(request.id); await gate; planner.descriptor.version = '2'; release();
  const job = await planning;
  expect(job.workflow!.phase).toBe('blocked'); expect(job.workflow!.blockers.join()).toContain('PLANNER_INCARNATION_CHANGED'); expect(job.candidates).toEqual([]);
});
it('resumes an interrupted planning stage without regenerating candidate identities', async () => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { started = resolve; });
  const planner = { ...fixturePlanner, async plan(input: Parameters<typeof fixturePlanner.plan>[0]) {
    started(); await new Promise<void>(resolve => { release = resolve; }); return fixturePlanner.plan(input); } };
  const { coordinator, request, ingestor } = await setup(planner); await coordinator.request(request); await coordinator.ingest(request.id);
  const interrupted = coordinator.plan(request.id); const oldOutcome = interrupted.catch(error => error); await gate;
  const restored = new VideoEditingStore(); await restored.restore();
  expect(restored.get(request.id)!.workflow!.phase).toBe('planning');
  const resumed = new VideoWorkflowCoordinator(restored, { ingestor, planner: fixturePlanner, capabilities });
  const planned = await resumed.plan(request.id); release(); expect(await oldOutcome).toBeInstanceOf(Error);
  expect(restored.get(request.id)!.candidates).toEqual(planned.candidates); expect((await resumed.plan(request.id)).candidates).toEqual(planned.candidates);
});
it('reconciles a workflow write that published before failing without repeating ingestion', async () => {
  const { request, ingestor } = await setup(); let failNext = false, ingestions = 0;
  const store = new VideoEditingStore({ write: async value => {
    await writeStrictDurableNow('video-editing-jobs', value, 1024 * 1024);
    if (failNext) { failNext = false; throw new Error('publication response lost'); }
  } }); await store.restore();
  const coordinator = new VideoWorkflowCoordinator(store, { ingestor: { async ingest(input) { ingestions++; return ingestor.ingest(input); } }, planner: fixturePlanner, capabilities });
  await coordinator.request(request); failNext = true;
  await expect(coordinator.ingest(request.id)).rejects.toThrow('publication response lost'); expect(ingestions).toBe(0);
  await store.restore(); expect(store.get(request.id)!.workflow!.phase).toBe('ingesting');
  expect((await coordinator.ingest(request.id)).workflow!.phase).toBe('evidence-ready'); expect(ingestions).toBe(1);
});
it('rejects tampered persisted preparation and ranking on cold restore', async () => {
  await preparedFixture(dir);
  const file = path.join(dir, 'state', 'video-editing-jobs.json'); const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  raw.jobs[0].workflow.prepared.preparedHash = 'f'.repeat(64); await fs.writeFile(file, JSON.stringify(raw));
  await expect(new VideoEditingStore().restore()).rejects.toThrow(/fingerprint/i);
});
it('prevents consumed target reuse while preserving a readable blocked preview', async () => {
  const { store, coordinator, request, document, prepared } = await preparedFixture(dir);
  await store.claim({ jobId: request.id, ...prepared.request, step: 'assemble' }); await store.settle(request.id, prepared.request.operationId, 'ambiguous', []);
  const second = { ...request, id: 'work-2' }; await coordinator.request(second); await coordinator.ingest(second.id);
  const designs = await coordinator.plan(second.id); await coordinator.select(second.id, designs.workflow!.comparison[0]!.candidateId, 'editor-1');
  const result = await coordinator.prepare(second.id, { ...document.evidence.find(row => row.id === 'before')!, id: 'before-2' });
  expect(result.document.workflow!.blockers).toContain('TARGET_ALREADY_CONSUMED');
  expect(result.preview.warnings).toContain('TARGET_ALREADY_CONSUMED'); expect(result.document.checkpoints).toEqual([]);
});
it('includes candidate rationale and risks in a deterministic reviewable serialization', async () => {
  const { preview } = await preparedFixture(dir);
  expect(preview.summary.rationale).toContain('Operator-supplied reference');
  expect(preview.summary.risks).toContain('Creative rhythm/reference-fit not evaluated.');
  expect(serializeWorkflowPreview(preview)).toBe(serializeWorkflowPreview(JSON.parse(JSON.stringify(preview))));
});
it('persists missing-file blockage and resumes read-only ingestion when the source becomes available', async () => {
  const { coordinator, request } = await setup(); await coordinator.request(request);
  await fs.unlink(request.assets[0]!.path);
  const blocked = await coordinator.ingest(request.id);
  expect(blocked.workflow!.phase).toBe('blocked'); expect(blocked.media).toEqual([]); expect(blocked.candidates).toEqual([]);
  await fs.writeFile(request.assets[0]!.path, 'restored actual bytes');
  expect((await coordinator.ingest(request.id)).workflow!.phase).toBe('evidence-ready');
});
it('accepts explicit operator-submitted designs in production mode without pretending to be an AI planner', async () => {
  const { store, coordinator, ingestor, request } = await setup(); await coordinator.request(request); const job = await coordinator.ingest(request.id);
  const input = { request, requestHash: job.workflow!.requestHash, media: job.media, references: job.references, evidence: job.evidence, capabilities };
  const submitted = await fixturePlanner.plan(input), planner = createOperatorPlanner('editor-1', submitted);
  submitted[0]!.rationale = 'mutated after submission';
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    const operator = new VideoWorkflowCoordinator(store, { ingestor, planner, capabilities });
    const planned = await operator.plan(request.id);
    expect(planned.workflow!.planner!.kind).toBe('operator'); expect(planned.candidates).toHaveLength(2);
    expect(planned.candidates[0]!.rationale).not.toBe('mutated after submission'); expect(planned.workflow!.selection).toBeUndefined();
    expect(planned.checkpoints).toEqual([]);
  } finally { process.env.NODE_ENV = previous; }
});
