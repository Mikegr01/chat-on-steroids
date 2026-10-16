import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { verifiedCapabilityReview } from './fixtures/video-capability-authentication.js';
import { initDurableStore, resetDurableForTests, writeStrictDurableNow } from '../src/main/durable.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import { sourceUsabilityFixture } from './fixtures/video-source-usability.js';
import { sourceUsabilityBinding } from '../src/main/video-editing/source-usability.js';
import { prepareExecution } from '../src/main/video-editing/execution.js';
import { produceTimeline } from '../src/main/video-editing/producers.js';
import { ResolveEvidenceReader } from '../src/main/video-editing/inspection.js';
import { timelinePage } from './fixtures/video-observation.js';
import { VideoEditingStore } from '../src/main/video-editing/store.js';
import { VideoWorkflowCoordinator } from '../src/main/video-editing/workflow.js';
import { operatorBinding } from '../src/main/video-editing/operator-authorization.js';
import { operatorAuthorizationSchema } from '../src/shared/video-operator.js';
import { createCapabilityAdmissionReceipt, capabilityAdmissionBlockers, effectiveSourceEnd } from '../src/main/video-editing/source-end-admission.js';
import { checkpointIntent } from '../src/main/video-editing/identity.js';
import { VIDEO_DOCUMENT_MAX_BYTES, type VideoEditingDocument } from '../src/shared/video-editing.js';

const boundary = vi.hoisted(() => ({ parent: null as any, session: null as any, page: null as any,
  epoch: 'curated:18', reads: [] as unknown[], hold: undefined as (() => Promise<void>) | undefined,
  readOnly: false, read: true, offline: false }));
// Reproduce historical custody without using a current authority issuer to bless it.
function historicalAuthorization(job: VideoEditingDocument) {
  const now = Date.now();
  return operatorAuthorizationSchema.parse({ ...operatorBinding(job), id: randomUUID(), kind: 'operator-explicit',
    provenance: 'operator-ipc', issuedAt: now, expiresAt: now + 600_000 });
}
vi.mock('../src/main/mcp/call-context.js', () => ({ currentCall: () => boundary.parent }));
vi.mock('../src/main/session/store.js', () => ({ getSession: async () => boundary.session }));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({ readOnly: boundary.readOnly, mediaRuntime: null }),
  effectiveCapabilities: () => ({ read: boundary.read }) }));
vi.mock('../src/main/app-identity.js', () => ({ resolveCustomUserData: () => dir }));
vi.mock('../src/main/video-editing/runtime-inspection.js', () => ({
  readAdmittedWorkflowEpoch: () => { if (boundary.offline) throw new Error('Adapter offline'); return boundary.epoch; },
  readAdmittedWorkflowAdapterInfo: () => ({ ready: true, epoch: boundary.epoch, sourceEnd: 'inclusive', guardVersion: 2, adapterVersion: '1.0.3' }),
  readAdmittedWorkflowCapabilities: () => ({ tools: ['resolve_inspect', 'resolve_assemble_rough_cut'], sourceEnd: 'inclusive', acceptance: 'unverified' }),
  createGuardedResolveReader: () => new ResolveEvidenceReader(async (name, args) => {
    if (name !== 'resolve_inspect' || args.selector !== 'timeline' || args.timeline_unique_id !== boundary.page.unique_id)
      throw new Error('Only exact read-only timeline inspection permitted');
    boundary.reads.push({ name, args }); await boundary.hold?.(); return structuredClone(boundary.page);
  }),
}));
import { videoAction, videoStore, resetVideoStoreForTests, videoActionSchema, confirmCapabilityAdmissionJob } from '../src/main/video-editing/service.js';

let dir: string;
beforeEach(async () => {
  dir = await makeTempDir('cos-legacy-prepared-'); initDurableStore(dir); resetVideoStoreForTests();
  boundary.epoch = 'curated:18'; boundary.reads = []; boundary.hold = undefined; boundary.readOnly = false; boundary.read = true; boundary.offline = false;
});
afterEach(async () => { resetVideoStoreForTests(); resetDurableForTests(); await removeTempDir(dir); });

/** Reproduce the legacy rev16 topology with synthetic owner/media identities and real derived hashes.
 * Never read/copy the live ledger. Old prepare compiled admission without a native receipt. */
async function legacyFixture() {
  const f = await sourceUsabilityFixture(dir, false, 'unknown');
  let job = await f.coordinator.plan(f.request.id);
  for (const asset of ['source-a', 'source-b']) job = await f.coordinator.setUsableRanges(job.id,
    { binding: sourceUsabilityBinding(job, asset), expectedRevision: job.workflow!.revision, ranges: [{ start: 0, end: 24 }] });
  await f.coordinator.select(job.id, job.candidates[0]!.id, 'operator-ipc');
  job = await f.coordinator.readmitCapabilities(job.id, { sourceEnd: 'inclusive', guardVersion: 2, adapterVersion: '1.0.3', epoch: boundary.epoch });
  const page: any = timelinePage();
  Object.assign(page, { adapter_version: '1.0.3', project_name: 'Synthetic recovery project', rough_cut_guard_version: 2,
    source_end: 'inclusive', items: [], total: 0, duration_frames: 0, project_unique_id: job.resolveProjectId });
  boundary.page = page;
  const target = produceTimeline([page], { id: 'legacy-before', subjectId: page.unique_id, observedAt: 100 }).evidence;
  job.evidence.push(target); job.workflow!.revision = 16; job.workflow!.capabilityAdmission!.revision = 15;
  const compiled = prepareExecution(job, { planId: job.candidates[0]!.plan.id, timelineId: target.subjectId,
    beforeEvidenceIds: [target.id], operationId: '00000000-0000-4000-8000-000000000016' }, { ...job.workflow!.capabilities, sourceEnd: 'inclusive' });
  expect(compiled.state).toBe('ready');
  job.workflow!.phase = 'prepared';
  job.workflow!.prepared = { request: compiled.request, capabilities: compiled.capabilities,
    preparedHash: compiled.preparedHash, intentHash: compiled.intentHash };
  await seed(job);
  boundary.parent = { caller: { sessionId: job.sessionId, conversationId: 'successor-B' } };
  boundary.session = { id: job.sessionId, conversationId: 'successor-B', chatIds: ['retired-A', 'successor-B'] };
  return { ...f, job, target, compiled };
}
async function seed(job: VideoEditingDocument) { await writeStrictDurableNow('video-editing-jobs', { version: 1, jobs: [job] }, VIDEO_DOCUMENT_MAX_BYTES); resetVideoStoreForTests(); }
function action(job: VideoEditingDocument) { return { action: 'recover-legacy-prepared', jobId: job.id, expectedRevision: 16,
  preparedHash: job.workflow!.prepared!.preparedHash, operationId: job.workflow!.prepared!.request.operationId }; }
const noConfirm = async () => { throw new Error('Recovery must not native-confirm or authorize'); };
function sameFacts(before: VideoEditingDocument, after: VideoEditingDocument) {
  const strip = (job: VideoEditingDocument) => { const copy: any = structuredClone(job);
    for (const key of ['phase', 'revision', 'prepared', 'legacyPreparedRecovery']) delete copy.workflow[key]; return copy; };
  expect(strip(after)).toEqual(strip(before));
}

it('recovers the rev16 legacy deadlock forward to rev17 while preserving every other accepted fact and receipt requirement', async () => {
  const f = await legacyFixture();
  const result: any = await videoAction(action(f.job), noConfirm);
  expect(result.status).toBe('recovered');
  expect(result.job.workflow).toMatchObject({ phase: 'selected', revision: 17 });
  expect(result.job.workflow.prepared).toBeUndefined(); sameFacts(f.job, result.job);
  expect(effectiveSourceEnd(result.job)).toBe('unknown');
  expect(capabilityAdmissionBlockers(result.job)).toEqual(['CAPABILITY_ADMISSION_OPERATOR_CONFIRMATION_REQUIRED']);
  expect(result.job.workflow.capabilityConfirmation).toBeUndefined();
  expect(result.job.operatorAuthorizations).toBeUndefined(); expect(result.job.checkpoints).toEqual([]);
  expect(boundary.reads).toHaveLength(1);
  expect(result.recovery).toMatchObject({ kind: 'legacy-capability-confirmation', jobId: f.job.id, sessionId: f.job.sessionId,
    conversationId: 'successor-B', localProjectId: null, priorRevision: 16, revision: 17, invalidatedPrepared: f.job.workflow!.prepared,
    verifiedTarget: { adapterDispatch: { snapshotSha256: 'd'.repeat(64), guardVersion: 2 } } });
  const restarted = new VideoEditingStore(); await restarted.restore(); expect(restarted.get(f.job.id)).toEqual(result.job);
  const replay: any = await videoAction(action(f.job), noConfirm);
  expect(replay.status).toBe('already-recovered'); expect(replay.job).toEqual(result.job); expect(replay.recovery).toEqual(result.recovery);
  resetVideoStoreForTests(); expect((await videoAction(action(f.job), noConfirm) as any).status).toBe('already-recovered');
  expect(boundary.reads).toHaveLength(1);
});
it('keeps the exact rev16 -> 17 -> native receipt 18 -> fresh preparation 19 lifecycle and inclusive source translation', async () => {
  const f = await legacyFixture(); const recovered: any = await videoAction(action(f.job), noConfirm);
  const confirmed: any = await confirmCapabilityAdmissionJob(f.job.id, recovered.job.workflow.capabilityAdmission.capabilityFingerprint, verifiedCapabilityReview);
  expect(confirmed.job.workflow.revision).toBe(18); expect(effectiveSourceEnd(confirmed.job)).toBe('inclusive');
  const store = await videoStore();
  const coordinator = new VideoWorkflowCoordinator(store, { ingestor: f.ingestor, capabilities: f.job.workflow!.capabilities, epoch: () => boundary.epoch });
  const fresh = { ...f.target, id: 'fresh-before', observedAt: Date.now() };
  const prepared = await coordinator.prepare(f.job.id, fresh);
  expect(prepared.document.workflow!.revision).toBe(19); expect(prepared.document.workflow!.phase).toBe('prepared');
  expect(prepared.prepared.request.operationId).not.toBe(f.compiled.request.operationId);
  expect(prepared.prepared.preparedHash).not.toBe(f.compiled.preparedHash);
  expect(prepared.prepared.operations[0]!.arguments.segments.map(row => [row.start_frame, row.end_frame, row.record_frame])).toEqual([[0, 23, 86400], [0, 23, 86424]]);
  expect(prepared.document.checkpoints).toEqual([]); expect(boundary.page.items).toEqual([]); expect(boundary.reads).toHaveLength(1);
  const restarted = new VideoEditingStore(); await restarted.restore(); expect(restarted.get(f.job.id)).toEqual(prepared.document);
});
it('fresh preparation before native receipt still reports the precise blocker', async () => {
  const f = await legacyFixture(); await videoAction(action(f.job), noConfirm);
  const coordinator = new VideoWorkflowCoordinator(await videoStore(), { ingestor: f.ingestor, capabilities: f.job.workflow!.capabilities });
  const result = await coordinator.prepare(f.job.id, { ...f.target, id: 'blocked-before' });
  expect(result.document.workflow!.blockers).toEqual(['CAPABILITY_ADMISSION_OPERATOR_CONFIRMATION_REQUIRED']);
  expect(result.document.workflow!.prepared).toBeUndefined(); expect(result.prepared.operations).toEqual([]);
});
it('returns exact durable replay after restart even if the adapter is offline, without another inspection', async () => {
  const f = await legacyFixture(); const result: any = await videoAction(action(f.job), noConfirm);
  resetVideoStoreForTests(); boundary.offline = true;
  const replay: any = await videoAction(action(f.job), noConfirm);
  expect(replay.status).toBe('already-recovered'); expect(replay.job).toEqual(result.job); expect(boundary.reads).toHaveLength(1);
});
it.each(['expectedRevision', 'preparedHash', 'operationId'] as const)('rejects wrong %s before and after recovery', async key => {
  const f = await legacyFixture(); const wrong: any = { ...action(f.job), [key]: key === 'expectedRevision' ? 15 : key === 'operationId' ? randomUUID() : '0'.repeat(64) };
  await expect(videoAction(wrong, noConfirm)).rejects.toThrow(); expect((await videoStore()).get(f.job.id)).toEqual(f.job);
  await videoAction(action(f.job), noConfirm); await expect(videoAction(wrong, noConfirm)).rejects.toThrow();
  expect((await videoStore()).get(f.job.id)!.workflow!.revision).toBe(17);
});
it.each(['session', 'project', 'conversation', 'readOnly', 'read'])('rejects wrong/revoked %s without reading or changing the job', async kind => {
  const f = await legacyFixture();
  if (kind === 'session') { boundary.parent.caller.sessionId = 'foreign'; boundary.session.id = 'foreign'; }
  if (kind === 'project') boundary.session.projectId = 'foreign';
  if (kind === 'conversation') boundary.parent.caller.conversationId = 'retired-A';
  if (kind === 'readOnly') boundary.readOnly = true;
  if (kind === 'read') boundary.read = false;
  await expect(videoAction(action(f.job), noConfirm)).rejects.toThrow();
  expect(boundary.reads).toEqual([]); expect((await videoStore()).get(f.job.id)).toEqual(f.job);
});
it.each(['snapshot', 'incomplete', 'unowned', 'guard', 'project', 'items', 'duration', 'start', 'fps', 'identity', 'offline'])('rejects target %s drift without invalidation', async kind => {
  const f = await legacyFixture();
  if (kind === 'snapshot') boundary.page.snapshot_sha256 = '0'.repeat(64);
  if (kind === 'incomplete') boundary.page.complete = false;
  if (kind === 'unowned') boundary.page.ownership.status = 'UNOWNED';
  if (kind === 'guard') boundary.page.rough_cut_guard_version = 1;
  if (kind === 'project') boundary.page.project_unique_id = 'foreign';
  if (kind === 'items') { boundary.page.items = timelinePage().items; boundary.page.total = 1; boundary.page.duration_frames = 240; }
  if (kind === 'duration') boundary.page.duration_frames = 1;
  if (kind === 'start') boundary.page.start_frame++;
  if (kind === 'fps') boundary.page.fps = 30;
  if (kind === 'identity') boundary.page.unique_id = 'foreign';
  if (kind === 'offline') boundary.hold = async () => { throw new Error('Adapter offline'); };
  await expect(videoAction(action(f.job), noConfirm)).rejects.toThrow(/LEGACY_RECOVERY_TARGET/);
  expect((await videoStore()).get(f.job.id)).toEqual(f.job);
});
it.each(['confirmation', 'admission', 'modern', 'authority', 'claimed', 'consumed', 'receipt', 'ambiguous', 'reconciled', 'terminal', 'phase'])('refuses %s durable state without inspection', async kind => {
  const f = await legacyFixture(), job = structuredClone(f.job), state = job.workflow!;
  if (kind === 'confirmation') state.capabilityConfirmation = createCapabilityAdmissionReceipt({ ...job,
    workflow: { ...state, phase: 'selected', prepared: undefined } }, 'operator-ipc');
  if (kind === 'admission') delete state.capabilityAdmission;
  if (kind === 'modern') state.capabilities.sourceEnd = 'inclusive';
  if (kind === 'authority' || kind === 'consumed') { const auth = historicalAuthorization(job);
    if (kind === 'consumed') auth.consumedAt = Date.now(); job.operatorAuthorizations = [auth]; }
  if (['claimed', 'receipt', 'ambiguous', 'reconciled', 'terminal'].includes(kind)) {
    const checkpoint = checkpointIntent(job, state.prepared!.request.planId, f.target.subjectId, 'assemble', [f.target.id], f.compiled.request.operationId);
    if (kind === 'receipt') checkpoint.receipt = { status: 'acknowledged' };
    if (kind === 'ambiguous') checkpoint.state = 'ambiguous';
    if (kind === 'reconciled') { checkpoint.state = 'ambiguous'; checkpoint.outcome = 'DEVIATED'; }
    if (kind === 'terminal') { checkpoint.state = 'ambiguous'; checkpoint.outcome = 'FAILED_CONFIRMED'; }
    job.checkpoints.push(checkpoint);
  }
  if (kind === 'phase') state.phase = 'selected';
  await seed(job); await expect(videoAction(action(f.job), noConfirm)).rejects.toThrow(/LEGACY_RECOVERY/);
  expect((await videoStore()).get(job.id)).toEqual(job); expect(boundary.reads).toEqual([]);
});
it.each(['legacy', 'noExecution', 'confirmation', 'snapshot', 'sourceEnd', 'authority'])('refuses caller-forged %s predicate in strict service schema', async field => {
  const f = await legacyFixture(); expect(videoActionSchema.safeParse({ ...action(f.job), [field]: true }).success).toBe(false);
});
it('serializes double recovery with one audit and one target read', async () => {
  const f = await legacyFixture();
  const results: any[] = await Promise.all([videoAction(action(f.job), noConfirm), videoAction(action(f.job), noConfirm)]);
  expect(results.map(row => row.status).sort()).toEqual(['already-recovered', 'recovered']); expect(boundary.reads).toHaveLength(1);
  expect(results[0].recovery.id).toBe(results[1].recovery.id);
});
it('retains the historical recovery audit when a changed adapter needs normal readmission', async () => {
  const f = await legacyFixture(); const result: any = await videoAction(action(f.job), noConfirm);
  boundary.epoch = 'curated:19';
  const readmitted: any = await videoAction({ action: 'readmit-source-end', jobId: f.job.id, expectedRevision: 17 }, noConfirm);
  expect(readmitted.job.workflow.revision).toBe(18); expect(readmitted.job.workflow.legacyPreparedRecovery).toEqual(result.recovery);
  const restarted = new VideoEditingStore(); await restarted.restore();
  expect(restarted.get(f.job.id)!.workflow!.capabilityAdmission!.adapterEpoch).toBe('curated:19');
});
it('validates recovery history against its original evidence after later output samples are admitted', async () => {
  const f = await legacyFixture(); const recovered: any = await videoAction(action(f.job), noConfirm);
  const confirmed: any = await confirmCapabilityAdmissionJob(f.job.id, recovered.job.workflow.capabilityAdmission.capabilityFingerprint, verifiedCapabilityReview);
  const job = structuredClone(confirmed.job);
  job.evidence.push({ id: 'later-render', subject: 'render', subjectId: 'render-later', basis: 'measured',
    producer: { name: 'cos-resolve-render-artifact', version: '1' }, observedAt: Date.now(), confidence: 1, parents: [],
    locator: { path: 'synthetic-render.mov', sha256: 'e'.repeat(64), bytes: 1 } },
  { id: 'later-sample', subject: 'frame', subjectId: 'render-later', basis: 'measured',
    producer: { name: 'ffmpeg', version: '8.1' }, observedAt: Date.now(), confidence: 1, parents: [],
    locator: { path: 'synthetic-sample.png', sha256: 'f'.repeat(64), bytes: 1 },
    mediaSample: { sourceHash: 'e'.repeat(64), requestedFrame: 0, position: 'UNVERIFIED', executableHash: 'a'.repeat(64), decodeSha256: 'b'.repeat(64) } });
  const saved = await (await videoStore()).put(job);
  const restarted = new VideoEditingStore(); await restarted.restore(); expect(restarted.get(job.id)).toEqual(saved);
  expect(saved.workflow!.legacyPreparedRecovery).toEqual(recovered.recovery);
});
it.each(['authority', 'claim', 'prepare'])('rejects stale %s queued across recovery publication', async kind => {
  const f = await legacyFixture(), store = await videoStore();
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  boundary.hold = () => { entered(); return new Promise<void>(resolve => { release = resolve; }); };
  const recovery = videoAction(action(f.job), noConfirm); await waiting;
  const stale = kind === 'authority' ? store.issueOperatorAuthorization(historicalAuthorization(f.job)) :
    kind === 'claim' ? store.claim({ jobId: f.job.id, ...f.compiled.request, step: 'assemble' }) :
      store.advanceWorkflow({ ...f.job, workflow: { ...f.job.workflow!, revision: 17 } }, 16);
  const rejected = expect(stale).rejects.toThrow(); release(); await recovery; await rejected;
  const job = store.get(f.job.id)!; expect(job.workflow!.revision).toBe(17); expect(job.workflow!.prepared).toBeUndefined();
  expect(job.checkpoints).toEqual([]); expect(job.operatorAuthorizations).toBeUndefined();
});
it('refuses stale disk publication, then recognizes an exact recovery committed by another restored store', async () => {
  const f = await legacyFixture(), stale = new VideoEditingStore(); await stale.restore();
  const result: any = await videoAction(action(f.job), noConfirm);
  await expect(stale.recoverLegacyPrepared(f.job.id, { expectedRevision: 16, preparedHash: f.compiled.preparedHash,
    operationId: f.compiled.request.operationId }, { sessionId: f.job.sessionId, localProjectId: null, conversationId: 'successor-B' },
    async () => ({ ...f.target, id: 'fresh', observedAt: Date.now() }), async () => {})).rejects.toThrow(/snapshot changed/);
  await stale.restore(); expect(stale.get(f.job.id)).toEqual(result.job);
});
it.each(['before-write', 'after-write'])('restores truthful recovery custody after %s publication failure', async failure => {
  const f = await legacyFixture(); let disk: any = { version: 1, jobs: [f.job] };
  const store = new VideoEditingStore({ read: async () => ({ kind: 'valid', value: structuredClone(disk) }),
    write: async value => { if (failure === 'after-write') disk = structuredClone(value); throw new Error('Disk publication failed'); } });
  await store.restore();
  await expect(store.recoverLegacyPrepared(f.job.id, { expectedRevision: 16, preparedHash: f.compiled.preparedHash,
    operationId: f.compiled.request.operationId }, { sessionId: f.job.sessionId, localProjectId: null, conversationId: 'successor-B' },
    async () => ({ ...f.target, id: 'fresh', observedAt: Date.now() }), async () => {})).rejects.toThrow('Disk publication failed');
  expect(store.get(f.job.id)).toEqual(f.job); await store.restore();
  expect(store.get(f.job.id)!.workflow!.revision).toBe(failure === 'after-write' ? 17 : 16);
  expect(store.get(f.job.id)!.checkpoints).toEqual([]);
});
it.each(['hash', 'revision', 'target', 'owner', 'operation'])('refuses tampered %s recovery audit on cold restore', async kind => {
  const f = await legacyFixture(); const result: any = await videoAction(action(f.job), noConfirm);
  const job = structuredClone(result.job), audit = job.workflow.legacyPreparedRecovery;
  if (kind === 'hash') audit.invalidatedPrepared.preparedHash = '0'.repeat(64);
  if (kind === 'revision') audit.revision = 16;
  if (kind === 'target') audit.verifiedTarget.adapterDispatch.snapshotSha256 = '0'.repeat(64);
  if (kind === 'owner') audit.sessionId = 'foreign';
  if (kind === 'operation') audit.invalidatedPrepared.request.operationId = randomUUID();
  await seed(job); await expect(new VideoEditingStore().restore()).rejects.toThrow(/LEGACY_RECOVERY/);
});
it.each(['owner', 'adapter', 'permission'])('fences %s changed while a read is pending', async kind => {
  const f = await legacyFixture(); let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  boundary.hold = () => { entered(); return new Promise<void>(resolve => { release = resolve; }); };
  const result = videoAction(action(f.job), noConfirm); await waiting;
  if (kind === 'owner') boundary.session.lastCommittedResumeHandoffId = 'new-owner-epoch';
  if (kind === 'adapter') boundary.epoch = 'curated:19';
  if (kind === 'permission') boundary.read = false;
  release(); await expect(result).rejects.toThrow(/changed/); expect((await videoStore()).get(f.job.id)).toEqual(f.job);
});
it('does not permit generic workflow/put invalidation, audit injection or reuse of the invalidated operation', async () => {
  const f = await legacyFixture(); const store = await videoStore(); const arbitrary = structuredClone(f.job);
  delete arbitrary.workflow!.prepared; arbitrary.workflow!.phase = 'selected'; arbitrary.workflow!.revision = 17;
  await expect(store.advanceWorkflow(arbitrary, 16)).rejects.toThrow(); await expect(store.put(arbitrary)).rejects.toThrow();
  const recovered: any = await videoAction(action(f.job), noConfirm);
  await expect(store.claim({ jobId: f.job.id, ...f.compiled.request, step: 'assemble' })).rejects.toThrow(/invalidated/i);
  const changed = structuredClone(recovered.job); changed.workflow.legacyPreparedRecovery.id = randomUUID();
  await expect(store.put(changed)).rejects.toThrow();
});
