import type { VideoEditingDocument, VideoEvidence, LegacyPreparedRecoveryInput } from '../../shared/video-editing.js';
import { canonicalJson } from './identity.js';
import { prepareExecution } from './execution.js';
import { capabilityAdmissionFingerprint } from './source-end-admission.js';

function reject(code: string): never { throw new Error(`LEGACY_RECOVERY_${code}`); }

/** No era timestamp exists in v1 custody. Recognize only the self-consistent pre-receipt
 * contradiction: unknown immutable capability + inclusive prepared compiler + bound admission
 * + absent receipt. Modern readmission preparation requires an immutable receipt; modern
 * create-time inclusive preparations are excluded. This is not a caller-supplied legacy flag. */
export function assertLegacyPreparedEligible(job: VideoEditingDocument): void {
  const state = job.workflow;
  if (!state || state.phase !== 'prepared' || !state.prepared || !state.selection) reject('PREPARED_REQUIRED');
  if (state.legacyPreparedRecovery) reject('ALREADY_INVALIDATED');
  if (state.capabilityConfirmation) reject('CONFIRMATION_EXISTS');
  if (job.operatorAuthorizations?.length) reject('AUTHORITY_EXISTS');
  // Checkpoints own claim, consumption, receipt, ambiguity and reconciliation/terminal outcome.
  if (job.checkpoints.length) reject('EXECUTION_CUSTODY_EXISTS');
  if (job.reviews.length || job.revisions.length || job.evidence.some(row => row.subject === 'render' || row.renderState || row.renderReceiptEvidenceId))
    reject('EXECUTION_RESULT_EXISTS');
  if (state.capabilities.sourceEnd !== 'unknown' || state.prepared.capabilities.sourceEnd !== 'inclusive') reject('NOT_LEGACY');
  const admission = state.capabilityAdmission;
  if (!admission) reject('ADMISSION_REQUIRED');
  if (admission.jobId !== job.id || admission.sessionId !== job.sessionId || admission.localProjectId !== job.localProjectId ||
    admission.resolveProjectId !== job.resolveProjectId || admission.sourceEnd !== 'inclusive' || admission.guardVersion !== 2 ||
    admission.provenance !== 'trusted-adapter' || admission.revision >= state.revision ||
    admission.capabilityFingerprint !== capabilityAdmissionFingerprint({ jobId: job.id, sessionId: job.sessionId,
      localProjectId: job.localProjectId, resolveProjectId: job.resolveProjectId, sourceEnd: 'inclusive', guardVersion: 2,
      adapterVersion: admission.adapterVersion, adapterEpoch: admission.adapterEpoch })) reject('ADMISSION_BINDING_INVALID');
  if (canonicalJson(state.prepared.capabilities) !== canonicalJson({ ...state.capabilities, sourceEnd: 'inclusive' })) reject('NOT_LEGACY');
  const compiled = prepareExecution(job, state.prepared.request, state.prepared.capabilities);
  if (compiled.state !== 'ready' || compiled.preparedHash !== state.prepared.preparedHash || compiled.intentHash !== state.prepared.intentHash)
    reject('PREPARATION_INVALID');
  storedPrecondition(job);
}

function storedPrecondition(job: VideoEditingDocument): VideoEvidence {
  const prepared = job.workflow!.prepared!;
  if (prepared.request.beforeEvidenceIds.length !== 1) reject('TARGET_PRECONDITION_INVALID');
  const before = job.evidence.find(row => row.id === prepared.request.beforeEvidenceIds[0]);
  if (!before || before.subject !== 'timeline' || before.subjectId !== prepared.request.timelineId || before.basis !== 'measured' ||
    before.producer.name !== 'cos-davinci-resolve' || before.acquisition?.tool !== 'resolve_inspect' || !before.acquisition.rawSha256 ||
    !before.timelineState?.complete || before.timelineState.resolveProjectId !== job.resolveProjectId ||
    !before.timelineState.ownership?.creationOperationId || before.timelineState.ownership.sourceTimelineId !== null ||
    before.timelineState.items.length || before.timelineState.durationFrames || before.timelineState.startFrame === undefined ||
    before.adapterDispatch?.guardVersion !== 2 || before.adapterDispatch.sourceEnd !== 'inclusive') reject('TARGET_PRECONDITION_INVALID');
  return before;
}

/** Both raw adapter snapshot and complete normalized pre-state must still match. No mutation port. */
export function assertLegacyRecoveryTarget(job: VideoEditingDocument, fresh: VideoEvidence): void {
  const before = storedPrecondition(job);
  if (fresh.subject !== 'timeline' || fresh.subjectId !== before.subjectId || fresh.basis !== 'measured' ||
    fresh.producer.name !== 'cos-davinci-resolve' || fresh.acquisition?.tool !== 'resolve_inspect' || !fresh.acquisition.rawSha256 ||
    fresh.observedAt <= before.observedAt || !fresh.timelineState?.complete || !fresh.timelineState.ownership?.creationOperationId ||
    fresh.adapterDispatch?.guardVersion !== 2 || fresh.adapterDispatch.sourceEnd !== 'inclusive' ||
    canonicalJson(fresh.timelineState) !== canonicalJson(before.timelineState) ||
    canonicalJson(fresh.adapterDispatch) !== canonicalJson(before.adapterDispatch)) reject('TARGET_PRECONDITION_CHANGED_OR_UNVERIFIED');
}

export function assertLegacyRecoveryExpectation(job: VideoEditingDocument, input: LegacyPreparedRecoveryInput): void {
  if (job.workflow?.revision !== input.expectedRevision) reject('REVISION_CHANGED');
  if (job.workflow?.prepared?.preparedHash !== input.preparedHash) reject('PREPARED_HASH_CHANGED');
  if (job.workflow.prepared.request.operationId !== input.operationId) reject('OPERATION_CHANGED');
}

/** Validate durable audit on cold restore without granting it confirmation or preparation authority. */
export function validateLegacyPreparedRecovery(job: VideoEditingDocument): void {
  const state = job.workflow, record = state?.legacyPreparedRecovery;
  if (!state || !record) return;
  if (record.jobId !== job.id || record.sessionId !== job.sessionId || record.localProjectId !== job.localProjectId ||
    record.resolveProjectId !== job.resolveProjectId || record.revision !== record.priorRevision + 1 || record.revision > state.revision ||
    record.recoveredAt < record.verifiedTarget.observedAt || new Set(record.evidenceIds).size !== record.evidenceIds.length ||
    record.evidenceIds.some(id => !job.evidence.some(row => row.id === id)))
    reject('AUDIT_BINDING_INVALID');
  const legacy: VideoEditingDocument = { ...job, operatorAuthorizations: undefined, checkpoints: [], reviews: [], revisions: [],
    // Later evidence is unrelated to the historical no-execution/compiler proof.
    // Original rows stay under the existing immutable artifact owner; retain only their IDs here.
    evidence: record.evidenceIds.map(id => job.evidence.find(row => row.id === id)!),
    workflow: { ...state, phase: 'prepared', revision: record.priorRevision, blockers: [], blockedAt: undefined,
      prepared: record.invalidatedPrepared, capabilityAdmission: record.capabilityAdmission,
      capabilityConfirmation: undefined, legacyPreparedRecovery: undefined } };
  assertLegacyPreparedEligible(legacy); assertLegacyRecoveryTarget(legacy, record.verifiedTarget);
  if (state.prepared?.request.operationId === record.invalidatedPrepared.request.operationId ||
    state.prepared?.preparedHash === record.invalidatedPrepared.preparedHash ||
    job.checkpoints.some(row => row.operationId === record.invalidatedPrepared.request.operationId)) reject('INVALIDATED_OPERATION_REUSED');
  if (state.revision === record.revision && (state.phase !== 'selected' || state.prepared || state.capabilityConfirmation ||
    job.operatorAuthorizations?.length || job.checkpoints.length)) reject('AUDIT_FORWARD_STATE_INVALID');
}

/** The only recognized prepared -> selected transition, requiring one validated audit commit. */
export function preserveLegacyPreparedRecovery(before: VideoEditingDocument, after: VideoEditingDocument): void {
  assertLegacyPreparedEligible(before);
  const old = before.workflow!, next = after.workflow!, record = next.legacyPreparedRecovery;
  if (!record || record.priorRevision !== old.revision || record.revision !== old.revision + 1 || next.revision !== record.revision ||
    next.phase !== 'selected' || next.prepared || canonicalJson(record.invalidatedPrepared) !== canonicalJson(old.prepared) ||
    canonicalJson(record.capabilityAdmission) !== canonicalJson(old.capabilityAdmission) ||
    canonicalJson(record.evidenceIds) !== canonicalJson(before.evidence.map(row => row.id))) reject('TRANSITION_INVALID');
  const expected = { ...before, workflow: { ...old, revision: old.revision + 1, phase: 'selected', prepared: undefined, legacyPreparedRecovery: record } };
  if (canonicalJson(expected) !== canonicalJson(after)) reject('UNRELATED_STATE_CHANGED');
  validateLegacyPreparedRecovery(after);
}
