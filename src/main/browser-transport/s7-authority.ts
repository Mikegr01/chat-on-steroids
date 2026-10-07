import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { readStrictDurable, writeStrictDurableNow, type StrictDurableRead } from '../durable.js';
import { parseProtocolCommand, handshakeHelloSchema, handshakeReadySchema, handshakeWelcomeSchema,
  parseProtocolEvent, commandClaimedPayloadSchema, messageCommittedPayloadSchema,
  type ProtocolCommand, type HandshakeWelcome } from '../../shared/protocol/index.js';
import type { InputEntry } from '../session/input.js';
import type { SessionSummary } from '../../shared/session.js';

export const S7_LEDGER = 'kosmosyn-s7-authority';
export const S7_MAX_BYTES = 1024 * 1024;
export const S7_MAX_RECORDS = 200;
/**
 * Unclaimed browser queue deadline for eligible S7 candidates.
 *
 * Matches REVIVAL_DEADLINE_MS (3 minutes): slow browser page wakeups and cold-tab
 * ChatGPT reloads routinely take between 60 and 90 seconds before the page helper can
 * inspect turns and make the claim. S7 custody/election still occurs only upon claim;
 * this bounds how long the candidate may wait for the browser without early failure.
 */
export const S7_PRECLAIM_PICKUP_MS = 3 * 60_000;
export interface S7Gate { enabled: boolean; initialized: boolean }
const epoch = z.string().min(1).max(128);
export const s7ElectionSchema = z.object({ commandId: z.string().regex(/^cmd_s7_[0-9a-f-]{36}$/i),
  targetConversationId: z.string().min(8).max(128), tabId: z.number().int().nonnegative(), documentId: epoch,
  navigationEpoch: z.number().int().nonnegative(), connectionEpoch: epoch, backgroundEmitterEpoch: epoch }).strict();
export type S7Election = z.infer<typeof s7ElectionSchema>;
const recordSchema = z.object({ inputId: z.string().uuid(), sessionId: z.string().min(8).max(64),
  commandId: z.string(), idempotencyKey: z.string(), targetConversationId: z.string().min(8).max(128),
  state: z.enum(['PERSISTED', 'BLOCKED', 'DISPATCHED', 'CLAIMED', 'EXECUTING', 'COMMITTED', 'COMPLETED', 'CANCELED', 'FAILED', 'EXPIRED', 'AMBIGUOUS']),
  authoredHash: z.string().regex(/^[0-9a-f]{64}$/), text: z.string().min(1).max(4096).optional(),
  election: s7ElectionSchema, published: z.boolean(), createdAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
  nativeMessageId: z.string().min(1).max(256).optional(), proofLevel: z.literal('STRONG_COMMIT').optional(),
  committedAt: z.number().int().nonnegative().optional(), sequence: z.number().int().nonnegative().optional(),
  claimedEvent: z.boolean().optional(), beforeNativeIds: z.array(z.string().min(1).max(256)).max(1000).optional() }).strict();
const ledgerSchema = z.object({ version: z.literal(1), records: z.array(recordSchema).max(S7_MAX_RECORDS) }).strict().superRefine((ledger, ctx) => {
  const ids = new Set<string>(), native = new Set<string>();
  let active = 0;
  for (const r of ledger.records) {
    if (ids.has(r.inputId) || r.commandId !== `cmd_s7_${r.inputId}` || r.idempotencyKey !== `s7_send:${r.inputId}` ||
        r.election.commandId !== r.commandId || r.election.targetConversationId !== r.targetConversationId ||
        (r.text !== undefined && (!singleLine(r.text) || hash(r.text) !== r.authoredHash)))
      ctx.addIssue({ code: 'custom', message: 'Invalid S7 custody identity' });
    ids.add(r.inputId);
    if (['DISPATCHED', 'CLAIMED', 'EXECUTING', 'PERSISTED', 'BLOCKED'].includes(r.state)) {
      active++;
      if (r.text === undefined) ctx.addIssue({ code: 'custom', message: 'Missing active S7 payload' });
    }
    if (['COMMITTED', 'COMPLETED'].includes(r.state) && (!r.nativeMessageId || r.proofLevel !== 'STRONG_COMMIT' || r.committedAt === undefined))
      ctx.addIssue({ code: 'custom', message: 'Missing S7 native receipt' });
    if (r.nativeMessageId) {
      const key = `${r.targetConversationId}:${r.nativeMessageId}`;
      if (native.has(key)) ctx.addIssue({ code: 'custom', message: 'Duplicate S7 native identity' });
      native.add(key);
    }
  }
  if (active > 1) ctx.addIssue({ code: 'custom', message: 'Multiple S7 flights' });
});
export type S7Record = z.infer<typeof recordSchema>;
export interface S7Reservation { readonly inputId: string; readonly target: string }
type Ledger = z.infer<typeof ledgerSchema>;
export interface S7Context { session: SessionSummary | null; uniqueSession: boolean; idle: boolean;
  automationOff: boolean; conflict: boolean; companion: boolean; current: () => boolean;
  election: S7Election; ready: boolean; uniqueDocuments: number }
export type S7Selection = { kind: 'LEGACY_AUTHORITY' | 'DEFER' } |
  { kind: 'PROTOCOL_AUTHORITY'; handoff: { kind: 'S7_PROTOCOL_HANDOFF'; command: ProtocolCommand; election: S7Election; expiresAt: number } };
interface Options { read?: () => Promise<StrictDurableRead>; write?: (value: Ledger) => Promise<void>; gate: () => S7Gate }
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function singleLine(text: string): boolean {
  return !!text.trim() && !/[\r\n\u2028\u2029]/.test(text) && text.length <= 4096 && Buffer.byteLength(text) <= 16384;
}
const uncertain = (r: S7Record) => ['PERSISTED', 'BLOCKED', 'DISPATCHED', 'CLAIMED', 'EXECUTING', 'AMBIGUOUS'].includes(r.state);
function eligible(row: InputEntry, context: S7Context, authority: S7Authority): boolean {
  return authority.candidate(row, context.session) &&
    context.uniqueSession &&
    !context.companion &&
    context.automationOff &&
    row.dueAt <= Date.now() &&
    row.deliveryText === row.text;
}

/** S7 has its own strict custody ledger. No transport pump, lease transfer or tombstone pruning. */
export class S7Authority {
  private ledger: Ledger = { version: 1, records: [] };
  private healthy = false;
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  private live = new Set<string>();
  private reservation: S7Reservation | null = null;
  private readiness: { welcome: HandshakeWelcome; emitter: string; ready: boolean; expiresAt: number } | null = null;
  constructor(private readonly options: Options) {}
  private read() { return this.options.read?.() ?? readStrictDurable(S7_LEDGER, S7_MAX_BYTES); }
  private write(value: Ledger) { return this.options.write?.(value) ?? writeStrictDurableNow(S7_LEDGER, value, S7_MAX_BYTES); }
  /** Settings take only this service queue, never the input queue. Callbacks project after release. */
  withSettings<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(work); this.queue = operation.catch(() => undefined); return operation;
  }
  /** A warm cache cannot authorize over missing, corrupt or externally replaced custody. */
  private async snapshotCurrent(): Promise<boolean> {
    try {
      const read = await this.read();
      if (read.kind === 'absent' && !this.options.gate().initialized && this.ledger.records.length === 0) return true;
      const parsed = read.kind === 'valid' ? ledgerSchema.safeParse(read.value) : null;
      if (parsed?.success && Buffer.byteLength(JSON.stringify(parsed.data)) <= S7_MAX_BYTES &&
          JSON.stringify(parsed.data) === JSON.stringify(ledgerSchema.parse(this.ledger))) return true;
    } catch { /* No payload or filesystem diagnostics cross the custody boundary. */ }
    this.healthy = false; this.loaded = true; return false;
  }
  private async publish(next: Ledger): Promise<void> {
    ledgerSchema.parse(next);
    if (Buffer.byteLength(JSON.stringify(next)) > S7_MAX_BYTES) throw new Error('S7 ledger capacity');
    if (!await this.snapshotCurrent()) throw new Error('S7 custody snapshot unavailable');
    await this.write(structuredClone(next));
    this.ledger = next;
  }
  async initialize(): Promise<void> {
    await this.withSettings(async () => {
      if (this.options.gate().initialized) {
        await this.validateInitialized();
        return;
      }
      const read = await this.read();
      if (read.kind === 'absent') await this.publish({ version: 1, records: [] });
      else {
        const parsed = read.kind === 'valid' ? ledgerSchema.safeParse(read.value) : null;
        if (!parsed?.success || Buffer.byteLength(JSON.stringify(parsed.data)) > S7_MAX_BYTES) throw new Error('S7 ledger unavailable');
        if (parsed.data.records.length) throw new Error('S7 uninitialized ledger is not empty');
        // An empty durable generation is the retry state after config persistence failed.
        if (!await this.snapshotCurrent()) throw new Error('S7 custody snapshot unavailable');
      }
      this.healthy = true; this.loaded = true;
    });
  }
  async validateInitialized(): Promise<void> {
    const read = await this.read();
    if (read.kind !== 'valid' || !ledgerSchema.safeParse(read.value).success || Buffer.byteLength(JSON.stringify(read.value)) > S7_MAX_BYTES)
      throw new Error('S7 initialized ledger unavailable');
    if (!await this.snapshotCurrent()) throw new Error('S7 initialized ledger unavailable');
  }
  async recover(): Promise<void> {
    await this.withSettings(async () => {
      const read = await this.read(); this.live.clear(); this.readiness = null;
      if (read.kind === 'absent' && !this.options.gate().initialized) {
        this.ledger = { version: 1, records: [] }; this.healthy = true; this.loaded = true; return;
      }
      const parsed = read.kind === 'valid' ? ledgerSchema.safeParse(read.value) : null;
      if (!parsed?.success || Buffer.byteLength(JSON.stringify(parsed.data)) > S7_MAX_BYTES) {
        this.healthy = false; this.loaded = true; return;
      }
      this.ledger = parsed.data; this.healthy = true; this.loaded = true;
      const next: Ledger = { version: 1, records: this.ledger.records.map(r => {
        const { text: _retired, beforeNativeIds: _baseline, ...tombstone } = r;
        if (!uncertain(r)) return tombstone;
        const privateUnpublished = !r.published && ['PERSISTED', 'BLOCKED'].includes(r.state) &&
          !r.sequence && !r.claimedEvent && r.beforeNativeIds === undefined && r.nativeMessageId === undefined &&
          r.proofLevel === undefined && r.committedAt === undefined;
        return { ...tombstone, state: privateUnpublished ? 'CANCELED' : 'AMBIGUOUS' };
      }) };
      if (JSON.stringify(next) !== JSON.stringify(this.ledger)) {
        try { await this.publish(next); } catch { this.healthy = false; }
      }
    });
  }
  blocks(row: Pick<InputEntry, 'id'>, reservation?: S7Reservation): boolean {
    return this.ledger.records.some(r => r.inputId === row.id) || (this.reservation?.inputId === row.id && this.reservation !== reservation) ||
      this.unsafeCustody();
  }
  private unsafeCustody(): boolean { return (this.loaded && !this.healthy) || (this.options.gate().initialized && !this.loaded); }
  candidate(row: InputEntry, session?: SessionSummary | null): boolean {
    if (!this.options.gate().enabled || !this.options.gate().initialized || this.unsafeCustody()) return false;
    const p = row.provenance;
    if (p?.kind !== 'ordinary-composer' || p.orchestratorRequested !== false || p.modelChoice !== 'current') return false;
    if (row.model !== null || row.reasoningEffort !== null) return false;
    if (!z.string().uuid().safeParse(row.id).success || !row.sessionId || !row.conversationId || row.opening) return false;
    if (row.state !== 'queued' || row.owner !== null || row.mode !== 'auto' || row.transportIntent !== 'browser') return false;
    if (row.requestedMode || row.delivery || row.attachmentDelivery || row.loopAfterTurn || row.afterTurn || row.error) return false;
    if (row.offeredAt !== undefined || row.sendAuthorizedAt !== undefined || row.companionInputId) return false;
    if ((row.images?.length ?? 0) > 0 || (row.attachments?.length ?? 0) > 0 || (row.toolImages?.length ?? 0) > 0) return false;
    if (row.automation && row.automation !== 'off') return false;
    if (row.objective || (row.stages?.length ?? 0) > 0 || row.finishOwner || row.recovery || row.silenceBoundary) return false;
    if (row.directTurn || row.queuedTurn || (row.purpose && row.purpose !== 'user') || row.lifetime) return false;
    if (row.authoredSource && row.authoredSource !== 'text') return false;
    if ((row.deliveryText !== undefined && row.deliveryText !== row.text) || !singleLine(row.text)) return false;
    if (session !== undefined) {
      if (!session || session.id !== row.sessionId || session.conversationId !== row.conversationId) return false;
      if (session.origin?.kind !== 'desktop') return false;
    }
    return true;
  }
  targetHeld(target: string | null, reservation?: S7Reservation): boolean {
    return !!target && (this.unsafeCustody() || (this.reservation?.target === target && this.reservation !== reservation) || this.ledger.records.some(r => r.targetConversationId === target && uncertain(r)));
  }
  records(): S7Record[] { return structuredClone(this.ledger.records); }
  reserve(inputId: string, target: string): S7Reservation | null {
    if (this.reservation) return null;
    const reservation = { inputId, target }; this.reservation = reservation;
    return reservation;
  }
  release(reservation: S7Reservation): void { if (this.reservation === reservation) this.reservation = null; }
  select(row: InputEntry, context: S7Context, reservation?: S7Reservation): Promise<S7Selection> {
    const reserve = reservation === this.reservation && reservation?.inputId === row.id && reservation.target === row.conversationId
      ? reservation : this.options.gate().enabled && eligible(row, context, this) ? this.reserve(row.id, row.conversationId!) : undefined;
    if (reserve === null) return Promise.resolve({ kind: 'DEFER' });
    return this.withSettings<S7Selection>(async () => {
      if (this.ledger.records.some(r => r.inputId === row.id) || this.unsafeCustody()) return { kind: 'DEFER' };
      if (!await this.snapshotCurrent()) return { kind: 'DEFER' };
      if (!this.options.gate().enabled || !eligible(row, context, this)) return { kind: 'LEGACY_AUTHORITY' };
      if (!this.options.gate().initialized || !this.healthy || !context.idle || context.conflict ||
          !context.ready || context.uniqueDocuments !== 1 || !context.current() ||
          !s7ElectionSchema.safeParse(context.election).success || context.election.commandId !== `cmd_s7_${row.id}` ||
          context.election.targetConversationId !== row.conversationId || this.ledger.records.some(uncertain) ||
          this.ledger.records.length >= S7_MAX_RECORDS) return { kind: 'DEFER' };
      const now = Date.now(), election = { ...context.election };
      const record: S7Record = { inputId: row.id, sessionId: row.sessionId!, commandId: election.commandId,
        idempotencyKey: `s7_send:${row.id}`, targetConversationId: row.conversationId!, state: 'DISPATCHED',
        authoredHash: hash(row.text), text: row.text, election, published: true, createdAt: now, expiresAt: now + 10000 };
      const command = parseProtocolCommand({ protocolVersion: 1, commandId: record.commandId, commandType: 'SEND_MESSAGE',
        source: 'desktop-main', target: 'content-script',
        sessionId: record.sessionId, conversationId: record.targetConversationId, idempotencyKey: record.idempotencyKey,
        createdAt: now, expiresAt: record.expiresAt, generation: 0, payload: { text: row.text, targetConversationId: record.targetConversationId, timeoutMs: 10000 } });
      try { await this.publish({ version: 1, records: [...this.ledger.records, record] }); }
      catch { return { kind: 'DEFER' }; }
      this.live.add(row.id);
      if (!context.current()) { await this.retire(record); return { kind: 'DEFER' }; }
      return { kind: 'PROTOCOL_AUTHORITY', handoff: { kind: 'S7_PROTOCOL_HANDOFF', command, election, expiresAt: record.expiresAt } };
    }).finally(() => { if (reserve && reserve !== reservation) this.release(reserve); });
  }
  private async replace(record: S7Record): Promise<void> {
    await this.publish({ version: 1, records: this.ledger.records.map(r => r.inputId === record.inputId ? record : r) });
  }
  private async retire(record: S7Record): Promise<void> {
    const { text: _retired, beforeNativeIds: _baseline, ...tombstone } = record;
    await this.replace({ ...tombstone, state: record.state === 'EXECUTING' ? 'AMBIGUOUS' : 'CANCELED' });
    this.live.delete(record.inputId);
  }
  action(action: string, rawElection: unknown, rawProof?: unknown, rawEvent?: unknown): Promise<{ ok: boolean; claimLeaseUntil?: number }> {
    return this.withSettings(async () => {
      const election = s7ElectionSchema.safeParse(rawElection);
      if (!election.success || !this.healthy) return { ok: false };
      if (!await this.snapshotCurrent()) return { ok: false };
      let record = this.ledger.records.find(r => r.commandId === election.data.commandId);
      if (!record || !this.live.has(record.inputId) || JSON.stringify(record.election) !== JSON.stringify(election.data)) return { ok: false };
      if (rawEvent !== undefined) {
        try {
          const event = parseProtocolEvent(rawEvent);
          const expected = { claimed: 'COMMAND_CLAIMED', start: 'MESSAGE_SUBMIT_STARTED', commit: 'MESSAGE_COMMITTED' }[action];
          if (!expected || event.eventType !== expected || event.commandId !== record.commandId || event.source !== 'content-script' ||
              event.sessionId !== record.sessionId || event.conversationId !== record.targetConversationId || event.generation !== 0 ||
              event.connectionEpoch !== record.election.connectionEpoch || event.emitterEpoch !== record.election.documentId ||
              event.sequence !== (record.sequence ?? 0) + 1) return { ok: false };
          if (action === 'claimed') {
            const claimed = commandClaimedPayloadSchema.strict().parse(event.payload);
            if (claimed.clientDocumentId !== record.election.documentId || claimed.tabId !== record.election.tabId) return { ok: false };
          } else if (action === 'start') {
            if (!record.claimedEvent || !event.payload || Object.keys(event.payload as object).length) return { ok: false };
          } else if (action === 'commit') {
            const proof = messageCommittedPayloadSchema.strict().parse(event.payload);
            const source = rawProof as Record<string, unknown> | undefined;
            if (proof.proofLevel !== 'STRONG_COMMIT' || proof.nativeMessageId !== source?.nativeMessageId ||
                proof.conversationId !== source?.conversationId || proof.candidateCount !== source?.candidateCount ||
                proof.matchedText !== source?.sourceText) return { ok: false };
          }
          record = { ...record, sequence: event.sequence };
        } catch { return { ok: false }; }
      }
      if (Date.now() >= record.expiresAt && action !== 'abort') {
        try { await this.retire(record); } catch { this.healthy = false; }
        return { ok: false };
      }
      try {
        if (action === 'abort') { if (uncertain(record)) await this.retire(record); return { ok: true }; }
        if (action === 'verify') return { ok: record.state === 'EXECUTING' };
        if (action === 'claim' && record.state === 'DISPATCHED') {
          await this.replace({ ...record, state: 'CLAIMED' }); return { ok: true, claimLeaseUntil: record.expiresAt };
        }
        if (action === 'claimed' && record.state === 'CLAIMED' && !record.claimedEvent) {
          await this.replace({ ...record, claimedEvent: true }); return { ok: true };
        }
        if (action === 'start' && record.state === 'CLAIMED') {
          const baseline = z.object({ beforeNativeIds: z.array(z.string().min(1).max(256)).max(1000) }).strict().safeParse(rawProof);
          if (!baseline.success) return { ok: false };
          await this.replace({ ...record, beforeNativeIds: [...new Set(baseline.data.beforeNativeIds)], state: 'EXECUTING' }); return { ok: true };
        }
        if (action === 'commit' && record.state === 'EXECUTING') {
          const proof = z.object({ canonical: z.literal(true), candidateCount: z.literal(1), conversationId: z.string(),
            sourceText: z.string().max(4096), attachmentCount: z.literal(0),
            nativeMessageId: z.string().min(1).max(256).refine(value => !!value.trim() && value === value.trim()) }).strict().safeParse(rawProof);
          if (!proof.success || proof.data.conversationId !== record.targetConversationId || proof.data.sourceText !== record.text ||
              record.beforeNativeIds?.includes(proof.data.nativeMessageId) ||
              this.ledger.records.some(r => r.inputId !== record.inputId && r.targetConversationId === record.targetConversationId && r.nativeMessageId === proof.data.nativeMessageId)) return { ok: false };
          const { text: _retired, beforeNativeIds: _baseline, ...tombstone } = record;
          await this.replace({ ...tombstone, state: 'COMMITTED', proofLevel: 'STRONG_COMMIT',
            nativeMessageId: proof.data.nativeMessageId, committedAt: Date.now() });
          this.live.delete(record.inputId); return { ok: true };
        }
      } catch { return { ok: false }; }
      return { ok: false };
    });
  }
  handshake(action: string, body: Record<string, unknown>): unknown {
    if (!this.options.gate().enabled || !this.options.gate().initialized || !this.healthy) return null;
    if (action === 'hello') {
      const hello = handshakeHelloSchema.safeParse(body.hello);
      const emitter = epoch.safeParse(body.emitterEpoch);
      if (!hello.success || hello.data.protocolVersion !== 1 || !hello.data.capabilities.includes('SEND_MESSAGE') || !emitter.success) return null;
      const welcome = handshakeWelcomeSchema.parse({ type: 'WELCOME', acceptedProtocolVersion: 1,
        desktopInstanceId: 'kosmosyn_s7_authority', appVersion: body.appVersion, negotiatedCapabilities: ['SEND_MESSAGE'],
        connectionGeneration: 0, connectionEpoch: `s7_${randomUUID()}`, reconcileRequested: false });
      this.readiness = { welcome, emitter: emitter.data, ready: false, expiresAt: Date.now() + 5000 }; return welcome;
    }
    const ready = handshakeReadySchema.safeParse(body.ready), state = this.readiness;
    if (!state || Date.now() >= state.expiresAt || !ready.success || body.emitterEpoch !== state.emitter ||
        ready.data.connectionEpoch !== state.welcome.connectionEpoch || ready.data.connectionGeneration !== 0) return null;
    state.ready = true; return { ready: true };
  }
  ready(election: S7Election): boolean {
    const r = this.readiness;
    return !!r && r.ready && Date.now() < r.expiresAt && r.emitter === election.backgroundEmitterEpoch && r.welcome.connectionEpoch === election.connectionEpoch;
  }
  invalidateConnection(): void { this.readiness = null; this.live.clear(); }
  receiptMatches(record: S7Record, row: InputEntry): boolean {
    return record.inputId === row.id && record.sessionId === row.sessionId && record.targetConversationId === row.conversationId && hash(row.text) === record.authoredHash;
  }
  historyAllowed(row: InputEntry): boolean {
    if (this.unsafeCustody()) return false;
    const record = this.ledger.records.find(r => r.inputId === row.id);
    return !record || (['COMMITTED', 'COMPLETED'].includes(record.state) && this.receiptMatches(record, row) &&
      record.nativeMessageId === row.messageId && record.committedAt === row.deliveredAt);
  }
}
let gateProvider = (): S7Gate => ({ enabled: false, initialized: false });
export function configureS7Gate(provider: () => S7Gate): void { gateProvider = provider; }
export const s7Authority = new S7Authority({ gate: () => gateProvider() });
