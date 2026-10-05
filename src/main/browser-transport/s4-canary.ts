import { randomUUID } from 'node:crypto';
import { CurrentBridgeAdapter } from './current-bridge-adapter.js';
import { BrowserTransportService } from './service.js';
import { handshakeHelloSchema, handshakeReadySchema, parseProtocolEvent,
  commandFailedPayloadSchema, type HandshakeWelcome, type CommandState } from '../../shared/protocol/index.js';

export type S4Result = { ok: true; commandId: string; state: 'COMPLETED'; createdAt: number;
  dispatchedAt: number; completedAt: number; connectionEpoch: string; observedTabCount: number } |
  { ok: false; failureCode: string; commandId?: string; state?: CommandState };
type Authority = { emitterEpoch: string; connectionEpoch: string; connectionGeneration: number };
const epoch = (value: unknown): value is string => typeof value === 'string' && value.length >= 8 && value.length <= 128;
const boundedMs = (value: number | undefined, fallback: number) =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= 30000 ? value : fallback;

/** Explicit internal diagnostic only. No startup command, public tool, or production binding. */
export class S4Canary {
  readonly adapter = new CurrentBridgeAdapter();
  readonly service = new BrowserTransportService(this.adapter, { instanceId: randomUUID() });
  private started = false;
  private initialization: Promise<void> | null = null;
  private active = false;
  private phase: 'idle' | 'handshake' | 'command' = 'idle';
  private welcome: HandshakeWelcome | null = null;
  private emitterEpoch: string | null = null;
  private ready = false;
  private disabled = false;
  private dispatchPublished = false;
  private commandId: string | null = null;
  private cleanupCommandId: string | null = null;
  private cleanupInFlight: Promise<void> | null = null;
  private releaseReady?: (ok: boolean) => void;
  private releaseCompletion?: (result: S4Result) => void;
  constructor(private readonly wake: () => void) {}

  async run(options: { enabled: boolean; handshakeTimeoutMs?: number; commandTimeoutMs?: number }): Promise<S4Result> {
    if (options.enabled !== true) return { ok: false, failureCode: 'DISABLED' };
    if (this.active) return { ok: false, failureCode: 'BUSY' };
    if (this.cleanupCommandId) {
      // One explicit retry after a failed cleanup. Pending callers never attach
      // more continuations to the retained flight or create another command.
      this.beginCleanup(this.cleanupCommandId);
      return { ok: false, failureCode: 'CLEANUP_PENDING', commandId: this.cleanupCommandId };
    }
    this.active = true;
    this.disabled = false;
    this.dispatchPublished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    let submission: Promise<unknown> | undefined;
    let terminalAccepted = false;
    try {
      const ready = new Promise<boolean>(resolve => {
        this.releaseReady = resolve;
        timer = setTimeout(() => resolve(false), boundedMs(options.handshakeTimeoutMs, 5000));
      });
      if (!this.started) {
        // One initialization flight, included in the handshake deadline. A late
        // disk read may initialize the owner but can never launch browser work.
        this.initialization ??= this.service.start().then(() => { this.started = true; }).catch(error => {
          this.initialization = null; throw error;
        });
        if (!(await Promise.race([this.initialization.then(() => true), ready.then(() => false)])))
          return { ok: false, failureCode: this.disabled ? 'DISABLED' : 'HANDSHAKE_TIMEOUT' };
      }
      if (this.disabled) return { ok: false, failureCode: 'DISABLED' };
      this.phase = 'handshake'; this.welcome = null; this.emitterEpoch = null; this.ready = false;
      await this.adapter.disconnect();
      this.wake();
      if (!(await ready) || !this.ready || !this.service.isReady() || !this.welcome)
        return { ok: false, failureCode: 'HANDSHAKE_TIMEOUT' };
      clearTimeout(timer); this.releaseReady = undefined;
      this.phase = 'command';
      const connectionEpoch = (this.welcome as HandshakeWelcome).connectionEpoch;
      const commandTimeoutMs = boundedMs(options.commandTimeoutMs, 10000);
      const command = this.service.createCommand('SESSION_PROBE', {
        probeTabs: true, probeModels: false, targetConversationId: null
      }, { sessionId: `s4_${randomUUID()}`, conversationId: null,
        idempotencyKey: `s4_${randomUUID()}`, expiresInMs: commandTimeoutMs });
      this.commandId = command.commandId;
      this.adapter.expectCommand(command.commandId);
      const completion = new Promise<S4Result>(resolve => {
        this.releaseCompletion = resolve;
        unsubscribe = this.service.onEvent(event => {
          if (event.commandId !== command.commandId) return;
          const record = this.service.getStore().get(command.commandId);
          if (record?.state === 'COMPLETED' && event.eventType === 'COMMAND_COMPLETED') {
            terminalAccepted = true;
            resolve({ ok: true, commandId: command.commandId, state: 'COMPLETED',
              createdAt: record.createdAt, dispatchedAt: record.dispatchedAt!, completedAt: record.completedAt!,
              connectionEpoch, observedTabCount: (event.payload as { observedTabCount: number }).observedTabCount });
          } else if (record?.state === 'FAILED') {
            terminalAccepted = true;
            resolve({ ok: false, commandId: command.commandId, state: 'FAILED', failureCode: 'PROBE_FAILED' });
          }
        });
        timer = setTimeout(() => {
          this.dispatchPublished = false; this.adapter.clear();
          resolve({ ok: false, commandId: command.commandId,
            state: this.service.getStore().get(command.commandId)?.state, failureCode: 'COMMAND_TIMEOUT' });
        }, commandTimeoutMs);
      });
      // The disk operation itself is not cancellable. Fence its eventual send
      // through the adapter identity and disconnect on every terminal result.
      const pendingSubmission = this.service.submitCommand(command);
      submission = pendingSubmission;
      const submitted = await Promise.race([pendingSubmission, completion]);
      if ('ok' in submitted) return submitted;
      const record = submitted;
      if (record.state !== 'DISPATCHED') return { ok: false, commandId: command.commandId,
        state: record.state, failureCode: 'ADAPTER_UNAVAILABLE' };
      this.dispatchPublished = true;
      this.wake();
      return await completion;
    } catch { return { ok: false, failureCode: 'SIDECAR_UNAVAILABLE',
      ...(this.commandId ? { commandId: this.commandId } : {}) }; }
    finally {
      clearTimeout(timer); unsubscribe?.(); this.releaseReady = undefined; this.releaseCompletion = undefined;
      this.dispatchPublished = false;
      if (this.commandId && !terminalAccepted) this.beginCleanup(this.commandId, submission);
      await this.adapter.disconnect(); this.commandId = null; this.phase = 'idle'; this.ready = false;
      this.dispatchPublished = false;
      this.welcome = null; this.emitterEpoch = null; this.active = false;
    }
  }

  private beginCleanup(commandId: string, submission?: Promise<unknown>): void {
    if (this.cleanupInFlight) return;
    this.cleanupCommandId = commandId;
    // Durable I/O cannot be cancelled. Custody extends beyond the visible run,
    // including a rejection that may have left a record in the real store.
    this.cleanupInFlight = (async () => {
      await submission?.catch(() => undefined);
      await this.service.expireReadOnlyCommand(commandId);
      this.cleanupCommandId = null;
    })().catch(() => {
      // Keep only the exact identity. A later explicit invocation may retry;
      // there is no timer, replay, replacement probe, or automatic retry loop.
    }).finally(() => { this.cleanupInFlight = null; });
  }

  /** All four calls are exposed only inside bridge.ts's existing auth/rate/body boundary. */
  async request(route: string, raw: unknown): Promise<{ status: number; body: unknown }> {
    if (!this.active || this.phase === 'idle') return { status: 503, body: { error: 'protocol_canary_disabled' } };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return this.bad();
    const body = raw as Record<string, unknown>;
    try {
      if (route === '/protocol/hello') {
        if (this.phase !== 'handshake' || !epoch(body.emitterEpoch)) return this.bad();
        const hello = handshakeHelloSchema.parse(body.hello);
        const welcome = this.service.handleHandshakeHello(hello);
        this.ready = false;
        if (welcome.type !== 'WELCOME') return { status: 409, body: welcome };
        this.welcome = welcome; this.emitterEpoch = body.emitterEpoch;
        return { status: 200, body: welcome };
      }
      if (route === '/protocol/ready') {
        const ready = handshakeReadySchema.parse(body.ready);
        if (this.phase !== 'handshake' || !this.matches({ ...ready, emitterEpoch: body.emitterEpoch })) return this.bad();
        this.service.handleHandshakeReady(ready);
        this.ready = this.service.isReady();
        if (!this.ready) return this.bad();
        await this.adapter.connect(); this.releaseReady?.(true);
        return { status: 200, body: { ready: true } };
      }
      if (!this.ready || !this.matches(body)) return this.bad();
      if (route === '/protocol/poll') {
        const command = this.adapter.poll();
        // Do not hand out before the service's durable DISPATCHED barrier finishes.
        const record = command && this.service.getStore().get(command.commandId);
        return { status: 200, body: { command: this.dispatchPublished && record?.state === 'DISPATCHED' ? command : null } };
      }
      if (route === '/protocol/events') {
        const event = parseProtocolEvent(body.event);
        if (!this.dispatchPublished || event.commandId !== this.commandId || event.source !== 'extension-background' ||
            event.sessionId !== this.service.getStore().get(event.commandId)?.command.sessionId ||
            event.conversationId !== null || event.emitterEpoch !== this.emitterEpoch ||
            event.connectionEpoch !== this.welcome?.connectionEpoch || event.generation !== this.welcome?.connectionGeneration ||
            !['COMMAND_COMPLETED', 'COMMAND_FAILED'].includes(event.eventType)) return this.bad();
        if (event.eventType === 'COMMAND_FAILED') {
          const failure = commandFailedPayloadSchema.parse(event.payload);
          if (Object.keys(event.payload as object).length !== 4 || failure.errorCode !== 'UNKNOWN_ERROR' ||
              failure.message !== 'S4 passive tab observation failed' || failure.retryable !== false) return this.bad();
        }
        const result = await this.service.handleEvent(event);
        return { status: result.accepted || result.duplicate ? 200 : 409, body: result };
      }
      return { status: 404, body: { error: 'not_found' } };
    } catch { return this.bad(); }
  }
  private matches(body: Record<string, unknown>): body is Record<string, unknown> & Authority {
    return !!this.welcome && body.emitterEpoch === this.emitterEpoch &&
      body.connectionEpoch === this.welcome.connectionEpoch && body.connectionGeneration === this.welcome.connectionGeneration;
  }
  private bad() { return { status: 409, body: { error: 'invalid_protocol_canary' } }; }
  disable(): void {
    this.disabled = true;
    this.ready = false; this.welcome = null; this.adapter.clear();
    this.releaseReady?.(false); this.releaseCompletion?.({ ok: false, failureCode: 'DISABLED' });
  }
}
