import { createHash, randomUUID } from 'node:crypto';
import { ucvValidationContextSchema, ucvValidationResultSchema, type UcvValidationContext,
  type UcvValidationResult } from '../../shared/ucv-validation.js';
import { createCapabilityOperatorProofStore } from './capability-operator-proof.js';

/** Terminal validation only. These ports contain no job, receipt, S7, Resolve or disk authority.
 * All identities originate here; null job/project identities cannot address production custody. */
export async function runUcvValidation(ports: {
  confirm(detail: string): Promise<boolean>;
  authenticate(detail: string, assertCurrent: () => void): Promise<'windows-user-consent-verifier' | null>;
  assertOwner(): void;
  now?: () => number;
}): Promise<UcvValidationResult> {
  const now = ports.now ?? Date.now, contextId = randomUUID(), sessionId = randomUUID(), createdAt = now();
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const context = Object.freeze(ucvValidationContextSchema.parse({ purpose: 'ucv-validation', contextId,
    jobId: null, sessionId, conversationId: null, localProjectId: null, resolveProjectId: null,
    capabilityFingerprint: hash(`ucv-validation:${contextId}`), admissionRevision: 1, workflowRevision: 1,
    adapterEpoch: 'ucv-validation:1', adapterVersion: 'ucv-validation:1', sourceEnd: 'inclusive', guardVersion: 2,
    sessionBinding: hash(sessionId), createdAt, expiresAt: createdAt + 60_000 }));
  const proofs = createCapabilityOperatorProofStore<UcvValidationContext>();
  const assertCurrent = () => {
    ports.assertOwner();
    const time = now();
    if (time < context.createdAt || time >= context.expiresAt) throw new Error('UCV validation context expired');
  };
  try {
    assertCurrent();
    const detail = 'Validate Windows verification in an isolated disposable context?\n' +
      'This requests Windows Hello once, consumes one proof and checks replay rejection.\n' +
      'No video job, capability receipt, S7 authority or Resolve operation is created.\n' +
      `Validation: ${contextId}\nComplete verification within one minute. Credentials must stay in Windows Hello.`;
    const accepted = await ports.confirm(detail);
    assertCurrent();
    if (!accepted) return ucvValidationResultSchema.parse({ status: 'cancelled', contextId,
      proofCreated: false, receiptCreated: false, disposed: true });
    const proof = await proofs.authenticate(context, detail, message => ports.authenticate(message, assertCurrent), assertCurrent, now);
    assertCurrent();
    if (proof === null) return ucvValidationResultSchema.parse({ status: 'not-verified', contextId,
      proofCreated: false, receiptCreated: false, disposed: true });
    proofs.consume(proof, context, now());
    // Only the exact missing-entry error proves that this same object has been consumed.
    // An unrelated owner/TTL/native failure cannot be reported as a rejected replay.
    let replayRejected = false;
    try { proofs.consume(proof, context, now()); }
    catch (error) {
      if (error instanceof Error && error.message === 'Independent operator authentication required; native Confirm is insufficient')
        replayRejected = true;
      else throw error;
    }
    if (!replayRejected) throw new Error('UCV validation proof replay accepted');
    assertCurrent();
    return ucvValidationResultSchema.parse({ status: 'validated', contextId, ucvResult: 'Verified',
      proofCreated: true, bindingValid: true, ttlValid: true, firstConsumption: 'success', replay: 'rejected',
      receiptCreated: false, disposed: true });
  } finally { proofs.dispose(); }
}
