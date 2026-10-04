import type { ChatObservation } from '../session/recorder.js';

export const SHADOW_V0_MAX_OBSERVATIONS = 256;

type ShadowV0Fault = 'projector' | 'processing';

export interface ShadowObservation {
  kind: 'USER_MESSAGE_OBSERVED';
  conversationId: string;
  nativeMessageId: string;
  observedAt: number;
}

interface ShadowCounters {
  admitted: number;
  duplicates: number;
  rejected: number;
  dropped: number;
  failures: number;
}

const retained: ShadowObservation[] = [];
const seenKeys = new Set<string>();
const pending: ShadowObservation[] = [];
const pendingKeys = new Set<string>();
const counters: ShadowCounters = {
  admitted: 0,
  duplicates: 0,
  rejected: 0,
  dropped: 0,
  failures: 0
};

let drainScheduled = false;
let generation = 0;
let testFault: ShadowV0Fault | null = null;

function enabled(): boolean {
  return process.env['CLF_KOSMOSYN_SHADOW_V0'] === '1';
}

function bump(counter: keyof ShadowCounters): void {
  if (counters[counter] < Number.MAX_SAFE_INTEGER) counters[counter] += 1;
}

function dedupeKey(conversationId: string, nativeMessageId: string): string {
  return `${conversationId.length}:${conversationId}${nativeMessageId}`;
}

function validNativeMessageId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 190;
}

function drain(expectedGeneration: number): void {
  if (expectedGeneration !== generation) return;
  drainScheduled = false;
  try {
    if (testFault === 'processing') throw new Error('injected_shadow_v0_processing_failure');
    while (pending.length > 0) {
      const observation = pending.shift()!;
      const key = dedupeKey(observation.conversationId, observation.nativeMessageId);
      pendingKeys.delete(key);
      if (retained.length >= SHADOW_V0_MAX_OBSERVATIONS) {
        bump('dropped');
        continue;
      }
      if (seenKeys.has(key)) {
        bump('duplicates');
        continue;
      }
      retained.push(observation);
      seenKeys.add(key);
      bump('admitted');
    }
  } catch {
    bump('failures');
    pending.length = 0;
    pendingKeys.clear();
  }
}

function scheduleDrain(): void {
  if (drainScheduled || pending.length === 0) return;
  drainScheduled = true;
  const expectedGeneration = generation;
  queueMicrotask(() => drain(expectedGeneration));
}

/**
 * Passive S0 admission from the already-validated legacy /events observations.
 * Only compact native-message identity is projected before the asynchronous drain;
 * transcript text and the original ChatObservation objects are never retained.
 */
export function enqueueShadowV0(conversationId: string, observations: readonly ChatObservation[]): void {
  if (!enabled()) return;
  if (testFault === 'projector') throw new Error('injected_shadow_v0_projector_failure');

  for (const observation of observations) {
    if (observation.kind !== 'user_message') continue;
    if (!validNativeMessageId(observation.messageId)) {
      bump('rejected');
      continue;
    }

    const key = dedupeKey(conversationId, observation.messageId);
    if (seenKeys.has(key) || pendingKeys.has(key)) {
      bump('duplicates');
      continue;
    }
    if (retained.length + pending.length >= SHADOW_V0_MAX_OBSERVATIONS) {
      bump('dropped');
      continue;
    }

    pending.push({
      kind: 'USER_MESSAGE_OBSERVED',
      conversationId,
      nativeMessageId: observation.messageId,
      observedAt: Date.now()
    });
    pendingKeys.add(key);
  }
  scheduleDrain();
}

/** Bridge containment seam for a synchronous Shadow projector failure. */
export function noteShadowV0Failure(): void {
  bump('failures');
}

/** Narrow deterministic test seam; production has no Shadow diagnostics API. */
export function shadowV0SnapshotForTests() {
  return {
    enabled: enabled(),
    capacity: SHADOW_V0_MAX_OBSERVATIONS,
    retained: retained.length,
    pending: pending.length,
    observations: retained.map((observation) => ({ ...observation })),
    counters: { ...counters }
  };
}

export async function settleShadowV0ForTests(): Promise<void> {
  for (let pass = 0; pass < 3 && (drainScheduled || pending.length > 0); pass += 1) {
    await Promise.resolve();
  }
}

export function setShadowV0FaultForTests(fault: ShadowV0Fault | null): void {
  testFault = fault;
}

export function resetShadowV0ForTests(): void {
  generation += 1;
  drainScheduled = false;
  retained.length = 0;
  pending.length = 0;
  seenKeys.clear();
  pendingKeys.clear();
  counters.admitted = 0;
  counters.duplicates = 0;
  counters.rejected = 0;
  counters.dropped = 0;
  counters.failures = 0;
  testFault = null;
}
