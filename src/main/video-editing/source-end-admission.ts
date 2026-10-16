import { createHash, randomUUID } from 'node:crypto';
import type { VideoEditingDocument, VideoWorkflow, CapabilityAdmission, CapabilityAdmissionReceipt } from '../../shared/video-editing.js';
import { capabilityAdmissionSchema, capabilityAdmissionReceiptSchema } from '../../shared/video-editing.js';
import { canonicalJson } from './identity.js';
import type { CapabilityAuthentication } from './capability-operator-proof.js';

export interface TrustedAdapterContext {
  epoch?: string;
  adapterSourceEnd?: string;
  guardVersion?: number;
}

/**
 * Resolves effective source-end convention for a video job:
 * 1. If immutable create-time capability is already verified inclusive, preserve existing behavior.
 * 2. If create-time is unknown/unverified, BOTH valid durable capability admission AND matching
 *    current independently authenticated operator receipt are required to establish inclusive.
 * 3. If re-admission or confirmation receipt is absent, stale, or conflicting, sourceEnd remains unknown.
 * 4. Never infers inclusive from candidate ranges.
 * 5. Never silently defaults unknown -> inclusive.
 * 6. No caller-supplied convention or bare Boolean confirmation is trusted.
 */
export function effectiveSourceEnd(
  job: VideoEditingDocument,
  trustedContext?: TrustedAdapterContext
): 'inclusive' | 'exclusive' | 'unknown' {
  if (!job.workflow) return 'unknown';

  // Rule 1: Immutable create-time verified inclusive capability takes natural effect
  if (job.workflow.capabilities.sourceEnd === 'inclusive') {
    return 'inclusive';
  }

  // Rule 2: Post-create admission requires BOTH trusted admission AND native confirmation receipt
  const admission = job.workflow.capabilityAdmission;
  if (!admission) {
    return 'unknown';
  }

  const confirmation = job.workflow.capabilityConfirmation;
  if (!confirmation) {
    return 'unknown'; // No silent grandfathering: receipt is missing -> fails closed
  }

  // Rule 3: Fail closed on any binding / session / project / scope mismatch
  const localProject = job.localProjectId ?? null;
  if (
    admission.jobId !== job.id ||
    admission.sessionId !== job.sessionId ||
    admission.localProjectId !== localProject ||
    admission.resolveProjectId !== job.resolveProjectId ||
    admission.sourceEnd !== 'inclusive' ||
    admission.guardVersion !== 2
  ) {
    return 'unknown';
  }

  // Verify confirmation receipt binding
  if (!isCapabilityConfirmationAuthorityValid(job, confirmation)) {
    return 'unknown';
  }

  // Staleness policy: if trusted context is present, check against current adapter state
  if (trustedContext) {
    if (trustedContext.epoch !== undefined && admission.adapterEpoch !== trustedContext.epoch) {
      return 'unknown'; // Adapter epoch changed -> stale admission fails closed
    }
    if (trustedContext.adapterSourceEnd !== undefined && trustedContext.adapterSourceEnd !== 'inclusive') {
      return 'unknown'; // Current adapter convention is no longer inclusive -> fails closed
    }
    if (trustedContext.guardVersion !== undefined && trustedContext.guardVersion !== 2) {
      return 'unknown'; // Guard version changed -> fails closed
    }
  }

  return 'inclusive';
}

export function capabilityAdmissionBlockers(
  job: VideoEditingDocument,
  trustedContext?: TrustedAdapterContext
): string[] {
  if (!job.workflow) return [];
  if (job.workflow.capabilities.sourceEnd === 'inclusive') return [];
  const admission = job.workflow.capabilityAdmission;
  if (!admission) return ['SOURCE_END_CONVENTION_UNVERIFIED'];

  const confirmation = job.workflow.capabilityConfirmation;
  if (!confirmation) {
    return ['CAPABILITY_ADMISSION_OPERATOR_CONFIRMATION_REQUIRED'];
  }
  if (!isCapabilityConfirmationAuthorityValid(job, confirmation)) {
    return ['CAPABILITY_ADMISSION_OPERATOR_CONFIRMATION_REQUIRED'];
  }

  if (trustedContext) {
    if (trustedContext.epoch !== undefined && admission.adapterEpoch !== trustedContext.epoch) {
      return ['ADAPTER_EPOCH_CHANGED'];
    }
    if (trustedContext.adapterSourceEnd !== undefined && trustedContext.adapterSourceEnd !== 'inclusive') {
      return ['ADAPTER_SOURCE_END_UNVERIFIED'];
    }
    if (trustedContext.guardVersion !== undefined && trustedContext.guardVersion !== 2) {
      return ['ADAPTER_GUARD_VERSION_UNSUPPORTED'];
    }
  }

  return [];
}

/**
 * Returns effective workflow capabilities derived from immutable create-time capabilities
 * plus valid durable re-admission if present.
 */
export function effectiveWorkflowCapabilities(
  job: VideoEditingDocument,
  trustedContext?: TrustedAdapterContext
): VideoWorkflow['capabilities'] {
  if (!job.workflow) throw new Error('Workflow required');
  const sourceEnd = effectiveSourceEnd(job, trustedContext);
  return {
    ...job.workflow.capabilities,
    sourceEnd,
  };
}

/**
 * Guards that the job is in a valid state to re-admit capabilities:
 * - Must have selection
 * - Must not have prepared operation
 * - Must not have checkpoints or execution custody
 * - Must not have operator authorizations
 * - Phase must be 'selected' or 'blocked' at 'preparing'
 */
export function assertCapabilityAdmissionMutable(job: VideoEditingDocument): void {
  const state = job.workflow;
  if (!state) throw new Error('Workflow required');
  if (!state.selection) throw new Error('Capability readmission requires existing candidate selection');
  if (state.prepared) throw new Error('Capability readmission forbidden after prepared operation exists');
  if (job.checkpoints.length > 0) throw new Error('Capability readmission forbidden after execution checkpoints exist');
  if (job.operatorAuthorizations && job.operatorAuthorizations.length > 0) {
    throw new Error('Capability readmission forbidden after operator authority exists');
  }
  if (state.phase !== 'selected' && !(state.phase === 'blocked' && state.blockedAt === 'preparing')) {
    throw new Error('Capability readmission requires selected or preparing-blocked phase');
  }
}

export function capabilityAdmissionFingerprint(payload: {
  jobId: string;
  sessionId: string;
  localProjectId: string | null;
  resolveProjectId: string;
  sourceEnd: 'inclusive';
  guardVersion: 2;
  adapterVersion: string;
  adapterEpoch: string;
}): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export function capabilityAdmissionReceiptFingerprint(payload: {
  jobId: string;
  sessionId: string;
  localProjectId: string | null;
  resolveProjectId: string;
  capabilityFingerprint: string;
  admissionRevision: number;
  adapterEpoch: string;
  sourceEnd: 'inclusive';
  guardVersion: 2;
  provenance: 'operator-ipc';
  authentication?: CapabilityAdmissionReceipt['authentication'];
  conversationId?: string | null;
}): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/**
 * Validates adapter info and builds a durable CapabilityAdmission record.
 */
export function validateCapabilityAdmissionInput(
  job: VideoEditingDocument,
  adapterInfo: { sourceEnd: string; guardVersion: number; adapterVersion: string; epoch: string }
): CapabilityAdmission {
  assertCapabilityAdmissionMutable(job);
  if (adapterInfo.sourceEnd !== 'inclusive') {
    throw new Error(`ADAPTER_SOURCE_END_UNVERIFIED: trusted adapter convention is ${adapterInfo.sourceEnd}, required inclusive`);
  }
  if (adapterInfo.guardVersion !== 2) {
    throw new Error(`ADAPTER_GUARD_VERSION_UNSUPPORTED: guard version is ${adapterInfo.guardVersion}, required 2`);
  }

  const payload = {
    jobId: job.id,
    sessionId: job.sessionId,
    localProjectId: job.localProjectId ?? null,
    resolveProjectId: job.resolveProjectId,
    sourceEnd: 'inclusive' as const,
    guardVersion: 2 as const,
    adapterVersion: adapterInfo.adapterVersion,
    adapterEpoch: adapterInfo.epoch,
  };
  const fingerprint = capabilityAdmissionFingerprint(payload);

  return capabilityAdmissionSchema.parse({
    ...payload,
    capabilityFingerprint: fingerprint,
    admittedAt: Date.now(),
    revision: job.workflow!.revision + 1,
    provenance: 'trusted-adapter',
  });
}

/**
 * Guards that the job is in a valid state to confirm capability admission:
 * - Must have capabilityAdmission
 * - Must have selection
 * - Must not have prepared operation
 * - Must not have checkpoints or execution custody
 * - Must not have operator authorizations
 * - Phase must be 'selected' or 'blocked' at 'preparing'
 */
export function assertCapabilityConfirmationMutable(job: VideoEditingDocument): void {
  const state = job.workflow;
  if (!state) throw new Error('Workflow required');
  if (!state.capabilityAdmission) throw new Error('Capability admission required before operator confirmation');
  if (!state.selection) throw new Error('Capability confirmation requires existing candidate selection');
  if (state.prepared) throw new Error('Capability confirmation forbidden after prepared operation exists');
  if (job.checkpoints.length > 0) throw new Error('Capability confirmation forbidden after execution checkpoints exist');
  if (job.operatorAuthorizations && job.operatorAuthorizations.length > 0) {
    throw new Error('Capability confirmation forbidden after operator authority exists');
  }
  if (state.phase !== 'selected' && !(state.phase === 'blocked' && state.blockedAt === 'preparing')) {
    throw new Error('Capability confirmation requires selected or preparing-blocked phase');
  }
}

/**
 * Checks content integrity and exact job/admission binding. A public hash is not operator identity.
 */
export function assertCapabilityAdmissionReceiptBinding(job: VideoEditingDocument, receipt: CapabilityAdmissionReceipt): void {
  if (!job.workflow?.capabilityAdmission) {
    throw new Error('Capability admission required before confirmation receipt validation');
  }
  const admission = job.workflow.capabilityAdmission;
  const localProject = job.localProjectId ?? null;

  if (
    receipt.kind !== 'operator-explicit' ||
    receipt.provenance !== 'operator-ipc' ||
    receipt.jobId !== job.id ||
    receipt.sessionId !== job.sessionId ||
    receipt.localProjectId !== localProject ||
    receipt.resolveProjectId !== job.resolveProjectId ||
    receipt.capabilityFingerprint !== admission.capabilityFingerprint ||
    receipt.admissionRevision !== admission.revision ||
    receipt.adapterEpoch !== admission.adapterEpoch ||
    receipt.sourceEnd !== 'inclusive' ||
    receipt.guardVersion !== 2
  ) {
    throw new Error('Capability admission confirmation binding changed');
  }
  if (receipt.authentication && receipt.authentication.verifiedAt !== receipt.confirmedAt)
    throw new Error('Capability authentication timestamp changed');

  const payload = {
    jobId: receipt.jobId,
    sessionId: receipt.sessionId,
    localProjectId: receipt.localProjectId,
    resolveProjectId: receipt.resolveProjectId,
    capabilityFingerprint: receipt.capabilityFingerprint,
    admissionRevision: receipt.admissionRevision,
    adapterEpoch: receipt.adapterEpoch,
    sourceEnd: receipt.sourceEnd,
    guardVersion: receipt.guardVersion,
    provenance: receipt.provenance,
    ...(receipt.authentication ? { authentication: receipt.authentication, conversationId: receipt.conversationId ?? null } : {}),
  };
  const expectedFingerprint = capabilityAdmissionReceiptFingerprint(payload);
  if (receipt.confirmationFingerprint !== expectedFingerprint) {
    throw new Error('Capability admission confirmation fingerprint invalid');
  }
}

/** Retention accepts historical receipt shapes; current authority requires the UCV proof
 * metadata and exact admission binding. Proof expiry bounds issuance/publication, not the
 * lifetime of an already committed receipt. A public fingerprint cannot mint a proof. */
export function isCapabilityConfirmationAuthorityValid(
  job: VideoEditingDocument,
  receipt: CapabilityAdmissionReceipt | undefined = job.workflow?.capabilityConfirmation
): boolean {
  const parsed = capabilityAdmissionReceiptSchema.safeParse(receipt);
  if (!parsed.success || parsed.data.authentication?.method !== 'windows-user-consent-verifier' ||
    parsed.data.authentication.verifiedAt !== parsed.data.confirmedAt) return false;
  try {
    assertCapabilityAdmissionReceiptBinding(job, parsed.data);
    return true;
  } catch { return false; }
}

/**
 * Builds a receipt. The fixed service/IPC owner must verify and consume OS proof before issuance.
 */
export function createCapabilityAdmissionReceipt(
  job: VideoEditingDocument,
  origin: 'operator-ipc',
  conversationId?: string,
  now = Date.now(),
  authentication?: CapabilityAuthentication
): CapabilityAdmissionReceipt {
  assertCapabilityConfirmationMutable(job);
  const admission = job.workflow!.capabilityAdmission!;

  const payload = {
    jobId: job.id,
    sessionId: job.sessionId,
    localProjectId: job.localProjectId ?? null,
    resolveProjectId: job.resolveProjectId,
    capabilityFingerprint: admission.capabilityFingerprint,
    admissionRevision: admission.revision,
    adapterEpoch: admission.adapterEpoch,
    sourceEnd: 'inclusive' as const,
    guardVersion: 2 as const,
    provenance: origin,
    ...(authentication ? { authentication } : {}),
  };
  const confirmationFingerprint = capabilityAdmissionReceiptFingerprint({ ...payload,
    ...(authentication ? { conversationId: conversationId ?? null } : {}),
  });

  return capabilityAdmissionReceiptSchema.parse({
    id: randomUUID(),
    kind: 'operator-explicit',
    ...payload,
    ...(conversationId ? { conversationId } : {}),
    confirmedAt: now,
    confirmationFingerprint,
  });
}
