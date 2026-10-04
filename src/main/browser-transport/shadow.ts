import type { ChatObservation } from '../session/recorder.js';
import type { TurnOutcome } from '../../shared/session.js';

export const SHADOW_V0_MAX_OBSERVATIONS = 256;
type ShadowV0Fault = 'projector' | 'processing';
type AssistantChange = 'ENTITY_CREATED' | 'LOGICAL_ALIAS_ADDED' | 'PROVIDER_ALIAS_ADDED' | 'FINALIZED' | 'TURN_ASSOCIATED';
export type ShadowObservation =
  | { kind: 'USER_MESSAGE_OBSERVED'; conversationId: string; nativeMessageId: string; browserDocumentId?: string; observedAt: number }
  | { kind: 'ASSISTANT_MESSAGE_OBSERVED'; conversationId: string; firstLogicalMessageId: string; observedLogicalMessageId: string; providerMessageId?: string; state: 'streaming' | 'final'; turnId?: string; changes: AssistantChange[]; eventTime: number; browserDocumentId?: string; observedAt: number }
  | { kind: 'TURN_START_OBSERVED'; conversationId: string; turnId: string; eventTime: number; browserDocumentId?: string; observedAt: number }
  | { kind: 'TURN_END_OBSERVED'; conversationId: string; turnId: string; outcome: TurnOutcome; providerMessageId?: string; reason?: 'thinking_failed'; eventTime: number; browserDocumentId?: string; observedAt: number };

export interface ObservationDocumentMetadata { browserDocumentId?: string; malformed?: boolean }
export const observationDocumentMetadata = new WeakMap<ChatObservation, ObservationDocumentMetadata>();
export function validBrowserDocumentId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
}
interface ShadowCounters { admitted: number; duplicates: number; rejected: number; dropped: number; failures: number }
const retained: ShadowObservation[] = [];
const pending: ShadowObservation[] = [];
const counters: ShadowCounters = { admitted: 0, duplicates: 0, rejected: 0, dropped: 0, failures: 0 };
let drainScheduled = false;
let generation = 0;
let testFault: ShadowV0Fault | null = null;
function enabled(): boolean { return process.env['CLF_KOSMOSYN_SHADOW_V0'] === '1'; }
function bump(counter: keyof ShadowCounters): void { if (counters[counter] < Number.MAX_SAFE_INTEGER) counters[counter] += 1; }
function validId(value: unknown, max = 190): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function allFacts(): ShadowObservation[] { return [...retained, ...pending]; }
function admit(fact: ShadowObservation): void {
  if (retained.length + pending.length >= SHADOW_V0_MAX_OBSERVATIONS) { bump('dropped'); return; }
  pending.push(fact);
}

interface AssistantEntity {
  anchor: string;
  logical: Set<string>;
  providers: Set<string>;
  state: 'streaming' | 'final';
  turnId?: string;
}
/** Reconstruct only from accepted facts. The 256-fact envelope bounds every set here. */
function assistantEntities(conversationId: string): AssistantEntity[] {
  const entities: AssistantEntity[] = [];
  for (const fact of allFacts()) {
    if (fact.kind !== 'ASSISTANT_MESSAGE_OBSERVED' || fact.conversationId !== conversationId) continue;
    let entity = entities.find(item => item.anchor === fact.firstLogicalMessageId);
    if (!entity) {
      entity = { anchor: fact.firstLogicalMessageId, logical: new Set(), providers: new Set(), state: 'streaming' };
      entities.push(entity);
    }
    entity.logical.add(fact.observedLogicalMessageId);
    if (fact.providerMessageId) entity.providers.add(fact.providerMessageId);
    if (fact.state === 'final') entity.state = 'final';
    if (!entity.turnId && fact.turnId) entity.turnId = fact.turnId;
  }
  return entities;
}

function projectAssistant(conversationId: string, observation: ChatObservation, common: { observedAt: number; browserDocumentId?: string }): ShadowObservation | null {
  if (!validId(observation.messageId)) { bump('rejected'); return null; }
  if (observation.providerMessageId !== undefined && !validId(observation.providerMessageId)) { bump('rejected'); return null; }
  const logicalId = observation.messageId;
  const providerId = observation.providerMessageId;
  const entities = assistantEntities(conversationId);
  const logical = entities.find(entity => entity.logical.has(logicalId));
  const providers = providerId ? entities.filter(entity => entity.providers.has(providerId)) : [];
  if (providers.length > 1 || (logical && providers.length === 1 && providers[0] !== logical)) { bump('rejected'); return null; }
  const entity = logical ?? providers[0];
  const changes: AssistantChange[] = [];
  if (!entity) changes.push('ENTITY_CREATED');
  else if (!entity.logical.has(logicalId)) changes.push('LOGICAL_ALIAS_ADDED');
  if (providerId && !entity?.providers.has(providerId)) changes.push('PROVIDER_ALIAS_ADDED');
  const nextState = observation.state === 'final' || observation.final === true ? 'final' : 'streaming';
  if (nextState === 'final' && entity?.state !== 'final') changes.push('FINALIZED');
  const turnId = validId(observation.turnId) && (!entity?.turnId || entity.turnId === observation.turnId) ? observation.turnId : undefined;
  if (turnId && !entity?.turnId) changes.push('TURN_ASSOCIATED');
  if (changes.length === 0) { bump('duplicates'); return null; }
  return { kind: 'ASSISTANT_MESSAGE_OBSERVED', conversationId,
    firstLogicalMessageId: entity?.anchor ?? logicalId, observedLogicalMessageId: logicalId,
    ...(providerId ? { providerMessageId: providerId } : {}), state: entity?.state === 'final' ? 'final' : nextState,
    ...(turnId ? { turnId } : {}), changes, eventTime: observation.time, ...common };
}

const outcomes: readonly TurnOutcome[] = ['completed', 'failed', 'stopped', 'interrupted', 'stalled', 'unknown'];
function projectTurnEnd(conversationId: string, observation: ChatObservation, common: { observedAt: number; browserDocumentId?: string }): ShadowObservation | null {
  if (!validId(observation.turnId) || !outcomes.includes(observation.outcome as TurnOutcome)) { bump('rejected'); return null; }
  const prior = allFacts().filter((fact): fact is Extract<ShadowObservation, { kind: 'TURN_END_OBSERVED' }> =>
    fact.kind === 'TURN_END_OBSERVED' && fact.conversationId === conversationId && fact.turnId === observation.turnId);
  if (prior.some(fact => fact.outcome === observation.outcome)) { bump('duplicates'); return null; }
  if (observation.outcome === 'stopped' && prior.some(fact => observation.time < fact.eventTime)) { bump('duplicates'); return null; }
  return { kind: 'TURN_END_OBSERVED', conversationId, turnId: observation.turnId, outcome: observation.outcome!,
    ...(validId(observation.providerMessageId) ? { providerMessageId: observation.providerMessageId } : {}),
    ...(observation.reason === 'thinking_failed' ? { reason: observation.reason } : {}), eventTime: observation.time, ...common };
}

function drain(expectedGeneration: number): void {
  if (expectedGeneration !== generation) return;
  drainScheduled = false;
  try {
    if (testFault === 'processing') throw new Error('injected_shadow_v0_processing_failure');
    while (pending.length > 0) { retained.push(pending.shift()!); bump('admitted'); }
  } catch { bump('failures'); pending.length = 0; }
}
function scheduleDrain(): void {
  if (drainScheduled || pending.length === 0) return;
  drainScheduled = true;
  const expectedGeneration = generation;
  queueMicrotask(() => drain(expectedGeneration));
}
/** Passive projection of compact browser evidence outside production recorder authority. */
export function enqueueShadowV0(conversationId: string, observations: readonly ChatObservation[]): void {
  if (!enabled()) return;
  if (testFault === 'projector') throw new Error('injected_shadow_v0_projector_failure');
  for (const observation of observations) {
    if (!['user_message', 'assistant_message', 'turn_start', 'turn_end'].includes(observation.kind)) continue;
    const meta = observationDocumentMetadata.get(observation);
    if (meta?.malformed || (meta?.browserDocumentId !== undefined && !validBrowserDocumentId(meta.browserDocumentId))) { bump('rejected'); continue; }
    const common = { observedAt: Date.now(), ...(meta?.browserDocumentId ? { browserDocumentId: meta.browserDocumentId } : {}) };
    let fact: ShadowObservation | null = null;
    if (observation.kind === 'user_message') {
      if (!validId(observation.messageId)) { bump('rejected'); continue; }
      if (allFacts().some(item => item.kind === 'USER_MESSAGE_OBSERVED' && item.conversationId === conversationId && item.nativeMessageId === observation.messageId)) { bump('duplicates'); continue; }
      fact = { kind: 'USER_MESSAGE_OBSERVED', conversationId, nativeMessageId: observation.messageId, ...common };
    } else if (observation.kind === 'assistant_message') fact = projectAssistant(conversationId, observation, common);
    else if (observation.kind === 'turn_start') {
      if (!validId(observation.turnId)) { bump('rejected'); continue; }
      if (allFacts().some(item => item.kind === 'TURN_START_OBSERVED' && item.conversationId === conversationId && item.turnId === observation.turnId)) { bump('duplicates'); continue; }
      fact = { kind: 'TURN_START_OBSERVED', conversationId, turnId: observation.turnId, eventTime: observation.time, ...common };
    } else fact = projectTurnEnd(conversationId, observation, common);
    if (fact) admit(fact);
  }
  scheduleDrain();
}
export function noteShadowV0Failure(): void { bump('failures'); }
/** Narrow deterministic test seam; production has no Shadow diagnostics API. */
export function shadowV0SnapshotForTests() {
  const entities = new Set<string>();
  const logical = new Set<string>();
  const provider = new Set<string>();
  for (const fact of allFacts()) if (fact.kind === 'ASSISTANT_MESSAGE_OBSERVED') {
    const prefix = `${fact.conversationId.length}:${fact.conversationId}`;
    entities.add(prefix + fact.firstLogicalMessageId);
    logical.add(prefix + fact.observedLogicalMessageId);
    if (fact.providerMessageId) provider.add(prefix + fact.providerMessageId);
  }
  return { enabled: enabled(), capacity: SHADOW_V0_MAX_OBSERVATIONS, retained: retained.length, pending: pending.length,
    observations: retained.map(fact => ({ ...fact, ...(fact.kind === 'ASSISTANT_MESSAGE_OBSERVED' ? { changes: [...fact.changes] } : {}) })) as Array<ShadowObservation & { nativeMessageId?: string }>,
    aliasCounts: { entities: entities.size, logical: logical.size, provider: provider.size }, counters: { ...counters } };
}
export async function settleShadowV0ForTests(): Promise<void> {
  for (let pass = 0; pass < 3 && (drainScheduled || pending.length > 0); pass += 1) await Promise.resolve();
}
export function setShadowV0FaultForTests(fault: ShadowV0Fault | null): void { testFault = fault; }
export function resetShadowV0ForTests(): void {
  generation += 1; drainScheduled = false; retained.length = 0; pending.length = 0;
  counters.admitted = 0; counters.duplicates = 0; counters.rejected = 0; counters.dropped = 0; counters.failures = 0;
  testFault = null;
}
