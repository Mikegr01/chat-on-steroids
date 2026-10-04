import http from 'node:http';
import fs from 'node:fs/promises';
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
  SHADOW_V0_MAX_OBSERVATIONS,
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

function userMessage(messageId: string | undefined, text = 'ordinary user text') {
  return {
    kind: 'user_message' as const,
    time: Date.now(),
    ...(messageId === undefined ? {} : { messageId }),
    text
  };
}

async function postEvents(conversationId: string, events: unknown[]) {
  return request('POST', '/events', { body: { conversationId, events } });
}

function expectLegacyEventsResponse(reply: { status: number; body: any }): void {
  expect(reply.status).toBe(200);
  expect(Object.keys(reply.body).sort()).toEqual(['sessionId', 'stored']);
  expect(reply.body).not.toHaveProperty('shadow');
}

beforeAll(async () => {
  dir = await makeTempDir('clf-kosmosyn-shadow-v0-');
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
  expect(port, 'no loopback port in 8765-8769 was free').not.toBeNull();
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

describe('Kosmosyn Shadow V0 S0', () => {
  it('keeps Shadow OFF by default and leaves legacy /events behavior unchanged', async () => {
    const reply = await postEvents(randomUUID(), [userMessage(randomUUID())]);

    expectLegacyEventsResponse(reply);
    expect(shadowV0SnapshotForTests()).toMatchObject({
      enabled: false,
      retained: 0,
      pending: 0,
      counters: { admitted: 0, duplicates: 0, rejected: 0, dropped: 0, failures: 0 }
    });
  });

  it('mirrors one eligible native-ID user_message exactly once without retaining its text', async () => {
    process.env[ENABLE_SWITCH] = '1';
    const conversationId = randomUUID();
    const nativeMessageId = randomUUID();
    const secretText = 'SHADOW_V0_MUST_NOT_RETAIN_THIS_FULL_PROMPT_TEXT';

    const reply = await postEvents(conversationId, [userMessage(nativeMessageId, secretText)]);
    expectLegacyEventsResponse(reply);
    await settleShadowV0ForTests();

    const snapshot = shadowV0SnapshotForTests();
    expect(snapshot.observations).toEqual([{
      kind: 'USER_MESSAGE_OBSERVED',
      conversationId,
      nativeMessageId,
      observedAt: expect.any(Number)
    }]);
    expect(snapshot.counters).toMatchObject({ admitted: 1, duplicates: 0, rejected: 0, dropped: 0, failures: 0 });
    expect(JSON.stringify(snapshot)).not.toContain(secretText);
  });

  it('uses exactly conversationId + nativeMessageId as diagnostic dedupe identity', async () => {
    process.env[ENABLE_SWITCH] = '1';
    const firstConversation = randomUUID();
    const secondConversation = randomUUID();
    const repeatedId = randomUUID();
    const distinctId = randomUUID();

    for (const [conversationId, messageId] of [
      [firstConversation, repeatedId],
      [firstConversation, repeatedId],
      [firstConversation, distinctId],
      [secondConversation, repeatedId]
    ] as const) {
      expectLegacyEventsResponse(await postEvents(conversationId, [userMessage(messageId)]));
    }
    await settleShadowV0ForTests();

    const snapshot = shadowV0SnapshotForTests();
    expect(snapshot.observations.map(({ conversationId, nativeMessageId }) => [conversationId, nativeMessageId])).toEqual([
      [firstConversation, repeatedId],
      [firstConversation, distinctId],
      [secondConversation, repeatedId]
    ]);
    expect(snapshot.counters.admitted).toBe(3);
    expect(snapshot.counters.duplicates).toBe(1);
  });

  it('rejects a missing native message ID in Shadow only', async () => {
    process.env[ENABLE_SWITCH] = '1';

    const reply = await postEvents(randomUUID(), [userMessage(undefined)]);
    expectLegacyEventsResponse(reply);
    await settleShadowV0ForTests();

    expect(shadowV0SnapshotForTests()).toMatchObject({
      retained: 0,
      counters: { admitted: 0, rejected: 1, failures: 0 }
    });
  });

  it.each(['projector', 'processing'] as const)('contains an injected Shadow %s exception outside /events authority', async fault => {
    process.env[ENABLE_SWITCH] = '1';
    setShadowV0FaultForTests(fault);

    const reply = await postEvents(randomUUID(), [userMessage(randomUUID())]);
    expectLegacyEventsResponse(reply);
    await settleShadowV0ForTests();

    expect(shadowV0SnapshotForTests()).toMatchObject({
      retained: 0,
      pending: 0,
      counters: { admitted: 0, failures: 1 }
    });
  });

  it('bounds Shadow memory and drops newest telemetry on overflow without affecting production', async () => {
    process.env[ENABLE_SWITCH] = '1';
    const conversationId = randomUUID();
    enqueueShadowV0(
      conversationId,
      Array.from({ length: SHADOW_V0_MAX_OBSERVATIONS }, () => userMessage(randomUUID(), 'discarded after projection'))
    );
    await settleShadowV0ForTests();
    expect(shadowV0SnapshotForTests()).toMatchObject({
      retained: SHADOW_V0_MAX_OBSERVATIONS,
      pending: 0,
      counters: { admitted: SHADOW_V0_MAX_OBSERVATIONS, dropped: 0 }
    });

    const reply = await postEvents(conversationId, [userMessage(randomUUID())]);
    expectLegacyEventsResponse(reply);
    await settleShadowV0ForTests();

    expect(shadowV0SnapshotForTests()).toMatchObject({
      retained: SHADOW_V0_MAX_OBSERVATIONS,
      pending: 0,
      counters: { admitted: SHADOW_V0_MAX_OBSERVATIONS, dropped: 1 }
    });
  });

  it('stops new admission immediately when the kill switch turns OFF', async () => {
    process.env[ENABLE_SWITCH] = '1';
    const conversationId = randomUUID();
    expectLegacyEventsResponse(await postEvents(conversationId, [userMessage(randomUUID())]));
    await settleShadowV0ForTests();
    expect(shadowV0SnapshotForTests().retained).toBe(1);

    delete process.env[ENABLE_SWITCH];
    expectLegacyEventsResponse(await postEvents(conversationId, [userMessage(randomUUID())]));
    await settleShadowV0ForTests();

    expect(shadowV0SnapshotForTests()).toMatchObject({ enabled: false, retained: 1, counters: { admitted: 1 } });
  });

  it('has no mutation/protocol authority and is not awaited by the /events hook', async () => {
    const shadowSource = await fs.readFile(new URL('../src/main/browser-transport/shadow.ts', import.meta.url), 'utf8');
    const bridgeSource = await fs.readFile(new URL('../src/main/bridge.ts', import.meta.url), 'utf8');

    expect(shadowSource).not.toMatch(/SEND_MESSAGE|BrowserTransportService|src\/shared\/protocol|src\/main\/goal|src\/main\/agents/i);
    expect(bridgeSource).toMatch(/enqueueShadowV0\(id, observations\)/);
    expect(bridgeSource).not.toMatch(/await\s+enqueueShadowV0\(id, observations\)/);
  });

  it('does not participate in bridge shutdown or block a subsequent bridge start', async () => {
    process.env[ENABLE_SWITCH] = '1';
    setShadowV0FaultForTests('processing');
    enqueueShadowV0(randomUUID(), [userMessage(randomUUID())]);

    await expect(stopBridge()).resolves.toBeUndefined();
    const port = await startBridge();
    expect(port).not.toBeNull();
    base = `http://127.0.0.1:${port}`;
    setShadowV0FaultForTests(null);
    await pair();
  });
});
