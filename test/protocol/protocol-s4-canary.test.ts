import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { BrowserTransportService } from '../../src/main/browser-transport/service.js';
import { FakeTransportAdapter } from '../../src/main/browser-transport/fake-adapter.js';
import { initDurableStore, resetDurableForTests, readDurable } from '../../src/main/durable.js';
import { PROTOCOL_STORE_NAME } from '../../src/main/browser-transport/store.js';
import { CurrentBridgeAdapter } from '../../src/main/browser-transport/current-bridge-adapter.js';
import { S4Canary } from '../../src/main/browser-transport/s4-canary.js';
import type { ProtocolCommand, ProtocolEvent, HandshakeWelcome } from '../../src/shared/protocol/index.js';
import type { ProtocolStoreSnapshot } from '../../src/main/browser-transport/types.js';

async function durableRecords() {
  return Object.values((await readDurable<ProtocolStoreSnapshot>(PROTOCOL_STORE_NAME))?.commands ?? {});
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function cleanup(canary: S4Canary) {
  return canary as unknown as { cleanupCommandId: string | null; cleanupInFlight: Promise<void> | null };
}
async function cleanupSettled(canary: S4Canary) {
  await vi.waitFor(() => expect(cleanup(canary).cleanupInFlight).toBeNull());
}

it('S4 completion never persists tab count through ordering metadata', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 's4-transient-'));
  initDurableStore(directory);
  const service = new BrowserTransportService(new FakeTransportAdapter('CONNECTED'));
  try {
    await service.start();
    const welcome = service.handleHandshakeHello({ type: 'HELLO', protocolVersion: 1,
      extensionVersion: '2.1.20', connectionGeneration: 0, capabilities: [] });
    if (welcome.type !== 'WELCOME') throw new Error('Expected welcome');
    service.handleHandshakeReady(welcome);
    const command = service.createCommand('SESSION_PROBE', { probeTabs: true, probeModels: false,
      targetConversationId: null }, { sessionId: 's4_transient' });
    await service.submitCommand(command);
    await service.handleEvent({ protocolVersion: 1, eventId: 'evt_s4_transient', commandId: command.commandId,
      eventType: 'COMMAND_COMPLETED', source: 'extension-background', sessionId: command.sessionId,
      conversationId: null, generation: welcome.connectionGeneration, connectionEpoch: welcome.connectionEpoch,
      emitterEpoch: 'emitter_s4_transient', sequence: 1, occurredAt: Date.now(), payload: { observedTabCount: 4321 } });
    const snapshot = JSON.stringify(await readDurable(PROTOCOL_STORE_NAME));
    expect(snapshot).not.toContain('observedTabCount');
    expect(service.getStore().get(command.commandId)?.orderingBySource?.['extension-background']?.payloadIdentity)
      .toMatch(/^probe:[a-f0-9]{64}$/);
  } finally {
    await service.stop(); resetDurableForTests();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('S4 durable expiry arbitration', () => {
  let directory: string, service: BrowserTransportService, probe: ProtocolCommand, welcome: HandshakeWelcome;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 's4-expiry-')); initDurableStore(directory);
    service = new BrowserTransportService(new FakeTransportAdapter('CONNECTED'));
    await service.start();
    const response = service.handleHandshakeHello({ type: 'HELLO', protocolVersion: 1,
      extensionVersion: '2.1.20', connectionGeneration: 0, capabilities: [] });
    if (response.type !== 'WELCOME') throw new Error('Expected welcome');
    welcome = response; service.handleHandshakeReady(welcome);
    probe = service.createCommand('SESSION_PROBE', { probeTabs: true, probeModels: false, targetConversationId: null },
      { sessionId: 's4_expiry_session' });
    await service.submitCommand(probe);
  });
  afterEach(async () => {
    await service.stop(); resetDurableForTests(); await fs.rm(directory, { recursive: true, force: true });
  });
  function event(eventType: 'COMMAND_COMPLETED' | 'COMMAND_FAILED'): ProtocolEvent {
    return { protocolVersion: 1, eventId: `evt_${globalThis.crypto.randomUUID()}`, commandId: probe.commandId,
      eventType, source: 'extension-background', sessionId: probe.sessionId, conversationId: null,
      generation: welcome.connectionGeneration, connectionEpoch: welcome.connectionEpoch,
      emitterEpoch: 's4_expiry_emitter', sequence: 1, occurredAt: Date.now(),
      payload: eventType === 'COMMAND_COMPLETED' ? { observedTabCount: 0 } : {
        errorCode: 'UNKNOWN_ERROR', message: 'S4 passive tab observation failed', retryable: false } };
  }
  it.each(['COMMAND_COMPLETED', 'COMMAND_FAILED'] as const)(
    '%s in flight durably wins before queued expiry', async eventType => {
      const blocked = gate(), store = service.getStore(), update = store.updateCommand.bind(store);
      let entered = false;
      vi.spyOn(store, 'updateCommand').mockImplementationOnce(async (record, immediate) => {
        entered = true; await blocked.promise; await update(record, immediate);
      });
      const accepting = service.handleEvent(event(eventType));
      await vi.waitFor(() => expect(entered).toBe(true));
      const expiry = service.expireReadOnlyCommand(probe.commandId);
      expect((await durableRecords())[0]?.state).toBe('DISPATCHED');
      blocked.release(); expect(await accepting).toMatchObject({ accepted: true }); await expiry;
      const state = eventType === 'COMMAND_COMPLETED' ? 'COMPLETED' : 'FAILED';
      expect((await durableRecords())[0]?.state).toBe(state);
      expect(service.getStore().getUnresolvedCommands()).toHaveLength(0);
      const before = structuredClone(store.get(probe.commandId));
      expect(await service.handleEvent(event(eventType === 'COMMAND_COMPLETED' ? 'COMMAND_FAILED' : 'COMMAND_COMPLETED')))
        .toMatchObject({ accepted: false });
      expect(store.get(probe.commandId)).toEqual(before);
    });
  it.each(['COMMAND_COMPLETED', 'COMMAND_FAILED'] as const)(
    'expiry in flight durably wins before queued late %s', async eventType => {
      const blocked = gate(), store = service.getStore(), update = store.updateCommand.bind(store);
      let entered = false;
      vi.spyOn(store, 'updateCommand').mockImplementationOnce(async (record, immediate) => {
        entered = true; await blocked.promise; await update(record, immediate);
      });
      const expiry = service.expireReadOnlyCommand(probe.commandId);
      await vi.waitFor(() => expect(entered).toBe(true));
      const accepting = service.handleEvent(event(eventType));
      expect((await durableRecords())[0]?.state).toBe('DISPATCHED');
      blocked.release(); await expiry;
      const before = structuredClone(store.get(probe.commandId));
      expect(await accepting).toMatchObject({ accepted: false });
      expect(store.get(probe.commandId)).toEqual(before);
      expect((await durableRecords())[0]?.state).toBe('EXPIRED');
      expect(store.getUnresolvedCommands()).toHaveLength(0);
    });
  it('failed terminal event persistence cannot defeat queued durable expiry', async () => {
    const store = service.getStore();
    vi.spyOn(store, 'updateCommand').mockImplementationOnce(async () => { throw new Error('event write failed'); });
    const accepting = expect(service.handleEvent(event('COMMAND_COMPLETED'))).rejects.toThrow('event write failed');
    const expiry = service.expireReadOnlyCommand(probe.commandId);
    await accepting; await expiry;
    expect((await durableRecords())[0]?.state).toBe('EXPIRED');
    expect(store.get(probe.commandId)?.orderingBySource).toBeUndefined();
    expect(store.get(probe.commandId)?.activeEmitterEpochBySource).toBeUndefined();
  });
  it('failed expiry rolls back before a queued completion can durably win', async () => {
    const store = service.getStore();
    vi.spyOn(store, 'updateCommand').mockImplementationOnce(async () => { throw new Error('expiry write failed'); });
    const expiry = expect(service.expireReadOnlyCommand(probe.commandId)).rejects.toThrow('expiry write failed');
    const accepting = service.handleEvent(event('COMMAND_COMPLETED'));
    await expiry; expect(await accepting).toMatchObject({ accepted: true });
    expect((await durableRecords())[0]?.state).toBe('COMPLETED');
  });
  it('existing canceled probe remains unchanged by expiry', async () => {
    await service.cancelCommand(probe.commandId, 'test');
    const before = structuredClone(service.getStore().get(probe.commandId));
    await service.expireReadOnlyCommand(probe.commandId);
    expect(service.getStore().get(probe.commandId)).toEqual(before);
    expect((await durableRecords())[0]?.state).toBe('CANCELED');
  });
  it.each(['SEND_MESSAGE', 'BIND_SESSION', 'CANCEL_COMMAND'] as const)(
    'expiry has no authority over %s', async kind => {
      const c: ProtocolCommand = kind === 'SEND_MESSAGE' ? service.createCommand(kind, { text: 'fixture', targetConversationId: 'test_conv' }, { sessionId: 'test_session' }) :
        kind === 'BIND_SESSION' ? service.createCommand(kind, { targetConversationId: 'test_conv', sessionId: 'test_session' }, { sessionId: 'test_session' }) :
          service.createCommand(kind, { targetCommandId: probe.commandId, reason: 'fixture' }, { sessionId: 'test_session' });
      await service.submitCommand(c);
      const before = structuredClone(service.getStore().get(c.commandId));
      await expect(service.expireReadOnlyCommand(c.commandId)).rejects.toThrow('NOT_READ_ONLY_PROBE');
      expect(service.getStore().get(c.commandId)).toEqual(before);
      expect((await durableRecords()).find(record => record.command.commandId === c.commandId)).toEqual(before);
    });
  it('restart preserves cleaned expiry and still expires interrupted dispatched probes without replay', async () => {
    await service.expireReadOnlyCommand(probe.commandId);
    const interrupted = service.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'restart_session' });
    await service.submitCommand(interrupted); await service.stop();
    const adapter = new FakeTransportAdapter('CONNECTED');
    const restarted = new BrowserTransportService(adapter);
    await restarted.start();
    try {
      expect(restarted.getStore().getUnresolvedCommands()).toHaveLength(0);
      expect((await durableRecords()).map(record => record.state)).toEqual(['EXPIRED', 'EXPIRED']);
      expect(restarted.getStore().get(interrupted.commandId)?.reconciledOnRestart).toBe(true);
      expect(restarted.getStore().get(interrupted.commandId)?.attempts).toBe(1);
      expect(adapter.sentMessages).toEqual([]);
    } finally { await restarted.stop(); }
  });
});

function command(): ProtocolCommand {
  return new BrowserTransportService(new FakeTransportAdapter()).createCommand('SESSION_PROBE', {
    probeTabs: true, probeModels: false, targetConversationId: null
  }, { sessionId: 's4_fixture_session' });
}
const welcomeFixture: HandshakeWelcome = { type: 'WELCOME', acceptedProtocolVersion: 1,
  desktopInstanceId: 's4_fixture_desktop', appVersion: '2.1.20', negotiatedCapabilities: [],
  reconcileRequested: true, connectionGeneration: 3, connectionEpoch: 's4_fixture_connection' };

async function background(query = vi.fn(async (): Promise<unknown[]> => []),
  endpoint?: (route: string, body: any) => Promise<{ status: number; body: unknown }>, cryptoProvider: unknown = globalThis.crypto) {
  const source = await fs.readFile('extension/background.js', 'utf8');
  const code = source.slice(source.indexOf('// S4 passive Protocol sidecar.'), source.indexOf('// End S4 passive Protocol sidecar.'));
  const forbidden = Object.fromEntries(['create', 'update', 'reload', 'remove', 'discard', 'sendMessage',
    'executeScript', 'set', 'focus'].map(name => [name, vi.fn(() => { throw new Error(`Forbidden ${name}`); })]));
  const socket = {};
  const posts: Array<{ route: string; body: any }> = [];
  const context = vm.createContext({ crypto: cryptoProvider, Date, Object, Number, Array,
    chrome: { tabs: { ...forbidden, query }, windows: forbidden, scripting: forbidden,
      storage: { local: forbidden, session: forbidden }, runtime: { getManifest: () => ({ version: '2.1.20' }) } },
    CHATGPT_TAB_URLS: ['https://chatgpt.com/*', 'https://chat.openai.com/*'], wakeSocket: socket,
    token: 'fixture-only', disconnected: false, port: 1, versionHeaders: () => ({}),
    fetchBounded: async (url: string, init: { body: string }) => {
      const route = new URL(url).pathname, body = JSON.parse(init.body);
      posts.push({ route, body });
      const response = endpoint ? await endpoint(route, body) : { status: 503, body: {} };
      return { ok: response.status === 200, json: async () => response.body };
    } });
  const api = vm.runInContext(`${code}\n({executeProtocolCanary, pumpProtocolCanary, epoch: protocolEmitterEpoch})`, context) as {
    executeProtocolCanary(c: unknown, w: unknown): Promise<ProtocolEvent | null>;
    pumpProtocolCanary(): Promise<void>; epoch: string;
  };
  return { ...api, query, posts, forbidden, context, socket };
}

describe('S4 real background passive executor', () => {
  it.each([null, { randomUUID: () => { throw new Error('crypto unavailable'); } }])(
    'unavailable strong crypto disables only the sidecar', async provider => {
      const h = await background(undefined, undefined, provider);
      expect(await h.executeProtocolCanary(command(), welcomeFixture)).toBeNull();
      await h.pumpProtocolCanary(); expect(h.posts).toEqual([]); expect(h.query).not.toHaveBeenCalled();
      expect(h.context.token).toBe('fixture-only'); expect(h.context.disconnected).toBe(false);
    });
  it.each([0, 1, 5, 10000])('reports exactly %i tabs without calling a mutator', async count => {
    const h = await background(vi.fn(async () => Array.from({ length: count }, () => ({ url: 'private', title: 'private' }))));
    const c = command(), event = await h.executeProtocolCanary(c, welcomeFixture);
    expect(event).toMatchObject({ eventType: 'COMMAND_COMPLETED', commandId: c.commandId,
      sessionId: c.sessionId, conversationId: null, source: 'extension-background',
      connectionEpoch: welcomeFixture.connectionEpoch, emitterEpoch: h.epoch,
      generation: welcomeFixture.connectionGeneration, sequence: 1, payload: { observedTabCount: count } });
    expect(Object.keys(event!.payload as object)).toEqual(['observedTabCount']);
    expect(h.query).toHaveBeenCalledExactlyOnceWith({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] });
    for (const fn of Object.values(h.forbidden)) expect(fn).not.toHaveBeenCalled();
    expect(JSON.stringify(event)).not.toMatch(/private|commitProof|nativeMessageId|commitConversationId/);
  });
  it.each([
    { commandType: 'SEND_MESSAGE' }, { commandType: 'BIND_SESSION' }, { commandType: 'CANCEL_COMMAND' },
    { protocolVersion: 2 }, { target: 'content-script' }, { source: 'content-script' },
    { conversationId: 'other' }, { owner: 'content-document' },
    { payload: { probeTabs: false, probeModels: false, targetConversationId: null } },
    { payload: { probeTabs: true, probeModels: true, targetConversationId: null } },
    { payload: { probeTabs: true, probeModels: false, targetConversationId: 'other' } },
    { payload: { probeTabs: true, probeModels: false } },
    { payload: { probeTabs: true, probeModels: false, targetConversationId: null, extra: true } },
    { expiresAt: 0 }
  ])('fails closed before observation for %j', async patch => {
    const h = await background();
    expect(await h.executeProtocolCanary({ ...command(), ...patch }, welcomeFixture)).toBeNull();
    expect(h.query).not.toHaveBeenCalled();
    for (const fn of Object.values(h.forbidden)) expect(fn).not.toHaveBeenCalled();
  });
  it.each(['throws', 'overflow', 'invalid'])('uses bounded existing failure event when query %s', async kind => {
    const h = await background(vi.fn(async () => {
      if (kind === 'throws') throw new Error('SECRET https://private.example/ stack');
      return kind === 'overflow' ? new Array(10001) : null as unknown as unknown[];
    }));
    const event = await h.executeProtocolCanary(command(), welcomeFixture);
    expect(event).toMatchObject({ eventType: 'COMMAND_FAILED', payload: {
      errorCode: 'UNKNOWN_ERROR', message: 'S4 passive tab observation failed', retryable: false } });
    expect(JSON.stringify(event)).not.toMatch(/SECRET|private.example|stack/);
    for (const fn of Object.values(h.forbidden)) expect(fn).not.toHaveBeenCalled();
  });
  it('keeps source sequence monotonic and mints a new emitter only on worker restart', async () => {
    const first = await background(), second = await background();
    const a = await first.executeProtocolCanary(command(), welcomeFixture);
    const b = await first.executeProtocolCanary(command(), welcomeFixture);
    expect(a!.emitterEpoch).toBe(b!.emitterEpoch); expect(b!.sequence).toBe(a!.sequence + 1);
    expect(first.epoch).not.toBe(second.epoch);
  });
  it('HTTP/event failure changes no legacy connection or storage state', async () => {
    const h = await background(undefined, async () => { throw new Error('transport failed'); });
    await h.pumpProtocolCanary();
    expect(h.context.token).toBe('fixture-only'); expect(h.context.port).toBe(1);
    expect(h.context.disconnected).toBe(false); expect(h.context.wakeSocket).toBe(h.socket);
    for (const fn of Object.values(h.forbidden)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('S4 one-slot CurrentBridgeAdapter', () => {
  it('accepts only a connected fixed probe, retaining one identity across polls', async () => {
    const adapter = new CurrentBridgeAdapter(), c = command();
    expect(await adapter.send({ kind: 'PROTOCOL_COMMAND', command: c })).toBe(false);
    await adapter.connect();
    expect(await adapter.send({ kind: 'PROTOCOL_COMMAND', command: c })).toBe(true);
    expect(await adapter.send({ kind: 'PROTOCOL_COMMAND', command: command() })).toBe(false);
    expect(adapter.poll()).toEqual(c); expect(adapter.poll()).toEqual(c);
    adapter.poll()!.payload = {}; expect(adapter.poll()).toEqual(c);
    await adapter.disconnect(); expect(adapter.poll()).toBeNull();
  });
  it.each(['SEND_MESSAGE', 'BIND_SESSION', 'CANCEL_COMMAND'])('rejects %s', async commandType => {
    const adapter = new CurrentBridgeAdapter(); await adapter.connect();
    expect(await adapter.send({ kind: 'PROTOCOL_COMMAND', command: { ...command(), commandType } })).toBe(false);
    expect(adapter.poll()).toBeNull();
  });
  it.each([{}, null, { kind: 'PROTOCOL_EVENT' }, { kind: 'PROTOCOL_COMMAND', command: command(), extra: true },
    { kind: 'PROTOCOL_COMMAND', command: { ...command(), payload: { probeTabs: true, probeModels: true, targetConversationId: null } } }])(
    'rejects malformed/broadened envelope %j', async envelope => {
      const adapter = new CurrentBridgeAdapter(); await adapter.connect(); expect(await adapter.send(envelope)).toBe(false);
    });
});

describe('S4 bounded controller and real background pump', () => {
  let directory: string, canary: S4Canary;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 's4-controller-')); initDurableStore(directory);
  });
  afterEach(async () => {
    canary?.disable(); await cleanup(canary)?.cleanupInFlight;
    if (canary?.service.getStore().isLoaded()) await canary.service.stop();
    resetDurableForTests(); await fs.rm(directory, { recursive: true, force: true });
  });
  async function wired(query?: ReturnType<typeof vi.fn<() => Promise<unknown[]>>>,
    intercept?: (route: string, body: any) => Promise<{ status: number; body: unknown } | undefined>) {
    const flights: Promise<void>[] = [];
    const h = await background(query, async (route, body) =>
      await intercept?.(route, body) ?? canary.request(route, body));
    canary = new S4Canary(() => { flights.push(h.pumpProtocolCanary()); });
    return { ...h, flights };
  }
  it('completes one durable probe with exact payload after HELLO/WELCOME/READY', async () => {
    const h = await wired(vi.fn(async () => [{ private: true }]));
    const result = await canary.run({ enabled: true, commandTimeoutMs: 600 });
    expect(result).toMatchObject({ ok: true, state: 'COMPLETED', observedTabCount: 1 });
    await Promise.all(h.flights);
    expect(h.posts.slice(0, 2).map(p => p.route)).toEqual(['/protocol/hello', '/protocol/ready']);
    const records = await durableRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.command).toMatchObject({ commandType: 'SESSION_PROBE', conversationId: null,
      payload: { probeTabs: true, probeModels: false, targetConversationId: null } });
    expect(records[0]).toMatchObject({ state: 'COMPLETED', committedAt: null, commitProofLevel: null,
      nativeMessageId: null, commitConversationId: null, claimedAt: null, owner: null });
    expect((await readDurable<ProtocolStoreSnapshot>(PROTOCOL_STORE_NAME))?.recentCommittedIds).toEqual([]);
    expect(JSON.stringify(await readDurable(PROTOCOL_STORE_NAME))).not.toContain('observedTabCount');
  });
  it('survives slow persist-before-dispatch with a coalesced payload-free command wake', async () => {
    const h = await wired();
    const persist = canary.service.getStore().persistNewCommand.bind(canary.service.getStore());
    vi.spyOn(canary.service.getStore(), 'persistNewCommand').mockImplementation(async record => {
      await new Promise(resolve => setTimeout(resolve, 40)); await persist(record);
    });
    expect(await canary.run({ enabled: true, commandTimeoutMs: 600 })).toMatchObject({ ok: true, observedTabCount: 0 });
    await Promise.all(h.flights); expect(h.query).toHaveBeenCalledTimes(1);
  });
  it('rejects concurrent invocation immediately and later deliberate runs have fresh identities', async () => {
    let release!: (tabs: unknown[]) => void;
    const h = await wired(vi.fn(() => new Promise<unknown[]>(resolve => { release = resolve; })));
    const first = canary.run({ enabled: true, commandTimeoutMs: 600 });
    expect(await canary.run({ enabled: true })).toEqual({ ok: false, failureCode: 'BUSY' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function')); release([]);
    const a = await first; await Promise.all(h.flights);
    h.query.mockResolvedValue([]);
    const b = await canary.run({ enabled: true, commandTimeoutMs: 600 });
    expect(a.ok).toBe(true); expect(b.ok).toBe(true); expect(a.commandId).not.toBe(b.commandId);
    const records = await durableRecords();
    expect(records[0]!.command.idempotencyKey).not.toBe(records[1]!.command.idempotencyKey);
  });
  it('requires a current handshake and creates no command before exact READY', async () => {
    canary = new S4Canary(() => {});
    const running = canary.run({ enabled: true, handshakeTimeoutMs: 60 });
    await vi.waitFor(() => expect(canary.service.getStore().isLoaded()).toBe(true));
    const first = await canary.request('/protocol/hello', { emitterEpoch: 'emitter_first', hello: {
      type: 'HELLO', protocolVersion: 1, extensionVersion: '2.1.20', connectionGeneration: 0, capabilities: [] } });
    const second = await canary.request('/protocol/hello', { emitterEpoch: 'emitter_second', hello: {
      type: 'HELLO', protocolVersion: 1, extensionVersion: '2.1.20', connectionGeneration: 0, capabilities: [] } });
    const stale = first.body as HandshakeWelcome;
    expect(second.status).toBe(200);
    expect((await canary.request('/protocol/ready', { emitterEpoch: 'emitter_first', ready: {
      type: 'READY', connectionGeneration: stale.connectionGeneration, connectionEpoch: stale.connectionEpoch,
      activeSessions: [], boundTabsCount: 0 } })).status).toBe(409);
    expect(await durableRecords()).toEqual([]);
    expect(await running).toEqual({ ok: false, failureCode: 'HANDSHAKE_TIMEOUT' });
    expect(await durableRecords()).toEqual([]);
  });
  it('disabled and idle/restarted controller never wake or schedule', async () => {
    const wake = vi.fn(); canary = new S4Canary(wake);
    expect(await canary.run({ enabled: false })).toEqual({ ok: false, failureCode: 'DISABLED' });
    expect(wake).not.toHaveBeenCalled(); expect(await durableRecords()).toEqual([]);
    expect((await canary.request('/protocol/poll', {})).status).toBe(503);
  });
  it('query failure terminates only the canary and a subsequent deliberate invocation succeeds', async () => {
    const h = await wired(vi.fn(async () => { throw new Error('secret'); }));
    expect(await canary.run({ enabled: true, commandTimeoutMs: 600 })).toMatchObject({ ok: false, state: 'FAILED', failureCode: 'PROBE_FAILED' });
    await Promise.all(h.flights); h.query.mockResolvedValue([]);
    expect(await canary.run({ enabled: true, commandTimeoutMs: 600 })).toMatchObject({ ok: true });
  });
  it('adapter send failure terminates only the canary', async () => {
    const h = await wired(); vi.spyOn(canary.adapter, 'send').mockResolvedValue(false);
    expect(await canary.run({ enabled: true, commandTimeoutMs: 600 })).toMatchObject({ ok: false, failureCode: 'ADAPTER_UNAVAILABLE' });
    await Promise.all(h.flights); expect(h.query).not.toHaveBeenCalled();
  });
  it('event POST failure times out, clears BUSY, and does not damage legacy state', async () => {
    let fail = true;
    const h = await wired(undefined, async route => route === '/protocol/events' && fail ? { status: 503, body: {} } : undefined);
    expect(await canary.run({ enabled: true, commandTimeoutMs: 60 })).toMatchObject({ ok: false, failureCode: 'COMMAND_TIMEOUT' });
    await Promise.all(h.flights); fail = false;
    await cleanupSettled(canary);
    expect(canary.service.getStore().getUnresolvedCommands()).toHaveLength(0);
    expect(h.context.token).toBe('fixture-only'); expect(h.context.disconnected).toBe(false);
    expect(await canary.run({ enabled: true, commandTimeoutMs: 600 })).toMatchObject({ ok: true });
  });
  it('store write failure schedules no browser observation', async () => {
    const h = await wired(); vi.spyOn(canary.service.getStore(), 'persistNewCommand').mockRejectedValue(new Error('disk failed'));
    expect(await canary.run({ enabled: true, commandTimeoutMs: 600 })).toMatchObject({ ok: false, failureCode: 'SIDECAR_UNAVAILABLE' });
    await Promise.all(h.flights); expect(h.query).not.toHaveBeenCalled();
  });
  it.each(['connectionEpoch', 'emitterEpoch', 'generation', 'sessionId', 'conversationId', 'source', 'payload'])(
    'rejects stale/malformed event %s without changing the durable command', async field => {
      const h = await wired(undefined, async (route, body) => {
        if (route !== '/protocol/events') return undefined;
        const wrong = field === 'payload' ? { observedTabCount: -1 } : field === 'generation' ? -1 : 'wrong_authority';
        const rejected = await canary.request(route, { ...body, event: { ...body.event, eventId: `evt_${globalThis.crypto.randomUUID()}`, [field]: wrong } });
        expect(rejected.status).toBe(409);
        expect(canary.service.getStore().get(body.event.commandId)?.state).toBe('DISPATCHED');
        return undefined;
      });
      const result = await canary.run({ enabled: true, commandTimeoutMs: 2000 });
      expect(result).toMatchObject({ ok: true, observedTabCount: 0 });
      await Promise.all(h.flights);
      const event = h.posts.find(p => p.route === '/protocol/events')!.body.event;
      expect(await canary.service.handleEvent(event)).toMatchObject({ duplicate: true });
    });
  it('retry of the same HTTP completion after failed persistence retains its identity', async () => {
    const h = await wired(undefined, async (route, body) => {
      if (route !== '/protocol/events') return undefined;
      expect((await canary.request(route, body)).status).toBe(409);
      const record = canary.service.getStore().get(body.event.commandId)!;
      expect(record.state).toBe('DISPATCHED'); expect(record.activeEmitterEpochBySource).toBeUndefined();
      expect(record.orderingBySource).toBeUndefined();
      return canary.request(route, body);
    });
    const update = canary.service.getStore().updateCommand.bind(canary.service.getStore());
    let fail = true;
    vi.spyOn(canary.service.getStore(), 'updateCommand').mockImplementation(async (record, immediate) => {
      if (record.state === 'COMPLETED' && fail) { fail = false; throw new Error('disk failure'); }
      await update(record, immediate);
    });
    expect(await canary.run({ enabled: true, commandTimeoutMs: 2000 })).toMatchObject({ ok: true });
    await Promise.all(h.flights); expect(h.query).toHaveBeenCalledTimes(1);
  });
  it('disable during the handshake creates no command and clears BUSY', async () => {
    const wake = vi.fn(); canary = new S4Canary(wake);
    const running = canary.run({ enabled: true, handshakeTimeoutMs: 2000 });
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1)); canary.disable();
    expect(await running).toMatchObject({ ok: false }); expect(await durableRecords()).toEqual([]);
    expect(canary.adapter.poll()).toBeNull();
  });
  it('already-dispatched timeout durably expires the probe instead of leaving unresolved work', async () => {
    const h = await wired(undefined, async route => route === '/protocol/events' ? { status: 503, body: {} } : undefined);
    const running = canary.run({ enabled: true, commandTimeoutMs: 200 });
    await vi.waitFor(() => expect(canary.service.getStore().getUnresolvedCommands()[0]?.state).toBe('DISPATCHED'));
    expect(await running).toMatchObject({ ok: false, failureCode: 'COMMAND_TIMEOUT' });
    await Promise.all(h.flights);
    await cleanupSettled(canary);
    expect((await durableRecords())[0]?.state).toBe('EXPIRED');
    expect(canary.service.getStore().getUnresolvedCommands()).toHaveLength(0);
  });
  it('blocked-submit timeout expires late persistence before a later canary slot', async () => {
    const h = await wired();
    const original = canary.service.submitCommand.bind(canary.service);
    let release!: () => void;
    vi.spyOn(canary.service, 'submitCommand').mockImplementationOnce(async c => {
      await new Promise<void>(resolve => { release = resolve; });
      return original(c);
    });
    expect(await canary.run({ enabled: true, commandTimeoutMs: 60 })).toMatchObject({ ok: false, failureCode: 'COMMAND_TIMEOUT' });
    await Promise.all(h.flights); release();
    await cleanupSettled(canary);
    expect((await durableRecords())[0]?.state).toBe('EXPIRED');
    expect(canary.service.getStore().getUnresolvedCommands()).toHaveLength(0);
    expect(canary.adapter.poll()).toBeNull();
    expect(await canary.run({ enabled: true, commandTimeoutMs: 2000 })).toMatchObject({ ok: true });
    await Promise.all(h.flights); expect(h.query).toHaveBeenCalledTimes(1);
  });
  it('blocked durable I/O retains exactly one cleanup owner across a burst and expires late PERSISTED', async () => {
    const h = await wired();
    const blocked = gate(), store = canary.service.getStore();
    const persist = store.persistNewCommand.bind(store);
    const submitted = vi.spyOn(canary.service, 'submitCommand');
    vi.spyOn(store, 'persistNewCommand').mockImplementationOnce(async record => {
      await blocked.promise; await persist(record);
    });
    const result = await Promise.race([canary.run({ enabled: true, commandTimeoutMs: 40 }),
      new Promise(resolve => setTimeout(() => resolve('UNBOUNDED'), 300))]);
    expect(result).toMatchObject({ failureCode: 'COMMAND_TIMEOUT' });
    const owner = cleanup(canary).cleanupInFlight, id = cleanup(canary).cleanupCommandId;
    expect(owner).toBeInstanceOf(Promise); expect(id).toBeTypeOf('string');
    for (let i = 0; i < 100; i++) {
      expect(await canary.run({ enabled: true })).toEqual({ ok: false, failureCode: 'CLEANUP_PENDING', commandId: id });
      expect(cleanup(canary).cleanupInFlight).toBe(owner);
      expect(cleanup(canary).cleanupCommandId).toBe(id);
    }
    expect(submitted).toHaveBeenCalledTimes(1); expect(await durableRecords()).toEqual([]);
    blocked.release(); await cleanupSettled(canary); await Promise.all(h.flights);
    expect((await durableRecords())[0]?.state).toBe('EXPIRED');
    expect(store.getUnresolvedCommands()).toHaveLength(0); expect(h.query).not.toHaveBeenCalled();
    expect(await canary.run({ enabled: true, commandTimeoutMs: 2000 })).toMatchObject({ ok: true });
    await Promise.all(h.flights);
  });
  it('blocked submit returning late DISPATCHED is expired with no second observation or replay', async () => {
    const h = await wired(), blocked = gate();
    const submit = canary.service.submitCommand.bind(canary.service);
    vi.spyOn(canary.service, 'submitCommand').mockImplementationOnce(async command => {
      const record = await submit(command); await blocked.promise; return record;
    });
    const running = canary.run({ enabled: true, commandTimeoutMs: 200 });
    await vi.waitFor(() => expect(canary.service.getStore().getUnresolvedCommands()[0]?.state).toBe('DISPATCHED'));
    expect((await durableRecords())[0]?.state).toBe('DISPATCHED');
    expect(await running).toMatchObject({ failureCode: 'COMMAND_TIMEOUT' });
    expect(await canary.run({ enabled: true })).toMatchObject({ failureCode: 'CLEANUP_PENDING' });
    blocked.release(); await cleanupSettled(canary); await Promise.all(h.flights);
    expect((await durableRecords())[0]?.state).toBe('EXPIRED');
    expect(canary.service.getStore().getUnresolvedCommands()).toHaveLength(0);
    expect(h.query).not.toHaveBeenCalled(); expect(canary.adapter.poll()).toBeNull();
  });
  it.each(['COMMAND_COMPLETED', 'COMMAND_FAILED'] as const)(
    'late submission preserves %s durably accepted before cleanup', async eventType => {
      const h = await wired(), blocked = gate();
      const submit = canary.service.submitCommand.bind(canary.service);
      vi.spyOn(canary.service, 'submitCommand').mockImplementationOnce(async command => {
        const record = await submit(command); await blocked.promise;
        const hello = h.posts.find(post => post.route === '/protocol/ready')!.body.ready;
        expect(await canary.service.handleEvent({ protocolVersion: 1, eventId: `evt_${globalThis.crypto.randomUUID()}`,
          commandId: command.commandId, eventType, source: 'extension-background', sessionId: command.sessionId,
          conversationId: null, generation: hello.connectionGeneration, connectionEpoch: hello.connectionEpoch,
          emitterEpoch: h.epoch, sequence: 1, occurredAt: Date.now(),
          payload: eventType === 'COMMAND_COMPLETED' ? { observedTabCount: 0 } : {
            errorCode: 'UNKNOWN_ERROR', message: 'S4 passive tab observation failed', retryable: false } })).toMatchObject({ accepted: true });
        return record;
      });
      const running = canary.run({ enabled: true, commandTimeoutMs: 1000 });
      await vi.waitFor(() => expect(canary.service.getStore().getUnresolvedCommands()[0]?.state).toBe('DISPATCHED'));
      expect(await running).toMatchObject({ failureCode: 'COMMAND_TIMEOUT' });
      blocked.release(); await cleanupSettled(canary); await Promise.all(h.flights);
      expect((await durableRecords())[0]?.state).toBe(eventType === 'COMMAND_COMPLETED' ? 'COMPLETED' : 'FAILED');
      expect(canary.service.getStore().getUnresolvedCommands()).toHaveLength(0);
      expect(h.query).not.toHaveBeenCalled();
    });
  it('late submit rejection with no durable record releases cleanup without a replacement probe', async () => {
    const h = await wired(), blocked = gate();
    vi.spyOn(canary.service.getStore(), 'persistNewCommand').mockImplementationOnce(async () => {
      await blocked.promise; throw new Error('no durable state');
    });
    expect(await canary.run({ enabled: true, commandTimeoutMs: 40 })).toMatchObject({ failureCode: 'COMMAND_TIMEOUT' });
    blocked.release(); await cleanupSettled(canary); await Promise.all(h.flights);
    expect(cleanup(canary).cleanupCommandId).toBeNull(); expect(await durableRecords()).toEqual([]);
    expect(h.query).not.toHaveBeenCalled();
  });
  it('two consecutive dispatched timeouts leave zero unresolved records after each cleanup', async () => {
    const h = await wired(undefined, async route => route === '/protocol/events' ? { status: 503, body: {} } : undefined);
    let previous: string | undefined;
    for (let i = 0; i < 2; i++) {
      const result = await canary.run({ enabled: true, commandTimeoutMs: 100 });
      expect(result).toMatchObject({ failureCode: 'COMMAND_TIMEOUT' });
      expect(result.commandId).not.toBe(previous); previous = result.commandId;
      await cleanupSettled(canary);
      expect(canary.service.getStore().getUnresolvedCommands()).toHaveLength(0);
    }
    await Promise.all(h.flights);
    expect((await durableRecords()).map(record => record.state)).toEqual(['EXPIRED', 'EXPIRED']);
    expect(h.query).toHaveBeenCalledTimes(2);
  });
  it('expiry disk failure restores exact memory, retains custody, blocks new work, and retries only explicitly', async () => {
    let failEvents = true;
    const h = await wired(undefined, async route => route === '/protocol/events' && failEvents ? { status: 503, body: {} } : undefined);
    const store = canary.service.getStore(), update = store.updateCommand.bind(store);
    let before: unknown, fail = true;
    const expire = canary.service.expireReadOnlyCommand.bind(canary.service);
    const expiry = vi.spyOn(canary.service, 'expireReadOnlyCommand');
    const rename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (fail && store.getUnresolvedCommands().length === 0 && cleanup(canary).cleanupCommandId) {
        throw new Error('expiry publication failed');
      }
      await rename(from, to);
    });
    vi.spyOn(store, 'updateCommand').mockImplementation(async (record, immediate) => {
      if (record.state === 'DISPATCHED') {
        await update(record, immediate); before = structuredClone(record); return;
      }
      await update(record, immediate);
    });
    try {
      const result = await canary.run({ enabled: true, commandTimeoutMs: 200 });
      expect(result).toMatchObject({ failureCode: 'COMMAND_TIMEOUT', state: 'DISPATCHED' });
      await cleanupSettled(canary);
      const id = cleanup(canary).cleanupCommandId!;
      expect(store.get(id)).toEqual(before); expect((await durableRecords())[0]?.state).toBe('DISPATCHED');
      expect(expiry).toHaveBeenCalledTimes(1);
      // A new explicit request owns one retry; simultaneous burst requests share it.
      const blocked = gate();
      expiry.mockImplementationOnce(async commandId => { await blocked.promise; await expire(commandId); });
      expect(await canary.run({ enabled: true })).toMatchObject({ failureCode: 'CLEANUP_PENDING', commandId: id });
      const owner = cleanup(canary).cleanupInFlight;
      for (let i = 0; i < 100; i++) {
        expect(await canary.run({ enabled: true })).toMatchObject({ failureCode: 'CLEANUP_PENDING' });
        expect(cleanup(canary).cleanupInFlight).toBe(owner);
      }
      expect(expiry).toHaveBeenCalledTimes(2); expect(await durableRecords()).toHaveLength(1);
      fail = false; blocked.release(); await cleanupSettled(canary);
      expect(cleanup(canary).cleanupCommandId).toBeNull(); expect((await durableRecords())[0]?.state).toBe('EXPIRED');
      expect(store.getUnresolvedCommands()).toHaveLength(0);
    } finally { fail = false; renameSpy.mockRestore(); }
    await Promise.all(h.flights);
    failEvents = false;
    expect(await canary.run({ enabled: true, commandTimeoutMs: 2000 })).toMatchObject({ ok: true });
    await Promise.all(h.flights);
  });
  it('timeout retires poll handout even while durable expiry publication is blocked', async () => {
    const h = await wired(undefined, async route => route === '/protocol/events' ? { status: 503, body: {} } : undefined);
    const blocked = gate(), store = canary.service.getStore(), update = store.updateCommand.bind(store);
    vi.spyOn(store, 'updateCommand').mockImplementation(async (record, immediate) => {
      if (record.state === 'EXPIRED') await blocked.promise;
      await update(record, immediate);
    });
    expect(await canary.run({ enabled: true, commandTimeoutMs: 100 })).toMatchObject({ failureCode: 'COMMAND_TIMEOUT' });
    const authority = h.posts.find(post => post.route === '/protocol/poll')!.body;
    expect((await canary.request('/protocol/poll', authority)).status).toBe(503);
    expect(canary.adapter.poll()).toBeNull();
    expect(await canary.run({ enabled: true })).toMatchObject({ failureCode: 'CLEANUP_PENDING' });
    blocked.release(); await cleanupSettled(canary); await Promise.all(h.flights);
    expect((await durableRecords())[0]?.state).toBe('EXPIRED');
  });
  it('bounds slow sidecar initialization before the handshake and creates no command', async () => {
    const wake = vi.fn(); canary = new S4Canary(wake);
    let release!: () => void;
    vi.spyOn(canary.service, 'start').mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const running = canary.run({ enabled: true, handshakeTimeoutMs: 30 });
    const result = await Promise.race([running, new Promise(resolve => setTimeout(() => resolve('UNBOUNDED'), 150))]);
    release();
    expect(result).toEqual({ ok: false, failureCode: 'HANDSHAKE_TIMEOUT' });
    await running; expect(wake).not.toHaveBeenCalled(); expect(await durableRecords()).toEqual([]);
  });
});

// Dynamic loading makes absence a behavioral assertion, rather than a compiler RED.
const adapterPath = '../../src/main/browser-transport/current-bridge-adapter.js';
const controllerPath = '../../src/main/browser-transport/s4-canary.js';
describe('S4 missing real transport RED', () => {
  it('provides a real bounded HTTP handout adapter', async () => {
    const module = await import(adapterPath).catch(() => ({}));
    expect(module).toHaveProperty('CurrentBridgeAdapter');
  });
  it('provides an explicitly invoked bridge-side canary controller', async () => {
    const module = await import(controllerPath).catch(() => ({}));
    expect(module).toHaveProperty('S4Canary');
  });
  it('executes SESSION_PROBE entirely in the background', async () => {
    const source = await fs.readFile('extension/background.js', 'utf8');
    const start = source.indexOf('// S4 passive Protocol sidecar.');
    const end = source.indexOf('// End S4 passive Protocol sidecar.');
    const handler = vm.runInNewContext(start < 0 ? 'undefined' :
      `${source.slice(start, end)}\nexecuteProtocolCanary`, { crypto: globalThis.crypto });
    expect(handler).toBeTypeOf('function');
  });
  it('routes protocol-canary wake exclusively to the dedicated pump', async () => {
    const source = await fs.readFile('extension/background.js', 'utf8');
    const start = source.indexOf('  connection.onmessage = (event) => {');
    const end = source.indexOf('  connection.onerror', start);
    const calls: string[] = [];
    const connection: Record<string, unknown> = {};
    vm.runInNewContext(source.slice(start, end), { connection, wakeSocket: connection,
      pumpProtocolCanary: async () => { calls.push('protocol'); },
      pumpBrowserControl: async () => { calls.push('browser'); },
      maintain: async () => { calls.push('legacy'); } });
    (connection.onmessage as Function)({ data: 'protocol-canary' });
    expect(calls).toEqual(['protocol']);
  });
});
