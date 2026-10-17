import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  ContextArtifactError,
  ContextArtifactStore,
  type ContextArtifactDescriptor
} from '../src/main/session/context-artifacts.js';
import {
  UnifiedExecProcessManager,
  applyUnifiedExecEnv,
  execCommandResponseText
} from '../src/main/codex/unified-exec.js';
import {
  beginContextArtifact,
  createSession,
  deleteSession,
  initSessionStore,
  readContextArtifact,
  resetSessionStoreForTests,
  unsetSessionRootForTests
} from '../src/main/session/store.js';
import { removeTempDir } from './helpers.js';

let dir = '';

afterEach(async () => {
  resetSessionStoreForTests();
  unsetSessionRootForTests();
  if (dir) await removeTempDir(dir);
  dir = '';
});

async function writeArtifact(
  store: ContextArtifactStore,
  sessionId: string,
  operationId: string,
  bytes: Buffer
): Promise<ContextArtifactDescriptor> {
  const writer = await store.begin({ sessionId, operationId, kind: 'exec-output' });
  if (!writer.write(bytes)) await writer.waitForDrain();
  return writer.commit();
}

it('retains lossless bytes beyond the bounded exec collector and literal-searches them', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-context-lossless-'));
  const sessionsRoot = path.join(dir, 'sessions');
  const sessionId = 'session-alpha';
  await fs.mkdir(path.join(sessionsRoot, sessionId), { recursive: true });
  const store = new ContextArtifactStore(sessionsRoot);
  const marker = 'NATIVE_CONTEXT_ENGINE_MIDDLE_MARKER';
  const source = Buffer.from(`${'h'.repeat(700_000)}${marker}${'t'.repeat(700_000)}`, 'ascii');
  const descriptor = await writeArtifact(store, sessionId, 'call-lossless', source);

  expect(descriptor.ref).toMatch(/^ctx_v1_[0-9a-f]{32}$/);
  expect(descriptor.rawBytes).toBe(source.length);
  expect(descriptor.sha256).toBe(createHash('sha256').update(source).digest('hex'));
  const found = await store.search(sessionId, descriptor.ref, marker, 1, 64);
  expect(found.matches).toHaveLength(1);
  expect(found.matches[0]?.text).toContain(marker);
});

it('fences refs by session, hides creating artifacts, and fails closed on tamper', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-context-fence-'));
  const sessionsRoot = path.join(dir, 'sessions');
  for (const id of ['session-alpha', 'session-bravo']) {
    await fs.mkdir(path.join(sessionsRoot, id), { recursive: true });
  }
  const store = new ContextArtifactStore(sessionsRoot);
  const writer = await store.begin({ sessionId: 'session-alpha', operationId: 'call-open', kind: 'exec-output' });
  if (!writer.write(Buffer.from('trusted evidence'))) await writer.waitForDrain();
  await expect(store.read('session-alpha', `ctx_v1_${writer.artifactId}`, 0, 8))
    .rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
  const descriptor = await writer.commit();

  await expect(store.read('session-bravo', descriptor.ref, 0, 8))
    .rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
  await fs.appendFile(
    path.join(sessionsRoot, 'session-alpha', 'context-artifacts', `${descriptor.artifactId}.bin`),
    'tamper'
  );
  await expect(store.read('session-alpha', descriptor.ref, 0, 64)).rejects.toMatchObject({ code: 'CORRUPT' });
});

it('accounts concurrent active writers against one shared session quota', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-context-quota-'));
  const sessionsRoot = path.join(dir, 'sessions');
  const sessionId = 'session-alpha';
  await fs.mkdir(path.join(sessionsRoot, sessionId), { recursive: true });
  const store = new ContextArtifactStore(sessionsRoot, { artifactBytes: 32, sessionBytes: 32, globalBytes: 64 });
  const first = await store.begin({ sessionId, operationId: 'call-one', kind: 'exec-output' });
  const second = await store.begin({ sessionId, operationId: 'call-two', kind: 'exec-output' });
  expect(first.write(Buffer.alloc(20))).toBe(false);
  expect(() => second.write(Buffer.alloc(20))).toThrowError(ContextArtifactError);
  try { second.write(Buffer.alloc(20)); } catch (error) { expect(error).toMatchObject({ code: 'QUOTA_EXCEEDED' }); }
  await first.waitForDrain();
  await first.abort();
  await second.abort();
});

it('rejects a context-artifacts symlink or Windows junction instead of writing outside the session', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-context-link-'));
  const sessionsRoot = path.join(dir, 'sessions');
  const sessionId = 'session-alpha';
  const sessionDir = path.join(sessionsRoot, sessionId);
  const outside = path.join(dir, 'outside');
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.symlink(outside, path.join(sessionDir, 'context-artifacts'), process.platform === 'win32' ? 'junction' : 'dir');

  const store = new ContextArtifactStore(sessionsRoot);
  await expect(store.begin({ sessionId, operationId: 'call-link', kind: 'exec-output' }))
    .rejects.toMatchObject({ code: 'CORRUPT' });
  expect(await fs.readdir(outside)).toEqual([]);
});

it('survives store restart and is removed with the owning session lifecycle', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-context-session-'));
  initSessionStore(dir);
  const session = await createSession({ title: 'context artifact lifecycle' });
  const writer = await beginContextArtifact(session.id, 'call-session-owned');
  if (!writer.write(Buffer.from('owned by session'))) await writer.waitForDrain();
  const descriptor = await writer.commit();

  resetSessionStoreForTests();
  initSessionStore(dir);
  expect((await readContextArtifact(session.id, descriptor.ref, 0, 64)).bytes.toString()).toBe('owned by session');
  await deleteSession(session.id);
  await expect(readContextArtifact(session.id, descriptor.ref, 0, 64)).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
});

it('retires an active pre-launch artifact writer before deleting its owning session', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-context-delete-race-'));
  initSessionStore(dir);
  const session = await createSession({ title: 'context writer deletion race' });
  const writer = await beginContextArtifact(session.id, 'call-pre-launch');
  expect(writer.write(Buffer.from('pre-launch evidence'))).toBe(false);
  await writer.waitForDrain();

  await deleteSession(session.id);

  expect(() => writer.write(Buffer.from('late evidence'))).toThrowError(/writer is closed/i);
  await expect(writer.commit()).rejects.toMatchObject({ code: 'WRITE_FAILED' });
  await expect(beginContextArtifact(session.id, 'call-after-delete')).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
});

it('captures exact unified-exec bytes before truncation without replacing current execution custody', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-context-exec-'));
  const sessionsRoot = path.join(dir, 'sessions');
  const sessionId = 'session-alpha';
  await fs.mkdir(path.join(sessionsRoot, sessionId), { recursive: true });
  const store = new ContextArtifactStore(sessionsRoot);
  const writer = await store.begin({ sessionId, operationId: 'call-exec', kind: 'exec-output' });
  const marker = 'NATIVE_CONTEXT_ENGINE_EXEC_MIDDLE_MARKER';
  const source = Buffer.from(`${'h'.repeat(700_000)}${marker}${'t'.repeat(700_000)}`, 'ascii');
  const manager = new UnifiedExecProcessManager(30_000);
  const processId = manager.allocateProcessId();
  try {
    const result = await manager.execCommand({
      command: [process.execPath, '-e', `process.stdout.write('h'.repeat(700000)+${JSON.stringify(marker)}+'t'.repeat(700000))`],
      shellType: 'bash', hookCommand: 'native context exact capture regression', processId,
      yieldTimeMs: 30_000, maxOutputTokens: 10_000, truncationPolicy: { kind: 'tokens', tokens: 10_000 },
      cwd: process.cwd(), displayCwd: process.cwd(), env: applyUnifiedExecEnv(process.env), tty: false,
      contextArtifactWriter: writer
    });
    expect(result.processId).toBeNull();
    expect(result.rawOutput.toString('utf8')).not.toContain(marker);
    expect(result.contextArtifact).toMatchObject({ rawBytes: source.length, sha256: createHash('sha256').update(source).digest('hex') });
    expect((await store.search(sessionId, result.contextArtifact!.ref, marker, 1, 64)).matches).toHaveLength(1);
    expect(Buffer.byteLength(execCommandResponseText(result), 'utf8')).toBeLessThan(60_000);
  } finally {
    await manager.terminateAllProcesses();
  }
});

it('preserves combined stdout/stderr arrival-order bytes exactly', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-context-merged-'));
  const sessionsRoot = path.join(dir, 'sessions');
  const sessionId = 'session-alpha';
  await fs.mkdir(path.join(sessionsRoot, sessionId), { recursive: true });
  const store = new ContextArtifactStore(sessionsRoot);
  const writer = await store.begin({ sessionId, operationId: 'call-merged', kind: 'exec-output' });
  const manager = new UnifiedExecProcessManager(30_000);
  const processId = manager.allocateProcessId();
  try {
    const result = await manager.execCommand({
      command: [process.execPath, '-e',
        "process.stdout.write('OUT-A|');setTimeout(()=>{process.stderr.write('ERR-B|');setTimeout(()=>process.stdout.write('OUT-C'),10)},10)"],
      shellType: 'bash', hookCommand: 'merged ordering regression', processId,
      yieldTimeMs: 30_000, maxOutputTokens: 10_000, truncationPolicy: { kind: 'tokens', tokens: 10_000 },
      cwd: process.cwd(), displayCwd: process.cwd(), env: applyUnifiedExecEnv(process.env), tty: false,
      contextArtifactWriter: writer
    });
    const exact = await store.read(sessionId, result.contextArtifact!.ref, 0, 64);
    expect(exact.bytes.equals(result.rawOutput)).toBe(true);
    expect(exact.bytes.toString()).toBe('OUT-A|ERR-B|OUT-C');
  } finally {
    await manager.terminateAllProcesses();
  }
});

it('retains a representative multi-megabyte command byte-for-byte', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-context-large-'));
  const sessionsRoot = path.join(dir, 'sessions');
  const sessionId = 'session-alpha';
  await fs.mkdir(path.join(sessionsRoot, sessionId), { recursive: true });
  const store = new ContextArtifactStore(sessionsRoot);
  const writer = await store.begin({ sessionId, operationId: 'call-large', kind: 'exec-output' });
  const totalBytes = 5_308_494;
  const marker = 'NATIVE_CONTEXT_LARGE_MIDDLE';
  const markerBytes = Buffer.from(marker, 'ascii');
  const before = Math.floor((totalBytes - markerBytes.length) / 2);
  const after = totalBytes - before - markerBytes.length;
  const expectedHash = createHash('sha256')
    .update(Buffer.alloc(before, 0x41))
    .update(markerBytes)
    .update(Buffer.alloc(after, 0x42))
    .digest('hex');
  const manager = new UnifiedExecProcessManager(30_000);
  const processId = manager.allocateProcessId();
  try {
    const result = await manager.execCommand({
      command: [process.execPath, '-e',
        `process.stdout.write(Buffer.alloc(${before},65));process.stdout.write(${JSON.stringify(marker)});process.stdout.write(Buffer.alloc(${after},66));`],
      shellType: 'bash', hookCommand: 'large artifact acceptance', processId,
      yieldTimeMs: 30_000, maxOutputTokens: 10_000, truncationPolicy: { kind: 'tokens', tokens: 10_000 },
      cwd: process.cwd(), displayCwd: process.cwd(), env: applyUnifiedExecEnv(process.env), tty: false,
      contextArtifactWriter: writer
    });
    expect(result.contextArtifact).toMatchObject({ rawBytes: totalBytes, sha256: expectedHash, state: 'committed' });
    expect(result.rawOutput.toString('utf8')).not.toContain(marker);
    expect((await store.search(sessionId, result.contextArtifact!.ref, marker, 1, 32)).matches).toHaveLength(1);
  } finally {
    await manager.terminateAllProcesses();
  }
});

it('waits for artifact finalization before successful process retirement releases its row', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-context-retire-'));
  const sessionsRoot = path.join(dir, 'sessions');
  const sessionId = 'session-alpha';
  await fs.mkdir(path.join(sessionsRoot, sessionId), { recursive: true });
  const store = new ContextArtifactStore(sessionsRoot);
  const writer = await store.begin({ sessionId, operationId: 'call-retire', kind: 'exec-output' });
  const realCommit = writer.commit.bind(writer);
  let releaseCommit!: () => void;
  let markCommitStarted!: () => void;
  const commitGate = new Promise<void>(resolve => { releaseCommit = resolve; });
  const commitStarted = new Promise<void>(resolve => { markCommitStarted = resolve; });
  writer.commit = async () => { markCommitStarted(); await commitGate; return realCommit(); };

  const manager = new UnifiedExecProcessManager(30_000);
  const processId = manager.allocateProcessId();
  const started = await manager.execCommand({
    command: [process.execPath, '-e', "process.stdout.write('retirement-evidence');setInterval(()=>{},1000)"],
    shellType: 'bash', hookCommand: 'artifact retirement regression', processId,
    yieldTimeMs: 30, maxOutputTokens: 10_000, truncationPolicy: { kind: 'tokens', tokens: 10_000 },
    cwd: process.cwd(), displayCwd: process.cwd(), env: applyUnifiedExecEnv(process.env), tty: false,
    contextArtifactWriter: writer
  });
  expect(started.processId).toBe(processId);
  let settled = false;
  const stopping = manager.terminateProcess(processId).then(() => { settled = true; });
  try {
    await commitStarted;
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(settled).toBe(false);
  } finally {
    releaseCommit();
    await stopping;
    await manager.terminateAllProcesses();
  }
});

it('keeps command output available and reports retention quota failure explicitly', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-context-retention-fail-'));
  const sessionsRoot = path.join(dir, 'sessions');
  const sessionId = 'session-alpha';
  await fs.mkdir(path.join(sessionsRoot, sessionId), { recursive: true });
  const store = new ContextArtifactStore(sessionsRoot, { artifactBytes: 64, sessionBytes: 1_024, globalBytes: 1_024 });
  const writer = await store.begin({ sessionId, operationId: 'call-retention-fail', kind: 'exec-output' });
  const manager = new UnifiedExecProcessManager(30_000);
  const processId = manager.allocateProcessId();
  try {
    const result = await manager.execCommand({
      command: [process.execPath, '-e', "process.stdout.write('x'.repeat(4096))"],
      shellType: 'bash', hookCommand: 'retention failure regression', processId,
      yieldTimeMs: 30_000, maxOutputTokens: 10_000, truncationPolicy: { kind: 'tokens', tokens: 10_000 },
      cwd: process.cwd(), displayCwd: process.cwd(), env: applyUnifiedExecEnv(process.env), tty: false,
      contextArtifactWriter: writer
    });
    expect(result.exitCode).toBe(0);
    expect(result.rawOutput.toString()).toContain('xxxxx');
    expect(result.contextArtifact).toBeUndefined();
    expect(result.contextArtifactError?.code).toBe('QUOTA_EXCEEDED');
    expect(execCommandResponseText(result)).toMatch(/Raw output retention: FAILED \(QUOTA_EXCEEDED:/);
  } finally {
    await manager.terminateAllProcesses();
  }
});

it('publishes the committed artifact ref with current background-output delivery', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-context-background-'));
  const sessionsRoot = path.join(dir, 'sessions');
  const sessionId = 'session-alpha';
  await fs.mkdir(path.join(sessionsRoot, sessionId), { recursive: true });
  const store = new ContextArtifactStore(sessionsRoot);
  const writer = await store.begin({ sessionId, operationId: 'call-background', kind: 'exec-output' });
  const manager = new UnifiedExecProcessManager(30_000);
  const processId = manager.allocateProcessId();
  try {
    const started = await manager.execCommand({
      command: [process.execPath, '-e', "setTimeout(()=>process.stdout.write('background-evidence'),500);setTimeout(()=>process.exit(0),1500)"],
      shellType: 'bash', hookCommand: 'background artifact regression', processId,
      yieldTimeMs: 30, maxOutputTokens: 10_000, truncationPolicy: { kind: 'tokens', tokens: 10_000 },
      cwd: process.cwd(), displayCwd: process.cwd(), env: applyUnifiedExecEnv(process.env), tty: false,
      contextArtifactWriter: writer
    });
    expect(started.processId).toBe(processId);
    await started.completion;
    const page = await manager.offerCompletedOutput(
      new Set([processId]),
      { completedAt: null, failed: false },
      1_024
    );
    expect(page?.output).toContain('background-evidence');
    expect(page?.contextArtifact?.ref).toMatch(/^ctx_v1_[0-9a-f]{32}$/);
    expect(page?.contextArtifact?.rawBytes).toBe(Buffer.byteLength('background-evidence'));
  } finally {
    await manager.terminateAllProcesses();
  }
});

it('releases concurrent quota reservations and file handles after abort', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-context-release-'));
  const sessionsRoot = path.join(dir, 'sessions');
  const sessionId = 'session-alpha';
  const sessionDir = path.join(sessionsRoot, sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  const store = new ContextArtifactStore(sessionsRoot, { artifactBytes: 32, sessionBytes: 32, globalBytes: 32 });
  const writers = await Promise.all(
    Array.from({ length: 4 }, (_, index) => store.begin({ sessionId, operationId: `call-${index}`, kind: 'exec-output' }))
  );
  expect(writers[0]!.write(Buffer.alloc(8))).toBe(false);
  expect(writers[1]!.write(Buffer.alloc(8))).toBe(false);
  expect(writers[2]!.write(Buffer.alloc(8))).toBe(false);
  expect(writers[3]!.write(Buffer.alloc(8))).toBe(false);
  await Promise.all(writers.map(writer => writer.waitForDrain()));
  await Promise.all(writers.map(writer => writer.abort()));

  const replacement = await store.begin({ sessionId, operationId: 'replacement', kind: 'exec-output' });
  expect(replacement.write(Buffer.alloc(32))).toBe(false);
  await replacement.waitForDrain();
  await replacement.abort();
  await fs.rm(sessionDir, { recursive: true, force: false });
  expect(await fs.stat(sessionDir).then(() => true, () => false)).toBe(false);
});
