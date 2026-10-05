import { randomUUID } from 'node:crypto';
import { CurrentBridgeAdapter, S6_KEY, S6_TEXT, S6_TIMEOUT, isS6Specimen } from './current-bridge-adapter.js';
export { isS6Specimen } from './current-bridge-adapter.js';
import { readDurable } from '../durable.js';
import { PROTOCOL_STORE_NAME } from './store.js';
import type { ProtocolStoreSnapshot } from './types.js';
import { BrowserTransportService, type S6Election } from './service.js';
import { handshakeHelloSchema, handshakeReadySchema, parseProtocolEvent,
  commandClaimedPayloadSchema, messageCommittedPayloadSchema, commandFailedPayloadSchema,
  commandStateSchema, parseProtocolCommand,
  type HandshakeWelcome, type CommandState } from '../../shared/protocol/index.js';

export type S6Result = { ok: boolean; failureCode?: string; commandId?: string; state?: CommandState };
export type S6Options = { enabled: true; targetConversationId: string };
// One process lease. Acquisition is synchronous, before even the first preflight await.
let targetLease: { target: string; release(): void } | null = null;
export function s6TargetHeld(target: string | null): boolean { return !!target && targetLease?.target === target; }
const boundedEpoch = (v: unknown): v is string => typeof v === 'string' && v.length >= 8 && v.length <= 128;

/** Internal source candidate only; no startup invocation or production binding. */
export class S6Canary {
  readonly adapter = new CurrentBridgeAdapter();
  readonly service = new BrowserTransportService(this.adapter, { instanceId: randomUUID() });
  private initialization: Promise<void> | null = null;
  private active = false;
  private phase: 'idle' | 'handshake' | 'command' = 'idle';
  private welcome: HandshakeWelcome | null = null;
  private backgroundEmitter: string | null = null;
  private commandId: string | null = null;
  private election: S6Election | null = null;
  private dispatchPublished = false;
  private ready = false;
  private releaseReady?: (ok: boolean) => void;
  private releaseResult?: (result: S6Result) => void;
  private cleanupId: string | null = null;
  private cleanupFlight: Promise<void> | null = null;
  private releaseLease?: () => void;
  constructor(private readonly wake: () => void, private readonly preflight: (target: string) => Promise<boolean>,
    private readonly released: () => void = () => undefined,
    private readonly targetCurrent: (target: string) => boolean = () => true) {}
  hasCustody(): boolean { return this.active || this.cleanupId !== null; }

  async run(options: S6Options): Promise<S6Result> {
    if (!options || options.enabled !== true) return { ok: false, failureCode: 'DISABLED' };
    if (Object.keys(options).length !== 2 || !/^[0-9a-f-]{8,64}$/i.test(options.targetConversationId))
      return { ok: false, failureCode: 'INVALID_SYNTHETIC_DOMAIN' };
    if (this.active) return { ok: false, failureCode: 'BUSY' };
    if (this.cleanupId) { this.beginCleanup(this.cleanupId); return { ok: false, failureCode: 'CLEANUP_PENDING' }; }
    if (targetLease) return { ok: false, failureCode: 'BUSY' };
    const lease = { target: options.targetConversationId, release: () => {
      if (targetLease === lease) targetLease = null;
    } };
    targetLease = lease; this.releaseLease = lease.release; this.active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    let submission: Promise<unknown> | undefined;
    try {
      // The bridge implementation calls listInputs(), entering the legacy serializer.
      if (!await this.preflight(options.targetConversationId)) return { ok: false, failureCode: 'CONVERSATION_BUSY' };
      if (!this.active) return { ok: false, failureCode: 'DISABLED' };
      // readDurable intentionally conflates absent/unreadable/corrupt auxiliary
      // state. None is permission to reset the one-shot mutation gate. S4 (or an
      // independently reviewed empty test profile) must establish a valid outbox.
      const snapshot = await readDurable<ProtocolStoreSnapshot>(PROTOCOL_STORE_NAME);
      if (!snapshot || snapshot.version !== 1 || typeof snapshot.instanceId !== 'string' ||
          !snapshot.commands || typeof snapshot.commands !== 'object' || Array.isArray(snapshot.commands) ||
          !Array.isArray(snapshot.recentCommittedIds)) return { ok: false, failureCode: 'REQUIRES_HEAD_REVIEW' };
      for (const [id, record] of Object.entries(snapshot.commands)) {
        if (!record || record.command?.commandId !== id || !commandStateSchema.safeParse(record.state).success ||
            (record.command.idempotencyKey === S6_KEY && !isS6Specimen(record.command)))
          return { ok: false, failureCode: 'REQUIRES_HEAD_REVIEW' };
        try { parseProtocolCommand(record.command); } catch { return { ok: false, failureCode: 'REQUIRES_HEAD_REVIEW' }; }
      }
      if (this.initialization) { await this.initialization; await this.service.refreshDurableStore(); }
      else {
        this.initialization = this.service.start().catch(error => { this.initialization = null; throw error; });
        await this.initialization;
      }
      const existing = this.service.getStore().findByIdempotencyKey(S6_KEY);
      if (existing) {
        // Permanent gate: even a proven unpublished specimen is consumed.
        if (existing.state === 'PERSISTED') await this.service.cleanupS6(existing.command.commandId);
        return { ok: false, failureCode: 'ALREADY_EXERCISED', commandId: existing.command.commandId, state: existing.state };
      }
      if (!this.active) return { ok: false, failureCode: 'DISABLED' };
      this.phase = 'handshake'; this.welcome = null; this.ready = false; this.backgroundEmitter = null;
      await this.adapter.disconnect();
      const handshake = new Promise<boolean>(resolve => {
        this.releaseReady = resolve; timer = setTimeout(() => resolve(false), 5000);
      });
      this.wake();
      if (!await handshake || !this.active || !this.ready || !this.service.isReady() || !this.welcome ||
          !this.service.getNegotiatedCapabilities().has('SEND_MESSAGE')) return { ok: false, failureCode: 'HANDSHAKE_TIMEOUT' };
      if (!this.targetCurrent(options.targetConversationId)) return { ok: false, failureCode: 'TARGET_CHANGED' };
      clearTimeout(timer); this.releaseReady = undefined;
      const welcome: HandshakeWelcome = this.welcome;
      this.phase = 'command'; this.election = null;
      const command = this.service.createCommand('SEND_MESSAGE', {
        text: S6_TEXT, targetConversationId: options.targetConversationId, timeoutMs: S6_TIMEOUT
      }, { sessionId: 's6_canary', conversationId: options.targetConversationId,
        idempotencyKey: S6_KEY, expiresInMs: S6_TIMEOUT });
      this.commandId = command.commandId;
      this.service.registerS6({ commandId: command.commandId, targetConversationId: options.targetConversationId,
        connectionEpoch: welcome.connectionEpoch, generation: welcome.connectionGeneration,
        backgroundEmitterEpoch: this.backgroundEmitter!, current: () =>
          this.active && this.phase === 'command' && this.ready && this.welcome === welcome &&
          this.targetCurrent(options.targetConversationId) });
      this.adapter.expectS6Command(command);
      const completion = new Promise<S6Result>(resolve => {
        this.releaseResult = resolve;
        unsubscribe = this.service.onCommandState(record => {
          if (record.command.commandId !== command.commandId) return;
          if (['COMMITTED', 'AMBIGUOUS', 'CANCELED', 'FAILED', 'EXPIRED'].includes(record.state))
            resolve({ ok: record.state === 'COMMITTED', commandId: command.commandId, state: record.state,
              ...(record.state === 'COMMITTED' ? {} : { failureCode: 'S6_RETIRED' }) });
        });
        timer = setTimeout(() => { this.dispatchPublished = false; this.adapter.clear();
          resolve({ ok: false, failureCode: 'COMMAND_TIMEOUT', commandId: command.commandId }); }, S6_TIMEOUT);
      });
      const submitting = this.service.submitCommand(command); submission = submitting;
      const submitted = await Promise.race([submitting, completion]);
      if ('ok' in submitted) return submitted;
      if (!this.active || submitted.state !== 'DISPATCHED') return { ok: false, failureCode: 'DISPATCH_FAILED', commandId: command.commandId };
      // Nothing can poll until both the durable DISPATCHED write and submit have settled.
      if (!await this.service.publishS6(command.commandId, () => {
        this.dispatchPublished = true; this.adapter.publishS6(command.commandId);
      })) return { ok: false, failureCode: 'PUBLICATION_REVOKED', commandId: command.commandId };
      if (!this.active || !this.dispatchPublished) return { ok: false, failureCode: 'DISABLED' };
      this.wake();
      return await completion;
    } catch { return { ok: false, failureCode: 'SIDECAR_UNAVAILABLE', ...(this.commandId ? { commandId: this.commandId } : {}) }; }
    finally {
      clearTimeout(timer); unsubscribe?.(); this.releaseReady = undefined; this.releaseResult = undefined;
      this.dispatchPublished = false; this.ready = false; this.active = false; this.phase = 'idle';
      this.adapter.clear(); await this.adapter.disconnect();
      if (this.commandId) this.beginCleanup(this.commandId, submission);
      else this.releaseCustody();
      this.commandId = null;
    }
  }
  private releaseCustody(): void { this.releaseLease?.(); this.releaseLease = undefined; this.released(); }
  private beginCleanup(commandId: string, submission?: Promise<unknown>): void {
    if (this.cleanupFlight) return;
    this.cleanupId = commandId;
    this.cleanupFlight = (async () => {
      await submission?.catch(() => undefined);
      await this.service.cleanupS6(commandId);
      this.cleanupId = null; this.releaseCustody();
    })().catch(() => { /* Retain exact command, process lease and sidecar custody. Explicit review only. */ })
      .finally(() => { this.cleanupFlight = null; });
  }
  private matches(body: Record<string, unknown>): boolean {
    return !!this.welcome && body.emitterEpoch === this.backgroundEmitter &&
      body.connectionEpoch === this.welcome.connectionEpoch && body.connectionGeneration === this.welcome.connectionGeneration;
  }
  async request(route: string, raw: unknown): Promise<{ status: number; body: unknown }> {
    const bad = () => ({ status: 409, body: { error: 'invalid_protocol_canary' } });
    if (!this.active || this.phase === 'idle') return { status: 503, body: { error: 'protocol_canary_disabled' } };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad();
    const body = raw as Record<string, unknown>;
    try {
      if (route === '/protocol/hello') {
        if (this.phase !== 'handshake' || this.welcome || !boundedEpoch(body.emitterEpoch)) return bad();
        const hello = handshakeHelloSchema.parse(body.hello);
        if (hello.capabilities.length !== 1 || hello.capabilities[0] !== 'SEND_MESSAGE') return bad();
        const welcome = this.service.handleHandshakeHello(hello);
        if (welcome.type !== 'WELCOME') return bad();
        this.welcome = welcome; this.backgroundEmitter = body.emitterEpoch;
        return { status: 200, body: welcome };
      }
      if (route === '/protocol/ready') {
        const ready = handshakeReadySchema.parse(body.ready);
        if (this.phase !== 'handshake' || !this.matches({ ...ready, emitterEpoch: body.emitterEpoch })) return bad();
        this.service.handleHandshakeReady(ready); this.ready = this.service.isReady();
        if (!this.ready) return bad();
        await this.adapter.connect();
        if (!this.active || !this.ready) return bad();
        this.releaseReady?.(true); return { status: 200, body: { ready: true } };
      }
      if (!this.ready || !this.matches(body)) return bad();
      if (route === '/protocol/poll' && (!this.dispatchPublished || !this.commandId)) return { status: 200, body: { command: null } };
      if (!this.dispatchPublished || !this.commandId) return bad();
      const record = this.service.getStore().get(this.commandId);
      if (route === '/protocol/poll') return { status: 200, body: { command:
        record?.state === 'DISPATCHED' ? this.adapter.poll() : null } };
      if (route === '/protocol/claim') {
        if (body.action === 'abort' && !this.election && body.commandId === this.commandId &&
            body.targetConversationId === record?.command.conversationId) {
          this.dispatchPublished = false; this.adapter.clear();
          await this.service.cleanupS6(this.commandId);
          this.releaseResult?.({ ok: false, failureCode: 'DOCUMENT_UNAVAILABLE', commandId: this.commandId });
          return { status: 200, body: { ok: true } };
        }
        const election = body.election as S6Election;
        if (!election || Object.keys(election).length !== 5 || election.commandId !== this.commandId ||
            election.targetConversationId !== record?.command.conversationId) return bad();
        if (body.action === 'elect') {
          if (this.election || !await this.service.electS6(election)) return bad();
          if (!this.active || !this.dispatchPublished) return bad();
          this.election = { ...election }; return { status: 200, body: { ok: true } };
        }
        if (!this.election || Object.keys(this.election).some(k => this.election![k as keyof S6Election] !== election[k as keyof S6Election])) return bad();
        if (body.action === 'abort') {
          this.dispatchPublished = false; this.adapter.clear();
          await this.service.cleanupS6(this.commandId);
          this.releaseResult?.({ ok: false, failureCode: 'DOCUMENT_LOST', commandId: this.commandId });
          return { status: 200, body: { ok: true } };
        }
        if (body.action === 'verify') return { status: 200, body: { ok: await this.service.verifyS6(this.commandId, election) } };
        if (body.action !== 'claim') return bad();
        const result = await this.service.claimCommand(this.commandId, election.documentId, S6_TIMEOUT, election, {
          connectionEpoch: this.welcome!.connectionEpoch, generation: this.welcome!.connectionGeneration,
          backgroundEmitterEpoch: this.backgroundEmitter! });
        return { status: result.ok && this.active && this.dispatchPublished ? 200 : 409,
          body: { ok: result.ok && this.active && this.dispatchPublished,
            ...(result.ok ? { claimLeaseUntil: result.record?.claimLeaseUntil } : {}) } };
      }
      if (route === '/protocol/events') {
        const elected = body.election as S6Election;
        if (!this.election || !elected || Object.keys(elected).length !== 5 ||
            Object.keys(this.election).some(k => this.election![k as keyof S6Election] !== elected[k as keyof S6Election])) return bad();
        const event = parseProtocolEvent(body.event);
        if (!this.election || event.commandId !== this.commandId || event.source !== 'content-script' ||
            event.emitterEpoch !== this.election.documentId || event.sessionId !== record?.command.sessionId ||
            event.conversationId !== record?.command.conversationId || event.connectionEpoch !== this.welcome?.connectionEpoch ||
            event.generation !== this.welcome?.connectionGeneration) return bad();
        if (event.eventType === 'COMMAND_CLAIMED') commandClaimedPayloadSchema.strict().parse(event.payload);
        else if (event.eventType === 'MESSAGE_SUBMIT_STARTED') {
          if (!event.payload || Object.keys(event.payload as object).length !== 0) return bad();
        } else if (event.eventType === 'MESSAGE_COMMITTED') {
          const p = messageCommittedPayloadSchema.strict().parse(event.payload);
          if (p.proofLevel !== 'STRONG_COMMIT' || !p.nativeMessageId?.trim() || p.nativeMessageId.length > 128 ||
              p.candidateCount !== 1 || p.conversationId !== record.command.conversationId ||
              p.evidenceDetails !== undefined || (p.matchedText !== undefined && p.matchedText !== S6_TEXT)) return bad();
        }
        else if (event.eventType === 'COMMAND_FAILED') {
          const p = commandFailedPayloadSchema.strict().parse(event.payload);
          if (p.message !== 'S6 document execution failed' || p.retryable !== false) return bad();
        } else return bad();
        const result = await this.service.handleEvent(event, { election: elected, authority: {
          connectionEpoch: this.welcome!.connectionEpoch, generation: this.welcome!.connectionGeneration,
          backgroundEmitterEpoch: this.backgroundEmitter! } });
        const committed = event.eventType === 'MESSAGE_COMMITTED' && record?.state === 'COMMITTED';
        return { status: result.accepted || result.duplicate ? 200 : 409,
          body: { ...result, accepted: (result.accepted || !!result.duplicate) && (committed || (this.active && this.dispatchPublished)) } };
      }
      return { status: 404, body: { error: 'not_found' } };
    } catch { return bad(); }
  }
  disable(): void {
    this.dispatchPublished = false; this.ready = false; this.active = false; this.adapter.clear();
    this.releaseReady?.(false); this.releaseResult?.({ ok: false, failureCode: 'DISABLED' });
  }
}
