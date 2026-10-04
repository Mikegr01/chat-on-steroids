import { z } from 'zod';

/**
 * Authoritative Protocol Version.
 * Protocol V1: Strict integer versioning. Rejects incompatible versions at handshake.
 */
export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

export const protocolVersionSchema = z.literal(1);

/**
 * Identity classifications across Kosmosyn Transport:
 * - DURABLE: Survives desktop and browser restarts (persisted to disk).
 * - PROCESS_LOCAL: Valid only within the lifetime of a single desktop process.
 * - BROWSER_LOCAL: Valid only within the lifetime of a single browser / extension worker process.
 * - SESSION_LOCAL: Scoped to one CoS session lifecycle.
 * - CONVERSATION_LOCAL: Scoped to one ChatGPT conversation ID (/c/<id>).
 * - EPHEMERAL: Memory-only; invalid across reloads or reconnects.
 */
export type IdentityScope =
  | 'DURABLE'
  | 'PROCESS_LOCAL'
  | 'BROWSER_LOCAL'
  | 'SESSION_LOCAL'
  | 'CONVERSATION_LOCAL'
  | 'EPHEMERAL';

/**
 * Command ID: Unique, opaque identifier for every dispatched protocol command.
 * Created by Desktop Main Authority before persistence.
 */
export const commandIdSchema = z.string().min(8).max(128);
export type CommandId = z.infer<typeof commandIdSchema>;

/**
 * Event ID: Unique, opaque identifier for every emitted protocol event.
 * Created by the event source (Extension, Content Script, or Desktop Core).
 */
export const eventIdSchema = z.string().min(8).max(128);
export type EventId = z.infer<typeof eventIdSchema>;

/**
 * Idempotency Key: Uniquely identifies mutation intent to prevent duplicate side effects.
 */
export const idempotencyKeySchema = z.string().min(8).max(256);
export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;

/** Legacy numeric generation used only before opaque connection-epoch negotiation. */
export const generationSchema = z.number().int().nonnegative();
export type Generation = z.infer<typeof generationSchema>;

/** Opaque incarnation identity. Equality is meaningful; numeric ordering is not. */
export const epochIdSchema = z.string().min(8).max(128);
export type EpochId = z.infer<typeof epochIdSchema>;

/**
 * Canonical Source and Target endpoints in the transport graph.
 */
export const endpointRoleSchema = z.enum([
  'desktop-main',
  'desktop-renderer',
  'extension-background',
  'content-script',
  'test-harness'
]);
export type EndpointRole = z.infer<typeof endpointRoleSchema>;
