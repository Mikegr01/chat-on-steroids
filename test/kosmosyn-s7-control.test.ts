import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
vi.mock('electron', () => ({ app: { on: vi.fn(), getPath: () => '', getVersion: () => '0.0.0', getAppPath: () => process.cwd(), isPackaged: false }, BrowserWindow: class {} }));
import { defaultConfig, getConfig, initConfigPath, loadConfig, getKosmosynS7State, initializeKosmosynS7, setKosmosynS7Enabled, updateConfig } from '../src/main/config.js';
import { initDurableStore, resetDurableForTests, readStrictDurable, writeStrictDurableNow } from '../src/main/durable.js';
import { s7Authority, S7_LEDGER, S7_MAX_BYTES } from '../src/main/browser-transport/s7-authority.js';
import { pendingCommands } from '../src/main/bridge.js';
import * as wake from '../src/main/browser-wake.js';

let directory: string;
const off = { enabled: false, initialized: false }, initialized = { enabled: false, initialized: true };
const empty = { version: 1, records: [] };
const ledger = () => path.join(directory, 'state', `${S7_LEDGER}.json`);
const custody = () => readStrictDurable(S7_LEDGER, S7_MAX_BYTES);
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 's7-control-'));
  initConfigPath(directory); initDurableStore(directory);
  await loadConfig(); await s7Authority.recover();
});
afterEach(async () => {
  vi.restoreAllMocks(); resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

it('creates exactly one empty generation through real authority, persists initialization OFF and is idempotent', async () => {
  const authority = vi.spyOn(s7Authority, 'initialize'), rename = vi.spyOn(fs, 'rename');
  expect(await getKosmosynS7State()).toEqual(off);
  expect(await initializeKosmosynS7()).toEqual(initialized);
  expect(authority).toHaveBeenCalledOnce();
  expect(await custody()).toEqual({ kind: 'valid', value: empty });
  expect(JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8')).kosmosynS7).toEqual(initialized);
  const writes = rename.mock.calls.length;
  expect(rename.mock.calls.filter(([, to]) => String(to) === ledger())).toHaveLength(1);
  expect(await initializeKosmosynS7()).toEqual(initialized);
  expect(rename.mock.calls).toHaveLength(writes);
  await setKosmosynS7Enabled(true);
  const enabledWrites = rename.mock.calls.length;
  expect(await initializeKosmosynS7()).toEqual({ enabled: true, initialized: true });
  expect(rename.mock.calls).toHaveLength(enabledWrites);
});

it('accepts the existing empty interrupted generation without rewriting it', async () => {
  await writeStrictDurableNow(S7_LEDGER, empty, S7_MAX_BYTES);
  const bytes = await fs.readFile(ledger()), rename = vi.spyOn(fs, 'rename');
  expect(await initializeKosmosynS7()).toEqual(initialized);
  expect(await fs.readFile(ledger())).toEqual(bytes);
  expect(rename.mock.calls.filter(([, to]) => String(to) === ledger())).toHaveLength(0);
});

it('config failure leaves published gate OFF/uninitialized and retry retains the first ledger generation', async () => {
  const original = fs.rename.bind(fs);
  const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === path.join(directory, 'config.json')) throw new Error('fixture config write failed');
    await original(from, to);
  });
  await expect(initializeKosmosynS7()).rejects.toThrow('fixture config write failed');
  expect(await getKosmosynS7State()).toEqual(off);
  expect(await custody()).toEqual({ kind: 'valid', value: empty });
  const bytes = await fs.readFile(ledger()); rename.mockRestore();
  const retry = vi.spyOn(fs, 'rename');
  expect(await initializeKosmosynS7()).toEqual(initialized);
  expect(await fs.readFile(ledger())).toEqual(bytes);
  expect(retry.mock.calls.filter(([, to]) => String(to) === ledger())).toHaveLength(0);
});

function terminalLedger() {
  const inputId = randomUUID(), target = randomUUID();
  const base = { inputId, sessionId: randomUUID(), commandId: `cmd_s7_${inputId}`, idempotencyKey: `s7_send:${inputId}`,
    targetConversationId: target, state: 'COMPLETED', authoredHash: createHash('sha256').update('retired').digest('hex'),
    election: { commandId: `cmd_s7_${inputId}`, targetConversationId: target, tabId: 7, documentId: 'document_original',
      navigationEpoch: 3, connectionEpoch: 'connection_original', backgroundEmitterEpoch: 'background_original' },
    published: true, createdAt: 1, expiresAt: 2, nativeMessageId: 'native_retained', proofLevel: 'STRONG_COMMIT', committedAt: 1 };
  const canceledId = randomUUID();
  const { nativeMessageId: _native, proofLevel: _proof, committedAt: _time, ...canceled } = base;
  return { version: 1, records: [base, { ...canceled, inputId: canceledId, commandId: `cmd_s7_${canceledId}`,
    idempotencyKey: `s7_send:${canceledId}`, state: 'CANCELED', election: { ...base.election, commandId: `cmd_s7_${canceledId}` } }] };
}

it('rejects non-empty uninitialized custody without adoption, truncation or config publication', async () => {
  await writeStrictDurableNow(S7_LEDGER, terminalLedger(), S7_MAX_BYTES);
  const bytes = await fs.readFile(ledger());
  await expect(initializeKosmosynS7()).rejects.toThrow('S7 uninitialized ledger is not empty');
  expect(await getKosmosynS7State()).toEqual(off);
  expect(await fs.readFile(ledger())).toEqual(bytes);
});

it.each(['malformed', 'schema-invalid', 'unreadable', 'unavailable'] as const)('rejects %s initialization without writing', async kind => {
  await fs.mkdir(path.dirname(ledger()), { recursive: true });
  await fs.writeFile(ledger(), kind === 'schema-invalid' ? '{"version":1,"records":"broken"}' : '{broken');
  const bytes = await fs.readFile(ledger());
  if (kind === 'unavailable') resetDurableForTests();
  if (kind === 'unreadable') vi.spyOn(fs, 'open').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
  const rename = vi.spyOn(fs, 'rename');
  await expect(initializeKosmosynS7()).rejects.toThrow('S7 ledger unavailable');
  expect(await getKosmosynS7State()).toEqual(off);
  expect(await fs.readFile(ledger())).toEqual(bytes);
  expect(rename).not.toHaveBeenCalled();
});

it('rejects enable before initialization and malformed direct control values', async () => {
  await expect(setKosmosynS7Enabled(true)).rejects.toThrow('Initialize');
  await expect(setKosmosynS7Enabled('true' as any)).rejects.toThrow('Invalid S7');
  expect(await getKosmosynS7State()).toEqual(off);
  expect(await custody()).toEqual({ kind: 'absent' });
});

it.each(['absent', 'malformed', 'schema-invalid', 'unreadable', 'unavailable', 'inconsistent'] as const)('rejects enable with %s initialized custody and stays OFF', async kind => {
  await initializeKosmosynS7();
  if (kind === 'absent') await fs.unlink(ledger());
  if (kind === 'malformed') await fs.writeFile(ledger(), '{broken');
  if (kind === 'schema-invalid') await fs.writeFile(ledger(), '{"version":1,"records":false}');
  if (kind === 'inconsistent') await writeStrictDurableNow(S7_LEDGER, terminalLedger(), S7_MAX_BYTES);
  if (kind === 'unavailable') resetDurableForTests();
  if (kind === 'unreadable') vi.spyOn(fs, 'open').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
  const rename = vi.spyOn(fs, 'rename');
  await expect(setKosmosynS7Enabled(true)).rejects.toThrow('S7 initialized ledger unavailable');
  expect(await getKosmosynS7State()).toEqual(initialized);
  expect(rename).not.toHaveBeenCalled();
});

it('failed enable config write leaves OFF and can be retried', async () => {
  await initializeKosmosynS7();
  const bytes = await fs.readFile(ledger());
  const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('fixture config write failed'));
  await expect(setKosmosynS7Enabled(true)).rejects.toThrow('fixture config write failed'); rename.mockRestore();
  expect(await getKosmosynS7State()).toEqual(initialized);
  expect(await fs.readFile(ledger())).toEqual(bytes);
  expect(await setKosmosynS7Enabled(true)).toEqual({ enabled: true, initialized: true });
});

it('disable and repeated initialization preserve completed and canceled tombstone bytes', async () => {
  await initializeKosmosynS7();
  await writeStrictDurableNow(S7_LEDGER, terminalLedger(), S7_MAX_BYTES); await s7Authority.recover();
  await setKosmosynS7Enabled(true);
  const bytes = await fs.readFile(ledger());
  expect(await initializeKosmosynS7()).toEqual({ enabled: true, initialized: true });
  expect(await setKosmosynS7Enabled(false)).toEqual(initialized);
  expect(await fs.readFile(ledger())).toEqual(bytes);
  expect(s7Authority.records().map(row => row.state)).toEqual(['COMPLETED', 'CANCELED']);
  await expect(updateConfig(latest => ({ ...latest, kosmosynS7: off }))).rejects.toThrow('cannot be reset');
});

it('OFF remains possible with unreadable custody, retaining initialized and all bytes', async () => {
  await initializeKosmosynS7(); await setKosmosynS7Enabled(true);
  await fs.writeFile(ledger(), '{broken retained custody');
  const bytes = await fs.readFile(ledger());
  const open = vi.spyOn(fs, 'open').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
  expect(await setKosmosynS7Enabled(false)).toEqual(initialized);
  expect(open).not.toHaveBeenCalled();
  expect(await fs.readFile(ledger())).toEqual(bytes);
});

it('concurrent controls serialize with normal config edits and create no browser commands or wakes', async () => {
  const commands = pendingCommands(), browserWake = vi.spyOn(wake, 'wakeBrowserWork');
  await Promise.all([initializeKosmosynS7(), initializeKosmosynS7(), updateConfig(latest => ({ ...latest, readOnly: true }))]);
  expect(getConfig().readOnly).toBe(true);
  const states = await Promise.all([setKosmosynS7Enabled(true), setKosmosynS7Enabled(false), getKosmosynS7State()]);
  expect(states).toEqual([{ initialized: true, enabled: true }, initialized, initialized]);
  expect(browserWake).not.toHaveBeenCalled(); expect(pendingCommands()).toEqual(commands);
});

it('an old profile has safe OFF defaults and startup recovery never initializes or enables it', async () => {
  const { kosmosynS7: _omitted, ...old } = defaultConfig();
  await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify(old)); await loadConfig(); await s7Authority.recover();
  expect(await getKosmosynS7State()).toEqual(off);
  expect(await custody()).toEqual({ kind: 'absent' });
});

it('queued initialization releases authority before config persistence and later enable/disable do not deadlock', async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const holding = s7Authority.withSettings(async () => { entered(); await held; }); await ready;
  const initializing = initializeKosmosynS7(), enabling = setKosmosynS7Enabled(true), disabling = setKosmosynS7Enabled(false);
  release(); await holding;
  expect(await initializing).toEqual(initialized);
  expect(await enabling).toEqual({ enabled: true, initialized: true });
  expect(await disabling).toEqual(initialized);
});
