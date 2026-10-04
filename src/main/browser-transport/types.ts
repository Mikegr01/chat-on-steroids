import type { CommandState, ProtocolCommand, CommitProofLevel, EndpointRole, ProtocolEventType } from '../../shared/protocol/index.js';

export type TransportState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING';

/**
 * Durable record for a protocol command stored in the outbox.
 */
export interface DurableCommandRecord {
  command: ProtocolCommand;
  state: CommandState;
  createdAt: number;
  updatedAt: number;
  persistedAt: number;
  dispatchedAt: number | null;
  claimedAt: number | null;
  owner: string | null; // Document/tab client lease holder
  claimLeaseUntil: number | null;
  committedAt: number | null;
  commitProofLevel: CommitProofLevel | null;
  nativeMessageId: string | null;
  commitConversationId: string | null;
  completedAt: number | null;
  attempts: number;
  lastError: string | null;
  cancellationRequested: boolean;
  reconciledOnRestart?: boolean;
  activeEmitterEpochBySource?: Partial<Record<EndpointRole, string>>;
  orderingBySource?: Partial<Record<EndpointRole, {
    emitterEpoch?: string;
    sequence: number;
    eventType: ProtocolEventType;
    payloadIdentity: string;
  }>>;
}

/**
 * Durable protocol state snapshot persisted on disk via durable.ts.
 */
export interface ProtocolStoreSnapshot {
  version: number;
  instanceId: string;
  commands: Record<string, DurableCommandRecord>;
  recentCommittedIds: string[];
}
