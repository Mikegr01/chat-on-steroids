import { z } from 'zod';

/** Main-minted disposable identities. Null job/project identities cannot address video custody. */
export const ucvValidationContextSchema = z.object({
  purpose: z.literal('ucv-validation'), contextId: z.string().uuid(),
  jobId: z.null(), sessionId: z.string().uuid(), conversationId: z.null(),
  localProjectId: z.null(), resolveProjectId: z.null(),
  capabilityFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  admissionRevision: z.literal(1), workflowRevision: z.literal(1),
  adapterEpoch: z.literal('ucv-validation:1'), adapterVersion: z.literal('ucv-validation:1'),
  sourceEnd: z.literal('inclusive'), guardVersion: z.literal(2),
  sessionBinding: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
}).strict().refine(value => value.expiresAt === value.createdAt + 60_000, 'Invalid validation lifetime');
export type UcvValidationContext = z.infer<typeof ucvValidationContextSchema>;

/** The proof and its authentication/challenge metadata never cross IPC. */
export const ucvValidationResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('validated'), contextId: z.string().uuid(),
    ucvResult: z.literal('Verified'), proofCreated: z.literal(true), bindingValid: z.literal(true),
    ttlValid: z.literal(true), firstConsumption: z.literal('success'), replay: z.literal('rejected'),
    receiptCreated: z.literal(false), disposed: z.literal(true), }).strict(),
  z.object({ status: z.enum(['cancelled', 'not-verified']), contextId: z.string().uuid(),
    proofCreated: z.literal(false), receiptCreated: z.literal(false), disposed: z.literal(true), }).strict(),
]);
export type UcvValidationResult = z.infer<typeof ucvValidationResultSchema>;
