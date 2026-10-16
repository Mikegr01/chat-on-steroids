import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { initDurableStore, resetDurableForTests, writeStrictDurableNow } from '../src/main/durable.js';
import { VIDEO_DOCUMENT_MAX_BYTES, videoEditingDocumentSchema, type VideoEditingDocument } from '../src/shared/video-editing.js';
import { VideoEditingStore } from '../src/main/video-editing/store.js';
import { VideoWorkflowCoordinator } from '../src/main/video-editing/workflow.js';
import { validateDocument } from '../src/main/video-editing/validation.js';
import { validateWorkflowDerived } from '../src/main/video-editing/workflow-state.js';
import { effectiveSourceEnd, isCapabilityConfirmationAuthorityValid, capabilityAdmissionBlockers } from '../src/main/video-editing/source-end-admission.js';
import { sourceUsabilityBinding } from '../src/main/video-editing/source-usability.js';
import { produceTimeline } from '../src/main/video-editing/producers.js';
import { authenticatedCapabilityReceipt } from './fixtures/video-capability-authentication.js';
import { sourceUsabilityFixture } from './fixtures/video-source-usability.js';
import { timelinePage } from './fixtures/video-observation.js';
import { setupWorkflow, workflowTarget } from './fixtures/video-workflow-runtime.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;
beforeEach(async () => { dir = await makeTempDir('cos-blocked-preparation-'); initDurableStore(dir); });
afterEach(async () => { vi.restoreAllMocks(); resetDurableForTests(); await removeTempDir(dir); });

const adapter = (epoch: string) => ({ sourceEnd: 'inclusive', guardVersion: 2, adapterVersion: '1.7.0', epoch });
function blockage(job: VideoEditingDocument) {
  return { phase: job.workflow!.phase, blockedAt: job.workflow!.blockedAt, blockers: job.workflow!.blockers };
}
const epochBlockage = { phase: 'blocked', blockedAt: 'preparing', blockers: ['ADAPTER_EPOCH_CHANGED'] };

/** Every blocked state comes from the production coordinator, never a forged state fixture.
 * All IO is synthetic or under the disposable test directory; no native verification/dispatch. */
async function blockedFixture() {
  const f = await sourceUsabilityFixture(dir, false, 'unknown');
  const planned = await f.coordinator.plan(f.request.id);
  for (const assetId of ['source-a', 'source-b']) {
    const job = f.store.get(f.request.id)!;
    await f.coordinator.setUsableRanges(f.request.id, { binding: sourceUsabilityBinding(job, assetId),
      expectedRevision: job.workflow!.revision, ranges: [{ start: 0, end: 24 }] });
  }
  await f.coordinator.select(f.request.id, planned.candidates[0]!.id, 'operator-ipc');
  let epoch = 'synthetic-plugin:18';
  const ingestor = { ingest: vi.fn(f.ingestor.ingest) }, planner = { ...f.planner, plan: vi.fn(f.planner.plan) };
  const coordinator = new VideoWorkflowCoordinator(f.store, { ingestor, planner,
    capabilities: f.store.get(f.request.id)!.workflow!.capabilities, epoch: () => epoch });
  const admitted = await coordinator.readmitCapabilities(f.request.id, adapter(epoch));
  const oldReceipt = authenticatedCapabilityReceipt(admitted, 'operator-ipc', 'synthetic-chat');
  await coordinator.confirmCapabilityAdmission(f.request.id, oldReceipt);
  const page = { ...timelinePage(), items: [], total: 0, duration_frames: 0,
    unique_id: 'synthetic-ai-target', project_unique_id: f.request.resolveProjectId,
    rough_cut_guard_version: 2, source_end: 'inclusive', snapshot_sha256: 'a'.repeat(64) };
  const target = produceTimeline([page], { id: 'synthetic-target', subjectId: page.unique_id, observedAt: 100 }).evidence;
  epoch = 'synthetic-plugin:21';
  const failed = await coordinator.prepare(f.request.id, target);
  expect(blockage(failed.document)).toEqual(epochBlockage);
  expect(failed.document.workflow!.prepared).toBeUndefined();
  return { ...f, coordinator, ingestor, planner, target, oldReceipt, blocked: failed.document,
    currentEpoch: () => epoch, changeEpoch: (value: string) => { epoch = value; } };
}

async function confirmedFixture() {
  const f = await blockedFixture();
  const readmitted = await f.coordinator.readmitCapabilities(f.request.id, adapter(f.currentEpoch()));
  const receipt = authenticatedCapabilityReceipt(readmitted, 'operator-ipc', 'synthetic-chat');
  const confirmed = await f.coordinator.confirmCapabilityAdmission(f.request.id, receipt);
  return { ...f, readmitted, receipt, confirmed };
}

it('BLOCKED_EPOCH_CHANGED_RECOVERY_SEQUENCE_CAN_COMPLETE and passes workflow validation', async () => {
  const f = await confirmedFixture();
  await expect(f.coordinator.prepare(f.request.id, f.target)).resolves.toMatchObject({
    document: { workflow: { phase: 'prepared', blockers: [] } }, prepared: { state: 'ready', blockers: [] } });
  const job = f.store.get(f.request.id)!;
  expect(() => validateDocument(job)).not.toThrow();
  expect(() => validateWorkflowDerived(job)).not.toThrow();
});

it.each(['blockedAt', 'blockers'] as const)('SUCCESSFUL_PREPARE_FROM_BLOCKED clears %s in its real publication', async field => {
  const f = await confirmedFixture(), publication = vi.spyOn(f.store, 'advanceWorkflow');
  // Capture the actual attempted production publication even when the old strict validator rejects it.
  const outcome = await f.coordinator.prepare(f.request.id, f.target).catch(error => error);
  if (outcome instanceof Error) expect(outcome.message).toBe('Workflow blockage mismatch');
  expect(publication).toHaveBeenCalledOnce();
  const proposed = videoEditingDocumentSchema.parse(publication.mock.calls[0]![0]);
  expect(proposed.workflow!.phase).toBe('prepared');
  expect(proposed.workflow!.prepared).toBeDefined();
  expect(proposed.workflow![field]).toEqual(field === 'blockedAt' ? undefined : []);
});

it('changed readmission retains epoch blockage and bindings but invalidates old receipt authority', async () => {
  const f = await blockedFixture();
  expect(isCapabilityConfirmationAuthorityValid(f.blocked)).toBe(true);
  expect(effectiveSourceEnd(f.blocked, { epoch: f.currentEpoch() })).toBe('unknown');
  const readmitted = await f.coordinator.readmitCapabilities(f.request.id, adapter(f.currentEpoch()));
  expect(blockage(readmitted)).toEqual(epochBlockage);
  expect(readmitted.workflow!.revision).toBe(f.blocked.workflow!.revision + 1);
  expect(readmitted.workflow!.capabilityConfirmation).toEqual(f.oldReceipt);
  expect(readmitted.workflow!.capabilityAdmission!.adapterEpoch).toBe(f.currentEpoch());
  expect(isCapabilityConfirmationAuthorityValid(readmitted)).toBe(false);
  expect(effectiveSourceEnd(readmitted)).toBe('unknown');
  expect(capabilityAdmissionBlockers(readmitted)).toEqual(['CAPABILITY_ADMISSION_OPERATOR_CONFIRMATION_REQUIRED']);
  expect(readmitted.candidates).toEqual(f.blocked.candidates);
  expect(readmitted.workflow!.selection).toEqual(f.blocked.workflow!.selection);
  expect(readmitted.evidence).toEqual(f.blocked.evidence);
  expect(readmitted.workflow!.prepared).toBeUndefined();
  expect(readmitted.checkpoints).toEqual([]);
  await expect(f.coordinator.confirmCapabilityAdmission(f.request.id, f.oldReceipt)).rejects.toThrow(/authenticated capability confirmation required/);
  expect(f.store.get(f.request.id)).toEqual(readmitted);
});

it('fresh synthetic UCV confirmation replaces stale receipt and retains blockage until prepare', async () => {
  const f = await confirmedFixture();
  expect(blockage(f.confirmed)).toEqual(epochBlockage);
  expect(f.confirmed.workflow!.revision).toBe(f.readmitted.workflow!.revision + 1);
  expect(f.receipt.id).not.toBe(f.oldReceipt.id);
  expect(f.confirmed.workflow!.capabilityConfirmation).toEqual(f.receipt);
  expect(f.receipt.admissionRevision).toBe(f.readmitted.workflow!.capabilityAdmission!.revision);
  expect(f.receipt.adapterEpoch).toBe(f.currentEpoch());
  expect(isCapabilityConfirmationAuthorityValid(f.confirmed)).toBe(true);
  expect(f.confirmed.workflow!.prepared).toBeUndefined();
  await f.store.restore();
  expect(f.store.get(f.request.id)).toEqual(f.confirmed);
});

it('recovered prepare preserves candidate/plan/target/confirmation and creates no execution custody or port calls', async () => {
  const f = await confirmedFixture();
  const result = await f.coordinator.prepare(f.request.id, f.target), job = result.document;
  expect(job.candidates).toEqual(f.confirmed.candidates);
  expect(job.workflow!.selection).toEqual(f.confirmed.workflow!.selection);
  expect(job.workflow!.request).toEqual(f.confirmed.workflow!.request);
  expect(job.workflow!.requestHash).toBe(f.confirmed.workflow!.requestHash);
  expect(job.workflow!.sourceUsability).toEqual(f.confirmed.workflow!.sourceUsability);
  expect(job.workflow!.capabilities).toEqual(f.confirmed.workflow!.capabilities);
  expect(job.workflow!.capabilityAdmission).toEqual(f.confirmed.workflow!.capabilityAdmission);
  expect(job.workflow!.capabilityConfirmation).toEqual(f.receipt);
  expect(result.prepared.request.planId).toBe(job.candidates.find(row => row.id === job.workflow!.selection!.candidateId)!.plan.id);
  expect(result.prepared.request.timelineId).toBe(f.target.subjectId);
  expect(result.prepared.request.beforeEvidenceIds).toEqual([f.target.id]);
  expect(job.evidence).toEqual([...f.confirmed.evidence, f.target]);
  expect(job.checkpoints).toEqual([]);
  expect(job.operatorAuthorizations ?? []).toEqual([]);
  expect(f.ingestor.ingest).not.toHaveBeenCalled();
  expect(f.planner.plan).not.toHaveBeenCalled();
  const disk = JSON.parse(await fs.readFile(path.join(dir, 'state/video-editing-jobs.json'), 'utf8'));
  expect(disk.jobs[0]).toEqual(JSON.parse(JSON.stringify(job)));
  expect(Object.keys(disk).sort()).toEqual(['jobs', 'version']);
  expect((await fs.readdir(path.join(dir, 'state'))).sort()).toEqual(['video-editing-jobs.json']);
});

it('blockage clear and prepared publication are atomic with exactly one revision, including lost-response restore', async () => {
  const f = await confirmedFixture(), publications: VideoEditingDocument[] = [];
  const store = new VideoEditingStore({ write: async value => {
    publications.push(structuredClone(value.jobs[0]!));
    await writeStrictDurableNow('video-editing-jobs', value, VIDEO_DOCUMENT_MAX_BYTES);
    throw new Error('publication response lost');
  } });
  await store.restore();
  const coordinator = new VideoWorkflowCoordinator(store, { ingestor: f.ingestor,
    capabilities: f.confirmed.workflow!.capabilities, epoch: f.currentEpoch });
  await expect(coordinator.prepare(f.request.id, f.target)).rejects.toThrow('publication response lost');
  expect(publications).toHaveLength(1);
  const committed = publications[0]!;
  expect(committed.workflow!.revision).toBe(f.confirmed.workflow!.revision + 1);
  expect(blockage(committed)).toEqual({ phase: 'prepared', blockedAt: undefined, blockers: [] });
  expect(committed.workflow!.prepared).toBeDefined();
  await store.restore();
  expect(store.get(f.request.id)).toEqual(committed);
  const cold = new VideoEditingStore(); await cold.restore();
  expect(cold.get(f.request.id)).toEqual(committed);
  await coordinator.prepare(f.request.id, f.target);
  expect(publications).toHaveLength(1);
});

it('write failure before publication leaves durable blockage intact and restore cannot invent recovery', async () => {
  const f = await confirmedFixture();
  const store = new VideoEditingStore({ write: async () => { throw new Error('write denied'); } });
  await store.restore();
  const coordinator = new VideoWorkflowCoordinator(store, { ingestor: f.ingestor,
    capabilities: f.confirmed.workflow!.capabilities, epoch: f.currentEpoch });
  await expect(coordinator.prepare(f.request.id, f.target)).rejects.toThrow('write denied');
  await store.restore();
  expect(store.get(f.request.id)).toEqual(f.confirmed);
});

it('failed prepare updates truthful blockers and remains blocked without preparation or authority', async () => {
  const f = await confirmedFixture(); f.changeEpoch('synthetic-plugin:22');
  const result = await f.coordinator.prepare(f.request.id, f.target);
  expect(blockage(result.document)).toEqual(epochBlockage);
  expect(result.document.workflow!.revision).toBe(f.confirmed.workflow!.revision + 1);
  expect(result.document.workflow!.prepared).toBeUndefined();
  expect(result.prepared.state).toBe('blocked');
  expect(result.prepared.operations).toEqual([]);
  expect(result.document.workflow!.capabilityConfirmation).toEqual(f.receipt);
  expect(result.document.checkpoints).toEqual([]);
  expect(result.document.operatorAuthorizations ?? []).toEqual([]);
  await f.store.restore();
  expect(f.store.get(f.request.id)).toEqual(result.document);
});

it('prepare without fresh confirmation updates blockage fail closed', async () => {
  const f = await blockedFixture();
  await f.coordinator.readmitCapabilities(f.request.id, adapter(f.currentEpoch()));
  const result = await f.coordinator.prepare(f.request.id, f.target);
  expect(blockage(result.document)).toEqual({ phase: 'blocked', blockedAt: 'preparing',
    blockers: ['CAPABILITY_ADMISSION_OPERATOR_CONFIRMATION_REQUIRED'] });
  expect(result.document.workflow!.prepared).toBeUndefined();
  expect(result.prepared.operations).toEqual([]);
});

it.each(['blockedAt', 'blockers'] as const)('prepared state with stale %s stays invalid at validation and cold restore', async field => {
  const f = await confirmedFixture();
  const { document } = await f.coordinator.prepare(f.request.id, f.target);
  const invalid = structuredClone(document);
  if (field === 'blockedAt') invalid.workflow!.blockedAt = 'preparing';
  else invalid.workflow!.blockers = ['ADAPTER_EPOCH_CHANGED'];
  expect(() => validateDocument(invalid)).toThrow('Workflow blockage mismatch');
  await writeStrictDurableNow('video-editing-jobs', { version: 1, jobs: [invalid] }, VIDEO_DOCUMENT_MAX_BYTES);
  await expect(new VideoEditingStore().restore()).rejects.toThrow('Workflow blockage mismatch');
});

it('normal selected to prepared still publishes once and repeated prepare is idempotent', async () => {
  const normal = await setupWorkflow(dir);
  await normal.coordinator.request(normal.request); await normal.coordinator.ingest(normal.request.id);
  const planned = await normal.coordinator.plan(normal.request.id);
  const selected = await normal.coordinator.select(normal.request.id, planned.workflow!.comparison[0]!.candidateId, 'operator-ipc');
  const publication = vi.spyOn(normal.store, 'advanceWorkflow');
  const result = await normal.coordinator.prepare(normal.request.id, workflowTarget());
  expect(blockage(result.document)).toEqual({ phase: 'prepared', blockedAt: undefined, blockers: [] });
  expect(result.document.workflow!.revision).toBe(selected.workflow!.revision + 1);
  await normal.coordinator.prepare(normal.request.id, workflowTarget());
  expect(publication).toHaveBeenCalledOnce();
});
