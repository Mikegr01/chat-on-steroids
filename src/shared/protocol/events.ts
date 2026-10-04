import { z } from 'zod';
import {
  protocolVersionSchema,
  commandIdSchema,
  eventIdSchema,
  generationSchema,
  epochIdSchema,
  endpointRoleSchema
} from './identity.js';
import { commitProofLevelSchema } from './lifecycle.js';
import { protocolErrorCodeSchema } from './errors.js';

export const protocolEventTypeSchema = z.enum([
  'COMMAND_PERSISTED',
  'COMMAND_DISPATCHED',
  'COMMAND_CLAIMED',
  'SESSION_BOUND',
  'SESSION_LOST',
  'TAB_ACQUIRED',
  'TAB_LOST',
  'COMPOSER_ACQUIRED',
  'COMPOSER_INVALIDATED',
  'MESSAGE_SUBMIT_STARTED',
  'MESSAGE_COMMITTED',
  'TURN_STARTED',
  'TURN_COMPLETED',
  'TURN_FAILED',
  'COMMAND_BLOCKED',
  'COMMAND_FAILED',
  'COMMAND_COMPLETED'
]);
export type ProtocolEventType = z.infer<typeof protocolEventTypeSchema>;

// Specific Event Payloads

export const commandClaimedPayloadSchema = z.object({
  clientDocumentId: z.string().min(1).max(128),
  tabId: z.union([z.number(), z.string()]),
  claimedAt: z.number().int().nonnegative()
});
export type CommandClaimedPayload = z.infer<typeof commandClaimedPayloadSchema>;

export const messageCommittedPayloadSchema = z.object({
  proofLevel: commitProofLevelSchema,
  nativeMessageId: z.string().nullable().optional(),
  conversationId: z.string().min(1).max(128),
  candidateCount: z.number().int().nonnegative().optional(),
  matchedText: z.string().max(240000).optional(),
  evidenceDetails: z.string().max(500).optional()
});
export type MessageCommittedPayload = z.infer<typeof messageCommittedPayloadSchema>;

export const turnStartedPayloadSchema = z.object({
  nativeTurnId: z.string().nullable().optional(),
  startedAt: z.number().int().nonnegative()
});
export type TurnStartedPayload = z.infer<typeof turnStartedPayloadSchema>;

export const turnCompletedPayloadSchema = z.object({
  nativeTurnId: z.string().nullable().optional(),
  assistantTextPreview: z.string().max(1000).optional(),
  completedAt: z.number().int().nonnegative()
});
export type TurnCompletedPayload = z.infer<typeof turnCompletedPayloadSchema>;

export const commandFailedPayloadSchema = z.object({
  errorCode: protocolErrorCodeSchema,
  message: z.string().min(1).max(500),
  retryable: z.boolean(),
  failedAt: z.number().int().nonnegative()
});
export type CommandFailedPayload = z.infer<typeof commandFailedPayloadSchema>;

export const commandBlockedPayloadSchema = z.object({
  reason: z.string().min(1).max(500),
  blockedAt: z.number().int().nonnegative()
});
export type CommandBlockedPayload = z.infer<typeof commandBlockedPayloadSchema>;

/**
 * Base Protocol Event Envelope.
 */
export const protocolEventEnvelopeSchema = z.object({
  protocolVersion: protocolVersionSchema,
  eventId: eventIdSchema,
  commandId: commandIdSchema,
  eventType: protocolEventTypeSchema,
  source: endpointRoleSchema,
  sessionId: z.string().min(1).max(64),
  conversationId: z.string().max(128).nullable().default(null),
  generation: generationSchema,
  connectionEpoch: epochIdSchema.optional(),
  emitterEpoch: epochIdSchema.optional(),
  sequence: z.number().int().positive(),
  occurredAt: z.number().int().nonnegative(),
  payload: z.unknown().default({})
});

export type ProtocolEvent<T = unknown> = z.infer<typeof protocolEventEnvelopeSchema> & {
  payload: T;
};

export function parseProtocolEvent(raw: unknown): ProtocolEvent {
  return protocolEventEnvelopeSchema.parse(raw);
}
