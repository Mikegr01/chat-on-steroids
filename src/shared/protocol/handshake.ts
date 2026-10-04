import { z } from 'zod';
import { protocolVersionSchema, generationSchema, epochIdSchema } from './identity.js';

export const ProtocolCapability = {
  SESSION_BINDING: 'SESSION_BINDING',
  SEND_MESSAGE: 'SEND_MESSAGE',
  TURN_OBSERVATION: 'TURN_OBSERVATION',
  COMPOSER_CONTROL: 'COMPOSER_CONTROL',
  TAB_MANAGEMENT: 'TAB_MANAGEMENT',
  FILE_UPLOAD: 'FILE_UPLOAD'
} as const;

export const protocolCapabilitySchema = z.enum([
  'SESSION_BINDING',
  'SEND_MESSAGE',
  'TURN_OBSERVATION',
  'COMPOSER_CONTROL',
  'TAB_MANAGEMENT',
  'FILE_UPLOAD'
]);
export type ProtocolCapability = z.infer<typeof protocolCapabilitySchema>;

export const handshakeHelloSchema = z.object({
  type: z.literal('HELLO'),
  protocolVersion: z.number().int(),
  extensionVersion: z.string().min(1).max(30),
  extensionBuild: z.string().max(64).optional(),
  browserIdentity: z.string().max(128).optional(),
  connectionGeneration: generationSchema,
  capabilities: z.array(protocolCapabilitySchema)
});
export type HandshakeHello = z.infer<typeof handshakeHelloSchema>;

export const handshakeWelcomeSchema = z.object({
  type: z.literal('WELCOME'),
  acceptedProtocolVersion: protocolVersionSchema,
  desktopInstanceId: z.string().min(8).max(128),
  appVersion: z.string().min(1).max(30),
  negotiatedCapabilities: z.array(protocolCapabilitySchema),
  reconcileRequested: z.boolean().default(true),
  connectionGeneration: generationSchema,
  connectionEpoch: epochIdSchema
});
export type HandshakeWelcome = z.infer<typeof handshakeWelcomeSchema>;

export const handshakeReadySchema = z.object({
  type: z.literal('READY'),
  connectionGeneration: generationSchema,
  connectionEpoch: epochIdSchema.optional(),
  activeSessions: z.array(z.string().min(1).max(64)),
  boundTabsCount: z.number().int().nonnegative()
});
export type HandshakeReady = z.infer<typeof handshakeReadySchema>;

export const handshakeRejectSchema = z.object({
  type: z.literal('REJECT'),
  reason: z.enum(['PROTOCOL_MISMATCH', 'MISSING_CAPABILITIES', 'UNAUTHORIZED']),
  expectedVersion: z.number().int(),
  actualVersion: z.number().int(),
  message: z.string().max(256)
});
export type HandshakeReject = z.infer<typeof handshakeRejectSchema>;

export const handshakeMessageSchema = z.discriminatedUnion('type', [
  handshakeHelloSchema,
  handshakeWelcomeSchema,
  handshakeReadySchema,
  handshakeRejectSchema
]);
export type HandshakeMessage = z.infer<typeof handshakeMessageSchema>;
