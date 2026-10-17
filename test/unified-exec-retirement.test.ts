import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { unifiedExecManager as manager } from '../src/main/codex/manager.js';
import { admitExecOwner, execOwner, resetExecOwnershipForTests } from '../src/main/codex/ownership.js';
import { createSession, deleteSession, getSession, initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { makeTempDir, removeTempDir } from './helpers.js';

// Control only native process events. The manager, interrupt and tree helper are real.
const native = vi.hoisted(() => ({ launch: vi.fn(), kill: vi.fn() }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    if (args[0] === '__controlled_pipe__') return native.launch();
    if (/[\\/]taskkill\.exe$/i.test(args[0])) return native.kill();
    return actual.spawn(...args);
  } };
});

function barrier<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const policy = { kind: 'tokens' as const, tokens: 1000 };
let root: string;

beforeEach(async () => {
  root = await makeTempDir('cos-pipe-retirement-');
  initSessionStore(root);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  resetExecOwnershipForTests();
  native.launch.mockReset();
  native.kill.mockReset();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  native.kill.mockImplementation(() => {
    const killer = Object.assign(new EventEmitter(), { kill: vi.fn() });
    queueMicrotask(() => killer.emit('close', 0));
    return killer;
  });
  await manager.terminateAllProcesses();
  resetExecOwnershipForTests();
  resetSessionStoreForTests();
  await removeTempDir(root);
});

async function pendingInitialExec(options: { earlyExit?: boolean; owner?: string } = {}) {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242, stdout: new PassThrough(), stderr: new PassThrough()
  });
  const killer = Object.assign(new EventEmitter(), { kill: vi.fn() });
  const interruptEntered = barrier();
  native.launch.mockReturnValue(child);
  native.kill.mockImplementation(() => { interruptEntered.resolve(); return killer; });
  const id = manager.allocateProcessId();
  const owner = options.owner ?? `controlled-pipe-${id}`;
  const initial = manager.execCommand({ processId: id, command: ['__controlled_pipe__'],
    shellType: 'powershell', hookCommand: 'controlled pipe retirement', cwd: process.cwd(),
    displayCwd: process.cwd(), env: process.env, tty: false, yieldTimeMs: 30_000,
    maxOutputTokens: undefined, truncationPolicy: policy, admit: () => admitExecOwner(id, owner) });
  let initialSettled = false;
  const initialOutcome = initial.then(value => { initialSettled = true; return { value }; },
    error => { initialSettled = true; return { error }; });
  const entry = (manager as any).processes.get(id);
  const collecting = barrier();
  const notified = entry.process.outputNotify.notified.bind(entry.process.outputNotify);
  vi.spyOn(entry.process.outputNotify, 'notified').mockImplementation(() => {
    collecting.resolve();
    return notified();
  });
  // Advance only the existing early-exit grace. All race ordering below uses barriers.
  if (!options.earlyExit) {
    await vi.advanceTimersByTimeAsync(150);
    await collecting.promise;
  }
  const retirementRead = barrier();
  let observePublication = false;
  let retirement: Promise<void> | undefined;
  Object.defineProperty(entry, 'retirement', { configurable: true,
    get: () => { if (observePublication) retirementRead.resolve(); return retirement; },
    set: (value: Promise<void>) => { retirement = value; } });
  const refresh = vi.spyOn(manager as any, 'refreshProcessState');
  const interrupt = () => manager.writeStdin({ processId: id, input: '\x03', yieldTimeMs: 10_000,
    maxOutputTokens: undefined, truncationPolicy: policy });
  const exit = () => {
    observePublication = true;
    child.emit('exit', 0, null); child.stdout.end(); child.stderr.end();
  };
  const publicationWaiting = async () => {
    await retirementRead.promise;
    await setImmediate(); // Drain ready continuations; no elapsed-time synchronization.
    expect(initialSettled).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    expect(entry.retirementPending).toBe(true);
    expect(manager.listProcesses()).toContainEqual(expect.objectContaining({ processId: id, retirementPending: true }));
    expect(execOwner(id)).toBe(owner);
  };
  return { id, owner, entry, killer, interruptEntered, retirementRead, initialOutcome, refresh, interrupt, exit, publicationWaiting };
}

it.runIf(process.platform === 'win32')('CASE 1: initial exec waits for successful pipe Ctrl-C retirement before publication', async () => {
  const h = await pendingInitialExec();
  const writeOutcome = h.interrupt().then(value => ({ value }), error => ({ error }));
  await h.interruptEntered.promise;
  expect(h.entry.retirementPending).toBe(true);
  h.exit(); // Leader/streams exit while taskkill still has no outcome.
  await h.publicationWaiting();
  const refreshedDuringRetirement = h.refresh.mock.calls.length;
  h.killer.emit('close', 0);
  const write = await writeOutcome;
  const initial = await h.initialOutcome;
  expect(write).toMatchObject({ value: { processId: null } });
  expect(initial).toMatchObject({ value: { processId: null } });
  expect(refreshedDuringRetirement).toBe(0);
  expect(execOwner(h.id)).toBe(h.owner); // Retained completed output still belongs to its owner.
});

it.runIf(process.platform === 'win32')('CASE 2: failed pipe Ctrl-C rejects both callers and retains row and custody', async () => {
  const h = await pendingInitialExec();
  const writeOutcome = h.interrupt().then(value => ({ value }), error => ({ error }));
  await h.interruptEntered.promise;
  h.exit();
  await h.publicationWaiting();
  h.killer.emit('close', 1);
  const write = await writeOutcome;
  const initial = await h.initialOutcome;
  expect(write).toMatchObject({ error: { kind: 'process_failed', message: expect.stringContaining('retirement unresolved; custody retained') } });
  expect(initial).toMatchObject({ error: { kind: 'process_failed' } });
  expect('error' in initial && initial.error).toBe('error' in write && write.error);
  expect(h.entry.retirementPending).toBe(true);
  expect(manager.listProcesses()).toContainEqual(expect.objectContaining({ processId: h.id, retirementPending: true }));
  manager.releaseProcessId(h.id);
  expect(execOwner(h.id)).toBe(h.owner);
  expect(await manager.offerCompletedOutput(new Set([h.id]), { completedAt: null, failed: false }, 1024)).toBeNull();
  await expect(manager.writeStdin({ processId: h.id, input: '', yieldTimeMs: 1,
    maxOutputTokens: undefined, truncationPolicy: policy })).rejects.toThrow('retirement unresolved');
  expect(h.refresh).not.toHaveBeenCalled();
});

it.runIf(process.platform === 'win32').each([true, false])('CASE 3: terminateProcess joins pipe retirement (success=%s)', async success => {
  const h = await pendingInitialExec();
  const write = h.interrupt().then(value => ({ value }), error => ({ error }));
  await h.interruptEntered.promise;
  const shared = h.entry.retirement;
  const terminate = manager.terminateProcess(h.id).then(value => ({ value }), error => ({ error }));
  expect(h.entry.retirement).toBe(shared);
  h.exit();
  await h.publicationWaiting();
  expect(native.kill).toHaveBeenCalledOnce();
  h.killer.emit('close', success ? 0 : 1);
  if (success) {
    expect(await write).toMatchObject({ value: { processId: null } });
    expect(await h.initialOutcome).toMatchObject({ value: { processId: null } });
    expect(await terminate).toEqual({ value: true });
  } else {
    const first = await write;
    expect(first).toHaveProperty('error');
    expect(await terminate).toEqual(first);
    expect(await h.initialOutcome).toEqual(first);
    expect(execOwner(h.id)).toBe(h.owner);
  }
  expect(native.kill).toHaveBeenCalledOnce();
});

it.runIf(process.platform === 'win32')('CASE 4: a second Ctrl-C cannot start another retirement while the first is unresolved', async () => {
  const h = await pendingInitialExec();
  const first = h.interrupt();
  await h.interruptEntered.promise;
  const shared = h.entry.retirement;
  await expect(h.interrupt()).rejects.toThrow('retirement unresolved; custody retained');
  expect(h.entry.retirement).toBe(shared);
  expect(native.kill).toHaveBeenCalledOnce();
  h.exit();
  await h.publicationWaiting();
  h.killer.emit('close', 0);
  expect(await first).toMatchObject({ processId: null });
  expect(await h.initialOutcome).toMatchObject({ value: { processId: null } });
});

it.runIf(process.platform === 'win32').each([true, false])('CASE 5: natural leader exit during early grace cannot publish unresolved retirement (success=%s)', async success => {
  const h = await pendingInitialExec({ earlyExit: true });
  const write = h.interrupt().then(value => ({ value }), error => ({ error }));
  await h.interruptEntered.promise;
  h.exit();
  await h.publicationWaiting();
  h.killer.emit('close', success ? 0 : 1);
  const initial = await h.initialOutcome;
  if (success) {
    expect(initial).toMatchObject({ value: { processId: null } });
    expect(await write).toMatchObject({ value: { processId: null } });
  } else {
    expect(initial).toMatchObject({ error: { kind: 'process_failed' } });
    expect(await write).toEqual(initial);
    expect(execOwner(h.id)).toBe(h.owner);
    expect(h.entry.retirementPending).toBe(true);
  }
});

it.runIf(process.platform === 'win32').each([true, false])('CASE 6: session deletion waits for pipe retirement and preserves failed custody (success=%s)', async success => {
  const session = await createSession({ title: 'controlled pipe owner' });
  const h = await pendingInitialExec({ owner: session.id });
  const write = h.interrupt().then(value => ({ value }), error => ({ error }));
  await h.interruptEntered.promise;
  const shared = h.entry.retirement;
  const terminating = barrier();
  const terminate = manager.terminateProcess.bind(manager);
  vi.spyOn(manager, 'terminateProcess').mockImplementation((...args) => {
    const result = terminate(...args);
    terminating.resolve();
    return result;
  });
  let deleted = false;
  const deletion = deleteSession(session.id).then(() => { deleted = true; return null; }, error => error);
  await terminating.promise;
  expect(h.entry.retirement).toBe(shared);
  h.exit();
  await h.publicationWaiting();
  expect(deleted).toBe(false);
  h.killer.emit('close', success ? 0 : 1);
  expect(native.kill).toHaveBeenCalledOnce();
  if (success) {
    expect(await deletion).toBeNull();
    expect(await getSession(session.id)).toBeNull();
    expect(execOwner(h.id)).toBeNull();
    expect(await write).toMatchObject({ value: { processId: null } });
    // Explicit deletion can withdraw the initial response's row after retirement.
    await h.initialOutcome;
  } else {
    expect(await deletion).toMatchObject({ kind: 'process_failed' });
    expect(await getSession(session.id)).not.toBeNull();
    expect(await write).toHaveProperty('error');
    expect(await h.initialOutcome).toHaveProperty('error');
    expect(execOwner(h.id)).toBe(session.id);
    expect(h.entry.retirementPending).toBe(true);
  }
});

it.runIf(process.platform === 'win32').each([true, false])('CASE 7: shutdown joins pipe retirement before releasing custody (success=%s)', async success => {
  const h = await pendingInitialExec();
  const write = h.interrupt().then(value => ({ value }), error => ({ error }));
  await h.interruptEntered.promise;
  const shared = h.entry.retirement;
  let shutdownSettled = false;
  const shutdown = manager.terminateAllProcesses().then(() => { shutdownSettled = true; return null; }, error => { shutdownSettled = true; return error; });
  expect(h.entry.retirement).toBe(shared);
  h.exit();
  await h.publicationWaiting();
  expect(shutdownSettled).toBe(false);
  h.killer.emit('close', success ? 0 : 1);
  const result = await shutdown;
  if (success) {
    expect(result).toBeNull();
    expect(execOwner(h.id)).toBeNull();
    expect(manager.listProcesses()).toEqual([]);
  } else {
    expect(result).toBeInstanceOf(AggregateError);
    expect(execOwner(h.id)).toBe(h.owner);
    expect(manager.listProcesses()).toContainEqual(expect.objectContaining({ processId: h.id, retirementPending: true }));
  }
  await write;
  await h.initialOutcome;
  expect(native.kill).toHaveBeenCalledOnce();
});

it.runIf(process.platform === 'win32')('CASE 8: id release and output acknowledgement cannot discard in-flight retirement', async () => {
  const h = await pendingInitialExec();
  const write = h.interrupt();
  await h.interruptEntered.promise;
  const shared = h.entry.retirement;
  manager.releaseProcessId(h.id);
  expect(h.entry.retirement).toBe(shared);
  h.exit();
  await h.publicationWaiting();
  expect(await manager.acknowledgeCompletedOutput(new Set([h.id]), Date.now())).toEqual([]);
  expect(await manager.offerCompletedOutput(new Set([h.id]), { completedAt: null, failed: false }, 1024)).toBeNull();
  expect(execOwner(h.id)).toBe(h.owner);
  expect(native.kill).toHaveBeenCalledOnce();
  h.killer.emit('close', 0);
  expect(await write).toMatchObject({ processId: null });
  expect(await h.initialOutcome).toMatchObject({ value: { processId: null } });
  manager.releaseProcessId(h.id);
  expect(execOwner(h.id)).toBeNull();
});

it.runIf(process.platform === 'win32')('explicit retry after failed retirement releases row and custody', async () => {
  const h = await pendingInitialExec();
  const first = h.interrupt().then(value => ({ value }), error => ({ error }));
  await h.interruptEntered.promise;
  h.exit();
  await h.publicationWaiting();
  h.killer.emit('close', 1);
  expect(await first).toHaveProperty('error');
  expect(await h.initialOutcome).toHaveProperty('error');
  expect(h.entry.retirementPending).toBe(true);
  expect(execOwner(h.id)).toBe(h.owner);

  const retryKiller = Object.assign(new EventEmitter(), { kill: vi.fn() });
  native.kill.mockImplementationOnce(() => {
    queueMicrotask(() => retryKiller.emit('close', 0));
    return retryKiller;
  });
  expect(await manager.terminateProcess(h.id)).toBe(true);
  expect(native.kill).toHaveBeenCalledTimes(2);
  expect(manager.listProcesses()).not.toContainEqual(expect.objectContaining({ processId: h.id }));
  expect(execOwner(h.id)).toBeNull();
});
