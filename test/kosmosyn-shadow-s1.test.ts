import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  },
  clipboard: {},
  shell: {}
}));

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath } = await import('../src/main/secrets.js');
const { initDurableStore } = await import('../src/main/durable.js');
const { initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { resetRecorderForTests } = await import('../src/main/session/recorder.js');
const { resetSwarm } = await import('../src/main/agents.js');
const {
  resetBridgeForTests,
  startBridge,
  stopBridge
} = await import('../src/main/bridge.js');
const {
  enqueueShadowV0,
  resetShadowV0ForTests,
  setShadowV0FaultForTests,
  settleShadowV0ForTests,
  shadowV0SnapshotForTests
} = await import('../src/main/browser-transport/shadow.js');
const { makeTempDir, removeTempDir } = await import('./helpers.js');
const { BRIDGE_PROTOCOL } = await import('../src/main/version.js');

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const ENABLE_SWITCH = 'CLF_KOSMOSYN_SHADOW_V0';

let backgroundSource = '';

class FakeStorageArea {
  data: Record<string, unknown> = {};
  maxBytes: number | null = null;

  constructor(initial: Record<string, unknown> = {}) {
    this.data = structuredClone(initial);
  }

  async get(keys: string[] | string): Promise<Record<string, unknown>> {
    const wanted = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(
      wanted.filter((key) => key in this.data).map((key) => [key, structuredClone(this.data[key])])
    );
  }

  async set(values: Record<string, unknown>): Promise<void> {
    const next = { ...this.data, ...structuredClone(values) };
    if (this.maxBytes !== null && Buffer.byteLength(JSON.stringify(next), 'utf8') > this.maxBytes) {
      throw new Error('QUOTA_BYTES exceeded');
    }
    this.data = next;
  }
}

function response(status = 200, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return structuredClone(body);
    }
  };
}

interface TestWorker {
  send(message: Record<string, unknown>, tabId?: number, documentId?: string, senderUrl?: string): Promise<any>;
  registerTab(tabId: number, documentId?: string): Promise<any>;
  reloadTab(tabId: number, newDocId: string, url?: string): Promise<any>;
  journal(): any[];
  inMemoryJournal(): any[];
  storage: { local: FakeStorageArea; session: FakeStorageArea };
}

function loadWorker(options: {
  local: FakeStorageArea;
  session: FakeStorageArea;
  fetch?: (input: string, init?: Record<string, unknown>) => Promise<any>;
}): TestWorker {
  let listener: ((message: any, sender: any, sendResponse: (value: any) => void) => boolean) | null = null;
  const knownTabs = new Map<number, { id: number; windowId: number; url?: string; autoDiscardable?: boolean }>();
  const tabUpdatedListeners: Array<(tabId: number, changeInfo: { url?: string; status?: string }) => void> = [];

  const chrome = {
    storage: { local: options.local, session: options.session },
    runtime: {
      getManifest: () => ({ version: '1.6.0' }),
      onMessage: {
        addListener(fn: typeof listener) {
          listener = fn;
        }
      },
      onInstalled: { addListener: () => undefined },
      onStartup: { addListener: () => undefined }
    },
    windows: {
      update: vi.fn(async () => ({ id: 7 })),
      get: vi.fn(async () => ({ focused: true }))
    },
    scripting: {
      executeScript: vi.fn(async () => []),
      insertCSS: vi.fn(async () => undefined)
    },
    alarms: {
      create: vi.fn(() => undefined),
      clear: vi.fn(async () => true),
      onAlarm: { addListener: () => undefined }
    },
    tabs: {
      create: vi.fn(async () => ({ id: 99 })),
      query: vi.fn(async () => [...knownTabs.values()]),
      update: vi.fn(async (id: number, props: any) => ({ id, windowId: 7, ...props })),
      get: vi.fn(async (id: number) => knownTabs.get(id) ?? { id, windowId: 7, url: 'https://chatgpt.com/' }),
      sendMessage: vi.fn(async () => ({ ok: true })),
      remove: vi.fn(async () => undefined),
      reload: vi.fn(async () => undefined),
      onCreated: { addListener: () => undefined },
      onRemoved: { addListener: () => undefined },
      onUpdated: {
        addListener(fn: (tabId: number, changeInfo: { url?: string; status?: string }) => void) {
          tabUpdatedListeners.push(fn);
        }
      }
    }
  };

  const fetchFn = options.fetch ?? (async () => response(503, {}));

  const vmContext = vm.createContext({
    chrome,
    fetch: fetchFn,
    AbortController,
    setTimeout,
    clearTimeout,
    URL,
    TextEncoder,
    console
  });

  vm.runInContext(backgroundSource.replace(/^import .*$/gm, ''), vmContext, { filename: 'background.js' });

  if (!listener) throw new Error('background.js did not register a message listener');

  return {
    storage: { local: options.local, session: options.session },
    journal() {
      const stored = options.session.data['journal'];
      return Array.isArray(stored) ? stored : [];
    },
    inMemoryJournal() {
      const inMem = vm.runInContext('journal', vmContext);
      return Array.isArray(inMem) ? inMem : [];
    },
    registerTab(tabId: number, documentId = `doc-${tabId}`) {
      return new Promise((resolve, reject) => {
        try {
          const keep = listener!(
            { type: 'register_document' },
            { tab: { id: tabId }, documentId, frameId: 0 },
            resolve
          );
          if (keep !== true) reject(new Error('listener did not keep response open'));
        } catch (err) {
          reject(err);
        }
      });
    },
    async reloadTab(tabId: number, newDocId: string, url = 'https://chatgpt.com/') {
      knownTabs.set(tabId, { id: tabId, windowId: 7, url });
      for (const fn of tabUpdatedListeners) fn(tabId, { url, status: 'loading' });
      for (let turn = 0; turn < 4; turn += 1) await new Promise((r) => setTimeout(r, 0));
      return new Promise((resolve, reject) => {
        try {
          const keep = listener!(
            { type: 'register_document' },
            { tab: { id: tabId }, documentId: newDocId, frameId: 0 },
            resolve
          );
          if (keep !== true) reject(new Error('listener did not keep response open'));
        } catch (err) {
          reject(err);
        }
      });
    },
    send(message: Record<string, unknown>, tabId = 1, documentId = `doc-${tabId}`, senderUrl = 'https://chatgpt.com/') {
      if (typeof message['conversationId'] === 'string' && message['conversationId'].length > 0) {
        knownTabs.set(tabId, {
          id: tabId,
          windowId: 7,
          url: `https://chatgpt.com/c/${message['conversationId']}`,
          autoDiscardable: true
        });
      }
      return new Promise((resolve, reject) => {
        try {
          const keep = listener!(message, { tab: { id: tabId }, documentId, frameId: 0, url: senderUrl }, resolve);
          if (keep !== true) reject(new Error('listener did not keep response open'));
        } catch (err) {
          reject(err);
        }
      });
    }
  };
}

let dir: string;
let base: string;
let token: string | null = null;

function request(
  method: string,
  path: string,
  options: { body?: unknown; auth?: string | null } = {}
): Promise<{ status: number; body: any }> {
  const url = new URL(path, base);
  const payload = options.body === undefined ? null : JSON.stringify(options.body);
  const headers: Record<string, string> = {
    origin: EXTENSION_ORIGIN,
    'x-extension-protocol': String(BRIDGE_PROTOCOL)
  };
  if (payload !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  const auth = options.auth === undefined ? token : options.auth;
  if (auth) headers['authorization'] = `Bearer ${auth}`;

  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
        });
      }
    );
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function pair(): Promise<void> {
  const reply = await request('POST', '/pair', { auth: null });
  expect(reply.status).toBe(200);
  token = reply.body.token as string;
}

function userMessage(messageId: string | undefined, text = 'ordinary user text', browserDocumentId?: string) {
  return {
    kind: 'user_message' as const,
    time: Date.now(),
    ...(messageId === undefined ? {} : { messageId }),
    ...(browserDocumentId === undefined ? {} : { browserDocumentId }),
    text
  };
}

async function postEvents(conversationId: string, events: unknown[]) {
  return request('POST', '/events', { body: { conversationId, events } });
}

beforeAll(async () => {
  backgroundSource = await fs.readFile(path.join(process.cwd(), 'extension', 'background.js'), 'utf8');
  dir = await makeTempDir('clf-kosmosyn-shadow-s1-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initDurableStore(dir);
  initSessionStore(dir);
  const config = defaultConfig();
  await saveConfig({
    ...config,
    sessions: { ...config.sessions, record: true },
    ui: { ...config.ui, autoContinue: false },
    goal: { ...config.goal, enabled: false }
  });
  const port = await startBridge();
  expect(port, 'no loopback port free').not.toBeNull();
  base = `http://127.0.0.1:${port}`;
  await pair();
});

afterAll(async () => {
  delete process.env[ENABLE_SWITCH];
  resetShadowV0ForTests();
  await stopBridge();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

beforeEach(() => {
  delete process.env[ENABLE_SWITCH];
  setShadowV0FaultForTests(null);
  resetShadowV0ForTests();
  resetSwarm();
  resetBridgeForTests();
  resetRecorderForTests();
});

describe('Kosmosyn S1 Browser Identity Propagation', () => {
  // 1. background stamps Chrome-authorized source.documentId onto a journaled observation
  it('1. stamps Chrome-authorized source.documentId onto a journaled observation', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    const chat = randomUUID();
    const docAuthId = 'chrome-doc-auth-12345';

    await worker.registerTab(1, docAuthId);
    const reply = await worker.send({
      type: 'events',
      conversationId: chat,
      entries: [{
        conversationId: chat,
        event: { kind: 'user_message', time: Date.now(), messageId: 'msg-1', text: 'hello' }
      }]
    }, 1, docAuthId);

    expect(reply.ok).toBe(true);
    const journal = worker.journal();
    expect(journal.length).toBeGreaterThanOrEqual(1);
    const entry = journal.find(e => e.conversationId === chat && e.event?.kind === 'user_message');
    expect(entry).toBeDefined();
    expect(entry.browserDocumentId).toBe(docAuthId);
  });

  // 2. a content/body-supplied browserDocumentId cannot override Chrome authority
  it('2. prevents content/body-supplied browserDocumentId from overriding Chrome authority', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired' });
    const session = new FakeStorageArea();
    const postedBatches: any[] = [];
    const fetchFn = vi.fn(async (urlStr: string, init?: any) => {
      const u = new URL(urlStr);
      if (u.pathname === '/hello') return response(200, { app: 'chat-on-steroids-custom', paired: true, bridge: BRIDGE_PROTOCOL });
      if (u.pathname === '/events') {
        postedBatches.push(JSON.parse(String(init.body)));
        return response(200, { ok: true, stored: 1 });
      }
      return response(200, {});
    });
    const worker = loadWorker({ local, session, fetch: fetchFn });
    const chat = randomUUID();
    const docAuthId = 'chrome-authoritative-doc-999';

    await worker.registerTab(2, docAuthId);
    await worker.send({
      type: 'events',
      conversationId: chat,
      entries: [{
        conversationId: chat,
        browserDocumentId: 'spoofed-document-by-untrusted-body',
        event: {
          kind: 'user_message',
          time: Date.now(),
          messageId: 'msg-spoof',
          text: 'spoofed',
          browserDocumentId: 'spoofed-document-in-event-payload'
        }
      }]
    }, 2, docAuthId);

    // Check journal storage
    const journal = worker.journal();
    if (journal.length > 0) {
      const entry = journal.find(e => e.conversationId === chat && e.event?.kind === 'user_message');
      if (entry) {
        expect(entry.browserDocumentId).toBe(docAuthId);
      }
    }
    // Check serialized /events delivery
    await vi.waitFor(() => expect(postedBatches.length).toBeGreaterThan(0));
    const deliveredEvent = postedBatches[0].events.find((e: any) => e.kind === 'user_message');
    expect(deliveredEvent).toBeDefined();
    expect(deliveredEvent.browserDocumentId).toBe(docAuthId);
  });

  // 3. document A provenance survives provisional routing changes and reload adoption by B
  it('3. preserves document A provenance through provisional routing changes and reload adoption by B', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    const docA = 'doc-A-initial';
    const docB = 'doc-B-after-reload';
    const tabId = 5;

    await worker.registerTab(tabId, docA);
    // Queue provisional observation under doc A (before conversation ID is assigned)
    await worker.send({
      type: 'events',
      conversationId: null,
      entries: [{
        conversationId: null,
        event: { kind: 'user_message', time: Date.now(), messageId: 'msg-prov-1', text: 'prov' }
      }]
    }, tabId, docA);

    // Tab reloads and registers as doc B
    await worker.reloadTab(tabId, docB);

    // ChatGPT now assigns conversation ID; tab sends bind
    const chat = randomUUID();
    await worker.send({ type: 'bind', conversationId: chat }, tabId, docB);

    const journal = worker.journal();
    const boundEntry = journal.find(e => e.conversationId === chat && e.event?.messageId === 'msg-prov-1');
    expect(boundEntry).toBeDefined();
    expect(boundEntry.conversationId).toBe(chat);
    expect(boundEntry.browserDocumentId).toBe(docA);
  });

  // 4. A and B can contribute to one conversation while retaining their distinct provenance
  it('4. retains distinct provenance when documents A and B contribute to one conversation', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    const chat = randomUUID();
    const docA = 'doc-contributor-A';
    const docB = 'doc-contributor-B';

    await worker.registerTab(10, docA);
    await worker.send({
      type: 'events',
      conversationId: chat,
      entries: [{ conversationId: chat, event: { kind: 'user_message', time: 100, messageId: 'm-A', text: 'from A' } }]
    }, 10, docA);

    await worker.registerTab(11, docB);
    await worker.send({
      type: 'events',
      conversationId: chat,
      entries: [{ conversationId: chat, event: { kind: 'user_message', time: 200, messageId: 'm-B', text: 'from B' } }]
    }, 11, docB);

    const journal = worker.journal();
    const entryA = journal.find(e => e.event?.messageId === 'm-A');
    const entryB = journal.find(e => e.event?.messageId === 'm-B');
    expect(entryA).toBeDefined();
    expect(entryB).toBeDefined();
    expect(entryA.browserDocumentId).toBe(docA);
    expect(entryB.browserDocumentId).toBe(docB);
  });

  // 5. /events delivery preserves per-row provenance
  it('5. preserves per-row provenance across /events delivery', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired' });
    const session = new FakeStorageArea();
    const posted: any[] = [];
    const fetchFn = vi.fn(async (urlStr: string, init?: any) => {
      const u = new URL(urlStr);
      if (u.pathname === '/hello') return response(200, { app: 'chat-on-steroids-custom', paired: true, bridge: BRIDGE_PROTOCOL });
      if (u.pathname === '/events') {
        posted.push(JSON.parse(String(init.body)));
        return response(200, { ok: true, stored: 2 });
      }
      return response(200, {});
    });
    const worker = loadWorker({ local, session, fetch: fetchFn });
    const chat = randomUUID();
    const docA = 'doc-batch-A';
    const docB = 'doc-batch-B';

    await worker.registerTab(1, docA);
    await worker.send({
      type: 'events',
      conversationId: chat,
      entries: [{ conversationId: chat, event: { kind: 'user_message', time: 1, messageId: 'row-1', text: '1' } }]
    }, 1, docA);

    await worker.registerTab(2, docB);
    await worker.send({
      type: 'events',
      conversationId: chat,
      entries: [{ conversationId: chat, event: { kind: 'user_message', time: 2, messageId: 'row-2', text: '2' } }]
    }, 2, docB);

    await vi.waitFor(() => expect(posted.flatMap((p: any) => p.events).length).toBeGreaterThanOrEqual(2));
    const events = posted.flatMap((p: any) => p.events);
    const r1 = events.find((e: any) => e.messageId === 'row-1');
    const r2 = events.find((e: any) => e.messageId === 'row-2');
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
    expect(r1.browserDocumentId).toBe(docA);
    expect(r2.browserDocumentId).toBe(docB);
  });

  // 6. 413 half-batch retry preserves exact provenance
  it('6. preserves exact provenance during 413 half-batch splitting and retry', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired' });
    const session = new FakeStorageArea();
    const calls: any[] = [];
    let attempts = 0;
    const fetchFn = vi.fn(async (urlStr: string, init?: any) => {
      const u = new URL(urlStr);
      if (u.pathname === '/hello') return response(200, { app: 'chat-on-steroids-custom', paired: true, bridge: BRIDGE_PROTOCOL });
      if (u.pathname === '/events') {
        attempts += 1;
        const body = JSON.parse(String(init.body));
        calls.push(body);
        if (attempts === 1) {
          return response(413, { error: 'body_too_large' });
        }
        return response(200, { ok: true, stored: body.events.length });
      }
      return response(200, {});
    });
    const worker = loadWorker({ local, session, fetch: fetchFn });
    const chat = randomUUID();
    const docA = 'doc-413-A';

    await worker.registerTab(1, docA);
    await worker.send({
      type: 'events',
      conversationId: chat,
      entries: [
        { conversationId: chat, event: { kind: 'user_message', time: 1, messageId: 'half-1', text: 'first' } },
        { conversationId: chat, event: { kind: 'user_message', time: 2, messageId: 'half-2', text: 'second' } }
      ]
    }, 1, docA);

    await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(2));
    // The retry call (calls[1]) should contain the halved batch with provenance intact
    expect(calls[1].events[0].browserDocumentId).toBe(docA);
  });

  // 7. worker restart / storage.session restoration preserves provenance
  it('7. preserves provenance across service-worker restart and session storage restoration', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired' });
    const session = new FakeStorageArea();
    const delivered: any[] = [];
    const fetchFn = vi.fn(async (urlStr: string, init?: any) => {
      const u = new URL(urlStr);
      if (u.pathname === '/hello') return response(200, { app: 'chat-on-steroids-custom', paired: true, bridge: BRIDGE_PROTOCOL });
      if (u.pathname === '/events') {
        delivered.push(JSON.parse(String(init.body)));
        return response(503, { ok: false });
      }
      return response(200, {});
    });

    const chat = randomUUID();
    const docPersist = 'doc-restored-across-worker-death';

    // Instance 1 enqueues
    const worker1 = loadWorker({ local, session, fetch: fetchFn });
    await worker1.registerTab(1, docPersist);
    await worker1.send({
      type: 'events',
      conversationId: chat,
      entries: [{ conversationId: chat, event: { kind: 'user_message', time: 1, messageId: 'msg-restart', text: 'txt' } }]
    }, 1, docPersist);

    // Verify session storage holds the browserDocumentId
    const storedJournal = (session.data['journal'] as any[]) ?? [];
    const storedEntry = storedJournal.find(e => e.event?.messageId === 'msg-restart');
    expect(storedEntry).toBeDefined();
    expect(storedEntry.browserDocumentId).toBe(docPersist);

    // Instance 2 simulates revived service worker reading session
    delivered.length = 0;
    const worker2 = loadWorker({ local, session, fetch: fetchFn });
    const journal2 = worker2.journal();
    const entry2 = journal2.find(e => e.event?.messageId === 'msg-restart');
    if (entry2) {
      expect(entry2.browserDocumentId).toBe(docPersist);
    }
  });

  // 8. queue-pressure gap aggregation cannot combine A+B under one false document identity
  it('8. prevents queue-pressure gap aggregation from combining A and B under one false document identity', async () => {
    const local = new FakeStorageArea();
    const session = new FakeStorageArea();
    const worker = loadWorker({ local, session });
    const chat = randomUUID();
    const docA = 'doc-pressure-A';
    const docB = 'doc-pressure-B';

    await worker.registerTab(1, docA);
    await worker.registerTab(2, docB);

    // Enqueue 2500 progress entries from doc A, then 4500 from doc B (total 7000 exceeds MAX_JOURNAL 4000)
    const entriesA = Array.from({ length: 2500 }, (_, i) => ({
      conversationId: chat,
      event: { kind: 'progress', time: Date.now(), text: `progress A ${i}` }
    }));
    await worker.send({ type: 'events', conversationId: chat, entries: entriesA }, 1, docA);

    const entriesB = Array.from({ length: 4500 }, (_, i) => ({
      conversationId: chat,
      event: { kind: 'progress', time: Date.now(), text: `progress B ${i}` }
    }));
    await worker.send({ type: 'events', conversationId: chat, entries: entriesB }, 2, docB);

    const journal = worker.journal();
    const gaps = journal.filter(e => e.gap === true);
    expect(gaps.length).toBeGreaterThanOrEqual(2);

    const docAGap = gaps.find(g => g.browserDocumentId === docA);
    const docBGap = gaps.find(g => g.browserDocumentId === docB);
    expect(docAGap).toBeDefined();
    expect(docBGap).toBeDefined();
  });

  // 9. old rows with no S1 field remain deliverable
  it('9. delivers pre-S1 legacy journal rows lacking browserDocumentId normally', async () => {
    const local = new FakeStorageArea({ port: 8765, token: 'paired' });
    const chat = randomUUID();
    const legacyEntry = {
      conversationId: chat,
      provisional: null,
      agent: null,
      agentCommandId: null,
      event: { kind: 'user_message', time: 100, messageId: 'legacy-msg', text: 'legacy prompt' }
    };
    const session = new FakeStorageArea({ journal: [legacyEntry] });
    const delivered: any[] = [];
    const fetchFn = vi.fn(async (urlStr: string, init?: any) => {
      const u = new URL(urlStr);
      if (u.pathname === '/hello') return response(200, { app: 'chat-on-steroids-custom', paired: true, bridge: BRIDGE_PROTOCOL });
      if (u.pathname === '/events') {
        delivered.push(JSON.parse(String(init.body)));
        return response(200, { ok: true, stored: 1 });
      }
      return response(200, {});
    });

    const worker = loadWorker({ local, session, fetch: fetchFn });
    await worker.registerTab(1, 'current-doc');
    // Trigger drain
    await worker.send({ type: 'drain' }, 1, 'current-doc');

    await vi.waitFor(() => expect(delivered.length).toBeGreaterThan(0));
    const legacyDelivered = delivered[0].events.find((e: any) => e.messageId === 'legacy-msg');
    expect(legacyDelivered).toBeDefined();
    expect(legacyDelivered.text).toBe('legacy prompt');
    expect(legacyDelivered.browserDocumentId).toBeUndefined();
  });

  // 10. main accepts legacy production behavior with missing or malformed S1 metadata while Shadow alone omits/rejects it
  it('10. accepts legacy production behavior with missing or malformed S1 metadata while Shadow omits/rejects it', async () => {
    process.env[ENABLE_SWITCH] = '1';
    const conversationId = randomUUID();
    const nativeMessageId1 = randomUUID();
    const nativeMessageId2 = randomUUID();

    // Case A: Missing browserDocumentId
    const reply1 = await postEvents(conversationId, [userMessage(nativeMessageId1, 'missing S1 metadata')]);
    expect(reply1.status).toBe(200);
    expect(reply1.body).toHaveProperty('sessionId');
    expect(reply1.body.stored).toBe(1);

    // Case B: Malformed browserDocumentId (too long or empty or non-string)
    const malformedEvent = {
      kind: 'user_message',
      time: Date.now(),
      messageId: nativeMessageId2,
      text: 'malformed S1 metadata',
      browserDocumentId: 'm'.repeat(200) // exceeds 128 char limit
    };
    const reply2 = await postEvents(conversationId, [malformedEvent]);
    expect(reply2.status).toBe(200);
    expect(reply2.body).toHaveProperty('sessionId');
    expect(reply2.body.stored).toBe(1);

    await settleShadowV0ForTests();
    const snapshot = shadowV0SnapshotForTests();

    // Shadow must NOT have admitted nativeMessageId2 because its metadata is malformed
    expect(snapshot.observations.some(o => o.nativeMessageId === nativeMessageId2)).toBe(false);
    expect(snapshot.counters.rejected).toBeGreaterThanOrEqual(1);

    // For missing S1 metadata, either omitted from Shadow or retained without browserDocumentId
    const missingObs = snapshot.observations.find(o => o.nativeMessageId === nativeMessageId1);
    if (missingObs) {
      expect(missingObs.browserDocumentId).toBeUndefined();
    }
  });

  // 11. eligible user_message reaches Shadow with the exact browserDocumentId
  it('11. delivers eligible user_message into Shadow with exact browserDocumentId', async () => {
    process.env[ENABLE_SWITCH] = '1';
    const conversationId = randomUUID();
    const nativeMessageId = randomUUID();
    const docId = 'chrome-verified-document-identity-uuid-1';

    const reply = await postEvents(conversationId, [
      userMessage(nativeMessageId, 'valid user text', docId)
    ]);
    expect(reply.status).toBe(200);
    await settleShadowV0ForTests();

    const snapshot = shadowV0SnapshotForTests();
    expect(snapshot.observations).toEqual([
      expect.objectContaining({
        kind: 'USER_MESSAGE_OBSERVED',
        conversationId,
        nativeMessageId,
        browserDocumentId: docId,
        observedAt: expect.any(Number)
      })
    ]);
    expect(snapshot.counters.admitted).toBe(1);
    expect(snapshot.counters.rejected).toBe(0);
  });

  // 12. same (conversationId, nativeMessageId) observed later from a replacement document remains one Shadow fact and does not overwrite first provenance
  it('12. deduplicates same (conversationId, nativeMessageId) from replacement document without overwriting first provenance', async () => {
    process.env[ENABLE_SWITCH] = '1';
    const conversationId = randomUUID();
    const nativeMessageId = randomUUID();
    const docA = 'first-document-authority-A';
    const docB = 'replacement-document-authority-B';

    // First arrival from document A
    const r1 = await postEvents(conversationId, [userMessage(nativeMessageId, 'first', docA)]);
    expect(r1.status).toBe(200);
    await settleShadowV0ForTests();

    // Second arrival after reload from replacement document B
    const r2 = await postEvents(conversationId, [userMessage(nativeMessageId, 'reloaded render', docB)]);
    expect(r2.status).toBe(200);
    await settleShadowV0ForTests();

    const snapshot = shadowV0SnapshotForTests();
    expect(snapshot.observations).toHaveLength(1);
    expect(snapshot.observations[0]!.browserDocumentId).toBe(docA);
    expect(snapshot.counters.admitted).toBe(1);
    expect(snapshot.counters.duplicates).toBe(1);
  });

  // 13. same nativeMessageId under a different conversation remains distinct
  it('13. keeps same nativeMessageId under different conversations distinct', async () => {
    process.env[ENABLE_SWITCH] = '1';
    const conv1 = randomUUID();
    const conv2 = randomUUID();
    const sharedNativeMessageId = randomUUID();
    const docA = 'doc-conv-1';
    const docB = 'doc-conv-2';

    await postEvents(conv1, [userMessage(sharedNativeMessageId, 'text 1', docA)]);
    await postEvents(conv2, [userMessage(sharedNativeMessageId, 'text 2', docB)]);
    await settleShadowV0ForTests();

    const snapshot = shadowV0SnapshotForTests();
    expect(snapshot.observations).toHaveLength(2);
    expect(snapshot.observations).toEqual([
      expect.objectContaining({ conversationId: conv1, nativeMessageId: sharedNativeMessageId, browserDocumentId: docA }),
      expect.objectContaining({ conversationId: conv2, nativeMessageId: sharedNativeMessageId, browserDocumentId: docB })
    ]);
    expect(snapshot.counters.admitted).toBe(2);
    expect(snapshot.counters.duplicates).toBe(0);
  });

  // 14. Shadow OFF admits nothing
  it('14. admits nothing when kill switch is OFF', async () => {
    delete process.env[ENABLE_SWITCH];
    const conversationId = randomUUID();
    const nativeMessageId = randomUUID();
    const docId = 'doc-should-not-enter-when-off';

    const reply = await postEvents(conversationId, [userMessage(nativeMessageId, 'text', docId)]);
    expect(reply.status).toBe(200);
    await settleShadowV0ForTests();

    const snapshot = shadowV0SnapshotForTests();
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.retained).toBe(0);
    expect(snapshot.pending).toBe(0);
    expect(snapshot.counters.admitted).toBe(0);
  });

  // 15. falsification: rejected raw observation cannot shift provenance onto next accepted row
  it('15. proves a rejected raw observation cannot shift provenance onto the next accepted row', async () => {
    process.env[ENABLE_SWITCH] = '1';
    const conversationId = randomUUID();
    const validNativeMessageId = randomUUID();
    const docRejected = 'doc-rejected-row';
    const docAccepted = 'doc-accepted-row';

    const rawBatch = [
      // Rejected raw row 0: invalid kind
      { kind: 'unknown_unsupported_kind', browserDocumentId: docRejected, time: Date.now() },
      // Accepted raw row 1: valid user message with docAccepted
      { kind: 'user_message', messageId: validNativeMessageId, browserDocumentId: docAccepted, time: Date.now(), text: 'valid' }
    ];

    const reply = await postEvents(conversationId, rawBatch);
    expect(reply.status).toBe(200);
    await settleShadowV0ForTests();

    const snapshot = shadowV0SnapshotForTests();
    expect(snapshot.observations).toHaveLength(1);
    expect(snapshot.observations[0]!.nativeMessageId).toBe(validNativeMessageId);
    expect(snapshot.observations[0]!.browserDocumentId).toBe(docAccepted);
    expect(snapshot.observations[0]!.browserDocumentId).not.toBe(docRejected);
  });

  // 16. durability gap retains routing provenance without browserDocumentId and avoids orphaning
  it('16. preserves routing provenance without browserDocumentId on storage-durability gaps and avoids orphaning', async () => {
    // Part 1: Conversation ID is already known
    const local = new FakeStorageArea({ port: 8765, token: 'paired' });
    const session = new FakeStorageArea();
    // Fail only journal session storage writes to enter durabilityGap branch in persistJournalNow
    session.set = async (values: Record<string, unknown>) => {
      if ('journal' in values) {
        throw new Error('QUOTA_BYTES exceeded');
      }
      Object.assign(session.data, structuredClone(values));
    };

    let bridgeOnline = false;
    const postedBatches: any[] = [];
    const fetchFn = vi.fn(async (urlStr: string, init?: any) => {
      const u = new URL(urlStr);
      if (u.pathname === '/hello') return response(200, { app: 'chat-on-steroids-custom', paired: true, bridge: BRIDGE_PROTOCOL });
      if (u.pathname === '/events') {
        if (!bridgeOnline) return response(503, { ok: false });
        postedBatches.push(JSON.parse(String(init.body)));
        return response(200, { ok: true, stored: 1 });
      }
      return response(200, {});
    });

    const worker = loadWorker({ local, session, fetch: fetchFn });
    const chat = randomUUID();
    const docSource = 'doc-auth-source-1';

    await worker.registerTab(1, docSource);
    const reply = await worker.send({
      type: 'events',
      conversationId: chat,
      agent: 'test-agent',
      agentCommandId: 'cmd-123',
      entries: [{
        conversationId: chat,
        agent: 'test-agent',
        agentCommandId: 'cmd-123',
        event: { kind: 'user_message', time: Date.now(), messageId: 'm-persist-fail', text: 'fail persist' }
      }]
    }, 1, docSource);

    expect(reply.ok).toBe(true);
    expect(reply.durable).toBe(false); // Proves durability failed

    const inMem = worker.inMemoryJournal();
    const gap = inMem.find((e: any) => e.gap === true && e.event?.kind === 'chat_error');
    expect(gap, 'durability gap must exist in in-memory journal').toBeDefined();

    // 1. Retains conversation routing identity from source row
    expect(gap.conversationId).toBe(chat);
    // Preserves agent provenance from source row
    expect(gap.agent).toBe('test-agent');
    expect(gap.agentCommandId).toBe('cmd-123');

    // 3 & 5. Does NOT contain or inherit browserDocumentId
    expect(gap.browserDocumentId).toBeUndefined();
    expect(gap.event.browserDocumentId).toBeUndefined();

    // 4. Can subsequently become deliverable after recovery
    bridgeOnline = true;
    await worker.send({ type: 'drain' }, 1, docSource);

    await vi.waitFor(() => expect(postedBatches.length).toBeGreaterThan(0));
    const allDeliveredEvents = postedBatches.flatMap((b: any) => b.events);
    const deliveredGap = allDeliveredEvents.find((e: any) => e.kind === 'chat_error');
    expect(deliveredGap, 'durability gap must be deliverable and not orphaned').toBeDefined();
    expect(deliveredGap.browserDocumentId).toBeUndefined();

    // Part 2: Conversation ID not yet known (provisional)
    const session2 = new FakeStorageArea();
    session2.set = async (values: Record<string, unknown>) => {
      if ('journal' in values) {
        throw new Error('QUOTA_BYTES exceeded');
      }
      Object.assign(session2.data, structuredClone(values));
    };
    let bridgeOnline2 = false;
    const postedBatches2: any[] = [];
    const fetchFn2 = vi.fn(async (urlStr: string, init?: any) => {
      const u = new URL(urlStr);
      if (u.pathname === '/hello') return response(200, { app: 'chat-on-steroids-custom', paired: true, bridge: BRIDGE_PROTOCOL });
      if (u.pathname === '/events') {
        if (!bridgeOnline2) return response(503, { ok: false });
        postedBatches2.push(JSON.parse(String(init.body)));
        return response(200, { ok: true, stored: 1 });
      }
      return response(200, {});
    });

    const worker2 = loadWorker({ local, session: session2, fetch: fetchFn2 });
    const docSource2 = 'doc-auth-source-2';
    await worker2.registerTab(2, docSource2);

    // Send provisional event (conversationId = null)
    const reply2 = await worker2.send({
      type: 'events',
      conversationId: null,
      entries: [{
        conversationId: null,
        event: { kind: 'user_message', time: Date.now(), messageId: 'm-prov-fail', text: 'prov fail' }
      }]
    }, 2, docSource2);

    expect(reply2.ok).toBe(true);
    expect(reply2.durable).toBe(false);

    const inMem2 = worker2.inMemoryJournal();
    const provGap = inMem2.find((e: any) => e.gap === true && e.event?.kind === 'chat_error');
    expect(provGap, 'durability gap must exist for provisional failure').toBeDefined();

    // 2. Retains provisional routing when conversation is not yet known
    expect(provGap.conversationId).toBeNull();
    expect(provGap.provisional).toBe('tab-2:doc-auth-source-2');
    expect(provGap.browserDocumentId).toBeUndefined();

    // Later, tab learns conversation ID and sends bind
    const chat2 = randomUUID();
    await worker2.send({ type: 'bind', conversationId: chat2 }, 2, docSource2);

    // Verify bindProvisional bound the gap
    expect(provGap.conversationId).toBe(chat2);

    // Trigger drain to verify deliverability after bind and recovery
    bridgeOnline2 = true;
    await worker2.send({ type: 'drain' }, 2, docSource2);

    await vi.waitFor(() => expect(postedBatches2.length).toBeGreaterThan(0));
    const deliveredProvGap = postedBatches2.flatMap((b: any) => b.events).find((e: any) => e.kind === 'chat_error');
    expect(deliveredProvGap, 'provisional durability gap must be delivered after bind').toBeDefined();
    expect(deliveredProvGap.browserDocumentId).toBeUndefined();
  });

  // 17. arbitrary ChatObservation document field cannot become S1 authority
  it('17. proves arbitrary ChatObservation document field cannot become S1 authority without accepted metadata', async () => {
    process.env[ENABLE_SWITCH] = '1';
    const conversationId = randomUUID();
    const nativeMessageId = randomUUID();
    const spoofedDocId = 'spoofed-document-attached-directly-to-chat-observation';

    const obs: any = {
      kind: 'user_message',
      messageId: nativeMessageId,
      time: Date.now(),
      text: 'direct observation without metadata',
      browserDocumentId: spoofedDocId
    };

    // Direct invocation of enqueueShadowV0 without setting observationDocumentMetadata
    enqueueShadowV0(conversationId, [obs]);
    await settleShadowV0ForTests();

    const snapshot = shadowV0SnapshotForTests();
    const admittedObs = snapshot.observations.find(o => o.nativeMessageId === nativeMessageId);
    expect(admittedObs).toBeDefined();
    // Provenance must NOT be adopted from arbitrary observation field
    expect(admittedObs?.browserDocumentId).toBeUndefined();
    expect(admittedObs?.browserDocumentId).not.toBe(spoofedDocId);
  });
});

