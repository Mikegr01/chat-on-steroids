import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSession, deleteSession, initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { unifiedExecManager } from '../src/main/codex/manager.js';
import { admitExecOwner, execOwner, execOwnershipFailure, executionPrincipal,
  noteExecOwner, onBackgroundExecChange, resetExecOwnershipForTests, stopExecProcess } from '../src/main/codex/ownership.js';
import { observeRequestCorrelation } from '../src/main/session/correlation.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let root: string;
let proofIndex = 0;
beforeEach(async () => {
  root = await makeTempDir('cos-exec-admission-');
  initSessionStore(root);
  resetExecOwnershipForTests();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await unifiedExecManager.terminateAllProcesses();
  resetExecOwnershipForTests();
  resetSessionStoreForTests();
  await removeTempDir(root);
});

const request = (id: number, principal: string | null, script = 'setInterval(()=>{},1000)', tty = false) => ({
  processId: id, command: [process.execPath, '-e', script], shellType: process.platform === 'win32' ? 'powershell' as const : 'bash' as const,
  hookCommand: 'atomic exec admission', cwd: root, displayCwd: root, env: process.env, tty,
  yieldTimeMs: 250, maxOutputTokens: undefined, truncationPolicy: { kind: 'tokens' as const, tokens: 1000 },
  admit: () => admitExecOwner(id, principal)
});
const proof = (requestId: string, sessionId: string) => observeRequestCorrelation({ requestId, sessionId,
  conversationId: `admission-chat-${++proofIndex}`, messageId: `admission-message-${proofIndex}`, tool: 'exec_command', observedAt: Date.now() });

it('CASE 2: retirement wins while PTY preparation awaits, so native launch and custody admission are refused', async () => {
  const session = await createSession({ title: 'retirement first' });
  const ptyModule = await import('node-pty');
  const pty = ptyModule.default ?? ptyModule;
  const spawn = vi.spyOn(pty, 'spawn');
  const id = unifiedExecManager.allocateProcessId();
  const args = request(id, session.id, undefined, true);
  const admit = vi.fn(args.admit);
  const started = unifiedExecManager.execCommand({ ...args, admit });
  const outcome = started.then(() => null, error => error as Error);
  expect(admit).not.toHaveBeenCalled(); // loadPty is an actual pre-launch async boundary.
  await deleteSession(session.id);
  expect((await outcome)?.message).toContain('EXEC_SESSION_RETIRED');
  expect(spawn).not.toHaveBeenCalled();
  expect(execOwnershipFailure(id, session.id)).toBe('unavailable');
  expect(unifiedExecManager.listProcesses()).toEqual([]);
});

it('CASE 3: request custody promotes only to its exact proven session and retains isolation', async () => {
  const session = await createSession({ title: 'request promotion' });
  const other = await createSession({ title: 'different owner' });
  const requestId = `wfr_admission_promote_${proofIndex}`;
  const principal = executionPrincipal(requestId, null);
  const id = unifiedExecManager.allocateProcessId();
  await unifiedExecManager.execCommand(request(id, principal));
  expect(execOwner(id)).toBe(`request:${requestId}`);
  expect(execOwnershipFailure(id, null)).toBe('unidentified');
  expect(execOwnershipFailure(id, 'request:unrelated')).toBe('unidentified');
  expect(proof(requestId, session.id)).toBe('stored');
  expect(execOwner(id)).toBe(session.id);
  expect(execOwnershipFailure(id, session.id)).toBeNull();
  expect(execOwnershipFailure(id, other.id)).toBe('different-owner');
  expect(proof(requestId, other.id)).toBe('refused');
  expect(execOwner(id)).toBe(session.id);
  const row = unifiedExecManager.listProcesses().find(row => row.processId === id)!;
  expect(await stopExecProcess(other.id, id, row.incarnation)).toBe(false);
  expect(unifiedExecManager.listProcesses()).toContainEqual(expect.objectContaining({ processId: id }));
});

it('CASE 4: proof arriving after session deletion retires the original request custody without resurrection', async () => {
  const session = await createSession({ title: 'late retired proof' });
  const requestId = `wfr_admission_retired_${proofIndex}`;
  const principal = executionPrincipal(requestId, null);
  const id = unifiedExecManager.allocateProcessId();
  await unifiedExecManager.execCommand(request(id, principal));
  await deleteSession(session.id); // The request has no session proof yet; do not guess.
  let drop = () => {};
  const retired = new Promise<void>(resolve => {
    drop = onBackgroundExecChange(() => { if (execOwner(id) === null) resolve(); });
  });
  try {
    expect(proof(requestId, session.id)).toBe('stored');
    expect(execOwnershipFailure(id, session.id)).toBe('unavailable');
    await retired;
    expect(unifiedExecManager.listProcesses()).not.toContainEqual(expect.objectContaining({ processId: id }));
    noteExecOwner(id, principal);
    expect(execOwner(id)).toBeNull();
    expect(() => admitExecOwner(id, principal)).toThrow('EXEC_SESSION_RETIRED');
  } finally { drop(); }
});

it('CASE 4: retirement between principal creation and exact proof refuses a later launch', async () => {
  const session = await createSession({ title: 'retired before proof and admission' });
  const requestId = `wfr_admission_preproof_${proofIndex}`;
  const principal = executionPrincipal(requestId, null);
  await deleteSession(session.id);
  expect(proof(requestId, session.id)).toBe('stored');
  const id = unifiedExecManager.allocateProcessId();
  await expect(unifiedExecManager.execCommand(request(id, principal))).rejects.toThrow('EXEC_SESSION_RETIRED');
  expect(execOwner(id)).toBeNull();
  expect(unifiedExecManager.listProcesses()).toEqual([]);
});

it('CASE 5: natural exit retains an already-owned result and release leaves no orphan owner', async () => {
  const session = await createSession({ title: 'natural exit' });
  const id = unifiedExecManager.allocateProcessId();
  const observed: Array<string | null> = [];
  const drop = onBackgroundExecChange(() => {
    if (unifiedExecManager.listProcesses().some(row => row.processId === id)) observed.push(execOwner(id));
  });
  try {
    const result = await unifiedExecManager.execCommand(request(id, session.id, "console.log('owned-result')"));
    expect(observed).toContain(session.id);
    expect(observed).not.toContain(null);
    expect(result.completedSessionId).toBe(id);
    expect(execOwner(id)).toBe(session.id);
    const reread = await unifiedExecManager.writeStdin({ processId: id, input: '', yieldTimeMs: 1,
      maxOutputTokens: undefined, truncationPolicy: { kind: 'tokens', tokens: 1000 } });
    expect(reread.rawOutput.toString()).toContain('owned-result');
    unifiedExecManager.releaseProcessId(id);
    expect(execOwnershipFailure(id, session.id)).toBe('unavailable');
  } finally { drop(); }
});

it('CASE 8: successful session retirement releases the process and its already-published custody', async () => {
  const session = await createSession({ title: 'successful retirement' });
  const id = unifiedExecManager.allocateProcessId();
  await unifiedExecManager.execCommand(request(id, session.id));
  expect(execOwner(id)).toBe(session.id);
  await deleteSession(session.id);
  expect(execOwner(id)).toBeNull();
  expect(unifiedExecManager.listProcesses()).toEqual([]);
});

it('keeps anonymous custody non-adoptable from a request or durable session', async () => {
  const id = unifiedExecManager.allocateProcessId();
  await unifiedExecManager.execCommand(request(id, null));
  expect(execOwnershipFailure(id, null)).toBe('unidentified');
  expect(execOwnershipFailure(id, 'request:another')).toBe('anonymous');
  expect(execOwnershipFailure(id, 'different-session')).toBe('anonymous');
});

it('rolls back custody and reservation when native spawn fails after admission', async () => {
  const session = await createSession({ title: 'failed native spawn' });
  const id = unifiedExecManager.allocateProcessId();
  const admit = vi.fn(() => admitExecOwner(id, session.id));
  await expect(unifiedExecManager.execCommand({ ...request(id, session.id), admit,
    command: [process.platform === 'win32' ? 'Z:\\missing-admission-program.exe' : '/missing-admission-program'] })).rejects.toThrow('Failed to create');
  expect(admit).toHaveBeenCalledOnce();
  expect(execOwnershipFailure(id, session.id)).toBe('unavailable');
  const random = vi.spyOn(Math, 'random').mockReturnValue((id - 1000 + 0.5) / 99000);
  expect(unifiedExecManager.allocateProcessId()).toBe(id);
  random.mockRestore();
  unifiedExecManager.releaseProcessId(id);
});

it('does not let a delayed PTY admission or rollback consume a recycled reservation', async () => {
  const session = await createSession({ title: 'reservation incarnation' });
  const id = unifiedExecManager.allocateProcessId();
  const admit = vi.fn(() => admitExecOwner(id, session.id));
  const old = unifiedExecManager.execCommand({ ...request(id, session.id, undefined, true), admit });
  const outcome = old.then(() => null, error => error as Error);
  unifiedExecManager.releaseProcessId(id);
  const random = vi.spyOn(Math, 'random').mockReturnValue((id - 1000 + 0.5) / 99000);
  expect(unifiedExecManager.allocateProcessId()).toBe(id);
  random.mockRestore();
  expect((await outcome)?.message).toContain('reservation changed');
  expect(admit).not.toHaveBeenCalled();
  await unifiedExecManager.execCommand(request(id, session.id));
  expect(execOwner(id)).toBe(session.id);
});
