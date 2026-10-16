import { authenticateCapabilityOperator, type CapabilityOperatorContext } from '../../src/main/video-editing/capability-operator-proof.js';
import { createCapabilityAdmissionReceipt } from '../../src/main/video-editing/source-end-admission.js';
import type { VideoEditingDocument } from '../../src/shared/video-editing.js';

/** Synthetic OS-authentication success. Never calls native UI or uses a live job. */
export const verifiedCapabilityReview = (detail: string, context: CapabilityOperatorContext) =>
  authenticateCapabilityOperator(context, detail, async () => 'windows-user-consent-verifier', () => {});

/** Receipt metadata for pure compiler/ledger tests; production issuance tests consume real
 * main-owned proofs through verifiedCapabilityReview. No native verifier is invoked. */
export function authenticatedCapabilityReceipt(job: VideoEditingDocument, origin: 'operator-ipc', conversationId?: string, now = Date.now()) {
  return createCapabilityAdmissionReceipt(job, origin, conversationId, now, {
    method: 'windows-user-consent-verifier', challengeHash: 'f'.repeat(64), verifiedAt: now, expiresAt: now + 60_000,
  });
}
