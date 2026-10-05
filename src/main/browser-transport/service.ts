import { createHmac, randomUUID } from 'node:crypto';
import type { TransportAdapter } from './adapter.js';
import { ProtocolStore, isRealMutationCommit } from './store.js';
import { EventDeduplicator } from './dedupe.js';
import type { DurableCommandRecord } from './types.js';
import {
  PROTOCOL_VERSION,
  protocolCommandPayloadSchema,
  type ProtocolCommand,
  type ProtocolEvent,
  type CommandState,
  type CommandType,
  type ProtocolCommandInputMap,
  type ProtocolCommandPayloadMap,
  type ProtocolErrorCode,
  isValidCommandTransition,
  parseProtocolEvent,
  type HandshakeHello,
  type HandshakeWelcome,
  type HandshakeReject,
  ProtocolCapability
} from '../../shared/protocol/index.js';
import { logInfo, logWarn } from '../logger.js';

function isValidProbeCompletionPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== 'observedTabCount') {
    return false;
  }
  const count = (payload as Record<string, unknown>).observedTabCount;
  if (typeof count !== 'number' || !Number.isSafeInteger(count)) {
    return false;
  }
  return count >= 0 && count <= 10000;
}

function semanticPayloadIdentity(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(semanticPayloadIdentity).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${semanticPayloadIdentity(entry)}`).join(',')}}`;
}

export interface ServiceOptions {
  instanceId: string;
  defaultLeaseTimeoutMs?: number;
  maxRecentEvents?: number;
}

/**
 * BrowserTransportService.
 *
 * Authoritative coordinator of protocol commands, durable outbox,
 * event ledger, idempotency, and reconciliation.
 */
export class BrowserTransportService {
  private readonly instanceId: string;
  private readonly defaultLeaseTimeoutMs: number;
  private readonly adapter: TransportAdapter;
  private readonly store: ProtocolStore;
  private readonly dedupe: EventDeduplicator;
  private currentGeneration = 1;
  private currentConnectionEpoch: string | null = null;
  private negotiatedCapabilities: Set<ProtocolCapability> = new Set();
  private isHandshakeReady = false;
  private unregisterAdapterListeners?: () => void;
  private eventListeners: Set<(event: ProtocolEvent) => void> = new Set();
  private commandStateListeners: Set<(record: DurableCommandRecord) => void> = new Set();
  private eventHandling: Promise<void> = Promise.resolve();
  // Count evidence is transient. Keep collision detection without storing the
  // completion payload (or a brute-forceable count digest) in ordering metadata.
  private readonly probeOrderingKey = randomUUID();

  constructor(adapter: TransportAdapter, options?: ServiceOptions) {
    this.adapter = adapter;
    this.instanceId = options?.instanceId ?? randomUUID();
    this.defaultLeaseTimeoutMs = options?.defaultLeaseTimeoutMs ?? 30000;
    this.store = new ProtocolStore(this.instanceId);
    this.dedupe = new EventDeduplicator(options?.maxRecentEvents ?? 1000);
  }

  public async start(): Promise<void> {
    await this.store.load();
    const unsubMsg = this.adapter.onMessage((msg) => this.handleRawIncomingMessage(msg));
    this.unregisterAdapterListeners = unsubMsg;
    await this.reconcileOnRestart();
  }

  public async stop(): Promise<void> {
    if (this.unregisterAdapterListeners) {
      this.unregisterAdapterListeners();
      this.unregisterAdapterListeners = undefined;
    }
    await this.eventHandling;
    await this.store.flushImmediate();
  }

  public getStore(): ProtocolStore {
    return this.store;
  }

  public getGeneration(): number {
    return this.currentGeneration;
  }

  public advanceGeneration(): number {
    this.currentGeneration++;
    return this.currentGeneration;
  }

  /**
   * Creates a typed protocol command.
   */
  public createCommand<K extends CommandType>(
    commandType: K,
    payload: ProtocolCommandInputMap[K],
    options: {
      sessionId: string;
      conversationId?: string | null;
      idempotencyKey?: string;
      expiresInMs?: number;
    }
  ): ProtocolCommand<ProtocolCommandPayloadMap[K]> {
    const now = Date.now();
    const commandId = `cmd_${randomUUID()}`;
    const idempotencyKey = options.idempotencyKey ?? `idemp_${randomUUID()}`;
    const expiresAt = now + (options.expiresInMs ?? this.defaultLeaseTimeoutMs);

    const validated = protocolCommandPayloadSchema.parse({
      commandType,
      payload
    });

    return {
      protocolVersion: PROTOCOL_VERSION,
      commandId,
      commandType,
      source: 'desktop-main',
      target: 'extension-background',
      sessionId: options.sessionId,
      conversationId: options.conversationId ?? null,
      owner: null,
      // Legacy V1 field retained for wire compatibility only. Durable intent is
      // deliberately not bound to a process-local transport incarnation.
      generation: 0,
      createdAt: now,
      expiresAt,
      idempotencyKey,
      payload: validated.payload as ProtocolCommandPayloadMap[K]
    };
  }

  /**
   * Persists a command to durable storage, then dispatches it over the transport.
   * Atomic commit barrier: Command is durable BEFORE wire transmission.
   */
  public async submitCommand<T>(command: ProtocolCommand<T>): Promise<DurableCommandRecord> {
    // 1. Idempotency check: see if a command with this key already exists
    const existing = this.store.findByIdempotencyKey(command.idempotencyKey);
    if (existing) {
      const existingCmd = existing.command;
      const isSameType = existingCmd.commandType === command.commandType;
      const isSameSession = existingCmd.sessionId === command.sessionId;
      const isSameConv = existingCmd.conversationId === command.conversationId;
      const isSamePayload = JSON.stringify(existingCmd.payload) === JSON.stringify(command.payload);

      if (isSameType && isSameSession && isSameConv && isSamePayload) {
        logInfo(`protocol: idempotency hit for key ${command.idempotencyKey}, returning existing record ${existing.command.commandId}`);
        return existing;
      }

      logWarn(`protocol: idempotency collision for key ${command.idempotencyKey} with conflicting payload or parameters`);
      throw new Error(`IDEMPOTENCY_CONFLICT: Idempotency key ${command.idempotencyKey} already exists with different payload or parameters`);
    }

    const now = Date.now();
    const record: DurableCommandRecord = {
      command: command as ProtocolCommand,
      state: 'PERSISTED',
      createdAt: command.createdAt,
      updatedAt: now,
      persistedAt: now,
      dispatchedAt: null,
      claimedAt: null,
      owner: null,
      claimLeaseUntil: null,
      committedAt: null,
      commitProofLevel: null,
      nativeMessageId: null,
      commitConversationId: null,
      completedAt: null,
      attempts: 0,
      lastError: null,
      cancellationRequested: false
    };

    // 2. Persist to disk BEFORE dispatch attempt
    await this.store.persistNewCommand(record);
    this.notifyCommandState(record);

    // 3. Attempt dispatch
    await this.dispatchRecord(record);
    return record;
  }

  /**
   * Dispatches an already-persisted command to the active transport.
   */
  public async dispatchRecord(record: DurableCommandRecord): Promise<boolean> {
    if (record.state !== 'PERSISTED' && record.state !== 'BLOCKED') {
      logWarn(`protocol: cannot dispatch command ${record.command.commandId} from state ${record.state}`);
      return false;
    }

    // Capability gate: ensure peer supports required capability if handshake capabilities have been negotiated
    if (this.negotiatedCapabilities.size > 0) {
      const requiredCapability = this.getRequiredCapability(record.command.commandType);
      if (requiredCapability && !this.negotiatedCapabilities.has(requiredCapability)) {
        logWarn(`protocol: command ${record.command.commandId} requires unavailable capability ${requiredCapability}`);
        record.lastError = `CAPABILITY_UNAVAILABLE: ${requiredCapability}`;
        this.transitionCommand(record, 'BLOCKED');
        await this.store.updateCommand(record, true);
        return false;
      }
    }

    record.attempts++;
    record.dispatchedAt = Date.now();

    const sent = await this.adapter.send({
      kind: 'PROTOCOL_COMMAND',
      command: record.command
    });

    if (sent) {
      this.transitionCommand(record, 'DISPATCHED');
    } else {
      logWarn(`protocol: transport send failed for command ${record.command.commandId}, remains in outbox`);
      // Remains in PERSISTED state for later outbox pump
    }

    await this.store.updateCommand(record, true);
    return sent;
  }

  /**
   * Extension / Target claims responsibility for a command.
   */
  public async claimCommand(
    commandId: string,
    owner: string,
    leaseMs = this.defaultLeaseTimeoutMs
  ): Promise<{ ok: boolean; error?: ProtocolErrorCode; record?: DurableCommandRecord }> {
    const record = this.store.get(commandId);
    if (!record) {
      return { ok: false, error: 'COMMAND_EXPIRED' };
    }

    const now = Date.now();

    // Check expiration
    if (now > record.command.expiresAt) {
      this.transitionCommand(record, 'EXPIRED');
      await this.store.updateCommand(record, true);
      return { ok: false, error: 'COMMAND_EXPIRED', record };
    }

    // Check existing owner
    if (record.owner && record.owner !== owner && record.claimLeaseUntil && record.claimLeaseUntil > now) {
      logWarn(`protocol: command ${commandId} already claimed by ${record.owner}, rejecting claim from ${owner}`);
      return { ok: false, error: 'DUPLICATE_CLAIM', record };
    }

    record.owner = owner;
    record.claimedAt = now;
    record.claimLeaseUntil = now + leaseMs;
    this.transitionCommand(record, 'CLAIMED');

    await this.store.updateCommand(record, true);
    return { ok: true, record };
  }

  /**
   * Ingests and processes an incoming protocol event.
   */
  public async handleEvent(event: ProtocolEvent): Promise<{ accepted: boolean; duplicate?: boolean; reason?: string }> {
    const result = this.eventHandling.then(() => this.handleEventSerialized(event));
    this.eventHandling = result.then(() => undefined, () => undefined);
    return result;
  }

  /** S4 read-only timeout custody; shares the durable event arbitration barrier. */
  public async expireReadOnlyCommand(commandId: string): Promise<void> {
    const result = this.eventHandling.then(async () => {
      const record = this.store.get(commandId);
      // Called only after submission has settled: absence means no durable work.
      if (!record) return;
      if (record.command.commandType !== 'SESSION_PROBE') throw new Error('NOT_READ_ONLY_PROBE');
      if (['COMPLETED', 'FAILED', 'EXPIRED', 'CANCELED'].includes(record.state)) return;
      if (record.state !== 'PERSISTED' && record.state !== 'DISPATCHED') throw new Error('PROBE_NOT_EXPIRABLE');
      const before = structuredClone(record);
      this.transitionCommand(record, 'EXPIRED', false);
      try {
        await this.store.updateCommand(record, true);
      } catch (error) {
        Object.assign(record, before);
        // Supersede the failed durable generation with the restored truth.
        this.store.restoreAfterFailedUpdate(record);
        throw error;
      }
      this.notifyCommandState(record);
    });
    this.eventHandling = result.then(() => undefined, () => undefined);
    return result;
  }

  private async handleEventSerialized(event: ProtocolEvent): Promise<{ accepted: boolean; duplicate?: boolean; reason?: string }> {
    // 1. Delivery dedupe. Mark only after processing so failed durable writes remain retryable.
    if (this.dedupe.has(event.eventId)) {
      logInfo(`protocol: duplicate event ${event.eventId} dropped`);
      return { accepted: false, duplicate: true, reason: 'DUPLICATE_EVENT' };
    }

    const record = this.store.get(event.commandId);
    if (!record) {
      logWarn(`protocol: event ${event.eventId} references unknown command ${event.commandId}`);
      this.dedupe.markProcessed(event.eventId);
      return { accepted: false, reason: 'UNKNOWN_COMMAND' };
    }

    // Read-only terminal truth is immutable, including its error/order metadata.
    // COMPLETED duplicates still follow the existing dedupe path below.
    if (record.command.commandType === 'SESSION_PROBE' &&
        (['FAILED', 'EXPIRED', 'CANCELED'].includes(record.state) ||
          (record.state === 'COMPLETED' && event.eventType !== 'COMMAND_COMPLETED'))) {
      this.dedupe.markProcessed(event.eventId);
      return { accepted: false, reason: 'INVALID_LIFECYCLE_FACT' };
    }

    const strongCommitFact = event.eventType === 'MESSAGE_COMMITTED' &&
      (event.payload as { proofLevel?: string }).proofLevel === 'STRONG_COMMIT';
    // Only externally provable mutation truth may bypass transport/emitter
    // freshness. COMMAND_COMPLETED is lifecycle evidence, not an immutable
    // external fact with its own independent identity.
    const durableFact = strongCommitFact;
    // Compatibility only for pre-handshake V1 tests/peers. Once an opaque
    // connection epoch exists, numeric generation has no admission authority.
    if (this.currentConnectionEpoch === null && event.generation < this.currentGeneration) {
      this.dedupe.markProcessed(event.eventId);
      return { accepted: false, reason: 'STALE_GENERATION' };
    }
    if (!durableFact && this.currentConnectionEpoch !== null && event.connectionEpoch !== this.currentConnectionEpoch) {
      this.dedupe.markProcessed(event.eventId);
      return { accepted: false, reason: 'STALE_CONNECTION_EPOCH' };
    }
    if (!durableFact && this.currentConnectionEpoch !== null && event.emitterEpoch === undefined) {
      this.dedupe.markProcessed(event.eventId);
      return { accepted: false, reason: 'MISSING_EMITTER_EPOCH' };
    }

    if (event.eventType === 'COMMAND_COMPLETED' && record.command.commandType === 'SESSION_PROBE') {
      const probePayload = record.command.payload as ProtocolCommandPayloadMap['SESSION_PROBE'];
      const targetConvId = probePayload.targetConversationId ?? null;
      const staticValid =
        (record.state === 'DISPATCHED' || record.state === 'COMPLETED') &&
        record.command.target === 'extension-background' &&
        event.source === 'extension-background' &&
        event.sessionId === record.command.sessionId &&
        record.command.conversationId === null &&
        targetConvId === null &&
        event.conversationId === null &&
        this.isReady() &&
        isValidProbeCompletionPayload(event.payload);

      if (!staticValid) {
        this.dedupe.markProcessed(event.eventId);
        return { accepted: false, reason: 'INVALID_LIFECYCLE_FACT' };
      }
    }

    const sourceEpoch = event.emitterEpoch ?? `legacy:${event.source}`;
    const activeEmitterEpoch = record.activeEmitterEpochBySource?.[event.source];
    const claimedDocumentId = event.eventType === 'COMMAND_CLAIMED'
      ? (event.payload as { clientDocumentId?: string }).clientDocumentId
      : undefined;
    const establishesNewEmitter = event.eventType === 'COMMAND_CLAIMED' &&
      Boolean(claimedDocumentId) && claimedDocumentId === sourceEpoch;
    if (establishesNewEmitter &&
        (record.owner !== claimedDocumentId || record.claimLeaseUntil === null || record.claimLeaseUntil <= Date.now())) {
      this.dedupe.markProcessed(event.eventId);
      return { accepted: false, reason: 'INVALID_CLAIM_AUTHORITY' };
    }
    if (!durableFact && activeEmitterEpoch && activeEmitterEpoch !== sourceEpoch && !establishesNewEmitter) {
      this.dedupe.markProcessed(event.eventId);
      return { accepted: false, reason: 'STALE_EMITTER_EPOCH' };
    }

    const willEstablishEmitter = !activeEmitterEpoch || establishesNewEmitter;
    const emitterIsCurrent = willEstablishEmitter || activeEmitterEpoch === sourceEpoch;
    const priorOrdering = record.orderingBySource?.[event.source];
    const semanticIdentity = semanticPayloadIdentity(event.payload);
    const payloadIdentity = record.command.commandType === 'SESSION_PROBE' && event.eventType === 'COMMAND_COMPLETED'
      ? `probe:${createHmac('sha256', this.probeOrderingKey).update(semanticIdentity).digest('hex')}`
      : semanticIdentity;
    const sameEmitterOrdering = priorOrdering?.emitterEpoch === sourceEpoch ||
      (priorOrdering?.emitterEpoch === undefined && sourceEpoch === `legacy:${event.source}`);
    const advancesOrdering = emitterIsCurrent &&
      (!priorOrdering || !sameEmitterOrdering || event.sequence > priorOrdering.sequence);
    if (priorOrdering && sameEmitterOrdering && !durableFact) {
      if (event.sequence < priorOrdering.sequence) {
        this.dedupe.markProcessed(event.eventId);
        return { accepted: false, reason: 'LOWER_SEQUENCE' };
      }
      if (event.sequence === priorOrdering.sequence) {
        this.dedupe.markProcessed(event.eventId);
        if (event.eventType !== priorOrdering.eventType || payloadIdentity !== priorOrdering.payloadIdentity) {
          return { accepted: false, reason: 'SEQUENCE_COLLISION' };
        }
        return { accepted: false, duplicate: true, reason: 'SEQUENCE_ALREADY_APPLIED' };
      }
    }

    const now = Date.now();
    const before = structuredClone(record);
    if (willEstablishEmitter) {
      record.activeEmitterEpochBySource ??= {};
      record.activeEmitterEpochBySource[event.source] = sourceEpoch;
    }
    let stateChanged = false;
    let durableMutation = false;

    // 3. Process according to event type
    switch (event.eventType) {
      case 'COMMAND_CLAIMED': {
        stateChanged = this.transitionCommand(record, 'CLAIMED', false);
        durableMutation = stateChanged;
        break;
      }

      case 'MESSAGE_SUBMIT_STARTED': {
        stateChanged = this.transitionCommand(record, 'EXECUTING', false);
        durableMutation = stateChanged;
        break;
      }

      case 'MESSAGE_COMMITTED': {
        const payload = event.payload as { proofLevel?: string; nativeMessageId?: string; conversationId?: string; candidateCount?: number; matchedText?: string };
        if (payload.proofLevel === 'STRONG_COMMIT') {
          if (record.command.commandType !== 'SEND_MESSAGE') {
            record.lastError = 'MESSAGE_COMMITTED rejected for non-SEND_MESSAGE command';
            durableMutation = true;
            break;
          }
          if (record.command.commandType === 'SEND_MESSAGE') {
            const sendPayload = record.command.payload as ProtocolCommandPayloadMap['SEND_MESSAGE'];
            const nativeMessageId = payload.nativeMessageId?.trim();
            const sameDurableFact = Boolean(nativeMessageId) &&
              (record.state === 'COMMITTED' || record.state === 'COMPLETED') &&
              record.nativeMessageId === nativeMessageId &&
              record.commitConversationId === sendPayload.targetConversationId &&
              payload.conversationId === sendPayload.targetConversationId &&
              event.conversationId === sendPayload.targetConversationId;
            if (sameDurableFact) {
              this.dedupe.markProcessed(event.eventId);
              return { accepted: false, duplicate: true, reason: 'FACT_ALREADY_APPLIED' };
            }
            if ((record.state === 'COMMITTED' || record.state === 'COMPLETED') && record.nativeMessageId && record.nativeMessageId !== nativeMessageId) {
              this.dedupe.markProcessed(event.eventId);
              return { accepted: false, reason: 'CONFLICTING_DURABLE_FACT' };
            }
            const validIdentity = Boolean(nativeMessageId) &&
              (record.command.conversationId === null || record.command.conversationId === sendPayload.targetConversationId) &&
              payload.candidateCount === 1 &&
              payload.conversationId === sendPayload.targetConversationId &&
              event.conversationId === sendPayload.targetConversationId &&
              (payload.matchedText === undefined || payload.matchedText === sendPayload.text);
            const prior = nativeMessageId ? this.store.findByNativeMessageId(sendPayload.targetConversationId, nativeMessageId) : undefined;
            if (!validIdentity || (prior && prior.command.commandId !== record.command.commandId)) {
              stateChanged = this.transitionCommand(record, 'AMBIGUOUS', false) || stateChanged;
              record.lastError = 'STRONG_COMMIT rejected: native message identity is missing, ambiguous, reused, or conversation-mismatched';
              durableMutation = true;
              break;
            }
            record.nativeMessageId = nativeMessageId ?? null;
            record.commitConversationId = sendPayload.targetConversationId;
          }
          record.committedAt = now;
          record.commitProofLevel = payload.proofLevel;
          stateChanged = this.transitionCommand(record, 'COMMITTED', false) || stateChanged;
          durableMutation = true;
        } else if (payload.proofLevel === 'WEAK_COMMIT') {
          // UI_ACTION != COMMIT: weak proof records preliminary level but does not commit mutation
          logInfo(`protocol: weak commit proof received for command ${record.command.commandId}; awaiting strong verification`);
          record.commitProofLevel = 'WEAK_COMMIT';
          durableMutation = true;
        } else if (payload.proofLevel === 'AMBIGUOUS') {
          stateChanged = this.transitionCommand(record, 'AMBIGUOUS', false) || stateChanged;
          durableMutation = stateChanged;
        }
        break;
      }

      case 'COMMAND_COMPLETED': {
        if (record.state === 'COMPLETED') {
          this.dedupe.markProcessed(event.eventId);
          return { accepted: false, duplicate: true, reason: 'FACT_ALREADY_APPLIED' };
        }
        stateChanged = this.transitionCommand(record, 'COMPLETED', false);
        if (!stateChanged) {
          this.dedupe.markProcessed(event.eventId);
          return { accepted: false, reason: 'INVALID_LIFECYCLE_FACT' };
        }
        record.completedAt = now;
        durableMutation = true;
        break;
      }

      case 'COMMAND_FAILED': {
        const payload = event.payload as { errorCode?: ProtocolErrorCode; message?: string };
        record.lastError = payload.message ?? 'Command failed';
        durableMutation = true;

        // CRUCIAL SAFETY: If mutation was already committed, failure does NOT undo external side effect!
        if (record.state === 'COMMITTED') {
          logWarn(`protocol: command ${record.command.commandId} reported workflow failure after COMMIT; preserving committed mutation truth`);
        } else if (record.state === 'EXECUTING' && record.command.commandType === 'SEND_MESSAGE') {
          // POST-SUBMIT UNCERTAINTY: If submit was already initiated, mutation outcome is uncertain!
          logWarn(`protocol: mutating command ${record.command.commandId} failed during execution; marking AMBIGUOUS`);
          stateChanged = this.transitionCommand(record, 'AMBIGUOUS', false) || stateChanged;
        } else {
          stateChanged = this.transitionCommand(record, 'FAILED', false) || stateChanged;
        }
        break;
      }

      case 'COMMAND_BLOCKED': {
        const payload = event.payload as { reason?: string };
        record.lastError = payload.reason ?? 'Blocked';
        stateChanged = this.transitionCommand(record, 'BLOCKED', false);
        durableMutation = true;
        break;
      }
    }

    if (advancesOrdering) {
      record.orderingBySource ??= {};
      record.orderingBySource[event.source] = {
        ...(sourceEpoch === `legacy:${event.source}` ? {} : { emitterEpoch: sourceEpoch }),
        sequence: event.sequence,
        eventType: event.eventType,
        payloadIdentity
      };
      durableMutation = true;
    }

    if (durableMutation) {
      try {
        await this.store.updateCommand(record, advancesOrdering);
      } catch (err) {
        for (const key of Object.keys(record) as (keyof DurableCommandRecord)[]) {
          if (!Object.prototype.hasOwnProperty.call(before, key)) {
            delete record[key];
          }
        }
        if (before.orderingBySource === undefined) delete record.orderingBySource;
        if (before.activeEmitterEpochBySource === undefined) delete record.activeEmitterEpochBySource;
        Object.assign(record, before);
        this.store.restoreAfterFailedUpdate(record);
        throw err;
      }
    }
    this.dedupe.markProcessed(event.eventId);
    if (stateChanged) this.notifyCommandState(record);
    this.notifyEvent(event);
    return { accepted: true };
  }

  /**
   * Cancel an in-flight command safely.
   */
  public async cancelCommand(
    commandId: string,
    reason: string
  ): Promise<{ ok: boolean; status: 'CANCELED_BEFORE_COMMIT' | 'COMMIT_ALREADY_OCCURRED' | 'ALREADY_COMPLETED' | 'NOT_FOUND' }> {
    const record = this.store.get(commandId);
    if (!record) {
      return { ok: false, status: 'NOT_FOUND' };
    }

    if (record.command.commandType === 'SESSION_PROBE' && record.state === 'COMPLETED') {
      return { ok: false, status: 'ALREADY_COMPLETED' };
    }

    record.cancellationRequested = true;

    // If already committed or completed, CANNOT undo side effect
    if (record.state === 'COMMITTED' || (record.state === 'COMPLETED' && isRealMutationCommit(record))) {
      logWarn(`protocol: command ${commandId} cannot be undone; side effect already committed`);
      await this.store.updateCommand(record, true);
      return { ok: false, status: 'COMMIT_ALREADY_OCCURRED' };
    }

    this.transitionCommand(record, 'CANCELED');
    record.lastError = `Canceled: ${reason}`;
    await this.store.updateCommand(record, true);
    return { ok: true, status: 'CANCELED_BEFORE_COMMIT' };
  }

  /**
   * Desktop restart recovery and reconciliation.
   * Scans outbox for unresolved commands.
   * MUTATIONS WITH UNCERTAIN STATUS TRANSITION TO AMBIGUOUS. NO BLIND REPLAY!
   */
  public async reconcileOnRestart(): Promise<void> {
    const unresolved = this.store.getUnresolvedCommands();
    logInfo(`protocol: reconciling ${unresolved.length} unresolved commands after startup`);

    for (const record of unresolved) {
      record.reconciledOnRestart = true;
      if (record.state === 'DISPATCHED' || record.state === 'CLAIMED' || record.state === 'EXECUTING') {
        if (record.command.commandType === 'SEND_MESSAGE') {
          // A mutating command whose completion or commit was not proven before restart is AMBIGUOUS!
          logWarn(`protocol: command ${record.command.commandId} was in flight during restart; marking AMBIGUOUS (no blind replay)`);
          this.transitionCommand(record, 'AMBIGUOUS');
          record.lastError = 'Interrupted by application restart; mutation outcome uncertain';
          await this.store.updateCommand(record, true);
        } else {
          // Read-only probe can safely be marked expired or failed
          this.transitionCommand(record, 'EXPIRED');
          await this.store.updateCommand(record, true);
        }
      }
    }
  }

  /**
   * Handles Handshake Hello from Extension.
   */
  public handleHandshakeHello(hello: HandshakeHello): HandshakeWelcome | HandshakeReject {
    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      logWarn(`protocol: rejecting extension handshake with incompatible protocol version ${hello.protocolVersion}`);
      return {
        type: 'REJECT',
        reason: 'PROTOCOL_MISMATCH',
        expectedVersion: PROTOCOL_VERSION,
        actualVersion: hello.protocolVersion,
        message: `Expected protocol version ${PROTOCOL_VERSION}, got ${hello.protocolVersion}`
      };
    }

    const negotiatedCapabilities = hello.capabilities.filter((cap) =>
      Object.values(ProtocolCapability).includes(cap)
    );
    this.negotiatedCapabilities = new Set(negotiatedCapabilities);
    this.isHandshakeReady = false;
    this.advanceGeneration();
    this.currentConnectionEpoch = randomUUID();

    return {
      type: 'WELCOME',
      acceptedProtocolVersion: PROTOCOL_VERSION,
      desktopInstanceId: this.instanceId,
      appVersion: '2.1.20',
      negotiatedCapabilities,
      reconcileRequested: true,
      connectionGeneration: this.currentGeneration,
      connectionEpoch: this.currentConnectionEpoch
    };
  }

  public handleHandshakeReady(ready: { connectionGeneration: number; connectionEpoch?: string }): void {
    if (ready.connectionGeneration === this.currentGeneration &&
        ready.connectionEpoch === this.currentConnectionEpoch) {
      this.isHandshakeReady = true;
    }
  }

  public getNegotiatedCapabilities(): Set<ProtocolCapability> {
    return new Set(this.negotiatedCapabilities);
  }

  public isReady(): boolean {
    return this.isHandshakeReady;
  }

  private getRequiredCapability(commandType: CommandType): ProtocolCapability | null {
    switch (commandType) {
      case 'SEND_MESSAGE':
        return ProtocolCapability.SEND_MESSAGE;
      case 'BIND_SESSION':
        return ProtocolCapability.SESSION_BINDING;
      default:
        return null;
    }
  }

  private transitionCommand(record: DurableCommandRecord, newState: CommandState, notify = true): boolean {
    if (record.state === newState) return false;

    if (!isValidCommandTransition(record.command.commandType, record.state, newState)) {
      logWarn(`protocol: invalid state transition from ${record.state} to ${newState} for command ${record.command.commandId}`);
      return false;
    }

    record.state = newState;
    record.updatedAt = Date.now();
    if (notify) this.notifyCommandState(record);
    return true;
  }

  private handleRawIncomingMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const obj = msg as Record<string, unknown>;

    if (obj.kind === 'PROTOCOL_EVENT' && obj.event) {
      try {
        const parsed = parseProtocolEvent(obj.event);
        void this.handleEvent(parsed);
      } catch (err) {
        logWarn(`protocol: failed to parse incoming event: ${(err as Error).message}`);
      }
    }
  }

  public onEvent(listener: (event: ProtocolEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  public onCommandState(listener: (record: DurableCommandRecord) => void): () => void {
    this.commandStateListeners.add(listener);
    return () => {
      this.commandStateListeners.delete(listener);
    };
  }

  private notifyEvent(event: ProtocolEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('event listener error:', err);
      }
    }
  }

  private notifyCommandState(record: DurableCommandRecord): void {
    for (const listener of this.commandStateListeners) {
      try {
        listener(record);
      } catch (err) {
        console.error('command state listener error:', err);
      }
    }
  }
}
