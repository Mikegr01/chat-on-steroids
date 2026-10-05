import http from 'node:http';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'unknown',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  }, clipboard: {}, shell: {}
}));

import * as shadow from '../src/main/browser-transport/shadow.js';
import * as inputModule from '../src/main/session/input.js';
import type { InputEntry, ConfirmedBrowserInputReceipt } from '../src/main/session/input.js';
import type { LegacyBrowserClaimPolicyInput } from '../src/main/browser-transport/shadow.js';
import { sendMessagePayloadSchema } from '../src/shared/protocol/commands.js';
import { BrowserTransportService } from '../src/main/browser-transport/service.js';
import { ProtocolStore, PROTOCOL_STORE_NAME } from '../src/main/browser-transport/store.js';
import { FakeTransportAdapter } from '../src/main/browser-transport/fake-adapter.js';
import { BRIDGE_PROTOCOL } from '../src/main/version.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath } = await import('../src/main/secrets.js');
const { initDurableStore, resetDurableForTests, readDurable, writeDurableNow } = await import('../src/main/durable.js');
const { createSession, initSessionStore, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { resetRecorderForTests } = await import('../src/main/session/recorder.js');
const { resetSwarm } = await import('../src/main/agents.js');
const { resetBridgeForTests, startBridge, stopBridge } = await import('../src/main/bridge.js');

const SWITCH = 'CLF_KOSMOSYN_SHADOW_V0';
const BOUND_CHAT = 'abcd0000-0000-4000-8000-000000000005';
let directory: string, base: string, token: string;

function request(route: string, body?: unknown, auth = token): Promise<{ status: number; body: any }> {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(route, base), { method: 'POST', headers: {
      origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
      'x-extension-protocol': String(BRIDGE_PROTOCOL),
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...(payload === null ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) })
    } }, res => {
      let data = '';
      res.setEncoding('utf8'); res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject); if (payload !== null) req.write(payload); req.end();
  });
}

function claim(overrides: Partial<InputEntry> = {}): InputEntry {
  return { id: randomUUID(), sessionId: null, text: 'exact frozen delivery text', mode: 'auto', dueAt: 0,
    model: null, reasoningEffort: null, state: 'browser', owner: 's5-document', createdAt: Date.now(),
    conversationId: BOUND_CHAT, ...overrides };
}
async function postClaim(input: InputEntry | null) {
  vi.spyOn(inputModule, 'claimBrowserInput').mockResolvedValue(input);
  const reply = await request('/input/claim', { id: input?.id ?? randomUUID(), owner: 's5-document',
    conversationId: input?.conversationId ?? null });
  expect(reply).toEqual({ status: 200, body: { input } });
  await shadow.settleShadowV0ForTests();
  return reply;
}
function decisions() { return shadow.shadowS5SnapshotForTests(); }
function project(input: InputEntry) {
  return { legacyInputId: input.id, text: input.text, targetConversationId: input.conversationId,
    purpose: input.purpose, model: input.model, reasoningEffort: input.reasoningEffort,
    hasMedia: (input.images?.length ?? 0) > 0 || (input.attachments?.length ?? 0) > 0 };
}
function receipt(input: InputEntry, extra: Partial<ConfirmedBrowserInputReceipt> = {}): ConfirmedBrowserInputReceipt {
  return { legacyInputId: input.id, conversationId: BOUND_CHAT, nativeMessageId: 's5-native',
    deliveryState: 'sent', deliveredAt: Date.now(), ...extra };
}
async function confirm(input: InputEntry, receipts?: ConfirmedBrowserInputReceipt[]) {
  shadow.enqueueShadowV0(BOUND_CHAT, [{ kind: 'user_message', messageId: 's5-native', time: Date.now(), text: 'native' }]);
  await shadow.correlateShadowS3(receipts ?? [receipt(input)]);
  await shadow.settleShadowV0ForTests();
}

beforeAll(async () => {
  directory = await makeTempDir('clf-kosmosyn-s5-');
  initConfigPath(directory); initSecretsPath(directory); initDurableStore(directory); initSessionStore(directory);
  const config = defaultConfig();
  await saveConfig({ ...config, ui: { ...config.ui, autoContinue: false }, goal: { ...config.goal, enabled: false } });
  const port = await startBridge(); expect(port).not.toBeNull(); base = `http://127.0.0.1:${port}`;
  const reply = await request('/pair', undefined, ''); expect(reply.status).toBe(200); token = reply.body.token;
});
beforeEach(() => {
  process.env[SWITCH] = '1'; shadow.resetShadowV0ForTests(); resetRecorderForTests(); resetSessionStoreForTests();
  inputModule.resetInputForTests(); resetBridgeForTests(); resetSwarm(); resetDurableForTests();
  initDurableStore(directory); initSessionStore(directory);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); delete process.env[SWITCH]; shadow.resetShadowV0ForTests(); });
afterAll(async () => { await stopBridge(); await removeTempDir(directory); });

describe('Kosmosyn S5 SEND_MESSAGE decision shadow', () => {
  it('observes a successful ordinary bound-chat claim as provisional WOULD_ADMIT / NOT_ARMED', async () => {
    const input = claim(); await postClaim(input);
    expect(decisions()).toHaveLength(1);
    expect(decisions()[0]).toMatchObject({ legacyInputId: input.id, policyVerdict: 'WOULD_ADMIT',
      runtimeReadiness: 'NOT_ARMED', legacyOutcome: 'CLAIMED', classification: 'PROVISIONAL' });
  });
  it('compares a successful New Chat/null-target claim as hypothetical rejection and final divergence', async () => {
    const input = claim({ conversationId: null }); await postClaim(input); await confirm(input);
    expect(decisions()[0]).toMatchObject({ policyVerdict: 'WOULD_REJECT', policyRejectReason: 'MISSING_TARGET_CONVERSATION_ID',
      legacyOutcome: 'CONFIRMED_SENT', classification: 'LEGACY_ALLOWED_PROTOCOL_REJECTED' });
  });
  it('promotes an ordinary claim to AGREED_ADMIT only through admitted S3 correlation', async () => {
    const input = claim(); await postClaim(input); await confirm(input);
    expect(decisions()[0]).toMatchObject({ legacyOutcome: 'CONFIRMED_SENT', classification: 'AGREED_ADMIT' });
  });
  it('keeps decision/helper semantics NOT_EVALUABLE and NOT_COMPARABLE even with S3 proof', async () => {
    const input = claim({ purpose: 'decision' }); await postClaim(input); await confirm(input);
    expect(decisions()[0]).toMatchObject({ policyVerdict: 'NOT_EVALUABLE',
      policyRejectReason: 'LEGACY_DECISION_SEMANTICS_NOT_MAPPED', classification: 'NOT_COMPARABLE' });
  });
  it('rejects the entire media claim as MEDIA_NOT_REPRESENTABLE', async () => {
    const input = claim({ images: [{ name: 'private-image', dataUrl: 'private-pixels' }] });
    await postClaim(input); await confirm(input);
    expect(decisions()[0]).toMatchObject({ policyVerdict: 'WOULD_REJECT', policyRejectReason: 'MEDIA_NOT_REPRESENTABLE',
      classification: 'LEGACY_ALLOWED_PROTOCOL_REJECTED' });
  });
  it('provides a synchronous, failure-contained S5 observation seam', () => {
    expect(shadow.observeLegacyBrowserClaim).toBeTypeOf('function');
    const timer = vi.spyOn(globalThis, 'setTimeout'), interval = vi.spyOn(globalThis, 'setInterval');
    const microtask = vi.spyOn(globalThis, 'queueMicrotask');
    const input = Object.freeze(project(claim()));
    expect(shadow.observeLegacyBrowserClaim(input)).toBeUndefined();
    expect(timer).not.toHaveBeenCalled(); expect(interval).not.toHaveBeenCalled(); expect(microtask).not.toHaveBeenCalled();
    expect(decisions()).toHaveLength(1);
  });

  it('does zero S5 work when Shadow is OFF and preserves the legacy response', async () => {
    delete process.env[SWITCH];
    const observation = vi.spyOn(shadow, 'observeLegacyBrowserClaim');
    const schemaCheck = vi.spyOn(sendMessagePayloadSchema.shape.text, 'safeParse');
    await postClaim(claim());
    expect(observation).not.toHaveBeenCalled(); expect(schemaCheck).not.toHaveBeenCalled();
    const unread = { get legacyInputId(): string { throw new Error('must not inspect while OFF'); } };
    expect(() => shadow.observeLegacyBrowserClaim(unread as ReturnType<typeof project>)).not.toThrow();
    expect(decisions()).toEqual([]);
    expect(shadow.shadowV0SnapshotForTests()).toMatchObject({ retained: 0, pending: 0,
      counters: { admitted: 0, duplicates: 0, rejected: 0, dropped: 0, failures: 0 } });
  });
  it('creates no record or rejection evidence for a null claim', async () => {
    const observation = vi.spyOn(shadow, 'observeLegacyBrowserClaim');
    await postClaim(null);
    expect(observation).not.toHaveBeenCalled(); expect(decisions()).toEqual([]);
    expect(shadow.shadowV0SnapshotForTests().counters.rejected).toBe(0);
  });
  it('deduplicates repeated claims before policy work and before final comparisons', async () => {
    const input = claim(); await postClaim(input);
    const evaluator = vi.spyOn(sendMessagePayloadSchema.shape.text, 'safeParse');
    await postClaim(input); await confirm(input); await postClaim(input);
    expect(evaluator).not.toHaveBeenCalled();
    expect(decisions()).toHaveLength(1); expect(decisions()[0]?.classification).toBe('AGREED_ADMIT');
    expect(shadow.shadowV0SnapshotForTests().counters.duplicates).toBeGreaterThanOrEqual(2);
  });
  it.each(['cancelled', 'decision'] as const)('respects an admitted S3 %s receipt as actual native-send proof', async deliveryState => {
    const input = claim(); await postClaim(input); await confirm(input, [receipt(input, { deliveryState })]);
    expect(decisions()[0]).toMatchObject({ legacyOutcome: 'CONFIRMED_SENT', classification: 'AGREED_ADMIT' });
  });
  it.each(['images', 'attachments'] as const)('rejects returned %s including a combined companion without retaining media', async kind => {
    const companion = randomUUID();
    const input = claim({ companionInputId: companion, ...(kind === 'images'
      ? { images: [{ name: 'PRIVATE_IMAGE_NAME', dataUrl: 'PRIVATE_IMAGE_BYTES' }] }
      : { attachments: [{ id: randomUUID(), name: 'PRIVATE_ATTACHMENT_NAME', mimeType: 'private/type', size: 12, preview: 'PRIVATE_PREVIEW' }] }) });
    await postClaim(input);
    await confirm(input, [receipt(input, { companionInputId: companion }), receipt(input, { legacyInputId: companion })]);
    expect(decisions()).toHaveLength(1);
    expect(decisions()[0]).toMatchObject({ policyRejectReason: 'MEDIA_NOT_REPRESENTABLE',
      legacyOutcome: 'CONFIRMED_SENT', classification: 'LEGACY_ALLOWED_PROTOCOL_REJECTED' });
    expect(shadow.shadowV0SnapshotForTests().observations.filter(f => f.kind === 'LEGACY_INPUT_NATIVE_CORRELATED')).toHaveLength(1);
  });
  it('joins one combined root claim once by S3 membership in either receipt order', async () => {
    const input = claim(), companion = randomUUID(); await postClaim(input);
    await confirm(input, [receipt(input, { legacyInputId: companion }), receipt(input, { companionInputId: companion })]);
    expect(decisions()).toHaveLength(1); expect(decisions()[0]?.classification).toBe('AGREED_ADMIT');
    await confirm(input, [receipt(input, { companionInputId: companion }), receipt(input, { legacyInputId: companion })]);
    expect(decisions()).toHaveLength(1); expect(decisions()[0]?.classification).toBe('AGREED_ADMIT');
  });
  it('does not promote raw receipt/native-ID evidence without an admitted S3 fact', async () => {
    const input = claim({ messageId: 's5-native', deliveredAt: Date.now() }); await postClaim(input);
    await shadow.correlateShadowS3([receipt(input)]); await shadow.settleShadowV0ForTests();
    expect(decisions()[0]).toMatchObject({ legacyOutcome: 'CLAIMED', classification: 'PROVISIONAL' });
  });
  it('ages missing S3 opportunistically at the fixed horizon, with valid late proof still allowed', async () => {
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const input = claim(); shadow.observeLegacyBrowserClaim(project(input));
    now += shadow.SHADOW_S5_RESOLUTION_HORIZON_MS;
    // A read alone does not advance the diagnostic clock or run retirement work.
    expect(decisions()[0]?.classification).toBe('PROVISIONAL');
    shadow.enqueueShadowV0(BOUND_CHAT, []);
    expect(decisions()[0]).toMatchObject({ legacyOutcome: 'DEFERRED_OR_UNKNOWN', classification: 'NOT_COMPARABLE', policyVerdict: 'WOULD_ADMIT' });
    await confirm(input);
    expect(decisions()[0]?.classification).toBe('AGREED_ADMIT');
  });
  it.each([false, true])('suppresses prior positive evidence after conflicting S3 (null target: %s)', async newChat => {
    const input = claim({ conversationId: newChat ? null : BOUND_CHAT }); await postClaim(input); await confirm(input);
    expect(decisions()[0]?.legacyOutcome).toBe('CONFIRMED_SENT');
    await shadow.correlateShadowS3([receipt(input, { nativeMessageId: 'conflicting-native' })]);
    await shadow.settleShadowV0ForTests();
    expect(decisions()[0]).toMatchObject({ legacyOutcome: 'DEFERRED_OR_UNKNOWN', classification: 'NOT_COMPARABLE' });
    // Neither a duplicate nor a late replay of the original positive fact can clear the fence.
    await confirm(input); expect(decisions()[0]?.classification).toBe('NOT_COMPARABLE');
    shadow.observeLegacyBrowserClaim(project(claim({ id: input.id })));
    expect(decisions()[0]?.classification).toBe('NOT_COMPARABLE');
  });
  it.each(['missing', 'malformed', 'read-failure', 'missing-companion', 'unrelated-pair', 'three-entries'] as const)
    ('suppresses accepted proof after S3 evidence loss: %s', async loss => {
      const input = claim(); await postClaim(input); await confirm(input);
      const original = receipt(input);
      if (loss === 'read-failure') {
        shadow.setShadowS3ReceiptReaderForTests(async () => { throw new Error('private failure detail'); });
        await shadow.correlateShadowS3();
      } else {
        const receipts = loss === 'missing' ? [] : loss === 'malformed' ? [{ ...original, deliveredAt: NaN }]
          : loss === 'missing-companion' ? [{ ...original, companionInputId: randomUUID() }]
          : [original, { ...original, legacyInputId: randomUUID() }, ...(loss === 'three-entries' ? [{ ...original, legacyInputId: randomUUID() }] : [])];
        await shadow.correlateShadowS3(receipts);
      }
      expect(decisions()[0]).toMatchObject({ legacyOutcome: 'DEFERRED_OR_UNKNOWN', classification: 'NOT_COMPARABLE' });
    });
  it('fences conflicting candidates in one S3 pass before any final agreement', async () => {
    const input = claim(); await postClaim(input);
    shadow.enqueueShadowV0(BOUND_CHAT, ['s5-native', 'other-native'].map(messageId => ({ kind: 'user_message', messageId, text: 'native', time: Date.now() })));
    await shadow.correlateShadowS3([receipt(input), receipt(input, { nativeMessageId: 'other-native' })]);
    await shadow.settleShadowV0ForTests();
    expect(decisions()[0]?.classification).toBe('NOT_COMPARABLE');
  });
  it('does not import a late failed S3 snapshot into a reset sample', async () => {
    let reject!: (error: Error) => void;
    shadow.setShadowS3ReceiptReaderForTests(() => new Promise((_resolve, rejectRead) => { reject = rejectRead; }));
    const old = shadow.correlateShadowS3();
    shadow.resetShadowV0ForTests();
    const input = claim(); shadow.observeLegacyBrowserClaim(project(input));
    reject(new Error('old snapshot failed')); await old; await confirm(input);
    expect(decisions()[0]?.classification).toBe('AGREED_ADMIT');
  });

  const policyInput: LegacyBrowserClaimPolicyInput = { text: 'x', targetConversationId: BOUND_CHAT, hasMedia: false };
  it.each([0, 1, 240000, 240001])('checks exact returned text length %i', length => {
    const result = shadow.evaluateLegacySendMessagePolicy({ ...policyInput, text: 'x'.repeat(length) });
    expect(result).toEqual(length === 0 || length === 240001
      ? { policyVerdict: 'WOULD_REJECT', policyRejectReason: 'TEXT_OUT_OF_BOUNDS' } : { policyVerdict: 'WOULD_ADMIT' });
  });
  it.each([null, undefined, '', 'x', 'x'.repeat(128), 'x'.repeat(129)])('checks target bounds (%s)', targetConversationId => {
    const result = shadow.evaluateLegacySendMessagePolicy({ ...policyInput, targetConversationId });
    expect(result).toEqual(targetConversationId == null
      ? { policyVerdict: 'WOULD_REJECT', policyRejectReason: 'MISSING_TARGET_CONVERSATION_ID' }
      : targetConversationId.length === 0 || targetConversationId.length === 129
        ? { policyVerdict: 'WOULD_REJECT', policyRejectReason: 'TARGET_CONVERSATION_ID_OUT_OF_BOUNDS' } : { policyVerdict: 'WOULD_ADMIT' });
  });
  it.each([['model', 80, 'MODEL_OUT_OF_BOUNDS'], ['reasoningEffort', 40, 'REASONING_EFFORT_OUT_OF_BOUNDS']] as const)
    ('checks optional %s against current Protocol bounds', (field, limit, reason) => {
      for (const value of [undefined, null, '', 'x'.repeat(limit), 'x'.repeat(limit + 1)]) {
        const result = shadow.evaluateLegacySendMessagePolicy({ ...policyInput, [field]: value });
        expect(result).toEqual(value != null && value.length > limit
          ? { policyVerdict: 'WOULD_REJECT', policyRejectReason: reason } : { policyVerdict: 'WOULD_ADMIT' });
      }
    });
  it('gives helper semantics precedence over invalid text, target, media and selections', () => {
    expect(shadow.evaluateLegacySendMessagePolicy({ text: '', targetConversationId: null, purpose: 'decision',
      hasMedia: true, model: 'x'.repeat(81), reasoningEffort: 'x'.repeat(41) })).toEqual({
      policyVerdict: 'NOT_EVALUABLE', policyRejectReason: 'LEGACY_DECISION_SEMANTICS_NOT_MAPPED' });
  });

  it('contains an actual policy evaluator exception and preserves the exact frozen HTTP input', async () => {
    const input = Object.freeze(claim());
    vi.spyOn(sendMessagePayloadSchema.shape.text, 'safeParse').mockImplementationOnce(() => { throw new Error('PRIVATE_EVALUATOR_ERROR'); });
    await postClaim(input); expect(decisions()).toEqual([]);
    expect(shadow.shadowV0SnapshotForTests().counters.failures).toBe(1);
    expect(await readDurable(PROTOCOL_STORE_NAME)).toBeNull();
  });
  it.each([false, true])('contains diagnostic accounting exceptions even at full capacity (%s)', async full => {
    if (full) {
      for (let index = 0; index < shadow.SHADOW_V0_MAX_OBSERVATIONS; index++) shadow.observeLegacyBrowserClaim(project(claim()));
    }
    shadow.setShadowV0FaultForTests('s5-accounting');
    const input = Object.freeze(claim()); await postClaim(input);
    expect(decisions()).toHaveLength(full ? 256 : 0);
    expect(decisions().every(fact => fact.classification === 'NOT_COMPARABLE')).toBe(true);
    expect(await readDurable(PROTOCOL_STORE_NAME)).toBeNull();
  });
  it('contains an observation exception even when outer failure accounting also throws', async () => {
    vi.spyOn(shadow, 'observeLegacyBrowserClaim').mockImplementation(() => { throw new Error('observer'); });
    vi.spyOn(shadow, 'noteShadowV0Failure').mockImplementation(() => { throw new Error('accounting'); });
    await postClaim(Object.freeze(claim())); expect(decisions()).toEqual([]);
  });
  it('passes only detached scalars and a media boolean, so observer mutation cannot change input', async () => {
    const input = Object.freeze(claim({ deliveryText: 'PRIVATE_DELIVERY_TEXT' }));
    const observer = vi.spyOn(shadow, 'observeLegacyBrowserClaim').mockImplementation(transient => {
      expect(Object.keys(transient).sort()).toEqual(['legacyInputId', 'text', 'targetConversationId', 'purpose', 'model', 'reasoningEffort', 'hasMedia'].sort());
      (transient as { text: string }).text = 'changed diagnostic copy';
    });
    await postClaim(input); expect(observer).toHaveBeenCalledOnce();
  });
  it('preserves the single shared cap across >256 mixed observations, including pending S2/S3', async () => {
    const input = claim(); shadow.observeLegacyBrowserClaim(project(input)); await confirm(input);
    for (let index = 0; index < 320; index++) {
      shadow.enqueueShadowV0(BOUND_CHAT, [{ kind: 'turn_start', turnId: `turn-${index}`, time: Date.now() }]);
      shadow.observeLegacyBrowserClaim(project(claim()));
      const sample = shadow.shadowV0SnapshotForTests();
      expect(sample.retained + sample.pending).toBeLessThanOrEqual(256);
    }
    await postClaim(claim());
    expect(shadow.shadowV0SnapshotForTests().retained).toBe(256);
    expect(shadow.shadowV0SnapshotForTests().counters.dropped).toBeGreaterThan(0);
    expect(decisions().every(fact => fact.classification === 'NOT_COMPARABLE')).toBe(true);
  });
  it('contains a lost pending S3 fact and never promotes it to agreement', async () => {
    const input = claim(); shadow.observeLegacyBrowserClaim(project(input));
    shadow.enqueueShadowV0(BOUND_CHAT, [{ kind: 'user_message', messageId: 's5-native', text: 'native', time: Date.now() }]);
    await shadow.settleShadowV0ForTests();
    shadow.setShadowV0FaultForTests('processing');
    await shadow.correlateShadowS3([receipt(input)]); await shadow.settleShadowV0ForTests();
    expect(decisions()[0]?.classification).toBe('NOT_COMPARABLE');
  });
  it('retains only allowlisted S5 facts with no payload, media, model, account or auth sentinels', async () => {
    const input = claim({ text: 'PRIVATE_PROMPT_TOKEN sk-private-auth', deliveryText: 'PRIVATE_DELIVERY_TEXT',
      model: 'PRIVATE_MODEL', reasoningEffort: 'PRIVATE_REASONING' as InputEntry['reasoningEffort'],
      images: [{ name: 'PRIVATE_IMAGE_NAME', dataUrl: 'PRIVATE_IMAGE_BYTES' }],
      attachments: [{ id: randomUUID(), name: 'PRIVATE_ATTACHMENT_NAME', mimeType: 'private/type', size: 5, preview: 'PRIVATE_PREVIEW' }] });
    const sensitive = Object.assign(input, { path: 'PRIVATE_PATH', account: 'PRIVATE_ACCOUNT', cookie: 'PRIVATE_COOKIE' });
    await postClaim(sensitive);
    const snapshot = shadow.shadowV0SnapshotForTests();
    expect(Object.keys(snapshot.observations[0]!).sort()).toEqual(['kind', 'legacyInputId', 'policyVerdict', 'policyRejectReason', 'runtimeReadiness', 'claimedAt'].sort());
    expect(JSON.stringify([snapshot, decisions()])).not.toMatch(/PRIVATE_|sk-private-auth|private\/type/);
  });
  it('allocates no Protocol command, outbox, lifecycle or runtime authority', async () => {
    const methods = [vi.spyOn(BrowserTransportService.prototype, 'createCommand'), vi.spyOn(BrowserTransportService.prototype, 'submitCommand'),
      vi.spyOn(BrowserTransportService.prototype, 'isReady'), vi.spyOn(ProtocolStore.prototype, 'persistNewCommand'),
      vi.spyOn(ProtocolStore.prototype, 'updateCommand'), vi.spyOn(FakeTransportAdapter.prototype, 'send')];
    const input = claim(); await postClaim(input); await confirm(input);
    methods.forEach(method => expect(method).not.toHaveBeenCalled());
    expect(await readDurable(PROTOCOL_STORE_NAME)).toBeNull();
    const source = await fs.readFile('src/main/browser-transport/shadow.ts', 'utf8');
    expect(source).not.toMatch(/createCommand|submitCommand|persistNewCommand|updateCommand|adapter\.send|ProtocolCapability|isReady\(/);
    expect(source).not.toMatch(/TERMINAL_PRE_SEND_FAILURE|AGREED_REJECT|LEGACY_REJECTED_PROTOCOL_WOULD_ADMIT|UNSUPPORTED_COMMAND_CLASS/);
  });
  it('resolves a real legacy claim through /input/ack and /events while ACK alone stays provisional', async () => {
    await writeDurableNow('session-input', []); inputModule.resetInputForTests();
    const session = await createSession({ conversationId: BOUND_CHAT });
    inputModule.configureInputDelivery({ changed: () => {}, applyAutomation: async () => {} });
    const row = await inputModule.enqueueInput({ id: randomUUID(), sessionId: session.id, text: 'real S5 send',
      mode: 'auto', dueAt: Date.now(), model: null, reasoningEffort: null });
    const response = await request('/input/claim', { id: row.id, owner: 's5-document', conversationId: BOUND_CHAT });
    expect(response.status).toBe(200); expect(response.body.input.id).toBe(row.id);
    expect(decisions()[0]?.classification).toBe('PROVISIONAL');
    expect(await request('/input/ack', { id: row.id, owner: 's5-document', conversationId: BOUND_CHAT,
      messageId: 's5-native' })).toEqual({ status: 200, body: { ok: true } });
    await shadow.settleShadowV0ForTests(); expect(decisions()[0]?.classification).toBe('PROVISIONAL');
    const events = await request('/events', { conversationId: BOUND_CHAT,
      events: [{ kind: 'user_message', messageId: 's5-native', text: response.body.input.text, time: Date.now() }] });
    expect(events.status).toBe(200); await shadow.settleShadowV0ForTests();
    expect(decisions()[0]).toMatchObject({ legacyInputId: row.id, classification: 'AGREED_ADMIT', legacyOutcome: 'CONFIRMED_SENT' });
    expect(await readDurable(PROTOCOL_STORE_NAME)).toBeNull();
  });
  it('uses media combined by the real claim instead of rereading a text-only root row', async () => {
    const session = await createSession({ conversationId: BOUND_CHAT }), companionId = randomUUID();
    const root = claim({ sessionId: session.id, companionInputId: companionId, requiresAuthorization: true,
      deliveryText: 'Frozen complete root plus companion delivery' });
    const companion = claim({ id: companionId, sessionId: session.id, requiresAuthorization: true,
      images: [{ name: 'companion-only-image', dataUrl: 'data:image/webp;base64,AAAA' }] });
    await writeDurableNow('session-input', [root, companion]); inputModule.resetInputForTests();
    inputModule.configureInputDelivery({ changed: () => {}, applyAutomation: async () => {} });
    const response = await request('/input/claim', { id: root.id, owner: 's5-document',
      conversationId: BOUND_CHAT, requiresAuthorization: true });
    expect(response.status).toBe(200);
    expect(response.body.input.text).toBe(root.deliveryText);
    expect(response.body.input.images).toEqual(companion.images);
    expect(decisions()).toHaveLength(1);
    expect(decisions()[0]).toMatchObject({ legacyInputId: root.id, policyVerdict: 'WOULD_REJECT', policyRejectReason: 'MEDIA_NOT_REPRESENTABLE' });
    await confirm(root, [receipt(root, { companionInputId: companionId }), receipt(root, { legacyInputId: companionId })]);
    expect(decisions()[0]?.classification).toBe('LEGACY_ALLOWED_PROTOCOL_REJECTED');
  });
  it('drops ephemeral S5 facts on reset/restart without replay or command creation', async () => {
    const input = claim(); await postClaim(input); await confirm(input); expect(decisions()).toHaveLength(1);
    shadow.resetShadowV0ForTests(); expect(decisions()).toEqual([]);
    await shadow.correlateShadowS3([receipt(input)]); expect(decisions()).toEqual([]);
    expect(await readDurable(PROTOCOL_STORE_NAME)).toBeNull();
    // Fresh module state models process restart; legacy durable state cannot replay S5 observations.
    vi.resetModules();
    const fresh = await import('../src/main/browser-transport/shadow.js');
    expect(fresh.shadowS5SnapshotForTests()).toEqual([]);
    fresh.resetShadowV0ForTests();
  });
  it('evaluates real frozen prepared claim text and leaves durable legacy state identical under S5 faults', async () => {
    await writeDurableNow('session-input', []); inputModule.resetInputForTests();
    const session = await createSession({ conversationId: BOUND_CHAT });
    const frozenText = 'Exact prepared delivery, including setup and authored task';
    inputModule.configureInputDelivery({ prepareText: () => frozenText, changed: () => {}, applyAutomation: async () => {} });
    const row = await inputModule.enqueueInput({ id: randomUUID(), sessionId: session.id, text: 'authored task',
      mode: 'auto', dueAt: Date.now(), model: null, reasoningEffort: null });
    const body = { id: row.id, owner: 's5-document', conversationId: BOUND_CHAT, requiresAuthorization: true };
    delete process.env[SWITCH];
    const baseline = await request('/input/claim', body); expect(baseline.status).toBe(200);
    expect(baseline.body.input.text).toBe(frozenText);
    const durable = await readDurable('session-input');
    const queueRead = vi.spyOn(inputModule, 'listInputs');
    const evaluator = vi.spyOn(sendMessagePayloadSchema.shape.text, 'safeParse');
    process.env[SWITCH] = '1';
    const observed = await request('/input/claim', body); expect(observed).toEqual(baseline);
    expect(evaluator).toHaveBeenCalledWith(frozenText); expect(queueRead).not.toHaveBeenCalled();
    for (const fault of ['s5-evaluator', 's5-accounting'] as const) {
      shadow.resetShadowV0ForTests(); shadow.setShadowV0FaultForTests(fault);
      expect(await request('/input/claim', body)).toEqual(baseline);
      expect(await readDurable('session-input')).toEqual(durable);
      expect(await readDurable(PROTOCOL_STORE_NAME)).toBeNull();
    }
  });
});
