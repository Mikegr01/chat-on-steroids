import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readStrictDurable, writeStrictDurableNow, type StrictDurableRead } from '../durable.js';
import { videoEditingDocumentSchema, videoIdSchema, executionCheckpointSchema, VIDEO_DOCUMENT_MAX_BYTES,
  type VideoEditingDocument, type ExecutionCheckpoint,videoEvidenceSchema } from '../../shared/video-editing.js';
import { canonicalJson, checkpointIntent } from './identity.js';
import { checkpointEvidenceBlockers, evidenceFor, sameRate, unique, validateDocument, validatePlan } from './validation.js';
import { evaluateRevision } from './revision.js';
import { preserveWorkflow, preserveSourceUsability, preserveCapabilityAdmission, preserveCapabilityConfirmation, validateWorkflowDerived } from './workflow-state.js';
import { operatorAuthorizationSchema, type OperatorAuthorization } from '../../shared/video-operator.js';
import { fingerprint } from './workflow-planning.js';
import { preparedWorkflow } from './workflow-preview.js';
import { verifyExecution } from './execution.js';
import { assertOperatorBinding } from './operator-authorization.js';
import { validateSourceUsabilityInput } from './source-usability.js';
import { validateCapabilityAdmissionInput, assertCapabilityConfirmationMutable, isCapabilityConfirmationAuthorityValid, capabilityAdmissionBlockers } from './source-end-admission.js';
import { compareWorkCandidates } from './workflow-planning.js';
import { legacyPreparedRecoveryInputSchema,
  type SourceUsabilityDecision, type CapabilityAdmissionReceipt } from '../../shared/video-editing.js';
import { assertLegacyPreparedEligible, assertLegacyRecoveryExpectation, assertLegacyRecoveryTarget, preserveLegacyPreparedRecovery } from './legacy-prepared-recovery.js';

const STATE_NAME = 'video-editing-jobs';
const ledgerSchema = z.object({ version: z.literal(1), jobs: z.array(videoEditingDocumentSchema).max(20) }).strict();
type Ledger = z.infer<typeof ledgerSchema>;
interface StoreOptions { read?: () => Promise<StrictDurableRead>; write?: (value: Ledger, assertOwner?: () => Promise<void>) => Promise<void> }
const claimSchema = z.object({ jobId: videoIdSchema, planId: videoIdSchema, timelineId: videoIdSchema,
  step: z.enum(['assemble', 'render']), beforeEvidenceIds: z.array(videoIdSchema).min(1).max(100),
  operationId: z.string().uuid().optional() }).strict();

function validateLedger(raw: unknown): Ledger {
  const ledger = ledgerSchema.parse(raw);
  if (Buffer.byteLength(canonicalJson(ledger)) > VIDEO_DOCUMENT_MAX_BYTES) throw new Error('Video custody byte limit');
  unique(ledger.jobs.map(row => row.id), 'job identities');
  unique(ledger.jobs.flatMap(row => row.checkpoints.map(value => value.operationId)), 'operation identities across jobs');
  unique(ledger.jobs.flatMap(row => row.checkpoints.filter(value => value.step === 'assemble')
    .map(value => canonicalJson([value.resolveProjectId, value.timelineId]))), 'consumed assembly targets');
  unique(ledger.jobs.flatMap(job=>(job.operatorAuthorizations ?? []).map(row=>row.id)), 'global operator authorizations');
  const invalidated = ledger.jobs.flatMap(job => job.workflow?.legacyPreparedRecovery
    ? [job.workflow.legacyPreparedRecovery.invalidatedPrepared.request.operationId] : []);
  unique(invalidated, 'invalidated legacy operations');
  if (ledger.jobs.some(job => job.checkpoints.some(row => invalidated.includes(row.operationId))))
    throw new Error('Invalidated legacy operation cannot acquire execution custody');
  for (const job of ledger.jobs) {
    validateDocument(job);
    validateWorkflowDerived(job);
    unique((job.operatorAuthorizations ?? []).map(row => row.id), 'operator authorizations');
    for (const authorization of job.operatorAuthorizations ?? []) assertOperatorBinding(job, authorization);
    for (const checkpoint of job.checkpoints) {
      if (checkpoint.operatorBinding) {
        const authority=job.operatorAuthorizations?.find(row=>row.id===checkpoint.operatorBinding!.authorizationId),prepared=preparedWorkflow(job);
        if (!authority || authority.consumedAt!==checkpoint.operatorBinding.claimedAt ||
          authority.preparedHash!==checkpoint.operatorBinding.preparedHash || authority.operationHash!==checkpoint.operatorBinding.operationHash ||
          authority.targetHash!==checkpoint.operatorBinding.targetHash || authority.planId!==checkpoint.planId || authority.timelineId!==checkpoint.timelineId ||
          prepared.request.operationId!==checkpoint.operationId || checkpoint.intentHash!==prepared.intentHash || checkpoint.step!=='assemble' ||
          canonicalJson(checkpoint.beforeEvidenceIds)!==canonicalJson(prepared.request.beforeEvidenceIds)) throw new Error('Operator claim/consumption join invalid');
        const fresh=job.evidence.find(row=>row.id===checkpoint.operatorBinding!.preflightEvidenceId),before=job.evidence.find(row=>row.id===prepared.request.beforeEvidenceIds[0])!;
        if(!fresh || fresh.basis!=='measured' || fresh.subject!=='timeline' || fresh.subjectId!==checkpoint.timelineId ||
          fresh.acquisition?.tool!=='resolve_inspect' || !fresh.acquisition.rawSha256 || !fresh.timelineState?.complete ||
          fresh.observedAt<=before.observedAt || fingerprint(fresh.timelineState)!==authority.targetHash ||
          fresh.adapterDispatch?.snapshotSha256!==checkpoint.operatorBinding.snapshotSha256)throw new Error('Fresh operator claim observation join invalid');
        if(checkpoint.state==='verified'&&checkpoint.afterEvidenceIds.some(id=>job.evidence.find(row=>row.id===id)!.observedAt<=fresh.observedAt))throw new Error('Operator post-state must follow fresh pre-state');
        if (checkpoint.outcome==='VERIFIED' && checkpoint.state!=='verified' || checkpoint.state==='verified' && checkpoint.outcome!=='VERIFIED') throw new Error('Operator outcome/state mismatch');
      }
      if (checkpoint.state === 'verified' && checkpointEvidenceBlockers(job, checkpoint).length)
        throw new Error('Execution verification requires complete matching measured state');
    }
    for (const revision of job.revisions) if (!evaluateRevision(job, revision.id).ready) throw new Error('Revision not actionable');
  }
  return ledger;
}

function preserveRows(before: Array<{ id?: string; operationId?: string }>, after: Array<{ id?: string; operationId?: string }>): void {
  for (const row of before) {
    const next = after.find(value => row.id ? value.id === row.id : value.operationId === row.operationId);
    if (!next || canonicalJson(next) !== canonicalJson(row)) throw new Error('Admitted artifacts and custody are immutable');
  }
}

/** One explicit owner, no timer, dispatcher, automatic replay or runtime startup registration. */
export class VideoEditingStore {
  private ledger: Ledger = { version: 1, jobs: [] };
  private healthy = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: StoreOptions = {}) {}
  private read() { return this.options.read?.() ?? readStrictDurable(STATE_NAME, VIDEO_DOCUMENT_MAX_BYTES); }
  private write(value: Ledger, assertOwner?: () => Promise<void>) {
    return this.options.write?.(value, assertOwner) ?? writeStrictDurableNow(STATE_NAME, value, VIDEO_DOCUMENT_MAX_BYTES, assertOwner);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work); this.queue = result.catch(() => undefined); return result;
  }
  private available(): void { if (!this.healthy) throw new Error('Video custody unavailable; restore required'); }
  private job(id: string): VideoEditingDocument {
    const job = this.ledger.jobs.find(row => row.id === id);
    if (!job) throw new Error('Unknown video job');
    return job;
  }
  private async publish(next: Ledger, assertOwner?: () => Promise<void>): Promise<void> {
    this.available(); validateLedger(next);
    try {
      const disk = await this.read();
      const current = disk.kind === 'absent' && this.ledger.jobs.length === 0 ? { version: 1, jobs: [] } :
        disk.kind === 'valid' ? validateLedger(disk.value) : null;
      if (!current || canonicalJson(current) !== canonicalJson(this.ledger)) throw new Error('Video custody snapshot changed or unreadable');
      await assertOwner?.();
      await this.write(structuredClone(next), assertOwner);
      this.ledger = structuredClone(next);
    } catch (error) {
      // A writer may fail after publication. Re-read custody before admitting more work.
      this.healthy = false;
      throw error;
    }
  }
  async restore(): Promise<void> {
    await this.serial(async () => {
      this.healthy = false;
      const read = await this.read();
      let next: Ledger;
      if (read.kind === 'absent') {
        if (this.ledger.jobs.length) throw new Error('Known video custody is missing');
        next = { version: 1, jobs: [] };
      } else if (read.kind === 'valid') next = validateLedger(read.value);
      else throw new Error('Video custody unreadable');
      for (const old of this.ledger.jobs) {
        const job = next.jobs.find(row => row.id === old.id);
        if (!job) throw new Error('Known video job custody is immutable');
        if (canonicalJson({ workflow: old.workflow }) !== canonicalJson({ workflow: job.workflow })) {
          if (canonicalJson(old.workflow?.legacyPreparedRecovery ?? null) !== canonicalJson(job.workflow?.legacyPreparedRecovery ?? null)) preserveLegacyPreparedRecovery(old, job);
          else if (canonicalJson(old.workflow?.sourceUsability ?? []) !== canonicalJson(job.workflow?.sourceUsability ?? [])) preserveSourceUsability(old, job);
          else if (canonicalJson(old.workflow?.capabilityAdmission ?? null) !== canonicalJson(job.workflow?.capabilityAdmission ?? null)) preserveCapabilityAdmission(old, job);
          else if (canonicalJson(old.workflow?.capabilityConfirmation ?? null) !== canonicalJson(job.workflow?.capabilityConfirmation ?? null)) preserveCapabilityConfirmation(old, job);
          else preserveWorkflow(old, job, true);
        }
        for (const authorization of old.operatorAuthorizations ?? []) {
          const restored = job.operatorAuthorizations?.find(row => row.id === authorization.id);
          if (!restored || canonicalJson({ ...restored, consumedAt: authorization.consumedAt }) !== canonicalJson(authorization) ||
            authorization.consumedAt !== undefined && restored.consumedAt !== authorization.consumedAt) throw new Error('Operator custody regressed');
        }
        for (const key of ['nativeExecutionEligible', 'sessionId', 'localProjectId', 'resolveProjectId', 'objective', 'maxRevisions'] as const)
          if (job[key] !== old[key]) throw new Error('Known video job identity is immutable');
        for (const key of ['evidence', 'references', 'media', 'candidates', 'reviews', 'revisions'] as const) preserveRows(old[key], job[key]);
        for (const checkpoint of old.checkpoints) {
          const restored = job.checkpoints.find(row => row.operationId === checkpoint.operationId);
          if (!restored || canonicalJson({ ...restored, state: checkpoint.state, afterEvidenceIds: checkpoint.afterEvidenceIds,
              receipt: checkpoint.receipt }) !== canonicalJson(checkpoint) ||
            (checkpoint.receipt && (!restored.receipt || canonicalJson(restored.receipt) !== canonicalJson(checkpoint.receipt))) ||
            (checkpoint.state !== 'claimed' && canonicalJson(restored) !== canonicalJson(checkpoint)))
            throw new Error('Known consumed custody is immutable');
        }
      }
      this.ledger = next;
      this.healthy = true;
    });
  }
  get(id: string): VideoEditingDocument | undefined {
    const job = this.ledger.jobs.find(row => row.id === id);
    return job ? structuredClone(job) : undefined;
  }
  async put(raw: unknown): Promise<VideoEditingDocument> {
    const job = videoEditingDocumentSchema.parse(raw); // Freeze before joining an async queue.
    return this.serial(async () => {
      this.available();
      const old = this.ledger.jobs.find(row => row.id === job.id);
      if (old) {
        if (canonicalJson(old.operatorAuthorizations ?? []) !== canonicalJson(job.operatorAuthorizations ?? [])) throw new Error('Operator custody requires its owner');
        preserveWorkflow(old, job, false);
        for (const key of ['nativeExecutionEligible', 'sessionId', 'localProjectId', 'resolveProjectId', 'objective', 'maxRevisions'] as const)
          if (job[key] !== old[key]) throw new Error('Video job identity/brief is immutable');
        for (const key of ['evidence', 'references', 'media', 'candidates', 'reviews', 'revisions', 'checkpoints'] as const)
          preserveRows(old[key], job[key]);
        if (job.checkpoints.length !== old.checkpoints.length) throw new Error('Checkpoint creation requires durable claim');
      } else {
        if (job.operatorAuthorizations?.length) throw new Error('New operator custody requires its owner');
        if (job.checkpoints.length) throw new Error('Checkpoint creation requires durable claim');
        if (job.workflow && (job.workflow.phase !== 'requested' || job.workflow.revision !== 0 || job.workflow.sourceUsability?.length || job.evidence.length || job.candidates.length || job.media.length || job.references.length)) throw new Error('New workflow starts requested and empty');
      }
      const next = { version: 1 as const, jobs: old ? this.ledger.jobs.map(row => row.id === job.id ? job : row) : [...this.ledger.jobs, job] };
      if (canonicalJson(next) !== canonicalJson(this.ledger)) await this.publish(next);
      return structuredClone(job);
    });
  }
  /** The same serialized ledger owns workflow transitions and operation custody. */
  async advanceWorkflow(raw: unknown, expectedRevision: number): Promise<VideoEditingDocument> {
    const captured = videoEditingDocumentSchema.parse(raw);
    return this.serial(async () => {
      this.available(); const old = this.job(captured.id);
      if (old.workflow?.revision !== expectedRevision) throw new Error('Workflow owner/revision changed');
      for (const key of ['nativeExecutionEligible', 'sessionId', 'localProjectId', 'resolveProjectId', 'objective', 'maxRevisions'] as const)
        if (captured[key] !== old[key]) throw new Error('Work identity immutable');
      preserveWorkflow(old, captured, true);
      if (canonicalJson(old.operatorAuthorizations ?? []) !== canonicalJson(captured.operatorAuthorizations ?? [])) throw new Error('Workflow cannot change operator custody');
      for (const key of ['evidence', 'references', 'media', 'candidates', 'reviews', 'revisions', 'checkpoints'] as const) preserveRows(old[key], captured[key]);
      if (captured.checkpoints.length !== old.checkpoints.length) throw new Error('Workflow cannot create execution custody');
      await this.publish({ version: 1, jobs: this.ledger.jobs.map(row => row.id === old.id ? captured : row) });
      return structuredClone(captured);
    });
  }
  consumedTarget(projectId: string, timelineId: string): ExecutionCheckpoint[] {
    this.available(); return structuredClone(this.ledger.jobs.flatMap(job => job.checkpoints.filter(row =>
      row.resolveProjectId === projectId && row.timelineId === timelineId && row.step === 'assemble')));
  }
  /** One forward-only compatibility commit. Read acquisition stays inside the existing custody
   * queue so authority, claims, preparation and double recovery cannot cross its publication. */
  async recoverLegacyPrepared(jobId: string, raw: unknown,
    owner: { sessionId: string; localProjectId: string | null; conversationId: string },
    inspect: (timelineId: string) => Promise<unknown>, assertOwner: () => Promise<void>) {
    const input = legacyPreparedRecoveryInputSchema.parse(raw), caller = structuredClone(owner);
    return this.serial(async () => {
      this.available(); const job = this.job(jobId), state = job.workflow;
      await assertOwner();
      if (job.sessionId !== caller.sessionId || job.localProjectId !== caller.localProjectId || !caller.conversationId)
        throw new Error('LEGACY_RECOVERY_OWNER_CHANGED');
      const prior = state?.legacyPreparedRecovery;
      if (prior) {
        if (input.expectedRevision !== prior.priorRevision || input.preparedHash !== prior.invalidatedPrepared.preparedHash ||
          input.operationId !== prior.invalidatedPrepared.request.operationId) throw new Error('LEGACY_RECOVERY_REPLAY_CONFLICT');
        return { status: 'already-recovered' as const, job: structuredClone(job), recovery: structuredClone(prior) };
      }
      assertLegacyPreparedEligible(job); assertLegacyRecoveryExpectation(job, input);
      const timelineId = state!.prepared!.request.timelineId;
      if (this.consumedTarget(job.resolveProjectId, timelineId).length) throw new Error('LEGACY_RECOVERY_TARGET_CONSUMED');
      const fresh = videoEvidenceSchema.parse(await inspect(timelineId));
      await assertOwner(); assertLegacyRecoveryTarget(job, fresh);
      const recovery = { id: randomUUID(), kind: 'legacy-capability-confirmation' as const,
        jobId, sessionId: job.sessionId, localProjectId: job.localProjectId, resolveProjectId: job.resolveProjectId,
        conversationId: caller.conversationId, priorRevision: state!.revision, revision: state!.revision + 1,
        recoveredAt: Date.now(), capabilityAdmission: structuredClone(state!.capabilityAdmission!),
        invalidatedPrepared: structuredClone(state!.prepared!), evidenceIds: job.evidence.map(row => row.id), verifiedTarget: fresh,
        custody: { authority: 'absent' as const, checkpoints: 0 as const, execution: 'absent' as const } };
      const next: VideoEditingDocument = { ...job, workflow: { ...state!, revision: recovery.revision,
        phase: 'selected', prepared: undefined, legacyPreparedRecovery: recovery } };
      preserveLegacyPreparedRecovery(job, next);
      await this.publish({ version: 1, jobs: this.ledger.jobs.map(row => row.id === jobId ? next : row) }, assertOwner);
      return { status: 'recovered' as const, job: structuredClone(next), recovery: structuredClone(recovery) };
    });
  }
  /** Native-confirmed pre-selection constraint and its derived comparison publish in one ledger write.
   * Measured media, request, planner input and candidate designs remain immutable. */
  async setSourceUsability(jobId: string, raw: unknown, assertOwner?: () => Promise<void>): Promise<VideoEditingDocument> {
    const captured = structuredClone(raw);
    return this.serial(async () => {
      this.available(); const job = this.job(jobId), state = job.workflow;
      const input = validateSourceUsabilityInput(job, captured);
      await assertOwner?.();
      const old = state!.sourceUsability?.find(row => row.binding.assetId === input.binding.assetId);
      // Only exact already-committed intent may tolerate a lost-response retry with an old revision.
      if (old && canonicalJson(old.binding) === canonicalJson(input.binding) && canonicalJson(old.ranges) === canonicalJson(input.ranges))
        return structuredClone(job);
      const decision: SourceUsabilityDecision = { binding: input.binding, ranges: input.ranges, sessionId: job.sessionId,
        localProjectId: job.localProjectId, resolveProjectId: job.resolveProjectId, provenance: 'native-operator',
        operatorId: 'operator-ipc', decidedAt: Date.now(), revision: state!.revision + 1 };
      const next = { ...job, workflow: { ...state!, revision: decision.revision,
        sourceUsability: [...(state!.sourceUsability ?? []).filter(row => row.binding.assetId !== decision.binding.assetId), decision]
          .sort((a, b) => a.binding.assetId < b.binding.assetId ? -1 : a.binding.assetId > b.binding.assetId ? 1 : 0) } };
      if (next.workflow.comparison.length) next.workflow.comparison = compareWorkCandidates(next, next.workflow.capabilities);
      await this.publish({ version: 1, jobs: this.ledger.jobs.map(row => row.id === jobId ? next : row) }, assertOwner);
      return structuredClone(next);
    });
  }
  /** Native-confirmed capability re-admission publishes durable admission in one ledger write.
   * WorkRequest, requestHash, media evidence, source usability and candidates remain immutable. */
  async setCapabilityAdmission(jobId: string, adapterInfo: { sourceEnd: string; guardVersion: number; adapterVersion: string; epoch: string }, assertOwner?: () => Promise<void>): Promise<VideoEditingDocument> {
    return this.serial(async () => {
      this.available(); const job = this.job(jobId), state = job.workflow;
      const admission = validateCapabilityAdmissionInput(job, adapterInfo);
      await assertOwner?.();
      // Only exact already-committed intent may tolerate a lost-response retry with an old revision.
      if (state!.capabilityAdmission && state!.capabilityAdmission.capabilityFingerprint === admission.capabilityFingerprint)
        return structuredClone(job);
      const remainingBlockers = (state!.blockers ?? []).filter(b => b !== 'SOURCE_END_CONVENTION_UNVERIFIED');
      const nextPhase = remainingBlockers.length ? 'blocked' : 'selected';
      const nextBlockedAt = remainingBlockers.length ? 'preparing' : undefined;
      const next: VideoEditingDocument = {
        ...job,
        workflow: {
          ...state!,
          revision: admission.revision,
          capabilityAdmission: admission,
          phase: nextPhase,
          blockedAt: nextBlockedAt,
          blockers: remainingBlockers,
        },
      };
      await this.publish({ version: 1, jobs: this.ledger.jobs.map(row => row.id === jobId ? next : row) }, assertOwner);
      return structuredClone(next);
    });
  }
  /** Native-confirmed capability admission receipt records durable operator confirmation in one ledger write.
   * WorkRequest, requestHash, media evidence, source usability, capability admission and candidates remain immutable. */
  async confirmCapabilityAdmission(jobId: string, receipt: CapabilityAdmissionReceipt, expectedRevision: number, assertOwner?: () => Promise<void>): Promise<VideoEditingDocument> {
    return this.serial(async () => {
      this.available(); const job = this.job(jobId), state = job.workflow;
      if (!state) throw new Error('Workflow required');
      assertCapabilityConfirmationMutable(job);
      if (state.revision !== expectedRevision) throw new Error('Capability confirmation revision changed');
      if (!isCapabilityConfirmationAuthorityValid(job, receipt)) throw new Error('Current independently authenticated capability confirmation required');
      if (isCapabilityConfirmationAuthorityValid(job))
        throw new Error('Capability admission already confirmed; no authority may be replayed');
      await assertOwner?.();
      const remainingBlockers = (state.blockers ?? []).filter(
        b => b !== 'CAPABILITY_ADMISSION_OPERATOR_CONFIRMATION_REQUIRED' && b !== 'SOURCE_END_CONVENTION_UNVERIFIED'
      );
      const nextPhase = remainingBlockers.length ? 'blocked' : 'selected';
      const nextBlockedAt = remainingBlockers.length ? 'preparing' : undefined;
      const next: VideoEditingDocument = {
        ...job,
        workflow: {
          ...state,
          revision: state.revision + 1,
          capabilityConfirmation: receipt,
          phase: nextPhase,
          blockedAt: nextBlockedAt,
          blockers: remainingBlockers,
        },
      };
      await this.publish({ version: 1, jobs: this.ledger.jobs.map(row => row.id === jobId ? next : row) }, assertOwner);
      return structuredClone(next);
    });
  }
  async issueOperatorAuthorization(raw: unknown): Promise<OperatorAuthorization> {
    const authorization = operatorAuthorizationSchema.parse(raw);
    return this.serial(async () => {
      this.available(); const job = this.job(authorization.jobId); assertOperatorBinding(job, authorization);
      if (capabilityAdmissionBlockers(job).length) throw new Error('Current capability confirmation authority required');
      if (authorization.consumedAt !== undefined || job.checkpoints.length || this.consumedTarget(job.resolveProjectId, authorization.timelineId).length)
        throw new Error('Operator authorization target consumed');
      if (job.operatorAuthorizations?.some(row => row.consumedAt !== undefined || row.expiresAt > authorization.issuedAt)) throw new Error('Existing live or consumed operator authority');
      const next = { ...job, operatorAuthorizations: [...(job.operatorAuthorizations ?? []), authorization] };
      await this.publish({ version: 1, jobs: this.ledger.jobs.map(row => row.id === job.id ? next : row) }); return structuredClone(authorization);
    });
  }
  async consumeOperatorAuthorization(jobId: string, id: string, preparedHash: string, targetHash: string, now = Date.now()) {
    return this.serial(async () => {
      this.available(); const job = this.job(jobId), authority = job.operatorAuthorizations?.find(row => row.id === id);
      if (!authority) throw new Error('Unknown operator authorization');
      assertOperatorBinding(job, authority);
      if (capabilityAdmissionBlockers(job).length) throw new Error('Current capability confirmation authority required');
      if (authority.consumedAt !== undefined) throw new Error('Operator authorization consumed');
      if (now < authority.issuedAt || now >= authority.expiresAt) throw new Error('Operator authorization expired');
      if (preparedHash !== authority.preparedHash || targetHash !== authority.targetHash || job.checkpoints.length || this.consumedTarget(job.resolveProjectId, authority.timelineId).length) throw new Error('Operator authorization binding/custody mismatch');
      const consumed = { ...authority, consumedAt: now };
      const next = { ...job, operatorAuthorizations: job.operatorAuthorizations!.map(row => row.id === id ? consumed : row) };
      await this.publish({ version: 1, jobs: this.ledger.jobs.map(row => row.id === jobId ? next : row) }); return structuredClone(consumed);
    });
  }
  /** One durable write consumes native authority and publishes exact operation custody together. */
  async claimOperator(jobId:string,authorizationId:string,preparedHash:string,targetHash:string,now=Date.now(),rawBefore?:unknown,assertOwner?:()=>Promise<void>):Promise<ExecutionCheckpoint> {
    return this.serial(async()=>{
      this.available(); const job=this.job(jobId), prepared=preparedWorkflow(job),authority=job.operatorAuthorizations?.find(row=>row.id===authorizationId);
      if (!authority) throw new Error('Unknown operator authority');
      assertOperatorBinding(job,authority);
      if (capabilityAdmissionBlockers(job).length) throw new Error('Current capability confirmation authority required');
      if (authority.consumedAt!==undefined || job.checkpoints.length || this.consumedTarget(job.resolveProjectId,authority.timelineId).length) throw new Error('Authority consumed or operation already claimed');
      if(now<authority.issuedAt || now>=authority.expiresAt) throw new Error('Authority expired');
      if (prepared.state!=='ready' || prepared.preparedHash!==preparedHash || authority.preparedHash!==preparedHash || authority.targetHash!==targetHash ||
        job.workflow?.planner?.kind==='fixture' || job.workflow?.capabilities.acceptance==='fixture' || job.evidence.some(row=>row.basis==='fixture')) throw new Error('Operator claim binding/evidence mismatch');
      const observed=videoEvidenceSchema.safeParse(rawBefore),original=job.evidence.find(row=>row.id===prepared.request.beforeEvidenceIds[0])!;
      if(!observed.success || observed.data.basis!=='measured' || observed.data.subject!=='timeline' || observed.data.subjectId!==authority.timelineId ||
        !observed.data.timelineState?.complete || fingerprint(observed.data.timelineState)!==targetHash || observed.data.observedAt<=original.observedAt ||
        observed.data.acquisition?.tool!=='resolve_inspect' || !observed.data.adapterDispatch)throw new Error('Fresh observation required before operator claim');
      const before=observed.data,existing=job.evidence.find(row=>row.id===before.id);
      if(existing&&canonicalJson(existing)!==canonicalJson(before))throw new Error('Fresh observation identity conflict');
      const checkpoint=executionCheckpointSchema.parse({...checkpointIntent(job,prepared.request.planId,authority.timelineId,'assemble',prepared.request.beforeEvidenceIds,prepared.request.operationId),
        operatorBinding:{preflightEvidenceId:before.id,snapshotSha256:before.adapterDispatch!.snapshotSha256,authorizationId,preparedHash,operationHash:authority.operationHash,targetHash,claimedAt:now}});
      const draft={...job,evidence:existing?job.evidence:[...job.evidence,before],operatorAuthorizations:job.operatorAuthorizations!.map(row=>row.id===authorizationId?{...row,consumedAt:now}:row),checkpoints:[...job.checkpoints,checkpoint]};
      await this.publish({version:1,jobs:this.ledger.jobs.map(row=>row.id===jobId?draft:row)},assertOwner);return structuredClone(checkpoint);
    });
  }
  /** Explicit observation reconciliation only. Never restores dispatch authority or removes custody. */
  async finishOperator(jobId:string,operationId:string,ids:string[],fallback:'AMBIGUOUS'|'FAILED_BEFORE_MUTATION'='AMBIGUOUS'):Promise<ExecutionCheckpoint> {
    const captured=z.array(videoIdSchema).max(100).parse(ids);
    return this.serial(async()=>{
      this.available();const job=this.job(jobId),prior=job.checkpoints.find(row=>row.operationId===operationId);
      if(!prior?.operatorBinding) throw new Error('Operator claim required');
      if(prior.state==='verified') return structuredClone(prior);
      evidenceFor(job,captured,'timeline',prior.timelineId);
      const verification=verifyExecution(job,{...prior,state:'claimed',beforeEvidenceIds:[...prior.beforeEvidenceIds,prior.operatorBinding.preflightEvidenceId]},captured);
      const empty=captured.length>0 && captured.every(id=>{
        const row=job.evidence.find(e=>e.id===id)!,before=job.evidence.find(e=>e.id===prior.beforeEvidenceIds[0])!;
        return row.basis==='measured' && row.observedAt>before.observedAt && canonicalJson(row.timelineState)===canonicalJson(before.timelineState);
      });
      const outcome=verification.status==='VERIFIED'?'VERIFIED':verification.status==='DEVIATED'?empty?'FAILED_CONFIRMED':'DEVIATED':captured.length?'UNVERIFIED':fallback;
      const next=executionCheckpointSchema.parse({...prior,state:outcome==='VERIFIED'?'verified':'ambiguous',outcome,afterEvidenceIds:captured});
      const draft={...job,checkpoints:job.checkpoints.map(row=>row.operationId===operationId?next:row)};
      await this.publish({version:1,jobs:this.ledger.jobs.map(row=>row.id===jobId?draft:row)});return structuredClone(next);
    });
  }
  async claim(raw: unknown): Promise<{ checkpoint: ExecutionCheckpoint; newlyClaimed: boolean }> {
    const input = claimSchema.parse(raw);
    const operationId = input.operationId ?? randomUUID();
    return this.serial(async () => {
      if (this.ledger.jobs.some(job => job.workflow?.legacyPreparedRecovery?.invalidatedPrepared.request.operationId === operationId))
        throw new Error('Invalidated legacy operation cannot be claimed');
      this.available(); const job = this.job(input.jobId);
      const intent = checkpointIntent(job, input.planId, input.timelineId, input.step, input.beforeEvidenceIds, operationId);
      const prior = this.ledger.jobs.flatMap(row => row.checkpoints).find(row => row.operationId === operationId);
      if (prior) {
        if (!job.checkpoints.includes(prior) || prior.intentHash !== intent.intentHash) throw new Error('Operation identity conflict');
        return { checkpoint: structuredClone(prior), newlyClaimed: false };
      }
      if (capabilityAdmissionBlockers(job).length) throw new Error('Current capability confirmation authority required');
      if (job.checkpoints.some(row => row.planId === input.planId && row.timelineId === input.timelineId && row.step === input.step))
        throw new Error('Planned semantic step already consumed');
      if (input.step === 'assemble' && this.ledger.jobs.some(row => row.checkpoints.some(value =>
        value.step === 'assemble' && value.resolveProjectId === job.resolveProjectId && value.timelineId === input.timelineId)))
        throw new Error('Assembly target already consumed; prepare a fresh version');
      const plan = job.candidates.find(row => row.plan.id === input.planId)!.plan;
      if (validatePlan(plan, job).length) throw new Error('Cannot claim infeasible edit intent');
      if (evidenceFor(job, input.beforeEvidenceIds).some(row => row.basis === 'inferred')) throw new Error('Inferred before evidence is insufficient');
      if (input.step !== 'assemble') throw new Error('Checkpoint step not implemented');
      for (const row of evidenceFor(job, input.beforeEvidenceIds)) {
        const state = row.timelineState;
        if (!state || !state.complete || state.resolveProjectId !== job.resolveProjectId || !sameRate(state.fps, plan.timeline.fps))
          throw new Error('Complete current target evidence required');
        if (state.items.length || state.durationFrames) throw new Error('Assembly requires a new empty target timeline');
      }
      const draft = structuredClone(job); draft.checkpoints.push(intent);
      await this.publish({ version: 1, jobs: this.ledger.jobs.map(row => row.id === draft.id ? draft : row) });
      return { checkpoint: structuredClone(intent), newlyClaimed: true };
    });
  }
  async settle(jobId: string, operationId: string, state: 'verified' | 'ambiguous', rawEvidenceIds: string[]): Promise<ExecutionCheckpoint> {
    const parsedIds = z.array(videoIdSchema).max(100).parse(rawEvidenceIds);
    z.enum(['verified', 'ambiguous']).parse(state);
    return this.serial(async () => {
      this.available(); const job = this.job(jobId);
      const prior = job.checkpoints.find(row => row.operationId === operationId);
      if (!prior) throw new Error('Unknown consumed operation');
      const next = executionCheckpointSchema.parse({ ...prior, state, afterEvidenceIds: parsedIds });
      if (prior.state !== 'claimed') {
        if (canonicalJson(next) !== canonicalJson(prior)) throw new Error('Operation outcome already settled');
        return structuredClone(prior);
      }
      evidenceFor(job, parsedIds, 'timeline', prior.timelineId);
      const draft = structuredClone(job); draft.checkpoints = draft.checkpoints.map(row => row.operationId === operationId ? next : row);
      await this.publish({ version: 1, jobs: this.ledger.jobs.map(row => row.id === draft.id ? draft : row) });
      return structuredClone(next);
    });
  }
  /** Adapter acknowledgement is a progress receipt, never observed completion or replay authority. */
  async recordReceipt(jobId: string, operationId: string, receipt: NonNullable<ExecutionCheckpoint['receipt']>): Promise<void> {
    const captured = executionCheckpointSchema.shape.receipt.parse(receipt)!;
    await this.serial(async () => {
      this.available(); const job = this.job(jobId);
      const prior = job.checkpoints.find(row => row.operationId === operationId);
      if (!prior || prior.state !== 'claimed') throw new Error('Receipt requires a consumed unresolved operation');
      if (prior.receipt) {
        if (canonicalJson(prior.receipt) !== canonicalJson(captured)) throw new Error('Operation receipt immutable');
        return;
      }
      const draft = structuredClone(job);
      draft.checkpoints.find(row => row.operationId === operationId)!.receipt = captured;
      await this.publish({ version: 1, jobs: this.ledger.jobs.map(row => row.id === draft.id ? draft : row) });
    });
  }
}
