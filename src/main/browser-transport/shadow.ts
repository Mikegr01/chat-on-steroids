import type { ChatObservation } from '../session/recorder.js';
import type { TurnOutcome } from '../../shared/session.js';
import { getConfirmedBrowserInputReceipts, type ConfirmedBrowserInputReceipt } from '../session/input.js';
import { sendMessagePayloadSchema } from '../../shared/protocol/commands.js';

export const SHADOW_V0_MAX_OBSERVATIONS = 256;
export const SHADOW_S5_RESOLUTION_HORIZON_MS = 300000;
type ShadowV0Fault = 'projector' | 'processing' | 's5-evaluator' | 's5-accounting';
type ShadowS5Policy =
  | { policyVerdict: 'WOULD_ADMIT' }
  | { policyVerdict: 'WOULD_REJECT'; policyRejectReason: 'TEXT_OUT_OF_BOUNDS' | 'MISSING_TARGET_CONVERSATION_ID' | 'TARGET_CONVERSATION_ID_OUT_OF_BOUNDS' | 'MEDIA_NOT_REPRESENTABLE' | 'MODEL_OUT_OF_BOUNDS' | 'REASONING_EFFORT_OUT_OF_BOUNDS' }
  | { policyVerdict: 'NOT_EVALUABLE'; policyRejectReason: 'LEGACY_DECISION_SEMANTICS_NOT_MAPPED' };
/** Transient scalar projection of the exact successful claim; never an InputEntry reference. */
export interface LegacyBrowserClaimPolicyInput {
  readonly text: string;
  readonly targetConversationId: string | null | undefined;
  readonly purpose?: string;
  readonly model?: string | null;
  readonly reasoningEffort?: string | null;
  readonly hasMedia: boolean;
}
type ShadowS5Claim = { kind: 'LEGACY_BROWSER_CLAIM_DECISION'; legacyInputId: string; runtimeReadiness: 'NOT_ARMED'; claimedAt: number;
  conversationId?: never; browserDocumentId?: never } & ShadowS5Policy;
type ShadowS5Outcome = 'CLAIMED' | 'CONFIRMED_SENT' | 'DEFERRED_OR_UNKNOWN';
type ShadowS5Classification = 'PROVISIONAL' | 'AGREED_ADMIT' | 'LEGACY_ALLOWED_PROTOCOL_REJECTED' | 'NOT_COMPARABLE';
type AssistantChange = 'ENTITY_CREATED' | 'LOGICAL_ALIAS_ADDED' | 'PROVIDER_ALIAS_ADDED' | 'FINALIZED' | 'TURN_ASSOCIATED';
export type ShadowObservation =
  | ShadowS5Claim
  | { kind: 'USER_MESSAGE_OBSERVED'; conversationId: string; nativeMessageId: string; browserDocumentId?: string; observedAt: number }
  | { kind: 'ASSISTANT_MESSAGE_OBSERVED'; conversationId: string; firstLogicalMessageId: string; observedLogicalMessageId: string; providerMessageId?: string; state: 'streaming' | 'final'; turnId?: string; changes: AssistantChange[]; eventTime: number; browserDocumentId?: string; observedAt: number }
  | { kind: 'TURN_START_OBSERVED'; conversationId: string; turnId: string; eventTime: number; browserDocumentId?: string; observedAt: number }
  | { kind: 'TURN_END_OBSERVED'; conversationId: string; turnId: string; outcome: TurnOutcome; providerMessageId?: string; reason?: 'thinking_failed'; eventTime: number; browserDocumentId?: string; observedAt: number }
  | { kind: 'LEGACY_INPUT_NATIVE_CORRELATED'; legacyInputIds: [string] | [string, string]; conversationId: string; nativeMessageId: string; browserDocumentId?: string; evidence: 'INPUT_ACK_AND_SHADOW'; observedAt: number };

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
// One append-only diagnostic sample. Once evidence is lost/conflicting, suppress all
// comparisons until reset rather than guessing affected IDs or retaining another index.
let s5EvidenceIntegrityLost = false;
let lastShadowActivityAt = 0;
function enabled(): boolean { return process.env['CLF_KOSMOSYN_SHADOW_V0'] === '1'; }
function bump(counter: keyof ShadowCounters): void {
  if (testFault === 's5-accounting') throw new Error('injected_shadow_s5_accounting_failure');
  if (counters[counter] < Number.MAX_SAFE_INTEGER) counters[counter] += 1;
}
function validId(value: unknown, max = 190): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function allFacts(): ShadowObservation[] { return [...retained, ...pending]; }
function admit(fact: ShadowObservation): void {
  if (retained.length + pending.length >= SHADOW_V0_MAX_OBSERVATIONS) { s5EvidenceIntegrityLost = true; bump('dropped'); return; }
  pending.push(fact);
}

/** Intrinsic representability only: no command allocation, runtime/capability checks or I/O. */
export function evaluateLegacySendMessagePolicy(input: LegacyBrowserClaimPolicyInput): ShadowS5Policy {
  if (input.purpose === 'decision') return { policyVerdict: 'NOT_EVALUABLE', policyRejectReason: 'LEGACY_DECISION_SEMANTICS_NOT_MAPPED' };
  const fields = sendMessagePayloadSchema.shape;
  if (!fields.text.safeParse(input.text).success) return { policyVerdict: 'WOULD_REJECT', policyRejectReason: 'TEXT_OUT_OF_BOUNDS' };
  if (input.targetConversationId == null) return { policyVerdict: 'WOULD_REJECT', policyRejectReason: 'MISSING_TARGET_CONVERSATION_ID' };
  if (!fields.targetConversationId.safeParse(input.targetConversationId).success) return { policyVerdict: 'WOULD_REJECT', policyRejectReason: 'TARGET_CONVERSATION_ID_OUT_OF_BOUNDS' };
  if (input.hasMedia) return { policyVerdict: 'WOULD_REJECT', policyRejectReason: 'MEDIA_NOT_REPRESENTABLE' };
  if (!fields.model.safeParse(input.model).success) return { policyVerdict: 'WOULD_REJECT', policyRejectReason: 'MODEL_OUT_OF_BOUNDS' };
  if (!fields.reasoningEffort.safeParse(input.reasoningEffort).success) return { policyVerdict: 'WOULD_REJECT', policyRejectReason: 'REASONING_EFFORT_OUT_OF_BOUNDS' };
  return { policyVerdict: 'WOULD_ADMIT' };
}

/** Synchronous, bounded and disposable. No caller object or private payload is retained. */
export function observeLegacyBrowserClaim(input: LegacyBrowserClaimPolicyInput & { readonly legacyInputId: string }): void {
  if (!enabled()) return;
  try {
    lastShadowActivityAt = Date.now();
    if (!validId(input.legacyInputId)) { bump('rejected'); return; }
    if (allFacts().some(fact => fact.kind === 'LEGACY_BROWSER_CLAIM_DECISION' && fact.legacyInputId === input.legacyInputId)) { bump('duplicates'); return; }
    if (retained.length + pending.length >= SHADOW_V0_MAX_OBSERVATIONS) { s5EvidenceIntegrityLost = true; bump('dropped'); return; }
    if (testFault === 's5-evaluator') throw new Error('injected_shadow_s5_evaluator_failure');
    const policy = evaluateLegacySendMessagePolicy(input);
    // Account before publication: even a diagnostic accounting failure drops only the sample.
    bump('admitted');
    retained.push({ kind: 'LEGACY_BROWSER_CLAIM_DECISION', legacyInputId: input.legacyInputId,
      ...policy, runtimeReadiness: 'NOT_ARMED', claimedAt: lastShadowActivityAt });
  } catch {
    s5EvidenceIntegrityLost = true;
    try { noteShadowV0Failure(); } catch { /* Diagnostic accounting cannot affect delivery. */ }
  }
}

/** Derive comparisons from the shared facts, without a second result store or per-send clock. */
export function shadowS5SnapshotForTests(): Array<ShadowS5Claim & { legacyOutcome: ShadowS5Outcome; classification: ShadowS5Classification }> {
  if (!enabled()) return [];
  const facts = allFacts();
  return retained.filter((fact): fact is ShadowS5Claim => fact.kind === 'LEGACY_BROWSER_CLAIM_DECISION').map(fact => {
    const confirmed = facts.some(item => item.kind === 'LEGACY_INPUT_NATIVE_CORRELATED' && item.legacyInputIds.includes(fact.legacyInputId));
    const legacyOutcome: ShadowS5Outcome = s5EvidenceIntegrityLost ? 'DEFERRED_OR_UNKNOWN' : confirmed ? 'CONFIRMED_SENT'
      : lastShadowActivityAt - fact.claimedAt >= SHADOW_S5_RESOLUTION_HORIZON_MS ? 'DEFERRED_OR_UNKNOWN' : 'CLAIMED';
    const classification: ShadowS5Classification = fact.policyVerdict === 'NOT_EVALUABLE' || legacyOutcome === 'DEFERRED_OR_UNKNOWN' ? 'NOT_COMPARABLE'
      : legacyOutcome === 'CLAIMED' ? 'PROVISIONAL' : fact.policyVerdict === 'WOULD_ADMIT' ? 'AGREED_ADMIT' : 'LEGACY_ALLOWED_PROTOCOL_REJECTED';
    return { ...fact, legacyOutcome, classification };
  });
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
  } catch { s5EvidenceIntegrityLost = true; pending.length = 0; try { bump('failures'); } catch {} }
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
  lastShadowActivityAt = Date.now();
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
export function noteShadowV0Failure(): void { s5EvidenceIntegrityLost = true; bump('failures'); }

let correlationInFlight: Promise<void> | null = null;
let activeCorrelationToken: object | null = null;
let rerunRequested = false;
let receiptReaderForTests: (() => Promise<readonly ConfirmedBrowserInputReceipt[]>) | null = null;
/** Test-only source override for deterministic blocked snapshot reads. */
export function setShadowS3ReceiptReaderForTests(reader: (() => Promise<readonly ConfirmedBrowserInputReceipt[]>) | null): void {
  receiptReaderForTests = reader;
}

/** Strong Kosmosyn S3 correlation between confirmed browser InputEntry obligations and S2 native user-message observations. */
async function executeCorrelation(explicitReceipts?: readonly ConfirmedBrowserInputReceipt[]): Promise<void> {
  if (!enabled()) return;
  lastShadowActivityAt = Date.now();
  const expectedGeneration = generation;
  if (testFault === 'projector') { s5EvidenceIntegrityLost = true; throw new Error('injected_shadow_v0_projector_failure'); }
    let receipts: readonly ConfirmedBrowserInputReceipt[];
    try {
      receipts = explicitReceipts ?? await (receiptReaderForTests ?? getConfirmedBrowserInputReceipts)();
    } catch {
      if (expectedGeneration === generation) noteShadowV0Failure();
      return;
    }

    if (expectedGeneration !== generation) return;

    lastShadowActivityAt = Date.now();
    if (!Array.isArray(receipts)) { s5EvidenceIntegrityLost = true; return; }

    const validReceipts = receipts.filter(r =>
      typeof r?.legacyInputId === 'string' && r.legacyInputId.length > 0 &&
      typeof r?.conversationId === 'string' && r.conversationId.length > 0 &&
      typeof r?.nativeMessageId === 'string' && r.nativeMessageId.length > 0 && !r.nativeMessageId.startsWith('input:') &&
      typeof r?.deliveredAt === 'number' && Number.isFinite(r.deliveredAt) &&
      ['sent', 'cancelled', 'decision'].includes(r.deliveryState)
    );

    // A later snapshot that loses any accepted positive evidence cannot reuse that
    // retained fact to manufacture an S5 agreement. This fence changes no S3 fact.
    for (const fact of allFacts()) if (fact.kind === 'LEGACY_INPUT_NATIVE_CORRELATED' &&
      fact.legacyInputIds.some(id => !validReceipts.some(receipt => receipt.legacyInputId === id &&
        receipt.conversationId === fact.conversationId && receipt.nativeMessageId === fact.nativeMessageId))) s5EvidenceIntegrityLost = true;
    if (validReceipts.length === 0) return;

    // Group receipts by exact native tuple: `${conversationId}:::${nativeMessageId}`
    const groups = new Map<string, ConfirmedBrowserInputReceipt[]>();
    for (const r of validReceipts) {
      const key = `${r.conversationId}:::${r.nativeMessageId}`;
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }

    interface CandidateSend {
      legacyInputIds: [string] | [string, string];
      conversationId: string;
      nativeMessageId: string;
    }

    const candidates: CandidateSend[] = [];

    for (const group of groups.values()) {
      if (group.length === 1) {
        const item = group[0]!;
        if (item.companionInputId) {
          // Companion relation incomplete / missing companion with same tuple
          s5EvidenceIntegrityLost = true;
          continue;
        }
        candidates.push({
          legacyInputIds: [item.legacyInputId],
          conversationId: item.conversationId,
          nativeMessageId: item.nativeMessageId
        });
      } else if (group.length === 2) {
        const a = group[0];
        const b = group[1];
        if (a && b) {
          if (a.companionInputId === b.legacyInputId && !b.companionInputId) {
            candidates.push({
              legacyInputIds: [a.legacyInputId, b.legacyInputId],
              conversationId: a.conversationId,
              nativeMessageId: a.nativeMessageId
            });
          } else if (b.companionInputId === a.legacyInputId && !a.companionInputId) {
            candidates.push({
              legacyInputIds: [b.legacyInputId, a.legacyInputId],
              conversationId: a.conversationId,
              nativeMessageId: a.nativeMessageId
            });
          } else {
            // Unrelated entries sharing the same native tuple: REJECT_CONFLICT
            s5EvidenceIntegrityLost = true;
            bump('rejected');
          }
        }
      } else {
        // More than 2 entries sharing same native tuple: REJECT_CONFLICT
        s5EvidenceIntegrityLost = true;
        bump('rejected');
      }
    }

    const existingCorrelated = allFacts().filter((f): f is Extract<ShadowObservation, { kind: 'LEGACY_INPUT_NATIVE_CORRELATED' }> =>
      f.kind === 'LEGACY_INPUT_NATIVE_CORRELATED'
    );

    for (const candidate of candidates) {
      let isDuplicate = false;
      let hasConflict = false;

      for (const existing of existingCorrelated) {
        const exactSameIds =
          existing.legacyInputIds.length === candidate.legacyInputIds.length &&
          existing.legacyInputIds.every(id => candidate.legacyInputIds.includes(id));

        if (exactSameIds) {
          if (
            existing.conversationId === candidate.conversationId &&
            existing.nativeMessageId === candidate.nativeMessageId
          ) {
            isDuplicate = true;
            break;
          } else {
            hasConflict = true;
            break;
          }
        } else {
          const sharesId = candidate.legacyInputIds.some(id => existing.legacyInputIds.includes(id));
          if (sharesId) {
            hasConflict = true;
            break;
          }
          if (
            existing.conversationId === candidate.conversationId &&
            existing.nativeMessageId === candidate.nativeMessageId
          ) {
            hasConflict = true;
            break;
          }
        }
      }

      if (hasConflict) {
        s5EvidenceIntegrityLost = true;
        bump('rejected');
        continue;
      }
      if (isDuplicate) {
        bump('duplicates');
        continue;
      }

      // Check S2 native user message observation
      const userFact = allFacts().find((f): f is Extract<ShadowObservation, { kind: 'USER_MESSAGE_OBSERVED' }> =>
        f.kind === 'USER_MESSAGE_OBSERVED' &&
        f.conversationId === candidate.conversationId &&
        f.nativeMessageId === candidate.nativeMessageId
      );

      if (!userFact) {
        // Observation has not arrived yet; cannot correlate
        continue;
      }

      const fact: ShadowObservation = {
        kind: 'LEGACY_INPUT_NATIVE_CORRELATED',
        legacyInputIds: candidate.legacyInputIds,
        conversationId: candidate.conversationId,
        nativeMessageId: candidate.nativeMessageId,
        ...(userFact.browserDocumentId ? { browserDocumentId: userFact.browserDocumentId } : {}),
        evidence: 'INPUT_ACK_AND_SHADOW',
        observedAt: Date.now()
      };

      // Also fence contradictions among candidates in this very pass. Existing S3
      // admission semantics remain authoritative; S5 never promotes conflicting proof.
      if (allFacts().some(existing => existing.kind === 'LEGACY_INPUT_NATIVE_CORRELATED' &&
        (existing.legacyInputIds.some(id => candidate.legacyInputIds.includes(id)) ||
          (existing.conversationId === candidate.conversationId && existing.nativeMessageId === candidate.nativeMessageId)))) s5EvidenceIntegrityLost = true;
      admit(fact);
    }

    scheduleDrain();
}

/** Direct deterministic correlation seam for tests with explicit receipts. */
export async function correlateShadowS3(explicitReceipts?: readonly ConfirmedBrowserInputReceipt[]): Promise<void> {
  await executeCorrelation(explicitReceipts);
}

/** Production trigger: an active pass retains only one coalesced rerun bit. */
export function requestShadowS3Correlation(): void {
  if (!enabled()) return;
  if (activeCorrelationToken) { rerunRequested = true; return; }
  const token = {};
  activeCorrelationToken = token;
  const run = (async () => {
    try {
      do {
        rerunRequested = false;
        try { await executeCorrelation(); }
        catch { try { noteShadowV0Failure(); } catch {} }
      } while (activeCorrelationToken === token && rerunRequested);
    } finally {
      if (activeCorrelationToken === token) {
        activeCorrelationToken = null;
        rerunRequested = false;
        correlationInFlight = null;
      }
    }
  })();
  correlationInFlight = run;
}

/** Narrow test-only scheduler diagnostic. */
export function shadowS3SchedulerForTests() { return { active: activeCorrelationToken !== null, rerunRequested }; }

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
    observations: retained.map(fact => ({
      ...fact,
      ...(fact.kind === 'ASSISTANT_MESSAGE_OBSERVED' ? { changes: [...fact.changes] } : {}),
      ...(fact.kind === 'LEGACY_INPUT_NATIVE_CORRELATED' ? { legacyInputIds: [...fact.legacyInputIds] } : {})
    })) as Array<ShadowObservation & { nativeMessageId?: string; legacyInputIds?: string[] }>,
    aliasCounts: { entities: entities.size, logical: logical.size, provider: provider.size }, counters: { ...counters } };
}
export async function settleShadowV0ForTests(): Promise<void> {
  if (correlationInFlight) {
    try { await correlationInFlight; } catch {}
  }
  for (let pass = 0; pass < 5 && (drainScheduled || pending.length > 0); pass += 1) await Promise.resolve();
}
export function setShadowV0FaultForTests(fault: ShadowV0Fault | null): void { testFault = fault; }
export function resetShadowV0ForTests(): void {
  generation += 1; drainScheduled = false; retained.length = 0; pending.length = 0;
  counters.admitted = 0; counters.duplicates = 0; counters.rejected = 0; counters.dropped = 0; counters.failures = 0;
  testFault = null;
  correlationInFlight = null;
  activeCorrelationToken = null;
  rerunRequested = false;
  receiptReaderForTests = null;
  s5EvidenceIntegrityLost = false;
  lastShadowActivityAt = 0;
}
