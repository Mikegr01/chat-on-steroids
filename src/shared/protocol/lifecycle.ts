import { z } from 'zod';

/**
 * Command Lifecycle States.
 * Every state transition has a concrete, verifiable meaning.
 */
export const CommandState = {
  CREATED: 'CREATED',
  PERSISTED: 'PERSISTED',
  DISPATCHED: 'DISPATCHED',
  CLAIMED: 'CLAIMED',
  EXECUTING: 'EXECUTING',
  COMMITTED: 'COMMITTED',
  COMPLETED: 'COMPLETED',
  // Exception states
  BLOCKED: 'BLOCKED',
  AMBIGUOUS: 'AMBIGUOUS',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  CANCELED: 'CANCELED'
} as const;

export const commandStateSchema = z.enum([
  'CREATED',
  'PERSISTED',
  'DISPATCHED',
  'CLAIMED',
  'EXECUTING',
  'COMMITTED',
  'COMPLETED',
  'BLOCKED',
  'AMBIGUOUS',
  'FAILED',
  'EXPIRED',
  'CANCELED'
]);
export type CommandState = z.infer<typeof commandStateSchema>;

/**
 * Commit Proof Levels for mutating commands (e.g. SEND_MESSAGE).
 */
export const CommitProofLevel = {
  /** Concrete, unambiguous evidence: matching user message rendered in DOM with ID in target chat */
  STRONG_COMMIT: 'STRONG_COMMIT',
  /** Preliminary evidence: composer text cleared or generation stop button appeared */
  WEAK_COMMIT: 'WEAK_COMMIT',
  /** Dispatched mutation whose outcome cannot be proven or disproven without reconciliation */
  AMBIGUOUS: 'AMBIGUOUS'
} as const;

export const commitProofLevelSchema = z.enum([
  'STRONG_COMMIT',
  'WEAK_COMMIT',
  'AMBIGUOUS'
]);
export type CommitProofLevel = z.infer<typeof commitProofLevelSchema>;

/**
 * Valid state transitions for the command state machine.
 */
export const VALID_TRANSITIONS: Readonly<Record<CommandState, readonly CommandState[]>> = {
  CREATED: ['PERSISTED', 'FAILED', 'CANCELED'],
  PERSISTED: ['DISPATCHED', 'BLOCKED', 'FAILED', 'EXPIRED', 'CANCELED', 'AMBIGUOUS'],
  DISPATCHED: ['CLAIMED', 'BLOCKED', 'FAILED', 'EXPIRED', 'CANCELED', 'AMBIGUOUS'],
  CLAIMED: ['EXECUTING', 'COMMITTED', 'FAILED', 'EXPIRED', 'CANCELED', 'AMBIGUOUS'],
  EXECUTING: ['COMMITTED', 'FAILED', 'EXPIRED', 'CANCELED', 'AMBIGUOUS'],
  COMMITTED: ['COMPLETED', 'FAILED', 'AMBIGUOUS'],
  COMPLETED: [],
  BLOCKED: ['PERSISTED', 'CANCELED', 'FAILED'], // Can be retried if block reason resolved
  AMBIGUOUS: ['COMMITTED', 'FAILED', 'CANCELED'], // Requires explicit reconciliation
  FAILED: [],
  EXPIRED: [],
  CANCELED: ['COMMITTED'] // External physical commit in DOM overrides cancellation intent
};

export function isValidTransition(from: CommandState, to: CommandState): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export function isTerminalState(state: CommandState): boolean {
  return (
    state === 'COMPLETED' ||
    state === 'FAILED' ||
    state === 'EXPIRED' ||
    state === 'CANCELED'
  );
}
