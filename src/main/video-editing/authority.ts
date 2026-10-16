import { z } from 'zod';
import { videoIdSchema } from '../../shared/video-editing.js';

/** Future causal-proof contract only. It imports and changes no frozen S7 authority. */
export const videoDecisionProofSchema = z.object({ sessionId: videoIdSchema,
  commandId: z.string().regex(/^cmd_s7_[0-9a-f-]{36}$/i), conversationId: videoIdSchema,
  nativeMessageId: z.string().min(1).max(256), proofLevel: z.literal('STRONG_COMMIT') }).strict();

export function categoryCAuthority(rawProof: unknown): { allowed: false; reason: 'S7_FINAL_LIVE_CANARY_DEFERRED' } {
  videoDecisionProofSchema.parse(rawProof);
  // No config flag or fixture receipt can turn deferred live acceptance into authority.
  return { allowed: false, reason: 'S7_FINAL_LIVE_CANARY_DEFERRED' };
}
