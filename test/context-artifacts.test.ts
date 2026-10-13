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
  resetSessionStoreForTests
} from '../src/main/session/store.js';
import { removeTempDir } from './helpers.js';

let dir = '';

afterEach(async () => {
  resetSessionStoreForTests();
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

it('retains bytes that the current 1 MiB head/tail collector loses', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-context-artifact-'));
  const sessionsRoot = path.join(dir, 'sessions');
  const sessionId = 'session-alpha';
  await fs.mkdir(path.join(sessionsRoot, sessionId), { recursive: true });
  const store = new ContextArtifactStore(sessionsRoot);
  const writer = await store.begin({ sessionId, operationId: 'call-alpha', kind: 'exec-output' });
  const marker = Buffer.from('NATIVE_CONTEXT_ENGINE_MIDDLE_MARKER', 'utf8');
  const source = Buffer.concat([
    Buffer.alloc(700_000, 0x68),
    marker,
    Buffer.alloc(700_000, 0x74)
  ]);

  if (!writer.write(source.subarray(0, 800_000))) await writer.waitForDrain();
  if (!writer.write(source.subarray(800_000))) await writer.waitForDrain();
  const descriptor = await writer.commit();
  const match = await store.search(sessionId, descriptor.ref, marker.toString('utf8'), 4, 64);

  expect(descriptor.state).toBe('committed');
  expect(descriptor.rawBytes).toBe(source.length);
  expect(match.matches).toHaveLength(1);
  expect(match.matches[0]?.text).toContain(marker.toString('utf8'));
});

it('keeps command artifacts distinct and denies cross-session refs', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-context-artifact-'));
  const sessionsRoot = path.join(dir, 'sessions');
  for (const id of ['session-alpha', 'session-bravo']) await fs.mkdir(path.join(sessionsRoot, id), { recursive: true });
  const store = new ContextArtifactStore(sessionsRoot);
  const first = await writeArtifact(store, 'session-alpha', 'call-one', Buffer.from('ONLY-COMMAND-ONE'));
  const second = await writeArtifact(store, 'session-alpha', 'call-two', Buffer.from('ONLY-COMMAND-TWO'));

  expect((await store.read('session-alpha', first.ref, 0, 64)).bytes.toString()).toBe('ONLY-COMMAND-ONE');
  expect((await store.read('session-alpha', second.ref, 0, 64)).bytes.toString()).toBe('ONLY-COMMAND-TWO');
  await expect(store.read('session-bravo', first.ref, 0, 64)).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
});

it('does not advertise or retrieve a creating artifact', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-context-artifact-'));
  const sessionsRoot = path.join(dir, 'sessions');
  const sessionId = 'session-alpha';
  await fs.mkdir(path.join(sessionsRoot, sessionId), { recursive: true });
  const store = new ContextArtifactStore(sessionsRoot);
  const writer = await store.begin({ sessionId, operationId: 'call-open', kind: 'exec-output' });
  if (!writer.write(Buffer.from('not committed'))) await writer.waitForDrain();
  await expect(store.read(sessionId, `ctx_v1_${writer.artifactId}`, 0, 64)).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
  await writer.abort();
});

it('fails closed on digest mismatch', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-context-artifact-'));
  const sessionsRoot = path.join(dir, 'sessions');
  const sessionId = 'session-alpha';
  await fs.mkdir(path.join(sessionsRoot, sessionId), { recursive: true });
  const store = new ContextArtifactStore(sessionsRoot);
  const descriptor = await writeArtifact(store, sessionId, 'call-digest', Buffer.from('trusted bytes'));
  await fs.appendFile(path.join(sessionsRoot, sessionId, 'context-artifacts', `${descriptor.artifactId}.bin`), 'tamper');

  await expect(store.read(sessionId, descriptor.ref, 0, 64)).rejects.toMatchObject({ code: 'CORRUPT' });
  await expect(store.search(sessionId, descriptor.ref, 'trusted')).rejects.toMatchObject({ code: 'CORRUPT' });
});

it('retrieves a committed artifact after restart and removes crash-created partials', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-context-artifact-'));
  const sessionsRoot = path.join(dir, 'sessions');
  const sessionId = 'session-alpha';
  const artifactDir = path.join(sessionsRoot, sessionId, 'context-artifacts');
  await fs.mkdir(artifactDir, { recursive: true });
  const firstStore = new ContextArtifactStore(sessionsRoot);
  const descriptor = await writeArtifact(firstStore, sessionId, 'call-restart', Buffer.from('restart-safe evidence'));
  await fs.writeFile(path.join(artifactDir, '.deadbeefdeadbeefdeadbeefdeadbeef.00112233.creating'), 'partial');

  const restarted = new ContextArtifactStore(sessionsRoot);
  expect((await restarted.read(sessionId, descriptor.ref, 0, 64)).bytes.toString()).toBe('restart-safe evidence');
  expect((await fs.readdir(artifactDir)).some(name => name.endsWith('.creating'))).toBe(false);
});

it('makes quota failure explicit and leaves no committed ref', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-context-artifact-'));
  const sessionsRoot = path.join(dir, 'sessions');
  const sessionId = 'session-alpha';
  await fs.mkdir(path.join(sessionsRoot, sessionId), { recursive: true });
  const store = new ContextArtifactStore(sessionsRoot, { artifactBytes: 16, sessionBytes: 32, globalBytes: 32 });
  const writer = await store.begin({ sessionId, operationId: 'call-quota', kind: 'exec-output' });
  expect(() => writer.write(Buffer.alloc(17))).toThrowError(ContextArtifactError);
  try { writer.write(Buffer.alloc(17)); } catch (error) { expect(error).toMatchObject({ code: 'QUOTA_EXCEEDED' }); }
  await writer.abort();
  await expect(store.read(sessionId, `ctx_v1_${writer.artifactId}`, 0, 1)).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
});

it('uses SessionStore lifecycle so restart retrieval works and session purge removes evidence', async () => {
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

it('captures exact unified-exec bytes before the 1 MiB collector and keeps model delivery bounded', async () => {
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
      shellType: 'bash',
      hookCommand: 'native context exact capture regression',
      processId,
      yieldTimeMs: 30_000,
      maxOutputTokens: 10_000,
      truncationPolicy: { kind: 'tokens', tokens: 10_000 },
      cwd: process.cwd(),
      displayCwd: process.cwd(),
      env: applyUnifiedExecEnv(process.env),
      tty: false,
      contextArtifactWriter: writer
    });
    expect(result.processId).toBeNull();
    expect(result.rawOutput.toString('utf8')).not.toContain(marker);
    expect(result.contextArtifact?.rawBytes).toBe(source.length);
    expect(result.contextArtifact?.sha256).toBe(createHash('sha256').update(source).digest('hex'));
    const recovered = await store.search(sessionId, result.contextArtifact!.ref, marker, 1, 64);
    expect(recovered.matches[0]?.text).toContain(marker);
    expect(Buffer.byteLength(execCommandResponseText(result), 'utf8')).toBeLessThan(60_000);
  } finally {
    await manager.terminateAllProcesses();
  }
});

it.each([
  ['terminal', 5_308_494],
  ['test-build', 5_609_819]
] as const)('retains representative %s output byte-for-byte at %i bytes', async (_label, totalBytes) => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-context-benchmark-'));
  const sessionsRoot = path.join(dir, 'sessions');
  const sessionId = 'session-alpha';
  await fs.mkdir(path.join(sessionsRoot, sessionId), { recursive: true });
  const store = new ContextArtifactStore(sessionsRoot);
  const writer = await store.begin({ sessionId, operationId: `benchmark-${totalBytes}`, kind: 'exec-output' });
  const marker = `BENCHMARK_MIDDLE_${totalBytes}`;
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
      shellType: 'bash', hookCommand: `benchmark ${totalBytes}`, processId, yieldTimeMs: 30_000,
      maxOutputTokens: 10_000, truncationPolicy: { kind: 'tokens', tokens: 10_000 }, cwd: process.cwd(), displayCwd: process.cwd(),
      env: applyUnifiedExecEnv(process.env), tty: false, contextArtifactWriter: writer
    });
    expect(result.contextArtifact).toMatchObject({ rawBytes: totalBytes, sha256: expectedHash, state: 'committed' });
    expect(result.rawOutput.toString('utf8')).not.toContain(marker);
    expect((await store.search(sessionId, result.contextArtifact!.ref, marker, 1, 32)).matches).toHaveLength(1);
    expect(Buffer.byteLength(execCommandResponseText(result), 'utf8')).toBeLessThan(60_000);
  } finally {
    await manager.terminateAllProcesses();
  }
});

it('keeps non-zero-exit failure evidence visible while also committing the exact artifact', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-context-failure-'));
  const sessionsRoot = path.join(dir, 'sessions');
  const sessionId = 'session-alpha';
  await fs.mkdir(path.join(sessionsRoot, sessionId), { recursive: true });
  const store = new ContextArtifactStore(sessionsRoot);
  const writer = await store.begin({ sessionId, operationId: 'call-failure', kind: 'exec-output' });
  const manager = new UnifiedExecProcessManager(30_000);
  const processId = manager.allocateProcessId();
  try {
    const result = await manager.execCommand({
      command: [process.execPath, '-e', "process.stderr.write('FAILURE_SENTINEL');process.exit(7)"],
      shellType: 'bash', hookCommand: 'failure visibility regression', processId, yieldTimeMs: 30_000,
      maxOutputTokens: 10_000, truncationPolicy: { kind: 'tokens', tokens: 10_000 }, cwd: process.cwd(), displayCwd: process.cwd(),
      env: applyUnifiedExecEnv(process.env), tty: false, contextArtifactWriter: writer
    });
    expect(result.exitCode).toBe(7);
    expect(execCommandResponseText(result)).toContain('FAILURE_SENTINEL');
    expect(result.contextArtifact?.state).toBe('committed');
  } finally {
    await manager.terminateAllProcesses();
  }
});

it('preserves the existing combined stdout/stderr arrival-order bytes exactly', async () => {
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
      shellType: 'bash', hookCommand: 'merged ordering regression', processId, yieldTimeMs: 30_000,
      maxOutputTokens: 10_000, truncationPolicy: { kind: 'tokens', tokens: 10_000 }, cwd: process.cwd(), displayCwd: process.cwd(),
      env: applyUnifiedExecEnv(process.env), tty: false, contextArtifactWriter: writer
    });
    const exact = await store.read(sessionId, result.contextArtifact!.ref, 0, 64);
    expect(exact.bytes.equals(result.rawOutput)).toBe(true);
    expect(exact.bytes.toString()).toBe('OUT-A|ERR-B|OUT-C');
  } finally {
    await manager.terminateAllProcesses();
  }
});

it('aborts creating evidence when the child cannot be spawned', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-context-spawn-fail-'));
  const sessionsRoot = path.join(dir, 'sessions');
  const sessionId = 'session-alpha';
  await fs.mkdir(path.join(sessionsRoot, sessionId), { recursive: true });
  const store = new ContextArtifactStore(sessionsRoot);
  const writer = await store.begin({ sessionId, operationId: 'call-spawn-fail', kind: 'exec-output' });
  const manager = new UnifiedExecProcessManager(30_000);
  const processId = manager.allocateProcessId();
  await expect(manager.execCommand({
    command: [path.join(dir, 'definitely-missing-executable.exe')],
    shellType: 'bash', hookCommand: 'spawn failure regression', processId, yieldTimeMs: 30_000,
    maxOutputTokens: 10_000, truncationPolicy: { kind: 'tokens', tokens: 10_000 }, cwd: process.cwd(), displayCwd: process.cwd(),
    env: applyUnifiedExecEnv(process.env), tty: false, contextArtifactWriter: writer
  })).rejects.toThrow(/create unified exec process/i);
  const artifactDir = path.join(sessionsRoot, sessionId, 'context-artifacts');
  expect((await fs.readdir(artifactDir)).some(name => name.endsWith('.creating') || name.endsWith('.json') || name.endsWith('.bin'))).toBe(false);
});

it('retires artifact writer ownership on cancellation and exposes runtime retention failure', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-context-cancel-'));
  const sessionsRoot = path.join(dir, 'sessions');
  const sessionId = 'session-alpha';
  await fs.mkdir(path.join(sessionsRoot, sessionId), { recursive: true });

  const cancellationStore = new ContextArtifactStore(sessionsRoot);
  const cancellationWriter = await cancellationStore.begin({ sessionId, operationId: 'call-cancel', kind: 'exec-output' });
  const manager = new UnifiedExecProcessManager(30_000);
  const processId = manager.allocateProcessId();
  const started = await manager.execCommand({
    command: [process.execPath, '-e', "process.stdout.write('started'); setInterval(() => {}, 1000)"],
    shellType: 'bash', hookCommand: 'cancel artifact regression', processId, yieldTimeMs: 50,
    maxOutputTokens: 10_000, truncationPolicy: { kind: 'tokens', tokens: 10_000 }, cwd: process.cwd(), displayCwd: process.cwd(),
    env: applyUnifiedExecEnv(process.env), tty: false, contextArtifactWriter: cancellationWriter
  });
  expect(started.processId).toBe(processId);
  await manager.terminateProcess(processId);
  const artifactDir = path.join(sessionsRoot, sessionId, 'context-artifacts');
  await expect.poll(async () => (await fs.readdir(artifactDir)).filter(name => name.endsWith('.json')).length).toBe(1);
  expect((await fs.readdir(artifactDir)).some(name => name.endsWith('.creating'))).toBe(false);
  const manifestName = (await fs.readdir(artifactDir)).find(name => name.endsWith('.json'))!;
  const manifest = JSON.parse(await fs.readFile(path.join(artifactDir, manifestName), 'utf8')) as ContextArtifactDescriptor;
  expect(manifest.state).toBe('committed');

  const failedStore = new ContextArtifactStore(sessionsRoot, { artifactBytes: 64, sessionBytes: 1_024, globalBytes: 1_024 });
  const failedWriter = await failedStore.begin({ sessionId, operationId: 'call-retention-fail', kind: 'exec-output' });
  const failedId = manager.allocateProcessId();
  const failed = await manager.execCommand({
    command: [process.execPath, '-e', "process.stdout.write('x'.repeat(4096))"],
    shellType: 'bash', hookCommand: 'retention failure regression', processId: failedId, yieldTimeMs: 30_000,
    maxOutputTokens: 10_000, truncationPolicy: { kind: 'tokens', tokens: 10_000 }, cwd: process.cwd(), displayCwd: process.cwd(),
    env: applyUnifiedExecEnv(process.env), tty: false, contextArtifactWriter: failedWriter
  });
  expect(failed.contextArtifact).toBeUndefined();
  expect(failed.contextArtifactError?.code).toBe('QUOTA_EXCEEDED');
  expect(failed.rawOutput.toString()).toContain('xxxxx');
  await manager.terminateAllProcesses();
});

it.each(['one', 'all'] as const)('waits for artifact finalization before %s process cancellation returns', async scope => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-context-shutdown-'));
  const sessionsRoot = path.join(dir, 'sessions');
  const sessionId = 'session-alpha';
  await fs.mkdir(path.join(sessionsRoot, sessionId), { recursive: true });
  const store = new ContextArtifactStore(sessionsRoot);
  const writer = await store.begin({ sessionId, operationId: `call-shutdown-${scope}`, kind: 'exec-output' });
  const commit = writer.commit.bind(writer);
  let releaseCommit!: () => void;
  let signalCommitStarted!: () => void;
  const commitGate = new Promise<void>(resolve => { releaseCommit = resolve; });
  const commitStarted = new Promise<void>(resolve => { signalCommitStarted = resolve; });
  writer.commit = async () => {
    signalCommitStarted();
    await commitGate;
    return commit();
  };

  const manager = new UnifiedExecProcessManager(30_000);
  const processId = manager.allocateProcessId();
  const started = await manager.execCommand({
    command: [process.execPath, '-e', "process.stdout.write('shutdown-evidence');setInterval(()=>{},1000)"],
    shellType: 'bash', hookCommand: `shutdown artifact ${scope}`, processId, yieldTimeMs: 30,
    maxOutputTokens: 10_000, truncationPolicy: { kind: 'tokens', tokens: 10_000 }, cwd: process.cwd(), displayCwd: process.cwd(),
    env: applyUnifiedExecEnv(process.env), tty: false, contextArtifactWriter: writer
  });
  expect(started.processId).toBe(processId);

  let settled = false;
  const stopping = (scope === 'one' ? manager.terminateProcess(processId) : manager.terminateAllProcesses())
    .then(() => { settled = true; });
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
