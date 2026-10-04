import { z } from 'zod';
import {
  protocolVersionSchema,
  commandIdSchema,
  idempotencyKeySchema,
  generationSchema,
  endpointRoleSchema
} from './identity.js';

/**
 * Payload for SESSION_PROBE command.
 * Probes browser extension, tab availability, ChatGPT session bindings, and liveness.
 */
export const sessionProbePayloadSchema = z.object({
  probeTabs: z.boolean().default(true),
  probeModels: z.boolean().default(false),
  targetConversationId: z.string().nullable().optional()
});
export type SessionProbeInput = z.input<typeof sessionProbePayloadSchema>;
export type SessionProbePayload = z.output<typeof sessionProbePayloadSchema>;

/**
 * Payload for SEND_MESSAGE command.
 * Dispatches a message to be typed and submitted to ChatGPT with strict binding.
 */
export const sendMessagePayloadSchema = z.object({
  text: z.string().min(1).max(240000),
  targetConversationId: z.string().min(1).max(128),
  model: z.string().max(80).nullable().optional(),
  reasoningEffort: z.string().max(40).nullable().optional(),
  clientTurnId: z.string().max(128).optional(),
  timeoutMs: z.number().int().positive().max(300000).default(30000)
});
export type SendMessageInput = z.input<typeof sendMessagePayloadSchema>;
export type SendMessagePayload = z.output<typeof sendMessagePayloadSchema>;

/**
 * Payload for BIND_SESSION command.
 * Explicitly binds a CoS session to a ChatGPT conversation.
 */
export const bindSessionPayloadSchema = z.object({
  targetConversationId: z.string().min(1).max(128),
  sessionId: z.string().min(8).max(64),
  role: z.enum(['prime', 'worker']).default('prime')
});
export type BindSessionInput = z.input<typeof bindSessionPayloadSchema>;
export type BindSessionPayload = z.output<typeof bindSessionPayloadSchema>;

/**
 * Payload for CANCEL_COMMAND.
 * Explicitly attempts to cancel an in-flight command before commit.
 */
export const cancelCommandPayloadSchema = z.object({
  targetCommandId: commandIdSchema,
  reason: z.string().min(1).max(256)
});
export type CancelCommandInput = z.input<typeof cancelCommandPayloadSchema>;
export type CancelCommandPayload = z.output<typeof cancelCommandPayloadSchema>;

export type ProtocolCommandInputMap = {
  SESSION_PROBE: SessionProbeInput;
  SEND_MESSAGE: SendMessageInput;
  BIND_SESSION: BindSessionInput;
  CANCEL_COMMAND: CancelCommandInput;
};

export type ProtocolCommandPayloadMap = {
  SESSION_PROBE: SessionProbePayload;
  SEND_MESSAGE: SendMessagePayload;
  BIND_SESSION: BindSessionPayload;
  CANCEL_COMMAND: CancelCommandPayload;
};

/**
 * Discriminated union of Command Payloads.
 */
export const protocolCommandPayloadSchema = z.discriminatedUnion('commandType', [
  z.object({
    commandType: z.literal('SESSION_PROBE'),
    payload: sessionProbePayloadSchema
  }),
  z.object({
    commandType: z.literal('SEND_MESSAGE'),
    payload: sendMessagePayloadSchema
  }),
  z.object({
    commandType: z.literal('BIND_SESSION'),
    payload: bindSessionPayloadSchema
  }),
  z.object({
    commandType: z.literal('CANCEL_COMMAND'),
    payload: cancelCommandPayloadSchema
  })
]);
export type ProtocolCommandPayload = z.infer<typeof protocolCommandPayloadSchema>;
export type CommandType = ProtocolCommandPayload['commandType'];

/**
 * Base Protocol Command Envelope.
 * Every field is strictly typed and justified.
 */
export const protocolCommandEnvelopeSchema = z.object({
  protocolVersion: protocolVersionSchema,
  commandId: commandIdSchema,
  commandType: z.enum(['SESSION_PROBE', 'SEND_MESSAGE', 'BIND_SESSION', 'CANCEL_COMMAND']),
  source: endpointRoleSchema,
  target: endpointRoleSchema,
  sessionId: z.string().min(1).max(64),
  conversationId: z.string().max(128).nullable().default(null),
  owner: z.string().max(128).nullable().default(null),
  generation: generationSchema,
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  idempotencyKey: idempotencyKeySchema,
  payload: z.unknown()
});

/**
 * Validated Protocol Command.
 */
export type ProtocolCommand<T = unknown> = z.infer<typeof protocolCommandEnvelopeSchema> & {
  payload: T;
};

/**
 * Helper to validate a full command envelope and its typed payload.
 */
export function parseProtocolCommand(raw: unknown): ProtocolCommand<ProtocolCommandPayload['payload']> {
  const base = protocolCommandEnvelopeSchema.parse(raw);
  const discriminated = protocolCommandPayloadSchema.parse({
    commandType: base.commandType,
    payload: base.payload
  });
  return {
    ...base,
    commandType: discriminated.commandType,
    payload: discriminated.payload
  };
}
