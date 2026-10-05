import { beforeEach, afterEach, describe, it, expect, vi, type Mock } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { BrowserTransportService } from '../../src/main/browser-transport/service.js';
import { FakeTransportAdapter } from '../../src/main/browser-transport/fake-adapter.js';
import { CurrentBridgeAdapter } from '../../src/main/browser-transport/current-bridge-adapter.js';
import { initDurableStore, resetDurableForTests, readDurable, writeDurableNow } from '../../src/main/durable.js';
import { PROTOCOL_STORE_NAME } from '../../src/main/browser-transport/store.js';
import type { CommandState, ProtocolEvent, HandshakeWelcome } from '../../src/shared/protocol/index.js';
import { S6Canary, s6TargetHeld } from '../../src/main/browser-transport/s6-canary.js';
import type { S6Election, S6ClaimContext } from '../../src/main/browser-transport/service.js';

const specimen = '[KOSMOSYN_S6_CANARY]';
const key = 's6_single_specimen_canary';
describe('S6 claim and capability durable boundaries', () => {
  let directory: string, service: BrowserTransportService;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 's6-contract-'));
    initDurableStore(directory);
    service = new BrowserTransportService(new FakeTransportAdapter('CONNECTED'));
    await service.start();
  });
  afterEach(async () => {
    await service.stop(); resetDurableForTests();
    await fs.rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  function command(strict = false) {
    return service.createCommand('SEND_MESSAGE', { text: specimen, targetConversationId: 'conv_s6', timeoutMs: 10000 },
      { sessionId: 's6_canary', conversationId: 'conv_s6', ...(strict ? { idempotencyKey: key } : {}) });
  }
  it('does not grant a claim lease after cancellation', async () => {
    const c = command(), record = await service.submitCommand(c);
    await service.cancelCommand(c.commandId, 'before claim');
    const before = structuredClone(record), durableBefore = await readDurable(PROTOCOL_STORE_NAME);
    expect((await service.claimCommand(c.commandId, 'doc_after_cancel')).ok).toBe(false);
    expect(record).toEqual(before);
    expect(await readDurable(PROTOCOL_STORE_NAME)).toEqual(durableBefore);
  });
  it.each(['CREATED', 'PERSISTED', 'CLAIMED', 'EXECUTING', 'COMMITTED', 'COMPLETED', 'BLOCKED',
    'AMBIGUOUS', 'FAILED', 'EXPIRED', 'CANCELED'] as CommandState[])(
    'strict S6 cannot claim from %s or introduce metadata', async state => {
      const c = command(true), record = await service.submitCommand(c);
      record.state = state; await service.getStore().updateCommand(record, true);
      const before = structuredClone(record);
      expect((await service.claimCommand(c.commandId, 'doc_strict')).ok).toBe(false);
      expect(record).toEqual(before);
    });
  it('claim persistence failure restores every field and publishes nothing', async () => {
    const c = command(), record = await service.submitCommand(c), before = structuredClone(record);
    const listener = vi.fn(); service.onCommandState(listener);
    vi.spyOn(service.getStore(), 'updateCommand').mockRejectedValueOnce(new Error('claim disk failure'));
    await expect(service.claimCommand(c.commandId, 'doc_disk')).rejects.toThrow('claim disk failure');
    expect(record).toEqual(before); expect(listener).not.toHaveBeenCalled();
  });
  it('HELLO [] blocks SEND_MESSAGE', async () => {
    service.handleHandshakeHello({ type: 'HELLO', protocolVersion: 1, extensionVersion: '2.1.20',
      connectionGeneration: 0, capabilities: [] });
    expect((await service.submitCommand(command())).state).toBe('BLOCKED');
  });
  it.each(['failure', 'strong-commit'] as const)('claim vs %s preserves both serialized queue orders', async kind => {
    for (const claimFirst of [true, false]) {
      const c = command(), r = await service.submitCommand(c);
      // Strong facts resolve CLAIMED/EXECUTING uncertainty. Exercise a legal
      // expired-observer rebind racing with that supported external fact.
      if (kind === 'strong-commit') {
        await service.claimCommand(c.commandId, 'doc_prior'); r.claimLeaseUntil = 0;
        await service.getStore().updateCommand(r, true);
      }
      const fact: ProtocolEvent = { protocolVersion: 1, eventId: `evt_${globalThis.crypto.randomUUID()}`,
        commandId: c.commandId, eventType: kind === 'failure' ? 'COMMAND_FAILED' : 'MESSAGE_COMMITTED',
        source: 'content-script', sessionId: c.sessionId, conversationId: c.conversationId,
        generation: service.getGeneration(), sequence: 1, occurredAt: Date.now(), payload: kind === 'failure' ? {
          errorCode: 'UNKNOWN_ERROR', message: 'fixture failure', retryable: false, failedAt: Date.now()
        } : { proofLevel: 'STRONG_COMMIT', nativeMessageId: `native_${c.commandId}`, conversationId: c.conversationId, candidateCount: 1 } };
      const blocked = deferred(), entered = deferred(), store = service.getStore(), update = store.updateCommand.bind(store);
      const spy = vi.spyOn(store, 'updateCommand').mockImplementationOnce(async (record, immediate) => {
        entered.release(); await blocked.promise; await update(record, immediate);
      });
      const first = claimFirst ? service.claimCommand(c.commandId, 'doc_race') : service.handleEvent(fact);
      await entered.promise;
      const second = claimFirst ? service.handleEvent(fact) : service.claimCommand(c.commandId, 'doc_race');
      blocked.release(); await first; const result = await second;
      expect(r.state).toBe(kind === 'failure' ? 'FAILED' : 'COMMITTED');
      expect(r.owner).toBe(claimFirst ? 'doc_race' : kind === 'strong-commit' ? 'doc_prior' : null);
      if (!claimFirst) expect(result).toMatchObject({ ok: false });
      const before = structuredClone(r); expect((await service.claimCommand(c.commandId, 'stale_later')).ok).toBe(false);
      expect(r).toEqual(before); spy.mockRestore();
    }
  });
});

it('cross-transport lease is acquired before serialized legacy preflight and busy creates no command', async () => {
  const { S6Canary, s6TargetHeld } = await import('../../src/main/browser-transport/s6-canary.js');
  const wake = vi.fn(), preflight = vi.fn(async (target: string) => {
    expect(s6TargetHeld(target)).toBe(true); return false;
  });
  const canary = new S6Canary(wake, preflight);
  expect(await canary.run({ enabled: true, targetConversationId: '12345678-abcd' }))
    .toEqual({ ok: false, failureCode: 'CONVERSATION_BUSY' });
  expect(wake).not.toHaveBeenCalled(); expect(canary.service.getStore().getUnresolvedCommands()).toEqual([]);
  expect(s6TargetHeld('12345678-abcd')).toBe(false);
});

it('one-specimen gate consumes every previous state including never-published and restart quarantine', async () => {
  const { isS6Specimen } = await import('../../src/main/browser-transport/s6-canary.js');
  const service = new BrowserTransportService(new FakeTransportAdapter());
  const c = service.createCommand('SEND_MESSAGE', { text: specimen, targetConversationId: '12345678-abcd', timeoutMs: 10000 },
    { sessionId: 's6_canary', conversationId: '12345678-abcd', idempotencyKey: key });
  expect(isS6Specimen(c)).toBe(true);
  expect(isS6Specimen({ ...c, payload: { ...c.payload, text: 'arbitrary user text' } })).toBe(false);
});

async function backgroundS6(context: Record<string, unknown>) {
  const source = await fs.readFile(path.join(process.cwd(), 'extension/background.js'), 'utf8');
  const start = source.indexOf('// S6 controlled SEND_MESSAGE sidecar.');
  const end = source.indexOf('// End S6 controlled SEND_MESSAGE sidecar.', start);
  const sandbox = vm.createContext({ ...context, Date, Number, Object, Array });
  vm.runInContext(source.slice(start, end), sandbox);
  return sandbox;
}
it('trusted sender rejects a non-top-frame and ignores content-supplied tab identity', async () => {
  const sandbox = await backgroundS6({});
  expect(await vm.runInContext("s6ContentRequest({ tabId: 999 }, { frameId: 1, tab: { id: 1 }, documentId: 'doc' })", sandbox))
    .toMatchObject({ ok: false });
});
it('duplicate target tabs elect exactly one active settled registered document', async () => {
  const target = '12345678-abcd';
  const sandbox = await backgroundS6({ tabDocuments: { 1: 'doc_1', 2: 'doc_2' }, tabEpochs: { 1: 3, 2: 3 },
    ownsDocument: () => true, conversationFromUrl: () => target, conversationForTab: () => target });
  sandbox.tabs = [{ id: 2, url: 'target', active: false, status: 'complete', lastAccessed: 99 },
    { id: 1, url: 'target', active: true, status: 'complete', lastAccessed: 1 }];
  expect(vm.runInContext(`s6Elect(tabs, '${target}')`, sandbox)).toMatchObject({ tabId: 1, documentId: 'doc_1', navigationEpoch: 3 });
});
it('durable start ACK precedes insertion and duplicate offer cannot spend another send', async () => {
  const source = await fs.readFile(path.join(process.cwd(), 'extension/content.js'), 'utf8');
  const start = source.indexOf('  // S6 controlled document mutation.'), end = source.indexOf('  // End S6 controlled document mutation.', start);
  const calls: string[] = [];
  const sandbox = vm.createContext({ Date, Set, alive: true, epoch: 3, desktopInputBusy: false,
    generating: false, pendingTools: 0, documentReady: Promise.resolve({ documentId: 'doc_1', navigationEpoch: 3 }),
    CLF_DOM: { conversationId: () => '12345678-abcd', composerVisible: () => true, composerWritable: () => true,
      composer: () => ({ textContent: '' }), hasComposerAttachments: () => false, generating: () => false, securityOrAuthRequired: () => false, messages: () => [],
      insertPrompt: () => { calls.push('insert'); return true; } },
    ask: async (message: { action: string; eventType?: string }) => {
      calls.push(message.eventType || message.action);
      return message.action === 'claim' ? { ok: true, claimLeaseUntil: Date.now() + 5000 } : { ok: false };
    } });
  vm.runInContext(source.slice(start, end), sandbox);
  sandbox.offer = { commandId: 'cmd_s6_once', targetConversationId: '12345678-abcd', navigationEpoch: 3,
    documentId: 'doc_1', expiresAt: Date.now() + 5000 };
  await vm.runInContext('executeS6Offer(offer)', sandbox);
  await vm.runInContext('executeS6Offer(offer)', sandbox);
  expect(calls).toEqual(['claim', 'COMMAND_CLAIMED']);
  expect(vm.runInContext('desktopInputBusy', sandbox)).toBe(false);
});

it('S6 publication is unavailable until explicitly durably published', async () => {
  const adapter = new CurrentBridgeAdapter(), service = new BrowserTransportService(adapter);
  const c = service.createCommand('SEND_MESSAGE', { text: specimen, targetConversationId: 'conv_s6', timeoutMs: 10000 },
    { sessionId: 's6_canary', conversationId: 'conv_s6', idempotencyKey: key });
  await adapter.connect();
  // Narrow opt-in slot, separate from the existing S4 admission.
  adapter.expectS6Command(c);
  expect(await adapter.send({ kind: 'PROTOCOL_COMMAND', command: c })).toBe(true);
  expect(adapter.poll()).toBeNull();
});

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
describe('S6 authorized flight arbitration and rollback', () => {
  let directory: string, service: BrowserTransportService, welcome: HandshakeWelcome;
  let election: S6Election, authority: S6ClaimContext, live: boolean;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 's6-arbitration-')); initDurableStore(directory);
    service = new BrowserTransportService(new FakeTransportAdapter('CONNECTED')); await service.start();
    const response = service.handleHandshakeHello({ type: 'HELLO', protocolVersion: 1,
      extensionVersion: '2.1.20', connectionGeneration: 0, capabilities: ['SEND_MESSAGE'] });
    if (response.type !== 'WELCOME') throw new Error('welcome missing');
    welcome = response; service.handleHandshakeReady(welcome); live = true;
    const command = service.createCommand('SEND_MESSAGE', { text: specimen, targetConversationId: '12345678-abcd', timeoutMs: 10000 },
      { sessionId: 's6_canary', conversationId: '12345678-abcd', idempotencyKey: key });
    authority = { connectionEpoch: welcome.connectionEpoch, generation: welcome.connectionGeneration, backgroundEmitterEpoch: 's6_background' };
    election = { tabId: 1, documentId: 's6_document', navigationEpoch: 2, targetConversationId: '12345678-abcd', commandId: command.commandId };
    service.registerS6({ ...authority, commandId: command.commandId, targetConversationId: election.targetConversationId, current: () => live });
    await service.submitCommand(command); expect(await service.publishS6(command.commandId, () => undefined)).toBe(true);
    expect(await service.electS6(election)).toBe(true);
  });
  afterEach(async () => {
    await service.stop(); resetDurableForTests(); vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const claim = (service: BrowserTransportService, e: S6Election, a: S6ClaimContext) => service.claimCommand(e.commandId, e.documentId, 30000, e, a);
  function event(type: ProtocolEvent['eventType'], sequence = 1, payload: unknown = {}): ProtocolEvent {
    return { protocolVersion: 1, eventId: `evt_${globalThis.crypto.randomUUID()}`, commandId: election.commandId,
      eventType: type, source: 'content-script', sessionId: 's6_canary', conversationId: election.targetConversationId,
      generation: welcome.connectionGeneration, connectionEpoch: welcome.connectionEpoch, emitterEpoch: election.documentId,
      sequence, occurredAt: Date.now(), payload };
  }
  function strong() { return { proofLevel: 'STRONG_COMMIT', nativeMessageId: 'native_s6', conversationId: election.targetConversationId, candidateCount: 1 }; }
  function accept(e: ProtocolEvent) { return service.handleEvent(e, { election, authority }); }
  it('fresh claim is durable, capped at expiration, and confirmation creates no lease', async () => {
    expect((await claim(service, election, authority)).ok).toBe(true);
    const r = service.getStore().get(election.commandId)!;
    expect(r.claimLeaseUntil).toBe(r.command.expiresAt);
    const lease = r.claimLeaseUntil, claimedAt = r.claimedAt;
    expect((await accept(event('COMMAND_CLAIMED', 1, {
      clientDocumentId: election.documentId, tabId: election.tabId, claimedAt: Date.now() }))).accepted).toBe(true);
    expect(r.claimLeaseUntil).toBe(lease); expect(r.claimedAt).toBe(claimedAt);
    expect(JSON.stringify(await readDurable(PROTOCOL_STORE_NAME))).toContain('s6_document');
  });
  it.each(['same', 'different', 'expired'])( '%s document duplicate cannot transfer or renew', async kind => {
    await claim(service, election, authority);
    const r = service.getStore().get(election.commandId)!;
    if (kind === 'expired') { r.claimLeaseUntil = 0; await service.getStore().updateCommand(r, true); }
    const before = structuredClone(r);
    expect((await service.claimCommand(election.commandId, kind === 'different' ? 'other_doc' : election.documentId, 30000,
      kind === 'different' ? { ...election, documentId: 'other_doc' } : election, authority)).ok).toBe(false);
    expect(r).toEqual(before);
  });
  it.each(['CREATED', 'PERSISTED', 'CLAIMED', 'EXECUTING', 'COMMITTED', 'COMPLETED', 'BLOCKED', 'AMBIGUOUS', 'FAILED', 'EXPIRED', 'CANCELED'] as CommandState[])(
    'registered strict flight rejects %s with exact record unchanged', async state => {
      const r = service.getStore().get(election.commandId)!; r.state = state;
      await service.getStore().updateCommand(r, true); const before = structuredClone(r);
      expect((await claim(service, election, authority)).ok).toBe(false); expect(r).toEqual(before);
    });
  it.each(['connectionEpoch', 'generation', 'backgroundEmitterEpoch'] as const)('service itself rejects incorrect %s', async field => {
    const wrong = { ...authority, [field]: field === 'generation' ? 999 : 'wrong_authority' };
    expect((await claim(service, election, wrong)).ok).toBe(false);
    expect(service.getStore().get(election.commandId)?.owner).toBeNull();
  });
  it('claim write failure removes newly introduced fields and exactly restores durable claim truth', async () => {
    const r = service.getStore().get(election.commandId)!, before = structuredClone(r), notify = vi.fn();
    service.onCommandState(notify);
    vi.spyOn(service.getStore(), 'updateCommand').mockImplementationOnce(async record => {
      Object.assign(record, { injectedFailedField: 'must disappear' }); throw new Error('durability failed');
    });
    await expect(claim(service, election, authority)).rejects.toThrow('durability failed');
    expect(r).toEqual(before); expect(notify).not.toHaveBeenCalled();
    expect(await claim(service, election, authority)).toMatchObject({ ok: true });
  });
  it.each(['cancel', 'timeout', 'disable'] as const)('claim before %s retains only the elected custody', async kind => {
    const blocked = deferred(), entered = deferred(), store = service.getStore(), update = store.updateCommand.bind(store);
    vi.spyOn(store, 'updateCommand').mockImplementationOnce(async (r, immediate) => { entered.release(); await blocked.promise; await update(r, immediate); });
    const claiming = claim(service, election, authority); await entered.promise;
    if (kind === 'disable') live = false;
    const retiring = kind === 'cancel' ? service.cancelCommand(election.commandId, 'race') : service.cleanupS6(election.commandId);
    blocked.release(); expect((await claiming).ok).toBe(kind !== 'disable'); await retiring;
    expect(store.get(election.commandId)?.owner).toBe(election.documentId);
    expect((await claim(service, election, authority)).ok).toBe(false);
  });
  it.each(['cancel', 'timeout', 'disable'] as const)('%s before claim attaches no owner or lease', async kind => {
    const retiring = kind === 'cancel' ? service.cancelCommand(election.commandId, 'race') : service.cleanupS6(election.commandId);
    const claiming = claim(service, election, authority); await retiring;
    expect((await claiming).ok).toBe(false);
    expect(service.getStore().get(election.commandId)).toMatchObject({ owner: null, claimedAt: null, claimLeaseUntil: null });
  });
  it('durable start wins over cancel/disable and is quarantined without discarding a later strong fact', async () => {
    await claim(service, election, authority);
    expect((await accept(event('MESSAGE_SUBMIT_STARTED'))).accepted).toBe(true);
    await service.cancelCommand(election.commandId, 'after start'); live = false;
    expect(service.getStore().get(election.commandId)?.state).toBe('AMBIGUOUS');
    expect((await accept(event('MESSAGE_COMMITTED', 2, strong()))).accepted).toBe(true);
    await service.cleanupS6(election.commandId);
    expect(service.getStore().get(election.commandId)?.state).toBe('COMMITTED');
    expect((await accept(event('MESSAGE_COMMITTED', 3, strong()))).duplicate).toBe(true);
  });
  it.each(['WEAK_COMMIT', 'missing', 'multiple', 'wrong-conversation'])( '%s cannot establish strong commit', async kind => {
    await claim(service, election, authority); await accept(event('MESSAGE_SUBMIT_STARTED'));
    const p = { ...strong(), ...(kind === 'WEAK_COMMIT' ? { proofLevel: 'WEAK_COMMIT' } : {}),
      ...(kind === 'missing' ? { nativeMessageId: '' } : {}), ...(kind === 'multiple' ? { candidateCount: 2 } : {}),
      ...(kind === 'wrong-conversation' ? { conversationId: 'other_target' } : {}) };
    await accept(event('MESSAGE_COMMITTED', 2, p));
    expect(service.getStore().get(election.commandId)?.state).not.toBe('COMMITTED');
  });
  it('failed durable start rolls back to CLAIMED and cannot authorize mutation', async () => {
    await claim(service, election, authority); const r = service.getStore().get(election.commandId)!, before = structuredClone(r);
    vi.spyOn(service.getStore(), 'updateCommand').mockRejectedValueOnce(new Error('start disk failure'));
    await expect(accept(event('MESSAGE_SUBMIT_STARTED'))).rejects.toThrow('start disk failure');
    expect(r).toEqual(before); expect(await service.verifyS6(election.commandId, election)).toBe(false);
  });
  it.each(['PERSISTED', 'DISPATCHED', 'CLAIMED', 'EXECUTING', 'COMMITTED', 'COMPLETED', 'AMBIGUOUS', 'FAILED', 'EXPIRED', 'CANCELED', 'BLOCKED'] as CommandState[])(
    'restart %s never sends or admits another specimen', async state => {
      const r = service.getStore().get(election.commandId)!; r.state = state; await service.getStore().updateCommand(r, true); await service.stop();
      const adapter = new FakeTransportAdapter('CONNECTED'), restarted = new BrowserTransportService(adapter); await restarted.start();
      try {
        expect(restarted.getStore().get(election.commandId)?.state).toBe(['DISPATCHED', 'CLAIMED', 'EXECUTING'].includes(state) ? 'AMBIGUOUS' : state);
        expect(adapter.sentMessages).toEqual([]);
        const wake = vi.fn(), canary = new S6Canary(wake, async () => true);
        expect(await canary.run({ enabled: true, targetConversationId: election.targetConversationId })).toMatchObject({ failureCode: 'ALREADY_EXERCISED' });
        expect(wake).not.toHaveBeenCalled(); expect(canary.service.getStore().findByIdempotencyKey(key)?.command.commandId).toBe(election.commandId);
        await canary.service.stop();
      } finally { await restarted.stop(); }
    });
});

describe('S6 controller publication, capability and retained cleanup custody', () => {
  let directory: string, canary: S6Canary, wake: Mock<() => void>;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 's6-controller-')); initDurableStore(directory);
    await writeDurableNow(PROTOCOL_STORE_NAME, { version: 1, instanceId: 's6_reviewed_empty_fixture', commands: {}, recentCommittedIds: [] });
    wake = vi.fn(); canary = new S6Canary(wake, async () => true);
  });
  afterEach(async () => {
    canary.disable();
    await vi.waitFor(() => expect(canary.hasCustody()).toBe(false));
    await canary.service.stop(); resetDurableForTests(); vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const options = { enabled: true as const, targetConversationId: '12345678-abcd' };
  async function handshake() {
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    const hello = await canary.request('/protocol/hello', { emitterEpoch: 's6_background', hello: {
      type: 'HELLO', protocolVersion: 1, extensionVersion: '2.1.20', connectionGeneration: 0, capabilities: ['SEND_MESSAGE'] } });
    expect(hello.status).toBe(200); const welcome = hello.body as HandshakeWelcome;
    const authority = { emitterEpoch: 's6_background', connectionEpoch: welcome.connectionEpoch, connectionGeneration: welcome.connectionGeneration };
    expect((await canary.request('/protocol/ready', { emitterEpoch: authority.emitterEpoch,
      ready: { type: 'READY', connectionEpoch: authority.connectionEpoch, connectionGeneration: authority.connectionGeneration, activeSessions: [], boundTabsCount: 0 } })).status).toBe(200);
    return authority;
  }
  it.each([null, '', 'New Chat', 'not-a-conversation'])( 'rejects invalid target %s before preflight/wake', async target => {
    expect(await canary.run({ enabled: true, targetConversationId: target as string })).toMatchObject({ failureCode: 'INVALID_SYNTHETIC_DOMAIN' });
    expect(wake).not.toHaveBeenCalled();
  });
  it('caller cannot supply text, images, media, model or reasoning', async () => {
    for (const extra of ['text', 'image', 'attachment', 'model', 'reasoning'])
      expect(await canary.run({ ...options, [extra]: 'user data' })).toMatchObject({ failureCode: 'INVALID_SYNTHETIC_DOMAIN' });
    expect(wake).not.toHaveBeenCalled();
  });
  it('READY and publication are required; stale S4 HELLO cannot arm S6', async () => {
    const running = canary.run(options); await vi.waitFor(() => expect(wake).toHaveBeenCalled());
    expect((await canary.request('/protocol/hello', { emitterEpoch: 's4_background', hello: {
      type: 'HELLO', protocolVersion: 1, extensionVersion: '2.1.20', connectionGeneration: 0, capabilities: [] } })).status).toBe(409);
    expect(canary.service.getStore().findByIdempotencyKey(key)).toBeUndefined();
    expect(canary.service.isReady()).toBe(false);
    canary.disable(); expect(await running).toMatchObject({ ok: false });
  });
  it.each(['missing', 'corrupt'] as const)('missing/corrupt one-shot gate authority fails closed (%s)', async kind => {
    if (kind === 'missing') await fs.rm(path.join(directory, 'state', `${PROTOCOL_STORE_NAME}.json`));
    if (kind === 'corrupt') await writeDurableNow(PROTOCOL_STORE_NAME, { version: 99, commands: null });
    wake.mockImplementation(() => { queueMicrotask(() => canary.disable()); });
    expect(await canary.run(options)).toMatchObject({ failureCode: 'REQUIRES_HEAD_REVIEW' });
    expect(wake).not.toHaveBeenCalled(); expect(canary.service.getStore().findByIdempotencyKey(key)).toBeUndefined();
  });
  it('DISPATCHED persistence in flight remains unpollable and a failure clears the exact adapter slot', async () => {
    const blocked = deferred(), entered = deferred(), store = canary.service.getStore(), update = store.updateCommand.bind(store);
    vi.spyOn(store, 'updateCommand').mockImplementation(async (r, immediate) => {
      if (r.state === 'DISPATCHED') { entered.release(); await blocked.promise; throw new Error('dispatch disk failure'); }
      return update(r, immediate);
    });
    const running = canary.run(options), authority = await handshake(); await entered.promise;
    expect((await canary.request('/protocol/poll', authority)).body).toEqual({ command: null });
    expect(canary.adapter.poll()).toBeNull(); blocked.release();
    expect(await running).toMatchObject({ ok: false, failureCode: 'SIDECAR_UNAVAILABLE' });
    await vi.waitFor(() => expect(canary.hasCustody()).toBe(false));
    const r = store.findByIdempotencyKey(key)!;
    canary.adapter.publishS6(r.command.commandId); expect(canary.adapter.poll()).toBeNull();
    expect(r.state).toBe('CANCELED');
  });
  it('authenticates frozen election, claims durably, starts durably, and acknowledges the exact strong fact', async () => {
    const running = canary.run(options), authority = await handshake();
    let commandId = '';
    await vi.waitFor(async () => {
      const body = (await canary.request('/protocol/poll', authority)).body as { command?: { commandId: string } };
      expect(body.command).toBeTruthy(); commandId = body.command!.commandId;
    });
    const election = { tabId: 1, documentId: 's6_document', navigationEpoch: 2, targetConversationId: options.targetConversationId, commandId };
    expect((await canary.request('/protocol/claim', { ...authority, election, action: 'claim' })).status).toBe(409);
    expect((await canary.request('/protocol/claim', { ...authority, election, action: 'elect' })).status).toBe(200);
    expect((await canary.request('/protocol/claim', { ...authority, election: { ...election, tabId: 99 }, action: 'claim' })).status).toBe(409);
    expect((await canary.request('/protocol/claim', { ...authority, election, action: 'claim' })).body).toMatchObject({ ok: true });
    expect((await canary.request('/protocol/claim', { ...authority, election, action: 'claim' })).status).toBe(409);
    async function send(eventType: ProtocolEvent['eventType'], sequence: number, payload: unknown, tuple = election) {
      return canary.request('/protocol/events', { ...authority, election: tuple, event: {
        protocolVersion: 1, eventId: `evt_${globalThis.crypto.randomUUID()}`, commandId, eventType, source: 'content-script',
        sessionId: 's6_canary', conversationId: options.targetConversationId, connectionEpoch: authority.connectionEpoch,
        generation: authority.connectionGeneration, emitterEpoch: election.documentId, sequence, occurredAt: Date.now(), payload } });
    }
    expect((await send('COMMAND_CLAIMED', 1, { clientDocumentId: election.documentId, tabId: 1, claimedAt: Date.now() },
      { ...election, navigationEpoch: 999 })).status).toBe(409);
    expect((await send('COMMAND_CLAIMED', 1, { clientDocumentId: election.documentId, tabId: 1, claimedAt: Date.now() })).body).toMatchObject({ accepted: true });
    expect((await send('MESSAGE_SUBMIT_STARTED', 2, {})).body).toMatchObject({ accepted: true });
    expect((await canary.request('/protocol/claim', { ...authority, election, action: 'verify' })).body).toEqual({ ok: true });
    const commit = { proofLevel: 'STRONG_COMMIT', nativeMessageId: 'native_s6_one', conversationId: options.targetConversationId, candidateCount: 1 };
    expect((await send('MESSAGE_COMMITTED', 3, { ...commit, evidenceDetails: 'private content must not persist' })).status).toBe(409);
    expect((await send('MESSAGE_COMMITTED', 3, commit)).body).toMatchObject({ accepted: true });
    expect(await running).toMatchObject({ ok: true, state: 'COMMITTED', commandId });
    await vi.waitFor(() => expect(canary.hasCustody()).toBe(false));
    expect(await canary.run({ ...options, targetConversationId: 'abcdef12-1234' })).toMatchObject({ failureCode: 'ALREADY_EXERCISED' });
    expect(JSON.stringify(await readDurable(PROTOCOL_STORE_NAME))).not.toContain('private content');
  });
  it('cleanup persistence failure retains lease and controller until one explicit reconciliation', async () => {
    const running = canary.run(options), authority = await handshake();
    await vi.waitFor(async () => expect((await canary.request('/protocol/poll', authority)).body).toHaveProperty('command.commandType', 'SEND_MESSAGE'));
    const store = canary.service.getStore(), update = store.updateCommand.bind(store);
    vi.spyOn(store, 'updateCommand').mockRejectedValueOnce(new Error('cleanup disk failure'));
    canary.disable(); await running;
    await vi.waitFor(() => expect((canary as unknown as { cleanupFlight: unknown }).cleanupFlight).toBeNull());
    expect(canary.hasCustody()).toBe(true); expect(s6TargetHeld(options.targetConversationId)).toBe(true);
    expect(await canary.run(options)).toMatchObject({ failureCode: 'CLEANUP_PENDING' });
    await vi.waitFor(() => expect(canary.hasCustody()).toBe(false));
    expect(store.findByIdempotencyKey(key)?.state).toBe('AMBIGUOUS');
    vi.mocked(store.updateCommand).mockImplementation(update);
    expect(await canary.run(options)).toMatchObject({ failureCode: 'ALREADY_EXERCISED' });
    expect(wake).toHaveBeenCalledTimes(2);
  });
  it('disable during claim persistence returns no browser permission and preserves exact safe cleanup custody', async () => {
    const running = canary.run(options), authority = await handshake();
    let commandId = '';
    await vi.waitFor(async () => {
      const body = (await canary.request('/protocol/poll', authority)).body as { command?: { commandId: string } };
      expect(body.command).toBeTruthy(); commandId = body.command!.commandId;
    });
    const election = { commandId, targetConversationId: options.targetConversationId, tabId: 1, documentId: 's6_document', navigationEpoch: 3 };
    expect((await canary.request('/protocol/claim', { ...authority, action: 'elect', election })).status).toBe(200);
    const entered = deferred(), blocked = deferred(), store = canary.service.getStore(), update = store.updateCommand.bind(store);
    vi.spyOn(store, 'updateCommand').mockImplementationOnce(async (r, immediate) => {
      entered.release(); await blocked.promise; await update(r, immediate);
    });
    const claiming = canary.request('/protocol/claim', { ...authority, action: 'claim', election });
    await entered.promise; canary.disable(); blocked.release();
    expect((await claiming).body).toMatchObject({ ok: false }); expect(await running).toMatchObject({ ok: false });
    await vi.waitFor(() => expect(canary.hasCustody()).toBe(false));
    expect(store.get(commandId)).toMatchObject({ state: 'CANCELED', owner: 's6_document' });
    expect(canary.adapter.poll()).toBeNull();
  });
});

describe('shipped S6 background sender and election authority', () => {
  const target = '12345678-abcd';
  async function fixture() {
    const socket = {}, calls: Array<{ route: string; body: any }> = [];
    const tab = { id: 1, url: `https://chatgpt.com/c/${target}`, status: 'complete', active: true };
    let document = 's6_document', navigation = 2;
    const command = new BrowserTransportService(new FakeTransportAdapter()).createCommand('SEND_MESSAGE', {
      text: specimen, targetConversationId: target, timeoutMs: 10000 },
    { sessionId: 's6_canary', conversationId: target, idempotencyKey: key });
    const election = { tabId: 1, documentId: document, navigationEpoch: navigation, targetConversationId: target, commandId: command.commandId };
    const chrome = { tabs: { get: vi.fn(async () => tab), query: vi.fn(async () => [tab]), sendMessage: vi.fn(async () => ({ ok: true })) } };
    const sandbox = await backgroundS6({ wakeSocket: socket, token: 'fixture-token', disconnected: false,
      protocolEmitterEpoch: 's6_background', protocolCanaryWelcome: null, protocolCanaryConnection: null,
      crypto: globalThis.crypto, chrome, CHATGPT_TAB_URLS: ['https://chatgpt.com/*'],
      tabDocuments: { 1: document }, tabEpochs: { 1: navigation }, cleanConversationId: (v: unknown) => v,
      ownsDocument: (source: any) => source?.tab === 1 && source.documentId === document && source.navigationEpoch === navigation,
      conversationFromUrl: (url: string) => url?.split('/c/')[1], conversationForTab: () => target,
      protocolCanaryCall: async (route: string, body: any) => {
        calls.push({ route, body });
        return route === '/protocol/poll' ? { command } : route === '/protocol/events' ? { accepted: true } : { ok: true, claimLeaseUntil: Date.now() + 10000 };
      } });
    sandbox.flight = { connection: socket, credential: 'fixture-token', welcome: { connectionEpoch: 's6_connection', connectionGeneration: 2 },
      election, command, offered: true, claiming: false, claimed: false, sequence: 0, pumping: false };
    vm.runInContext('s6Arm = flight', sandbox);
    const sender = { frameId: 0, tab: { id: 1 }, documentId: document };
    const message = { action: 'claim', commandId: command.commandId, navigationEpoch: navigation, tabId: 999, documentId: 'malicious_document' };
    const request = async (m = message, s = sender) => { sandbox.message = m; sandbox.sender = s; return vm.runInContext('s6ContentRequest(message, sender)', sandbox); };
    return { sandbox, calls, chrome, tab, message, sender, request, election,
      stale: () => { document = 'replacement'; navigation++; } };
  }
  it('derives both sender identities and never forwards malicious content identities', async () => {
    const f = await fixture(); expect(await f.request()).toMatchObject({ ok: true });
    expect(f.calls[0]).toMatchObject({ route: '/protocol/claim', body: { action: 'claim', election: f.election, emitterEpoch: 's6_background' } });
    expect(JSON.stringify(f.calls)).not.toContain('malicious_document'); expect(JSON.stringify(f.calls)).not.toContain('999');
    expect(await f.request()).toMatchObject({ ok: false }); expect(f.calls).toHaveLength(1);
  });
  it.each(['frame', 'tab', 'document', 'epoch', 'pending', 'discarded', 'frozen', 'loading', 'wrong-conversation', 'retired'])(
    '%s fails closed before browser claim authority', async kind => {
      const f = await fixture(), sender = { ...f.sender, tab: { ...f.sender.tab } }, message = { ...f.message };
      if (kind === 'frame') sender.frameId = 1;
      if (kind === 'tab') sender.tab.id = 2;
      if (kind === 'document') sender.documentId = 'replacement';
      if (kind === 'epoch') message.navigationEpoch++;
      if (kind === 'pending') Object.assign(f.tab, { pendingUrl: 'https://chatgpt.com/c/another' });
      if (kind === 'discarded' || kind === 'frozen') Object.assign(f.tab, { [kind]: true });
      if (kind === 'loading') f.tab.status = 'loading';
      if (kind === 'wrong-conversation') f.tab.url = 'https://chatgpt.com/c/another';
      if (kind === 'retired') f.stale();
      expect(await f.request(message, sender)).toMatchObject({ ok: false });
      expect(f.calls.some(call => call.body.action === 'claim')).toBe(false);
    });
  it('revalidates document after the awaited tab read; no transfer', async () => {
    const f = await fixture(); f.chrome.tabs.get.mockImplementationOnce(async () => { f.stale(); return f.tab; });
    expect(await f.request()).toMatchObject({ ok: false });
    expect(f.calls.some(call => call.body.action === 'claim')).toBe(false);
  });
  it('duplicate poll hands out one offer to one frozen document', async () => {
    const f = await fixture(); (f.sandbox.flight as any).offered = false;
    (f.sandbox.flight as any).election = null;
    await vm.runInContext('pumpProtocolS6(flight)', f.sandbox);
    await vm.runInContext('pumpProtocolS6(flight)', f.sandbox);
    expect(f.chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.chrome.tabs.sendMessage.mock.calls[0]).toEqual([1, expect.objectContaining({ type: 'clf-s6-offer', commandId: f.election.commandId }), { documentId: 's6_document' }]);
  });
  it('worker restart drops arm; registered documents cannot independently re-execute', async () => {
    const f = await fixture(); vm.runInContext('s6Arm = null', f.sandbox);
    expect(await f.request()).toMatchObject({ ok: false }); expect(f.calls).toEqual([]);
  });
});

describe('shipped S6 document mutex, start barrier and native proof', () => {
  async function fixture(mode = 'success') {
    const source = await fs.readFile(path.join(process.cwd(), 'extension/content.js'), 'utf8');
    const code = source.slice(source.indexOf('  // S6 controlled document mutation.'), source.indexOf('  // End S6 controlled document mutation.'));
    const calls: string[] = [], composer = { textContent: '' }, rows: any[] = [];
    let sandbox: vm.Context;
    const native = { getAttribute: (key: string) => key === 'data-message-id' ? 'native_s6' : null };
    const node = { getAttribute: () => null, querySelectorAll: () => [native] };
    const button = { isConnected: true, disabled: false, getAttribute: () => null, getClientRects: () => [1], click: () => {
      expect(vm.runInContext('desktopInputBusy', sandbox)).toBe(true); calls.push('click');
      if (mode !== 'missing-native') rows.push({ role: 'user', text: specimen, id: 'native_s6', node });
      if (mode === 'multiple') rows.push({ role: 'user', text: specimen, id: 'native_s6_second', node });
    } };
    const dom = { conversationId: () => '12345678-abcd', composerVisible: () => true, composerWritable: () => true,
      composer: () => composer, hasComposerAttachments: () => false, securityOrAuthRequired: () => false, generating: () => false,
      messages: () => rows, sendButton: () => button, insertPrompt: () => {
        expect(vm.runInContext('desktopInputBusy', sandbox)).toBe(true); calls.push('insert'); composer.textContent = specimen; return true;
      } };
    sandbox = vm.createContext({ Date, Set, alive: true, epoch: 3, desktopInputBusy: mode === 'busy', generating: false, pendingTools: 0,
      documentReady: Promise.resolve({ documentId: 's6_document', navigationEpoch: 3 }), CLF_DOM: dom,
      waitPageView: async (read: () => unknown) => { expect(vm.runInContext('desktopInputBusy', sandbox)).toBe(true); calls.push('observe'); return read(); },
      ask: async (m: any) => {
        expect(vm.runInContext('desktopInputBusy', sandbox)).toBe(true); calls.push(m.eventType || m.action);
        if (m.action === 'claim') return { ok: true, claimLeaseUntil: Date.now() + 10000 };
        if (m.eventType === 'MESSAGE_SUBMIT_STARTED') {
          expect(composer.textContent).toBe(''); expect(calls).not.toContain('insert');
          return mode === 'lost-start-ack' ? null : { accepted: mode !== 'failed-start' };
        }
        if (m.action === 'verify') return { ok: mode !== 'disabled-before-send' };
        return { accepted: true };
      } });
    vm.runInContext(code, sandbox);
    sandbox.offer = { commandId: 'cmd_s6_once', targetConversationId: '12345678-abcd', documentId: 's6_document', navigationEpoch: 3, expiresAt: Date.now() + 10000 };
    return { calls, sandbox, dom, composer, run: () => vm.runInContext('executeS6Offer(offer)', sandbox) };
  }
  it('holds mutex continuously through durable start, one native click and strong commit', async () => {
    const f = await fixture(); expect(await f.run()).toBe(true); expect(await f.run()).toBe(false);
    expect(f.calls).toEqual(['claim', 'COMMAND_CLAIMED', 'MESSAGE_SUBMIT_STARTED', 'insert', 'verify', 'click', 'observe', 'MESSAGE_COMMITTED']);
    expect(vm.runInContext('desktopInputBusy', f.sandbox)).toBe(false);
  });
  it.each(['failed-start', 'lost-start-ack', 'busy'])( '%s permits zero insertion and zero Send', async mode => {
    const f = await fixture(mode); expect(await f.run()).toBe(false);
    expect(f.calls).not.toContain('insert'); expect(f.calls).not.toContain('click');
    expect(await f.run()).toBe(false);
    expect(vm.runInContext('desktopInputBusy', f.sandbox)).toBe(mode === 'busy');
  });
  it.each(['disabled-before-send', 'missing-native', 'multiple'])( '%s cannot claim strong commit or retry', async mode => {
    const f = await fixture(mode); expect(await f.run()).toBe(false); expect(await f.run()).toBe(false);
    expect(f.calls.filter(call => call === 'click')).toHaveLength(mode === 'disabled-before-send' ? 0 : 1);
    expect(f.calls).not.toContain('MESSAGE_COMMITTED'); expect(f.calls).toContain('COMMAND_FAILED');
    expect(vm.runInContext('desktopInputBusy', f.sandbox)).toBe(false);
  });
  it.each(['attachments', 'auth', 'generating', 'tools', 'document', 'conversation'])( '%s revokes before mutation', async kind => {
    const f = await fixture();
    if (kind === 'attachments') f.dom.hasComposerAttachments = () => true;
    if (kind === 'auth') f.dom.securityOrAuthRequired = () => true;
    if (kind === 'generating') f.dom.generating = () => true;
    if (kind === 'tools') f.sandbox.pendingTools = 1;
    if (kind === 'document') f.sandbox.documentReady = Promise.resolve({ documentId: 'replacement', navigationEpoch: 3 });
    if (kind === 'conversation') f.dom.conversationId = () => 'another_target';
    expect(await f.run()).toBe(false); expect(f.calls).not.toContain('insert'); expect(f.calls).not.toContain('click');
  });
});
