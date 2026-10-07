import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
vi.mock('electron', () => ({ app: { on: vi.fn(), getPath: () => '', getVersion: () => '0.0.0', getAppPath: () => process.cwd(), isPackaged: false },
  BrowserWindow: class {}, safeStorage: { isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (text: string) => Buffer.from(text), decryptStringAsync: async (data: Buffer) => ({ result: data.toString(), shouldReEncrypt: false }) } }));
vi.mock('../src/main/extension-path.js', () => ({ extensionDir: () => process.cwd(), shippedExtensionBuild: () => null, extensionUpdateOffer: () => null, prepareExtensionUpdate: () => null }));
vi.mock('../src/main/connection.js', async original => {
  const actual = await original<typeof import('../src/main/connection.js')>();
  return { ...actual, connect: async () => {}, getStatus: () => ({ ...actual.getStatus(), state: 'connected' }) };
});
vi.mock('../src/main/browser.js', () => ({ openInPreferredBrowser: async () => 'fixture', isPreferredBrowserRunning: async () => null }));
import { defaultConfig, initConfigPath, loadConfig, saveConfig, getConfig, updateConfig, initializeKosmosynS7, setKosmosynS7Enabled } from '../src/main/config.js';
import { initSecretsPath } from '../src/main/secrets.js';
import { initDurableStore, resetDurableForTests, flushDurable, readStrictDurable, writeStrictDurableNow } from '../src/main/durable.js';
import { createSession, initSessionStore, resetSessionStoreForTests, rebindSession } from '../src/main/session/store.js';
import { s7Authority, S7_LEDGER, S7_MAX_BYTES } from '../src/main/browser-transport/s7-authority.js';
import * as input from '../src/main/session/input.js';
import { bridgePort, startBridge, stopBridge } from '../src/main/bridge.js';
import { APP_VERSION, BRIDGE_PROTOCOL } from '../src/main/version.js';
let directory: string, bearer = '';
const history = vi.fn(async () => false), changed = vi.fn();
async function post(route: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${bridgePort()}${route}`, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-extension-version': APP_VERSION, 'x-extension-protocol': String(BRIDGE_PROTOCOL),
    ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 's7-real-claim-')); bearer = '';
  initConfigPath(directory); initSecretsPath(directory); initDurableStore(directory); initSessionStore(directory);
  await loadConfig(); await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, finishTool: false, autoContinue: false }, goal: { ...defaultConfig().goal, enabled: false } });
  input.resetInputForTests(); history.mockClear(); changed.mockClear();
  input.configureInputDelivery({ changed, recordDelivered: history, applyAutomation: async () => {} });
  await startBridge(); const paired = await post('/pair', {}); expect(paired.status).toBe(200); bearer = paired.body.token;
});
afterEach(async () => {
  vi.restoreAllMocks(); await stopBridge(); await flushDurable(); input.resetInputForTests();
  resetDurableForTests(); resetSessionStoreForTests(); await fs.rm(directory, { recursive: true, force: true });
});
async function enabled() {
  await initializeKosmosynS7();
  await setKosmosynS7Enabled(true);
}
async function offer() {
  const conversationId = randomUUID(); const session = await createSession({ title: 'S7 fixture', conversationId, origin: { kind: 'desktop', fromSessionId: null, agentId: null, task: '' } });
  const row = await input.enqueueInput({ id: randomUUID(), sessionId: session.id, text: 'Exact private authored text', mode: 'auto', dueAt: 0,
    model: null, reasoningEffort: null, provenance: { kind: 'ordinary-composer', orchestratorRequested: false, modelChoice: 'current' } });
  const welcome = await post('/s7/hello', { emitterEpoch: 'background_original', hello: { type: 'HELLO', protocolVersion: 1,
    extensionVersion: APP_VERSION, connectionGeneration: 0, capabilities: ['SEND_MESSAGE'] } });
  const election = { commandId: `cmd_s7_${row.id}`, targetConversationId: conversationId, tabId: 7, documentId: 'document_original',
    navigationEpoch: 3, connectionEpoch: welcome.body.connectionEpoch, backgroundEmitterEpoch: 'background_original' };
  if (welcome.status === 200) expect((await post('/s7/ready', { emitterEpoch: election.backgroundEmitterEpoch, ready: { type: 'READY',
    connectionGeneration: 0, connectionEpoch: election.connectionEpoch, activeSessions: [], boundTabsCount: 1 } })).status).toBe(200);
  const claim = () => post('/input/claim', { id: row.id, owner: 'original_owner', conversationId, requiresAuthorization: true,
    s7Preflight: { election, uniqueDocuments: 1 } });
  return { row, session, election, conversationId, claim };
}
async function event(f: Awaited<ReturnType<typeof offer>>, type: string, sequence: number, sourceProof?: unknown) {
  const payload = type === 'COMMAND_CLAIMED' ? { clientDocumentId: f.election.documentId, tabId: 7, claimedAt: Date.now() }
    : type === 'MESSAGE_COMMITTED' ? { proofLevel: 'STRONG_COMMIT', nativeMessageId: 'native_new', conversationId: f.conversationId,
      candidateCount: 1, matchedText: f.row.text } : {};
  return post('/s7/action', { action: 'event', election: f.election, sourceProof, event: { protocolVersion: 1, eventId: `evt_${randomUUID()}`,
    commandId: f.election.commandId, eventType: type, source: 'content-script', sessionId: f.session.id, conversationId: f.conversationId,
    generation: 0, connectionEpoch: f.election.connectionEpoch, emitterEpoch: f.election.documentId, sequence, occurredAt: Date.now(), payload } });
}
it('OFF preserves the actual first-claim legacy response and no S7 custody', async () => {
  const f = await offer(); const result = await f.claim(); expect(result.body.input.id).toBe(f.row.id);
  expect(result.body.s7).toBeUndefined(); expect(s7Authority.blocks(f.row)).toBe(false);
});
it('production initialization alone keeps ordinary admission on legacy without S7 custody', async () => {
  expect(await initializeKosmosynS7()).toEqual({ enabled: false, initialized: true });
  const f = await offer(); const result = await f.claim();
  expect(result.body.input.id).toBe(f.row.id); expect(result.body.s7).toBeUndefined();
  expect(s7Authority.records()).toEqual([]);
});
it('initialization must durably precede enabling, and schema rejects malformed provenance', async () => {
  await expect(saveConfig({ ...getConfig(), kosmosynS7: { enabled: true, initialized: true } })).rejects.toThrow('Initialize');
  expect(getConfig().kosmosynS7).toEqual({ enabled: false, initialized: false });
  expect(input.inputArgs.safeParse({ id: randomUUID(), sessionId: null, text: 'test', mode: 'auto', dueAt: 0,
    model: null, reasoningEffort: null, provenance: { kind: 'ordinary-composer', orchestratorRequested: 'false', modelChoice: 'current' } }).success).toBe(false);
});
it('same first HTTP claim returns only typed S7 handoff and no second wake', async () => {
  await enabled(); const f = await offer(); const wake = vi.spyOn(await import('../src/main/browser-wake.js'), 'wakeBrowserWork');
  wake.mockClear(); const result = await f.claim(); expect(result.body.input).toBeNull();
  expect(result.body.s7.election).toEqual(f.election); expect(wake).not.toHaveBeenCalled();
  expect(s7Authority.blocks(f.row)).toBe(true); expect((await f.claim()).body).toEqual({ input: null });
  expect(await input.authorizeBrowserInput(f.row.id, 'original_owner', f.conversationId)).toBe(false);
  expect(await input.editQueuedInput(f.row.id, 'changed')).toBe(false); expect(await input.cancelInput(f.row.id)).toBe(false);
});
it('failed input projection cannot grant legacy claim/authorization/tool/edit/cancel after disabling', async () => {
  await enabled(); const f = await offer(); const rename = fs.rename.bind(fs);
  const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith('session-input.json')) throw new Error('fixture projection rejected'); await rename(from, to);
  });
  const result = await f.claim(); expect(result.body.s7.command.commandId).toBe(`cmd_s7_${f.row.id}`); spy.mockRestore();
  await updateConfig(latest => ({ ...latest, kosmosynS7: { enabled: false, initialized: true } }));
  const wake = vi.spyOn(await import('../src/main/browser-wake.js'), 'wakeBrowserWork'); wake.mockClear();
  expect((await input.noteInputStartupError(f.row.id, 'Must not rewrite Protocol custody'))?.error).toBeUndefined();
  expect(wake).not.toHaveBeenCalled();
  expect((await f.claim()).body.input).toBeNull(); expect(await input.authorizeBrowserInput(f.row.id, 'original_owner', f.conversationId)).toBe(false);
  expect(await input.editQueuedInput(f.row.id, 'changed')).toBe(false); expect(await input.cancelInput(f.row.id)).toBe(false);
  expect(await input.hasEligibleToolInput(f.session.id)).toBe(false);
});
it('canonical receipt persists before history, reconciles lost projection, and restart never replays', async () => {
  await enabled(); const f = await offer(); await f.claim();
  expect((await post('/s7/action', { action: 'claim', election: f.election })).body.ok).toBe(true);
  expect((await event(f, 'MESSAGE_SUBMIT_STARTED', 1, { beforeNativeIds: [] })).body.accepted).toBe(false);
  expect((await event(f, 'COMMAND_CLAIMED', 1)).body.accepted).toBe(true);
  expect((await event(f, 'MESSAGE_SUBMIT_STARTED', 2, { beforeNativeIds: [] })).body.accepted).toBe(true);
  expect(history).not.toHaveBeenCalled();
  history.mockImplementationOnce(async () => { expect(s7Authority.records().find(r => r.inputId === f.row.id)?.state).toBe('COMMITTED'); return true; });
  const sourceProof = { canonical: true, candidateCount: 1, attachmentCount: 0, conversationId: f.conversationId, sourceText: f.row.text, nativeMessageId: 'native_new' };
  expect((await event(f, 'MESSAGE_COMMITTED', 3, sourceProof)).body.accepted).toBe(true);
  expect((await input.listInputs()).find(row => row.id === f.row.id)).toMatchObject({ state: 'sent', messageId: 'native_new', historyRecorded: true });
  await stopBridge(); await startBridge(); expect((await f.claim()).body.input).toBeNull();
  expect(JSON.stringify(s7Authority.records())).not.toContain(f.row.text);
});
it('session rebind after selection rejects the final mutation fence', async () => {
  await enabled(); const f = await offer(); await f.claim();
  expect((await post('/s7/action', { action: 'claim', election: f.election })).body.ok).toBe(true);
  await event(f, 'COMMAND_CLAIMED', 1); await event(f, 'MESSAGE_SUBMIT_STARTED', 2, { beforeNativeIds: [] });
  await rebindSession(f.session.id, f.conversationId, randomUUID());
  expect((await post('/s7/action', { action: 'verify', election: f.election })).status).toBe(409);
});
it('strict reader distinguishes unavailable/absent/malformed/unreadable and failed generations never retry', async () => {
  resetDurableForTests(); expect(await readStrictDurable(S7_LEDGER, S7_MAX_BYTES)).toEqual({ kind: 'unavailable' });
  initDurableStore(directory); expect(await readStrictDurable(S7_LEDGER, S7_MAX_BYTES)).toEqual({ kind: 'absent' });
  const ledgerPath = path.join(directory, 'state', `${S7_LEDGER}.json`); await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.writeFile(ledgerPath, '{broken'); expect(await readStrictDurable(S7_LEDGER, S7_MAX_BYTES)).toEqual({ kind: 'malformed' });
  const spy = vi.spyOn(fs, 'open').mockRejectedValueOnce(Object.assign(new Error('fixture denied'), { code: 'EACCES' }));
  expect(await readStrictDurable(S7_LEDGER, S7_MAX_BYTES)).toEqual({ kind: 'unreadable' }); spy.mockRestore();
  await writeStrictDurableNow(S7_LEDGER, { version: 1, records: [] }, S7_MAX_BYTES);
  const failure = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('fixture rejected generation'));
  await expect(writeStrictDurableNow(S7_LEDGER, { rejected: 'private newer generation' }, S7_MAX_BYTES)).rejects.toThrow(); failure.mockRestore();
  await flushDurable(); expect(await readStrictDurable(S7_LEDGER, S7_MAX_BYTES)).toEqual({ kind: 'valid', value: { version: 1, records: [] } });
});
it('reservation precedes the input queue and a disabling callback cannot reverse queue order', async () => {
  await enabled(); const f = await offer();
  const otherTarget = randomUUID(), otherSession = await createSession({ title: 'Independent legacy', conversationId: otherTarget });
  const other = await input.enqueueInput({ id: randomUUID(), sessionId: otherSession.id, text: 'Independent ordinary legacy', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
  let release!: () => void, enter!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { enter = resolve; });
  input.configureInputDelivery({ changed, recordDelivered: history, applyAutomation: async () => {}, prepareText: async entry => {
    if (entry.id === other.id) { enter(); await blocked; } return entry.text;
  } });
  const first = input.claimBrowserInput(other.id, 'independent', otherTarget, true); await entered;
  const selected = input.claimBrowserInput(f.row.id, 'original_owner', f.conversationId, true, {
    election: f.election, ready: true, uniqueDocuments: 1, conflict: false, current: () => true });
  expect(s7Authority.targetHeld(f.conversationId)).toBe(true);
  let callbackStarted!: () => void;
  const callback = new Promise<void>(resolve => { callbackStarted = resolve; });
  const disabling = updateConfig(latest => ({ ...latest, kosmosynS7: { enabled: false, initialized: true } }), async () => {
    callbackStarted(); await input.listInputs();
  });
  await callback; release(); expect(await first).not.toBeNull(); const result = await selected;
  expect(result && 'kind' in result).toBe(false); await disabling;
  expect(s7Authority.records()).toEqual([]); expect(s7Authority.targetHeld(f.conversationId)).toBe(false);
});
it('initialized missing ledger blocks ordinary legacy UUIDs even when disabled', async () => {
  await enabled(); const f = await offer();
  await updateConfig(latest => ({ ...latest, kosmosynS7: { enabled: false, initialized: true } }));
  await fs.unlink(path.join(directory, 'state', `${S7_LEDGER}.json`)); await s7Authority.recover();
  expect((await f.claim()).body.input).toBeNull(); expect(await input.pendingBrowserInputs()).toEqual([]);
  await expect(s7Authority.initialize()).rejects.toThrow('unavailable');
});
it('fresh, older and malformed configuration remain OFF without an environment shortcut', async () => {
  expect(defaultConfig().kosmosynS7).toEqual({ enabled: false, initialized: false });
  for (const value of [undefined, null, true, { enabled: 'true', initialized: true }, { enabled: true, initialized: false }, { enabled: true, initialized: false, extra: 1 }]) {
    const config = { ...defaultConfig(), kosmosynS7: value }; await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify(config));
    expect((await loadConfig()).kosmosynS7).toEqual({ enabled: false, initialized: false });
  }
});
it('failed receipt projection retains strong commit and startup repairs the same receipt without a wake', async () => {
  await enabled(); const f = await offer(); await f.claim();
  await post('/s7/action', { action: 'claim', election: f.election }); await event(f, 'COMMAND_CLAIMED', 1);
  await event(f, 'MESSAGE_SUBMIT_STARTED', 2, { beforeNativeIds: [] });
  const rename = fs.rename.bind(fs);
  const failure = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith('session-input.json')) throw new Error('fixture receipt projection'); await rename(from, to);
  });
  expect((await event(f, 'MESSAGE_COMMITTED', 3, { canonical: true, candidateCount: 1, attachmentCount: 0,
    conversationId: f.conversationId, sourceText: f.row.text, nativeMessageId: 'native_new' })).body.accepted).toBe(true);
  expect(s7Authority.records().find(r => r.inputId === f.row.id)?.state).toBe('COMMITTED'); failure.mockRestore();
  await stopBridge(); await startBridge();
  expect((await input.listInputs()).find(r => r.id === f.row.id)).toMatchObject({ state: 'sent', messageId: 'native_new' });
  expect((await f.claim()).body.input).toBeNull();
});
it('readiness expiring while the input claim waits cannot select durable authority', async () => {
  await enabled(); const f = await offer();
  let release!: () => void, enter!: () => void, selectEntered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const selecting = new Promise<void>(resolve => { selectEntered = resolve; });
  const serviceWork = s7Authority.withSettings(async () => { enter(); await blocked; }); await entered;
  const select = s7Authority.select.bind(s7Authority);
  const spy = vi.spyOn(s7Authority, 'select').mockImplementation((...args) => { selectEntered(); return select(...args); });
  const claim = f.claim(); await selecting;
  const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 6000);
  release(); await serviceWork;
  try {
    expect((await claim).body).toEqual({ input: null });
    expect(s7Authority.records()).toEqual([]);
  } finally { clock.mockRestore(); spy.mockRestore(); }
});
