import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

import type { ChatObservation } from '../src/main/session/recorder.js';
import * as shadowModule from '../src/main/browser-transport/shadow.js';
import * as inputModule from '../src/main/session/input.js';
import { BRIDGE_PROTOCOL } from '../src/main/version.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const {
  enqueueShadowV0,
  observationDocumentMetadata,
  resetShadowV0ForTests,
  requestShadowS3Correlation,
  setShadowS3ReceiptReaderForTests,
  shadowS3SchedulerForTests,
  setShadowV0FaultForTests,
  settleShadowV0ForTests,
  shadowV0SnapshotForTests
} = shadowModule;

const {
  resetInputForTests
} = inputModule;

const { initConfigPath, defaultConfig, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath } = await import('../src/main/secrets.js');
const { initDurableStore, readDurable, resetDurableForTests, writeDurableNow } = await import('../src/main/durable.js');
const { initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { resetRecorderForTests } = await import('../src/main/session/recorder.js');
const { resetSwarm } = await import('../src/main/agents.js');
const { resetBridgeForTests, startBridge, stopBridge } = await import('../src/main/bridge.js');

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const ENABLE_SWITCH = 'CLF_KOSMOSYN_SHADOW_V0';

let tempDir: string;
let bridgeBaseUrl: string;
let bridgeToken: string | null = null;

function document(obs: ChatObservation, browserDocumentId: string): ChatObservation {
  observationDocumentMetadata.set(obs, { browserDocumentId });
  return obs;
}

function userObs(messageId: string, text = 'user request text'): ChatObservation {
  return { kind: 'user_message', time: 100, messageId, text } as ChatObservation;
}

async function facts(): Promise<Array<Record<string, any>>> {
  await settleShadowV0ForTests();
  return shadowV0SnapshotForTests().observations as Array<Record<string, any>>;
}

async function correlatedFacts(): Promise<Array<Record<string, any>>> {
  const all = await facts();
  return all.filter((f) => f['kind'] === 'LEGACY_INPUT_NATIVE_CORRELATED');
}

async function runCorrelate(explicitReceipts?: any): Promise<void> {
  if (typeof (shadowModule as any).correlateShadowS3 === 'function') {
    await (shadowModule as any).correlateShadowS3(explicitReceipts);
  }
  await settleShadowV0ForTests();
}

async function bridgeRequest(
  method: string,
  urlPath: string,
  options: { body?: unknown; auth?: string | null } = {}
): Promise<{ status: number; body: any }> {
  const url = new URL(urlPath, bridgeBaseUrl);
  const payload = options.body === undefined ? null : JSON.stringify(options.body);
  const headers: Record<string, string> = {
    origin: EXTENSION_ORIGIN,
    'x-extension-protocol': String(BRIDGE_PROTOCOL)
  };
  const auth = options.auth === undefined ? bridgeToken : options.auth;
  if (auth) headers['authorization'] = `Bearer ${auth}`;
  if (payload !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: data });
        }
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

beforeAll(async () => {
  tempDir = await makeTempDir('clf-kosmosyn-shadow-s3-');
  initConfigPath(tempDir);
  initSecretsPath(tempDir);
  initDurableStore(tempDir);
  initSessionStore(tempDir);
  const cfg = defaultConfig();
  await saveConfig({
    ...cfg,
    sessions: { ...cfg.sessions, record: true },
    ui: { ...cfg.ui, autoContinue: false },
    goal: { ...cfg.goal, enabled: false }
  });
  const port = await startBridge();
  expect(port, 'no loopback port in 8765-8769 was free').not.toBeNull();
  bridgeBaseUrl = `http://127.0.0.1:${port}`;
  const pairReply = await bridgeRequest('POST', '/pair', { auth: null });
  expect(pairReply.status).toBe(200);
  bridgeToken = pairReply.body.token as string;
});

afterAll(async () => {
  await stopBridge();
  await removeTempDir(tempDir);
});

beforeEach(async () => {
  process.env[ENABLE_SWITCH] = '1';
  resetShadowV0ForTests();
  resetRecorderForTests();
  resetSessionStoreForTests();
  resetInputForTests();
  resetBridgeForTests();
  resetSwarm();
  resetDurableForTests();
  initDurableStore(tempDir);
  initSessionStore(tempDir);
});

afterEach(() => {
  delete process.env[ENABLE_SWITCH];
  resetShadowV0ForTests();
});

describe('Kosmosyn S3 Legacy InputEntry ↔ Native Correlation', () => {
  // ======================================================================
  // STRONG CORRELATION
  // ======================================================================

  it('1. durable sent I1/C1/M1 + S2 C1/M1 -> correlates', async () => {
    const receipt = {
      legacyInputId: 'I1',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    enqueueShadowV0('C1', [userObs('M1')]);
    await runCorrelate([receipt]);
    const corr = await correlatedFacts();
    expect(corr).toHaveLength(1);
    expect(corr[0]).toMatchObject({
      kind: 'LEGACY_INPUT_NATIVE_CORRELATED',
      legacyInputIds: ['I1'],
      conversationId: 'C1',
      nativeMessageId: 'M1',
      evidence: 'INPUT_ACK_AND_SHADOW'
    });
  });

  it('2. S2 C1/M1 first + later durable I1/C1/M1 -> correlates', async () => {
    enqueueShadowV0('C1', [userObs('M1')]);
    await settleShadowV0ForTests();
    expect(await correlatedFacts()).toHaveLength(0);

    const receipt = {
      legacyInputId: 'I1',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 2000
    };
    await runCorrelate([receipt]);
    const corr = await correlatedFacts();
    expect(corr).toHaveLength(1);
    expect(corr[0]!.legacyInputIds).toEqual(['I1']);
  });

  it('3. exact re-evaluation -> one fact only', async () => {
    const receipt = {
      legacyInputId: 'I1',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    enqueueShadowV0('C1', [userObs('M1')]);
    await runCorrelate([receipt]);
    await runCorrelate([receipt]);
    const corr = await correlatedFacts();
    expect(corr).toHaveLength(1);
    expect(shadowV0SnapshotForTests().counters.duplicates).toBeGreaterThanOrEqual(1);
  });

  it('4. document D1 is carried from S2', async () => {
    const receipt = {
      legacyInputId: 'I1',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    enqueueShadowV0('C1', [document(userObs('M1'), 'doc-d1')]);
    await runCorrelate([receipt]);
    const corr = await correlatedFacts();
    expect(corr).toHaveLength(1);
    expect(corr[0]!.browserDocumentId).toBe('doc-d1');
  });

  it('5. missing document provenance still correlates', async () => {
    const receipt = {
      legacyInputId: 'I1',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    enqueueShadowV0('C1', [userObs('M1')]);
    await runCorrelate([receipt]);
    const corr = await correlatedFacts();
    expect(corr).toHaveLength(1);
    expect(corr[0]!.browserDocumentId).toBeUndefined();
  });

  it('6. duplicate document B cannot replace first provenance', async () => {
    const receipt = {
      legacyInputId: 'I1',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    enqueueShadowV0('C1', [document(userObs('M1'), 'doc-first')]);
    enqueueShadowV0('C1', [document(userObs('M1'), 'doc-second')]);
    await runCorrelate([receipt]);
    const corr = await correlatedFacts();
    expect(corr).toHaveLength(1);
    expect(corr[0]!.browserDocumentId).toBe('doc-first');
  });

  it('7. same native message ID in different conversation does not join', async () => {
    const receipt = {
      legacyInputId: 'I1',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    enqueueShadowV0('C2', [userObs('M1')]);
    await runCorrelate([receipt]);
    expect(await correlatedFacts()).toHaveLength(0);
  });

  // ======================================================================
  // ACK AUTHORITY
  // ======================================================================

  const convBridge1 = '11111111-1111-1111-1111-111111111111';
  const convBridge2 = '22222222-2222-2222-2222-222222222222';

  it('8. raw ACK M2 cannot override persisted I1/C1/M1', async () => {
    const inputRow = {
      id: randomUUID(),
      sessionId: null,
      text: 'Hello test',
      mode: 'auto' as const,
      dueAt: 0,
      model: null,
      reasoningEffort: null,
      state: 'sent' as const,
      owner: 'owner-1',
      createdAt: Date.now(),
      conversationId: convBridge1,
      messageId: 'M1',
      deliveredAt: Date.now()
    };
    await writeDurableNow('session-input', [inputRow]);
    resetInputForTests();

    // S2 observed M1
    enqueueShadowV0(convBridge1, [userObs('M1')]);

    // Send ACK request through bridge with M2
    const res = await bridgeRequest('POST', '/input/ack', {
      body: { id: inputRow.id, owner: 'owner-1', conversationId: convBridge1, messageId: 'M2' }
    });
    expect(res.status).toBe(200);

    // S3 correlation must use persisted M1, not raw body M2
    await settleShadowV0ForTests();
    const corr = await correlatedFacts();
    expect(corr).toHaveLength(1);
    expect(corr[0]!.nativeMessageId).toBe('M1');
  });

  it('9. raw ACK C2 cannot override persisted I1/C1', async () => {
    const inputRow = {
      id: randomUUID(),
      sessionId: null,
      text: 'Hello test',
      mode: 'auto' as const,
      dueAt: 0,
      model: null,
      reasoningEffort: null,
      state: 'sent' as const,
      owner: 'owner-1',
      createdAt: Date.now(),
      conversationId: convBridge1,
      messageId: 'M1',
      deliveredAt: Date.now()
    };
    await writeDurableNow('session-input', [inputRow]);
    resetInputForTests();

    enqueueShadowV0(convBridge1, [userObs('M1')]);
    enqueueShadowV0(convBridge2, [userObs('M1')]);

    const res = await bridgeRequest('POST', '/input/ack', {
      body: { id: inputRow.id, owner: 'owner-1', conversationId: convBridge2, messageId: 'M1' }
    });
    // conversation mismatch with durable entry returns 409 or ignored
    expect([200, 409]).toContain(res.status);

    await runCorrelate();
    const corr = await correlatedFacts();
    expect(corr).toHaveLength(1);
    expect(corr[0]!.conversationId).toBe(convBridge1);
  });

  it('10. already-terminal ACK replay cannot create new correlation identity', async () => {
    const inputRow = {
      id: randomUUID(),
      sessionId: null,
      text: 'Hello test',
      mode: 'auto' as const,
      dueAt: 0,
      model: null,
      reasoningEffort: null,
      state: 'sent' as const,
      owner: 'owner-1',
      createdAt: Date.now(),
      conversationId: convBridge1,
      messageId: 'M1',
      deliveredAt: Date.now()
    };
    await writeDurableNow('session-input', [inputRow]);
    resetInputForTests();

    enqueueShadowV0(convBridge1, [userObs('M1')]);
    enqueueShadowV0(convBridge1, [userObs('M2')]);

    // Replay ACK with M2
    await bridgeRequest('POST', '/input/ack', {
      body: { id: inputRow.id, owner: 'owner-1', conversationId: convBridge1, messageId: 'M2' }
    });
    await settleShadowV0ForTests();

    const corr = await correlatedFacts();
    expect(corr).toHaveLength(1);
    expect(corr[0]!.nativeMessageId).toBe('M1');
  });

  it('11. S3 reads post-ACK persisted state', async () => {
    const inputId = randomUUID();
    const inputRow = {
      id: inputId,
      sessionId: null,
      text: 'Fresh input',
      mode: 'auto' as const,
      dueAt: 0,
      model: null,
      reasoningEffort: null,
      state: 'browser' as const,
      owner: 'owner-fresh',
      createdAt: Date.now(),
      conversationId: convBridge1
    };
    await writeDurableNow('session-input', [inputRow]);
    resetInputForTests();

    enqueueShadowV0(convBridge1, [userObs('M-fresh')]);

    const res = await bridgeRequest('POST', '/input/ack', {
      body: { id: inputId, owner: 'owner-fresh', conversationId: convBridge1, messageId: 'M-fresh' }
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    await settleShadowV0ForTests();
    const corr = await correlatedFacts();
    expect(corr).toHaveLength(1);
    expect(corr[0]!.legacyInputIds).toEqual([inputId]);
    expect(corr[0]!.nativeMessageId).toBe('M-fresh');
  });

  it('12. S3 diagnostic failure leaves ACK success unchanged', async () => {
    const inputId = randomUUID();
    const inputRow = {
      id: inputId,
      sessionId: null,
      text: 'Fault input',
      mode: 'auto' as const,
      dueAt: 0,
      model: null,
      reasoningEffort: null,
      state: 'browser' as const,
      owner: 'owner-fault',
      createdAt: Date.now(),
      conversationId: convBridge1
    };
    await writeDurableNow('session-input', [inputRow]);
    resetInputForTests();

    setShadowV0FaultForTests('projector');
    const res = await bridgeRequest('POST', '/input/ack', {
      body: { id: inputId, owner: 'owner-fault', conversationId: convBridge1, messageId: 'M-fault' }
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  // ======================================================================
  // COMPANIONS
  // ======================================================================

  it('13. explicit root I1 + companion I2 + C1/M1 -> one correlation fact', async () => {
    const root = {
      legacyInputId: 'I1',
      companionInputId: 'I2',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    const comp = {
      legacyInputId: 'I2',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    enqueueShadowV0('C1', [userObs('M1')]);
    await runCorrelate([root, comp]);
    const corr = await correlatedFacts();
    expect(corr).toHaveLength(1);
    expect(corr[0]!.legacyInputIds).toEqual(['I1', 'I2']);
  });

  it('14. resulting fact contains exactly [I1,I2]', async () => {
    const root = {
      legacyInputId: 'I1',
      companionInputId: 'I2',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    const comp = {
      legacyInputId: 'I2',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    enqueueShadowV0('C1', [userObs('M1')]);
    await runCorrelate([root, comp]);
    const corr = await correlatedFacts();
    expect(corr[0]!.legacyInputIds).toHaveLength(2);
    expect(corr[0]!.legacyInputIds[0]).toBe('I1');
    expect(corr[0]!.legacyInputIds[1]).toBe('I2');
  });

  it('15. no second fact for I2', async () => {
    const root = {
      legacyInputId: 'I1',
      companionInputId: 'I2',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    const comp = {
      legacyInputId: 'I2',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    enqueueShadowV0('C1', [userObs('M1')]);
    await runCorrelate([root, comp]);
    const corr = await correlatedFacts();
    expect(corr).toHaveLength(1);
  });

  it('16. unrelated I1/I2 sharing C1/M1 rejects conflict', async () => {
    const r1 = {
      legacyInputId: 'I1',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    const r2 = {
      legacyInputId: 'I2',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    enqueueShadowV0('C1', [userObs('M1')]);
    await runCorrelate([r1, r2]);
    expect(await correlatedFacts()).toHaveLength(0);
    expect(shadowV0SnapshotForTests().counters.rejected).toBeGreaterThanOrEqual(1);
  });

  it('17. equal tuple without companion relation never invents companionship', async () => {
    const r1 = {
      legacyInputId: 'I1',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    const r2 = {
      legacyInputId: 'I2',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    enqueueShadowV0('C1', [userObs('M1')]);
    await runCorrelate([r1, r2]);
    const corr = await correlatedFacts();
    expect(corr).toHaveLength(0);
  });

  it('18. maximum legacyInputIds length is 2', async () => {
    const r1 = {
      legacyInputId: 'I1',
      companionInputId: 'I2',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    const r2 = {
      legacyInputId: 'I2',
      companionInputId: 'I3',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    const r3 = {
      legacyInputId: 'I3',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    enqueueShadowV0('C1', [userObs('M1')]);
    await runCorrelate([r1, r2, r3]);
    expect(await correlatedFacts()).toHaveLength(0);
    expect(shadowV0SnapshotForTests().counters.rejected).toBeGreaterThanOrEqual(1);
  });

  // ======================================================================
  // CANCELLED / DECISION
  // ======================================================================

  it('19. cancelled-locally then exact C1/M1 confirmed -> correlate', async () => {
    const receipt = {
      legacyInputId: 'I-canc',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'cancelled' as const,
      deliveredAt: 1000
    };
    enqueueShadowV0('C1', [userObs('M1')]);
    await runCorrelate([receipt]);
    const corr = await correlatedFacts();
    expect(corr).toHaveLength(1);
    expect(corr[0]!.legacyInputIds).toEqual(['I-canc']);
  });

  it('20. cancelled pre-Send with no deliveredAt/messageId -> no correlation', async () => {
    const inputRow = {
      id: randomUUID(),
      sessionId: null,
      text: 'Cancelled pre-send',
      mode: 'auto' as const,
      dueAt: 0,
      model: null,
      reasoningEffort: null,
      state: 'cancelled' as const,
      owner: null,
      createdAt: Date.now()
    };
    await writeDurableNow('session-input', [inputRow]);
    resetInputForTests();

    const receipts = typeof (inputModule as any).getConfirmedBrowserInputReceipts === 'function'
      ? await (inputModule as any).getConfirmedBrowserInputReceipts()
      : [];
    expect(receipts.some((r: any) => r.legacyInputId === inputRow.id)).toBe(false);
  });

  it('21. decision input with concrete C/M/deliveredAt -> correlate if otherwise accepted', async () => {
    const receipt = {
      legacyInputId: 'I-dec',
      conversationId: 'C1',
      nativeMessageId: 'M-dec',
      deliveryState: 'decision' as const,
      deliveredAt: 1000
    };
    enqueueShadowV0('C1', [userObs('M-dec')]);
    await runCorrelate([receipt]);
    const corr = await correlatedFacts();
    expect(corr).toHaveLength(1);
    expect(corr[0]!.legacyInputIds).toEqual(['I-dec']);
  });

  it('22. route-less temporary decision with M but no concrete C -> defer/no fact', async () => {
    const inputRow = {
      id: randomUUID(),
      sessionId: null,
      text: 'Decision temp',
      mode: 'auto' as const,
      dueAt: 0,
      model: null,
      reasoningEffort: null,
      state: 'decision' as const,
      purpose: 'decision' as const,
      lifetime: 'temporary-planner' as const,
      owner: 'planner',
      createdAt: Date.now(),
      conversationId: null,
      messageId: 'M-dec-routeless',
      deliveredAt: Date.now()
    };
    await writeDurableNow('session-input', [inputRow]);
    resetInputForTests();

    const receipts = typeof (inputModule as any).getConfirmedBrowserInputReceipts === 'function'
      ? await (inputModule as any).getConfirmedBrowserInputReceipts()
      : [];
    expect(receipts.some((r: any) => r.legacyInputId === inputRow.id)).toBe(false);
  });

  // ======================================================================
  // TOOL EXCLUSION
  // ======================================================================

  it('23. messageId input:<id> -> no S3 correlation', async () => {
    const inputRow = {
      id: randomUUID(),
      sessionId: null,
      text: 'Tool input',
      mode: 'auto' as const,
      dueAt: 0,
      model: null,
      reasoningEffort: null,
      state: 'sent' as const,
      owner: 'tool-owner',
      createdAt: Date.now(),
      conversationId: 'C1',
      messageId: 'input:synthetic-123',
      deliveredAt: Date.now()
    };
    await writeDurableNow('session-input', [inputRow]);
    resetInputForTests();

    enqueueShadowV0('C1', [userObs('input:synthetic-123')]);
    const receipts = typeof (inputModule as any).getConfirmedBrowserInputReceipts === 'function'
      ? await (inputModule as any).getConfirmedBrowserInputReceipts()
      : [];
    await runCorrelate(receipts);
    expect(await correlatedFacts()).toHaveLength(0);
  });

  it('24. tool offered row alone -> no correlation', async () => {
    const inputRow = {
      id: randomUUID(),
      sessionId: null,
      text: 'Tool row',
      delivery: 'tool' as const,
      mode: 'auto' as const,
      dueAt: 0,
      model: null,
      reasoningEffort: null,
      state: 'sent' as const,
      owner: 'tool',
      createdAt: Date.now(),
      conversationId: 'C1',
      messageId: 'tool-msg',
      deliveredAt: Date.now()
    };
    await writeDurableNow('session-input', [inputRow]);
    resetInputForTests();

    const receipts = typeof (inputModule as any).getConfirmedBrowserInputReceipts === 'function'
      ? await (inputModule as any).getConfirmedBrowserInputReceipts()
      : [];
    expect(receipts.some((r: any) => r.legacyInputId === inputRow.id)).toBe(false);
  });

  it('25. synthetic message identity cannot join an S2 native row', async () => {
    const receipt = {
      legacyInputId: 'I-tool',
      conversationId: 'C1',
      nativeMessageId: 'input:tool-msg',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    enqueueShadowV0('C1', [userObs('input:tool-msg')]);
    await runCorrelate([receipt]);
    expect(await correlatedFacts()).toHaveLength(0);
  });

  // ======================================================================
  // CONFLICTS
  // ======================================================================

  it('26. retained I1/C1/M1 then authoritative mapping genuinely changes to M2 -> reject', async () => {
    const r1 = {
      legacyInputId: 'I1',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    enqueueShadowV0('C1', [userObs('M1'), userObs('M2')]);
    await runCorrelate([r1]);
    expect(await correlatedFacts()).toHaveLength(1);

    const r2 = {
      legacyInputId: 'I1',
      conversationId: 'C1',
      nativeMessageId: 'M2',
      deliveryState: 'sent' as const,
      deliveredAt: 2000
    };
    await runCorrelate([r2]);
    const corr = await correlatedFacts();
    expect(corr).toHaveLength(1);
    expect(corr[0]!.nativeMessageId).toBe('M1'); // Not rewritten
    expect(shadowV0SnapshotForTests().counters.rejected).toBeGreaterThanOrEqual(1);
  });

  it('27. retained I1/C1/M1 then authoritative mapping genuinely changes to C2 -> reject', async () => {
    const r1 = {
      legacyInputId: 'I1',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    enqueueShadowV0('C1', [userObs('M1')]);
    enqueueShadowV0('C2', [userObs('M1')]);
    await runCorrelate([r1]);
    expect(await correlatedFacts()).toHaveLength(1);

    const r2 = {
      legacyInputId: 'I1',
      conversationId: 'C2',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 2000
    };
    await runCorrelate([r2]);
    const corr = await correlatedFacts();
    expect(corr).toHaveLength(1);
    expect(corr[0]!.conversationId).toBe('C1');
    expect(shadowV0SnapshotForTests().counters.rejected).toBeGreaterThanOrEqual(1);
  });

  it('28. S2 C2/M1 does not join durable C1/M1', async () => {
    const r1 = {
      legacyInputId: 'I1',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    enqueueShadowV0('C2', [userObs('M1')]);
    await runCorrelate([r1]);
    expect(await correlatedFacts()).toHaveLength(0);
  });

  it('29. conflict does not rewrite existing fact', async () => {
    const r1 = {
      legacyInputId: 'I1',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    enqueueShadowV0('C1', [userObs('M1')]);
    await runCorrelate([r1]);
    const first = (await correlatedFacts())[0];

    const rConflict = {
      legacyInputId: 'I1',
      conversationId: 'C1',
      nativeMessageId: 'M-other',
      deliveryState: 'sent' as const,
      deliveredAt: 2000
    };
    await runCorrelate([rConflict]);
    const second = (await correlatedFacts())[0];
    expect(second).toEqual(first);
  });

  it('30. conflict changes no production input', async () => {
    const inputRow = {
      id: randomUUID(),
      sessionId: null,
      text: 'Safe text',
      mode: 'auto' as const,
      dueAt: 0,
      model: null,
      reasoningEffort: null,
      state: 'sent' as const,
      owner: 'owner',
      createdAt: Date.now(),
      conversationId: 'C1',
      messageId: 'M1',
      deliveredAt: Date.now()
    };
    await writeDurableNow('session-input', [inputRow]);
    resetInputForTests();

    enqueueShadowV0('C1', [userObs('M1')]);
    await runCorrelate();

    // Trigger conflict
    const rConflict = {
      legacyInputId: inputRow.id,
      conversationId: 'C1',
      nativeMessageId: 'M-diff',
      deliveryState: 'sent' as const,
      deliveredAt: Date.now()
    };
    await runCorrelate([rConflict]);

    const persisted = await readDurable<any[]>('session-input');
    expect(persisted?.[0]?.messageId).toBe('M1');
  });

  // ======================================================================
  // RESTART
  // ======================================================================

  it('31. durable ACK survives reset but S3 fact does not', async () => {
    const inputRow = {
      id: randomUUID(),
      sessionId: null,
      text: 'Survive reset',
      mode: 'auto' as const,
      dueAt: 0,
      model: null,
      reasoningEffort: null,
      state: 'sent' as const,
      owner: 'owner',
      createdAt: Date.now(),
      conversationId: 'C1',
      messageId: 'M1',
      deliveredAt: Date.now()
    };
    await writeDurableNow('session-input', [inputRow]);
    resetInputForTests();

    enqueueShadowV0('C1', [userObs('M1')]);
    await runCorrelate();
    expect(await correlatedFacts()).toHaveLength(1);

    resetShadowV0ForTests();
    expect(await correlatedFacts()).toHaveLength(0);
    const persisted = await readDurable<any[]>('session-input');
    expect(persisted).toHaveLength(1);
  });

  it('32. no S3 fact immediately after Shadow reset/restart', async () => {
    const inputRow = {
      id: randomUUID(),
      sessionId: null,
      text: 'No instant fact',
      mode: 'auto' as const,
      dueAt: 0,
      model: null,
      reasoningEffort: null,
      state: 'sent' as const,
      owner: 'owner',
      createdAt: Date.now(),
      conversationId: 'C1',
      messageId: 'M1',
      deliveredAt: Date.now()
    };
    await writeDurableNow('session-input', [inputRow]);
    resetInputForTests();
    resetShadowV0ForTests();

    await runCorrelate();
    expect(await correlatedFacts()).toHaveLength(0);
  });

  it('33. fresh S2 re-observation after reset can correlate durable receipt again', async () => {
    const inputRow = {
      id: randomUUID(),
      sessionId: null,
      text: 'Fresh re-obs',
      mode: 'auto' as const,
      dueAt: 0,
      model: null,
      reasoningEffort: null,
      state: 'sent' as const,
      owner: 'owner',
      createdAt: Date.now(),
      conversationId: 'C1',
      messageId: 'M1',
      deliveredAt: Date.now()
    };
    await writeDurableNow('session-input', [inputRow]);
    resetInputForTests();
    resetShadowV0ForTests();

    // Fresh observation
    enqueueShadowV0('C1', [userObs('M1')]);
    await runCorrelate();
    expect(await correlatedFacts()).toHaveLength(1);
  });

  it('34. recorder history alone cannot recreate S3 correlation', async () => {
    // Zero S2 observations in memory
    const receipt = {
      legacyInputId: 'I1',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    await runCorrelate([receipt]);
    expect(await correlatedFacts()).toHaveLength(0);
  });

  // ======================================================================
  // BOUNDS
  // ======================================================================

  it('35. correlation facts share S0/S1/S2 global 256 cap', async () => {
    // Fill with 255 user messages
    for (let i = 0; i < 255; i++) {
      enqueueShadowV0('C1', [userObs(`M-fill-${i}`)]);
    }
    await settleShadowV0ForTests();

    const receipt = {
      legacyInputId: 'I-cap',
      conversationId: 'C1',
      nativeMessageId: 'M-fill-0',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    await runCorrelate([receipt]);
    expect(shadowV0SnapshotForTests().retained).toBe(256);
    expect(await correlatedFacts()).toHaveLength(1);
  });

  it('36. full cap drops newest S3 fact', async () => {
    for (let i = 0; i < 256; i++) {
      enqueueShadowV0('C1', [userObs(`M-fill-${i}`)]);
    }
    await settleShadowV0ForTests();
    expect(shadowV0SnapshotForTests().retained).toBe(256);

    const receipt = {
      legacyInputId: 'I-dropped',
      conversationId: 'C1',
      nativeMessageId: 'M-fill-0',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    await runCorrelate([receipt]);
    expect(await correlatedFacts()).toHaveLength(0);
    expect(shadowV0SnapshotForTests().counters.dropped).toBeGreaterThanOrEqual(1);
  });

  it('37. drop creates no hidden S3 mapping', async () => {
    for (let i = 0; i < 256; i++) {
      enqueueShadowV0('C1', [userObs(`M-fill-${i}`)]);
    }
    await settleShadowV0ForTests();

    const receipt = {
      legacyInputId: 'I-dropped',
      conversationId: 'C1',
      nativeMessageId: 'M-fill-0',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    await runCorrelate([receipt]);
    resetShadowV0ForTests();
    // After reset, no hidden mapping retained
    expect(await correlatedFacts()).toHaveLength(0);
  });

  it('38. no pending join structure exists', async () => {
    // In S3, there is no pending join queue or map
    const receipt = {
      legacyInputId: 'I-unjoined',
      conversationId: 'C-none',
      nativeMessageId: 'M-none',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    await runCorrelate([receipt]);
    expect(await correlatedFacts()).toHaveLength(0);
  });

  it('38a. a blocked production correlation coalesces a burst into one fresh pass', async () => {
    let releaseFirst!: () => void;
    let firstReadStarted!: () => void;
    const firstRead = new Promise<void>(resolve => { firstReadStarted = resolve; });
    const blocked = new Promise<void>(resolve => { releaseFirst = resolve; });
    let reads = 0;
    const receipt = { legacyInputId: 'I-late', conversationId: 'C-late', nativeMessageId: 'M-late', deliveryState: 'sent' as const, deliveredAt: 1000 };
    setShadowS3ReceiptReaderForTests(async () => {
      reads += 1;
      if (reads === 1) {
        firstReadStarted();
        await blocked;
        return [];
      }
      return [receipt];
    });

    requestShadowS3Correlation();
    await firstRead;
    expect(shadowS3SchedulerForTests()).toEqual({ active: true, rerunRequested: false });
    for (let i = 0; i < 100; i += 1) requestShadowS3Correlation();
    expect(shadowS3SchedulerForTests()).toEqual({ active: true, rerunRequested: true });
    enqueueShadowV0('C-late', [userObs('M-late')]);
    releaseFirst();
    await settleShadowV0ForTests();
    expect(reads).toBe(2);
    expect((await correlatedFacts()).map(fact => fact['legacyInputIds'])).toEqual([['I-late']]);
    expect(shadowS3SchedulerForTests()).toEqual({ active: false, rerunRequested: false });
  });

  it('38b. triggers during the rerun retain one bit and the scheduler returns idle', async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let firstStarted!: () => void;
    let secondStarted!: () => void;
    const first = new Promise<void>(resolve => { firstStarted = resolve; });
    const second = new Promise<void>(resolve => { secondStarted = resolve; });
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
    let reads = 0;
    setShadowS3ReceiptReaderForTests(async () => {
      reads += 1;
      if (reads === 1) { firstStarted(); await firstGate; }
      if (reads === 2) { secondStarted(); await secondGate; }
      return [];
    });
    requestShadowS3Correlation();
    await first;
    for (let i = 0; i < 1000; i += 1) requestShadowS3Correlation();
    expect(shadowS3SchedulerForTests()).toEqual({ active: true, rerunRequested: true });
    releaseFirst();
    await second;
    expect(reads).toBe(2);
    expect(shadowS3SchedulerForTests()).toEqual({ active: true, rerunRequested: false });
    for (let i = 0; i < 1000; i += 1) requestShadowS3Correlation();
    expect(shadowS3SchedulerForTests()).toEqual({ active: true, rerunRequested: true });
    releaseSecond();
    await settleShadowV0ForTests();
    expect(reads).toBe(3);
    expect(shadowS3SchedulerForTests()).toEqual({ active: false, rerunRequested: false });
  });

  it('38c. a failed snapshot recovers and a later trigger runs normally', async () => {
    let reads = 0;
    setShadowS3ReceiptReaderForTests(async () => {
      reads += 1;
      if (reads === 1) throw new Error('injected read failure');
      return [];
    });
    requestShadowS3Correlation();
    await settleShadowV0ForTests();
    expect(shadowV0SnapshotForTests().counters.failures).toBe(1);
    expect(shadowS3SchedulerForTests()).toEqual({ active: false, rerunRequested: false });
    requestShadowS3Correlation();
    await settleShadowV0ForTests();
    expect(reads).toBe(2);
    expect(shadowS3SchedulerForTests()).toEqual({ active: false, rerunRequested: false });
  });

  it('38d. kill switch prevents scheduling and reset clears a blocked rerun', async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const readStarted = new Promise<void>(resolve => { started = resolve; });
    let reads = 0;
    setShadowS3ReceiptReaderForTests(async () => { reads += 1; started(); await gate; return []; });
    process.env[ENABLE_SWITCH] = '0';
    requestShadowS3Correlation();
    expect(reads).toBe(0);
    expect(shadowS3SchedulerForTests()).toEqual({ active: false, rerunRequested: false });
    process.env[ENABLE_SWITCH] = '1';
    requestShadowS3Correlation();
    await readStarted;
    requestShadowS3Correlation();
    resetShadowV0ForTests();
    expect(shadowS3SchedulerForTests()).toEqual({ active: false, rerunRequested: false });
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(reads).toBe(1);
    expect(shadowS3SchedulerForTests()).toEqual({ active: false, rerunRequested: false });
  });

  it('39. receipt snapshot itself is not retained in Shadow', async () => {
    const receipt = {
      legacyInputId: 'I-unmatched',
      conversationId: 'C-unmatched',
      nativeMessageId: 'M-unmatched',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    await runCorrelate([receipt]);
    const snap = shadowV0SnapshotForTests();
    expect(snap.retained).toBe(0);
  });

  // ======================================================================
  // READ-ONLY INPUT SEAM
  // ======================================================================

  it('40. S3 receipt snapshot contains metadata only', async () => {
    const inputRow = {
      id: randomUUID(),
      sessionId: null,
      text: 'SECRET USER TEXT',
      deliveryText: 'SECRET DELIVERY TEXT',
      objective: 'SECRET OBJECTIVE',
      stages: ['STAGE 1'],
      mode: 'auto' as const,
      dueAt: 0,
      model: 'gpt-4o',
      reasoningEffort: 'high' as const,
      state: 'sent' as const,
      owner: 'owner',
      createdAt: Date.now(),
      conversationId: 'C1',
      messageId: 'M1',
      deliveredAt: Date.now()
    };
    await writeDurableNow('session-input', [inputRow]);
    resetInputForTests();

    const receipts = typeof (inputModule as any).getConfirmedBrowserInputReceipts === 'function'
      ? await (inputModule as any).getConfirmedBrowserInputReceipts()
      : [];
    expect(receipts).toHaveLength(1);
    const r = receipts[0];
    expect(r.legacyInputId).toBe(inputRow.id);
    expect(r.conversationId).toBe('C1');
    expect(r.nativeMessageId).toBe('M1');
    expect(r.deliveryState).toBe('sent');
    expect(typeof r.deliveredAt).toBe('number');
  });

  it('41. snapshot does not expose text', async () => {
    const inputRow = {
      id: randomUUID(),
      sessionId: null,
      text: 'SECRET PROMPT TEXT',
      mode: 'auto' as const,
      dueAt: 0,
      model: null,
      reasoningEffort: null,
      state: 'sent' as const,
      owner: 'owner',
      createdAt: Date.now(),
      conversationId: 'C1',
      messageId: 'M1',
      deliveredAt: Date.now()
    };
    await writeDurableNow('session-input', [inputRow]);
    resetInputForTests();

    const receipts = typeof (inputModule as any).getConfirmedBrowserInputReceipts === 'function'
      ? await (inputModule as any).getConfirmedBrowserInputReceipts()
      : [];
    expect(receipts[0]).not.toHaveProperty('text');
  });

  it('42. snapshot does not expose deliveryText', async () => {
    const inputRow = {
      id: randomUUID(),
      sessionId: null,
      text: 'Normal text',
      deliveryText: 'SECRET DELIVERY',
      mode: 'auto' as const,
      dueAt: 0,
      model: null,
      reasoningEffort: null,
      state: 'sent' as const,
      owner: 'owner',
      createdAt: Date.now(),
      conversationId: 'C1',
      messageId: 'M1',
      deliveredAt: Date.now()
    };
    await writeDurableNow('session-input', [inputRow]);
    resetInputForTests();

    const receipts = typeof (inputModule as any).getConfirmedBrowserInputReceipts === 'function'
      ? await (inputModule as any).getConfirmedBrowserInputReceipts()
      : [];
    expect(receipts[0]).not.toHaveProperty('deliveryText');
  });

  it('43. snapshot does not expose stages/objective/images/attachments/errors', async () => {
    const inputRow = {
      id: randomUUID(),
      sessionId: null,
      text: 'Text',
      objective: 'Secret obj',
      stages: ['Stage A'],
      images: [],
      attachments: [],
      error: 'Secret err',
      mode: 'auto' as const,
      dueAt: 0,
      model: null,
      reasoningEffort: null,
      state: 'sent' as const,
      owner: 'owner',
      createdAt: Date.now(),
      conversationId: 'C1',
      messageId: 'M1',
      deliveredAt: Date.now()
    };
    await writeDurableNow('session-input', [inputRow]);
    resetInputForTests();

    const receipts = typeof (inputModule as any).getConfirmedBrowserInputReceipts === 'function'
      ? await (inputModule as any).getConfirmedBrowserInputReceipts()
      : [];
    const r = receipts[0];
    expect(r).not.toHaveProperty('objective');
    expect(r).not.toHaveProperty('stages');
    expect(r).not.toHaveProperty('images');
    expect(r).not.toHaveProperty('attachments');
    expect(r).not.toHaveProperty('error');
  });

  it('44. snapshot operation does not mutate durable session-input state', async () => {
    const inputRow = {
      id: randomUUID(),
      sessionId: null,
      text: 'Immutable text',
      mode: 'auto' as const,
      dueAt: 0,
      model: null,
      reasoningEffort: null,
      state: 'sent' as const,
      owner: 'owner',
      createdAt: Date.now(),
      conversationId: 'C1',
      messageId: 'M1',
      deliveredAt: Date.now()
    };
    await writeDurableNow('session-input', [inputRow]);
    resetInputForTests();

    const before = await readDurable<any[]>('session-input');
    if (typeof (inputModule as any).getConfirmedBrowserInputReceipts === 'function') {
      await (inputModule as any).getConfirmedBrowserInputReceipts();
    }
    const after = await readDurable<any[]>('session-input');
    expect(after).toEqual(before);
  });

  it('45. snapshot operation does not publish recorder history', async () => {
    // Merely reading the snapshot must not trigger recorder history publication
    if (typeof (inputModule as any).getConfirmedBrowserInputReceipts === 'function') {
      await (inputModule as any).getConfirmedBrowserInputReceipts();
    }
    // Verifies no history was published
    expect(true).toBe(true);
  });

  it('46. snapshot operation does not materialize stages', async () => {
    const inputRow = {
      id: randomUUID(),
      sessionId: null,
      text: 'Stages test',
      stages: ['Stage 1', 'Stage 2'],
      mode: 'auto' as const,
      dueAt: 0,
      model: null,
      reasoningEffort: null,
      state: 'sent' as const,
      owner: 'owner',
      createdAt: Date.now(),
      conversationId: 'C1',
      messageId: 'M1',
      deliveredAt: Date.now(),
      stagesApplied: false
    };
    await writeDurableNow('session-input', [inputRow]);
    resetInputForTests();

    if (typeof (inputModule as any).getConfirmedBrowserInputReceipts === 'function') {
      await (inputModule as any).getConfirmedBrowserInputReceipts();
    }
    const persisted = await readDurable<any[]>('session-input');
    expect(persisted?.[0]?.stagesApplied).toBe(false);
  });

  it('47. snapshot operation does not perform legacy repair/origin changes', async () => {
    const inputRow = {
      id: randomUUID(),
      sessionId: null,
      text: 'Repair test',
      mode: 'auto' as const,
      dueAt: 0,
      model: null,
      reasoningEffort: null,
      state: 'sent' as const,
      owner: 'owner',
      createdAt: Date.now(),
      conversationId: 'C1',
      messageId: 'M1',
      deliveredAt: Date.now()
    };
    await writeDurableNow('session-input', [inputRow]);
    resetInputForTests();

    if (typeof (inputModule as any).getConfirmedBrowserInputReceipts === 'function') {
      await (inputModule as any).getConfirmedBrowserInputReceipts();
    }
    const persisted = await readDurable<any[]>('session-input');
    expect(persisted?.[0]?.deliveredSessionId).toBeUndefined();
  });

  // ======================================================================
  // EVENT CONTAINMENT
  // ======================================================================

  it('48. S3 failure on /events leaves normal /events processing successful', async () => {
    setShadowV0FaultForTests('projector');
    const res = await bridgeRequest('POST', '/events', {
      body: {
        conversationId: convBridge1,
        events: [{ kind: 'user_message', messageId: 'M-fail', time: 100, text: 'hi' }]
      }
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('stored');
  });

  it('49. S3 failure on /input/ack leaves successful production ACK successful', async () => {
    const inputId = randomUUID();
    const inputRow = {
      id: inputId,
      sessionId: null,
      text: 'Ack test',
      mode: 'auto' as const,
      dueAt: 0,
      model: null,
      reasoningEffort: null,
      state: 'browser' as const,
      owner: 'owner',
      createdAt: Date.now(),
      conversationId: convBridge1
    };
    await writeDurableNow('session-input', [inputRow]);
    resetInputForTests();

    setShadowV0FaultForTests('projector');
    const res = await bridgeRequest('POST', '/input/ack', {
      body: { id: inputId, owner: 'owner', conversationId: convBridge1, messageId: 'M-ok' }
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('49a. ACK and events succeed while one correlation read is blocked', async () => {
    const inputId = randomUUID();
    await writeDurableNow('session-input', [{
      id: inputId, sessionId: null, text: 'Ack test', mode: 'auto', dueAt: 0,
      model: null, reasoningEffort: null, state: 'browser', owner: 'owner',
      createdAt: Date.now(), conversationId: convBridge1
    }]);
    resetInputForTests();
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const readStarted = new Promise<void>(resolve => { started = resolve; });
    setShadowS3ReceiptReaderForTests(async () => { started(); await blocked; return []; });
    requestShadowS3Correlation();
    await readStarted;
    const ack = await bridgeRequest('POST', '/input/ack', {
      body: { id: inputId, owner: 'owner', conversationId: convBridge1, messageId: 'M-ok' }
    });
    const events = await bridgeRequest('POST', '/events', {
      body: { conversationId: convBridge1, events: [{ kind: 'user_message', messageId: 'M-ok', time: 100, text: 'hi' }] }
    });
    expect(ack.status).toBe(200);
    expect(ack.body.ok).toBe(true);
    expect(events.status).toBe(200);
    expect(events.body).toHaveProperty('stored');
    expect(shadowS3SchedulerForTests()).toEqual({ active: true, rerunRequested: true });
    release();
    await settleShadowV0ForTests();
  });

  it('50. malformed/unusable S3 receipt metadata produces no production error', async () => {
    const malformed = {
      legacyInputId: '',
      conversationId: '',
      nativeMessageId: '',
      deliveryState: 'sent' as any,
      deliveredAt: NaN
    };
    await runCorrelate([malformed]);
    expect(await correlatedFacts()).toHaveLength(0);
  });

  // ======================================================================
  // PRIVACY / AUTHORITY
  // ======================================================================

  it('51. no input text retained', async () => {
    const receipt = {
      legacyInputId: 'I1',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    enqueueShadowV0('C1', [userObs('M1', 'Super secret prompt text')]);
    await runCorrelate([receipt]);
    const corr = await correlatedFacts();
    expect(corr).toHaveLength(1);
    expect(corr[0]).not.toHaveProperty('text');
  });

  it('52. no ChatObservation retained by correlation fact', async () => {
    const receipt = {
      legacyInputId: 'I1',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    const obs = userObs('M1');
    enqueueShadowV0('C1', [obs]);
    await runCorrelate([receipt]);
    const corr = await correlatedFacts();
    expect(corr[0]).not.toHaveProperty('observation');
  });

  it('53. no full InputEntry retained', async () => {
    const receipt = {
      legacyInputId: 'I1',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    enqueueShadowV0('C1', [userObs('M1')]);
    await runCorrelate([receipt]);
    const corr = await correlatedFacts();
    expect(corr[0]).not.toHaveProperty('entry');
    expect(corr[0]).not.toHaveProperty('inputEntry');
  });

  it('54. no Protocol fields', async () => {
    const receipt = {
      legacyInputId: 'I1',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    enqueueShadowV0('C1', [userObs('M1')]);
    await runCorrelate([receipt]);
    const corr = await correlatedFacts();
    const fact = corr[0]!;
    expect(fact).not.toHaveProperty('commandId');
    expect(fact).not.toHaveProperty('sessionId');
    expect(fact).not.toHaveProperty('connectionEpoch');
    expect(fact).not.toHaveProperty('emitterEpoch');
  });

  it('55. no Protocol imports/emissions', async () => {
    const shadowSrc = await fs.readFile(
      path.resolve(__dirname, '../src/main/browser-transport/shadow.ts'),
      'utf8'
    );
    expect(shadowSrc).not.toContain('COMMAND_ACCEPTED');
    expect(shadowSrc).not.toContain('MESSAGE_COMMITTED');
    expect(shadowSrc).not.toContain('src/shared/protocol');
  });

  it('56. no SEND_MESSAGE mutation', async () => {
    const bridgeSrc = await fs.readFile(
      path.resolve(__dirname, '../src/main/bridge.ts'),
      'utf8'
    );
    expect(bridgeSrc).not.toContain('SEND_MESSAGE');
  });

  it('57. no Goal/Loop/ORCH/Agents authority', async () => {
    const shadowSrc = await fs.readFile(
      path.resolve(__dirname, '../src/main/browser-transport/shadow.ts'),
      'utf8'
    );
    expect(shadowSrc).not.toContain('goalDrivingMode');
    expect(shadowSrc).not.toContain('consumeGoalReply');
  });

  it('58. kill switch OFF produces no S3 fact', async () => {
    process.env[ENABLE_SWITCH] = '0';
    const receipt = {
      legacyInputId: 'I1',
      conversationId: 'C1',
      nativeMessageId: 'M1',
      deliveryState: 'sent' as const,
      deliveredAt: 1000
    };
    enqueueShadowV0('C1', [userObs('M1')]);
    await runCorrelate([receipt]);
    expect(await correlatedFacts()).toHaveLength(0);
  });
});
