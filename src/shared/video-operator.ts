import { z } from 'zod';
export const operatorAuthorizationSchema = z.object({ id: z.string().uuid(), kind: z.literal('operator-explicit'),
  jobId: z.string().min(1).max(128), planId: z.string().min(1).max(128), resolveProjectId: z.string().min(1).max(128),
  timelineId: z.string().min(1).max(128), preparedHash: z.string().regex(/^[a-f0-9]{64}$/), targetHash: z.string().regex(/^[a-f0-9]{64}$/),
  operationHash: z.string().regex(/^[a-f0-9]{64}$/), provenance: z.literal('operator-ipc'),
  issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
  consumedAt: z.number().int().nonnegative().optional() }).strict()
  .refine(a => a.expiresAt > a.issuedAt && a.expiresAt - a.issuedAt <= 600000 &&
    (a.consumedAt === undefined || a.consumedAt >= a.issuedAt && a.consumedAt <= a.expiresAt));
export type OperatorAuthorization = z.infer<typeof operatorAuthorizationSchema>;
