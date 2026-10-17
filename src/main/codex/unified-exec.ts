/**
 * Codex "unified exec": the runtime behind `exec_command` and `write_stdin`.
 *
 * Ported from `codex-rs/core/src/unified_exec/` — `mod.rs`, `process.rs`, `process_manager.rs`
 * and `errors.rs` — together with `ExecCommandToolOutput` from `codex-rs/core/src/tools/context.rs`.
 *
 * Nothing here shells out to Codex or depends on a Codex install. The Rust tokio machinery
 * (`Notify`, `CancellationToken`, `watch`, an interaction `Mutex`) is reproduced with the
 * JavaScript equivalents so the observable semantics survive: one shared output buffer that
 * a poll *drains*, a head/tail cap on what is retained, a yield deadline with a short
 * post-exit grace, and a session that outlives the call that created it.
 *
 * Two Windows adaptations, both about launching rather than about behaviour:
 *   - `cmd.exe` gets a verbatim command line. Node (like Rust) would otherwise escape inner
 *     quotes as `\"`, which cmd has never understood, and cmd exits 0 after failing to run
 *     it — a command that silently does nothing.
 *   - `interrupt()` terminates Windows pipe process trees; POSIX uses group SIGINT. A Windows console
 *     control event cannot be delivered to a child that owns no console.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { HeadTailBuffer } from './head-tail-buffer.js';
import { CommandBatchDisplay } from './command-batch.js';
import {
  approxTokenCount,
  approxTokensFromByteCount,
  byteLength,
  formattedTruncateText,
  policyTokenBudget,
  truncateText,
  type TruncationPolicy
} from './truncate.js';
import {
  clampYieldTime,
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
  formatOutputOmissionMarker,
  generateChunkId,
  INTERRUPT,
  MAX_UNIFIED_EXEC_PROCESSES,
  MAX_YIELD_TIME_MS,
  MIN_EMPTY_YIELD_TIME_MS,
  MIN_YIELD_TIME_MS,
  resolveMaxTokens,
  UNIFIED_EXEC_ENV
} from './unified-exec-constants.js';
import { terminateProcessTree } from '../exec.js';
import { prefixPowershellScriptWithUtf8, type ShellType } from './shell.js';
import {
  ContextArtifactError,
  type ContextArtifactDescriptor,
  type ContextArtifactWriter
} from '../session/context-artifacts.js';

// --------------------------------------------------------------------------- errors

export type UnifiedExecErrorKind =
  | 'create_process'
  | 'process_failed'
  | 'unknown_process_id'
  | 'write_to_stdin'
  | 'stdin_closed'
  | 'missing_command_line';

/**
 * `UnifiedExecError`, with both of the Rust renderings it is shown through.
 *
 * `message` is the `Display` form, which is what `write_stdin failed: {err}` prints; `debug()`
 * is the derived `Debug` form, which is what `exec_command failed for ...: {err:?}` prints.
 * They differ, and both reach the model, so both are reproduced.
 */
export class UnifiedExecError extends Error {
  readonly kind: UnifiedExecErrorKind;
  readonly processId: number | null;
  readonly detail: string | null;

  private constructor(kind: UnifiedExecErrorKind, message: string, detail: string | null, processId: number | null) {
    super(message);
    this.name = 'UnifiedExecError';
    this.kind = kind;
    this.detail = detail;
    this.processId = processId;
  }

  static createProcess(message: string): UnifiedExecError {
    return new UnifiedExecError('create_process', `Failed to create unified exec process: ${message}`, message, null);
  }

  static processFailed(message: string): UnifiedExecError {
    return new UnifiedExecError('process_failed', `Unified exec process failed: ${message}`, message, null);
  }

  static unknownProcessId(processId: number): UnifiedExecError {
    return new UnifiedExecError('unknown_process_id', `Unknown process id ${processId}`, null, processId);
  }

  static writeToStdin(): UnifiedExecError {
    return new UnifiedExecError('write_to_stdin', 'failed to write to stdin', null, null);
  }

  static stdinClosed(): UnifiedExecError {
    return new UnifiedExecError(
      'stdin_closed',
      'stdin is closed for this session; rerun exec_command with tty=true to keep stdin open',
      null,
      null
    );
  }

  static missingCommandLine(): UnifiedExecError {
    return new UnifiedExecError('missing_command_line', 'missing command line for unified exec request', null, null);
  }

  /** The `{err:?}` rendering of the Rust enum. */
  debug(): string {
    switch (this.kind) {
      case 'create_process':
        return `CreateProcess { message: ${JSON.stringify(this.detail ?? '')} }`;
      case 'process_failed':
        return `ProcessFailed { message: ${JSON.stringify(this.detail ?? '')} }`;
      case 'unknown_process_id':
        return `UnknownProcessId { process_id: ${this.processId ?? 0} }`;
      case 'write_to_stdin':
        return 'WriteToStdin';
      case 'stdin_closed':
        return 'StdinClosed';
      case 'missing_command_line':
        return 'MissingCommandLine';
    }
  }
}

// --------------------------------------------------------------------------- notify

/** `tokio::sync::Notify`, minus the stored permit: waiters registered before the notify. */
class Notify {
  private waiters = new Set<() => void>();

  /** A one-shot wait that must be disposed, so a lost race does not leak its resolver. */
  notified(): { promise: Promise<void>; dispose: () => void } {
    let resolver: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      resolver = resolve;
      this.waiters.add(resolver);
    });
    return { promise, dispose: () => this.waiters.delete(resolver) };
  }

  notifyWaiters(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const resolve of waiters) resolve();
  }
}

/** An async mutex standing in for the per-process `interaction_lock`. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  private locked = false;
  private queued = 0;

  async lock(): Promise<() => void> {
    // Count the request before the first await. A holder releases synchronously, while the next
    // queued lock only resumes in a microtask; without this bit of state tryLock() can barge into
    // that handoff gap even though a waiter is already entitled to the lock.
    this.queued += 1;
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => {
      release = () => {
        this.locked = false;
        resolve();
      };
    });
    const previous = this.tail;
    this.tail = previous.then(() => next);
    await previous;
    this.queued -= 1;
    this.locked = true;
    return release;
  }

  /** `try_lock_owned`: null when someone else holds it, so pruning can skip busy sessions. */
  tryLock(): (() => void) | null {
    if (this.locked || this.queued > 0) return null;
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => {
      release = () => {
        this.locked = false;
        resolve();
      };
    });
    this.tail = this.tail.then(() => next);
    this.locked = true;
    return release;
  }
}

// --------------------------------------------------------------------------- pty loading

/** The slice of node-pty this module uses, declared locally so an absent module is not a build edge. */
interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(signal?: string): void;
}

interface PtyModule {
  spawn(
    file: string,
    args: readonly string[] | string,
    options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }
  ): PtyProcess;
}

let ptyModule: Promise<PtyModule | null> | null = null;

async function loadPty(): Promise<PtyModule | null> {
  ptyModule ??= import('node-pty')
    .then((module) => ((module as { default?: PtyModule }).default ?? module) as PtyModule)
    .catch(() => null);
  return ptyModule;
}

// --------------------------------------------------------------------------- process

export interface SpawnParams {
  batchMarker?: string;
  /** The derived argv; element 0 is the executable. */
  command: string[];
  shellType: ShellType;
  cwd: string;
  env: NodeJS.ProcessEnv;
  tty: boolean;
  contextArtifactWriter?: ContextArtifactWriter;
}

export interface ContextArtifactRetention {
  descriptor?: ContextArtifactDescriptor;
  error?: { code: string; message: string };
}

const EARLY_EXIT_GRACE_PERIOD_MS = 150;
const POST_EXIT_CLOSE_WAIT_CAP_MS = 50;
export const MAX_COMPLETED_EXEC_RESULTS = 64;
export const COMPLETED_EXEC_OUTPUT_BYTES = 256 * 1024;

/** Applies `UNIFIED_EXEC_ENV` over the caller's environment, as `apply_unified_exec_env`. */
export function applyUnifiedExecEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of UNIFIED_EXEC_ENV) result[key] = value;
  return result;
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  return out;
}

/** MSVCRT-style quoting for one argument, for the verbatim `cmd.exe` command line only. */
function quoteWindowsArgument(argument: string): string {
  if (argument !== '' && !/[\s"]/.test(argument)) return argument;
  return `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
}

/**
 * One running unified exec session.
 *
 * The output buffer is *drained* by whoever polls it, which is the property the whole design
 * rests on: a chunk is delivered to exactly one call, so two consecutive `write_stdin` polls
 * see new bytes while work runs. Once completed delivery is acknowledged, the manager's
 * bounded history permits explicitly labeled rereads without executing the command again.
 */
class UnifiedExecProcess {
  readonly identity = {};
  private readonly startedAt = Date.now();
  private resolveCompletion!: (value: ProcessCompletion) => void;
  readonly completion = new Promise<ProcessCompletion>(resolve => { this.resolveCompletion = resolve; });
  private buffer = new HeadTailBuffer();
  private readonly history = new HeadTailBuffer(COMPLETED_EXEC_OUTPUT_BYTES);
  private displayBuffer: HeadTailBuffer | undefined;
  private readonly batchDisplay: CommandBatchDisplay | undefined;
  readonly outputNotify = new Notify();
  readonly outputClosedNotify = new Notify();
  readonly cancelNotify = new Notify();
  readonly interactionLock = new Mutex();
  outputClosed = false;
  cancelled = false;
  private exited = false;
  private exit: number | null = null;
  private failure: string | null = null;
  private openStreams = 0;
  private child: ChildProcess | null = null;
  private pty: PtyProcess | null = null;
  private contextArtifactWriter: ContextArtifactWriter | null;
  private artifactBackpressure: Promise<void> | null = null;
  private artifactPaused = false;
  private artifactFinalized = false;
  private resolveArtifactResult!: (result: ContextArtifactRetention) => void;
  private readonly artifactResult: Promise<ContextArtifactRetention>;
  readonly tty: boolean;
  private readonly spawnPid: number;

  private constructor(tty: boolean, pid: number, batchMarker?: string, contextArtifactWriter?: ContextArtifactWriter) {
    this.tty = tty;
    this.spawnPid = pid;
    this.contextArtifactWriter = contextArtifactWriter ?? null;
    this.artifactResult = new Promise(resolve => { this.resolveArtifactResult = resolve; });
    if (!this.contextArtifactWriter) {
      this.artifactFinalized = true;
      this.resolveArtifactResult({});
    }
    if (batchMarker) {
      this.batchDisplay = new CommandBatchDisplay(batchMarker);
      this.displayBuffer = new HeadTailBuffer();
    }
  }

  /**
   * The session leader's OS pid, read through to the live handle rather than snapshotted.
   *
   * node-pty's Windows ConPTY backend connects asynchronously: `pty.spawn()` hands back a
   * handle whose `pid` is still 0, and it is filled in later, when the conout pipe reports
   * `ready_datapipe` — comfortably after `EARLY_EXIT_GRACE_PERIOD_MS`. Recording it at
   * construction therefore stored 0 for every Windows tty session for the session's whole
   * life. That made `list_processes` advertise a pid nobody can act on, and, worse, made
   * `terminate()` fail its own `pid > 0` test and skip `terminateProcessTree` entirely — so
   * whenever node-pty had deferred its internal `kill()` (it queues the call until the pty is
   * ready), nothing ever killed the shell, and its console host outlived the app. Every
   * consumer reads this well after connect, so reading through is both correct and enough.
   */
  get pid(): number {
    const live = this.pty?.pid ?? 0;
    return live > 0 ? live : this.spawnPid;
  }

  static async spawn(
    params: SpawnParams, admit: () => void, register: (process: UnifiedExecProcess) => void
  ): Promise<UnifiedExecProcess> {
    const file = params.command[0];
    if (file === undefined || params.command.length === 0) {
      await params.contextArtifactWriter?.abort().catch(() => undefined);
      throw UnifiedExecError.missingCommandLine();
    }
    const args = params.command.slice(1);

    if (params.tty) {
      const pty = await loadPty();
      if (!pty) {
        await params.contextArtifactWriter?.abort().catch(() => undefined);
        throw UnifiedExecError.createProcess('a pseudo-console is not available on this machine');
      }
      let handle: PtyProcess;
      try {
        admit();
        handle = pty.spawn(
          file,
          // cmd.exe needs the command line it will actually parse; everything else is
          // quoted by node-pty from the argument list.
          params.shellType === 'cmd' && process.platform === 'win32'
            ? [quoteWindowsArgument(file), ...args].join(' ')
            : args,
          {
            name: 'dumb',
            cols: DEFAULT_TERMINAL_COLS,
            rows: DEFAULT_TERMINAL_ROWS,
            cwd: params.cwd,
            env: stringEnv(params.env)
          }
        );
      } catch (error) {
        await params.contextArtifactWriter?.abort().catch(() => undefined);
        throw UnifiedExecError.createProcess(error instanceof Error ? error.message : String(error));
      }
      const managed = new UnifiedExecProcess(true, handle.pid, params.batchMarker, params.contextArtifactWriter);
      managed.pty = handle;
      register(managed);
      handle.onData((data) => managed.pushChunk(Buffer.from(data, 'utf8')));
      handle.onExit((event) => {
        managed.signalExit(event.exitCode);
        managed.closeOutput();
      });
      await managed.waitForEarlyExit();
      return managed;
    }

    let child: ChildProcess;
    try {
      const verbatim = params.shellType === 'cmd' && process.platform === 'win32';
      admit();
      child = spawn(file, args, {
        cwd: params.cwd,
        env: params.env,
        windowsHide: true,
        shell: false,
        // Codex sessions must own descendants as well as the shell process. On POSIX a
        // detached child is a process-group leader, which lets interrupt/terminate signal
        // the whole session without changing Windows' existing taskkill semantics.
        detached: process.platform !== 'win32',
        // `stdin_open: tty` in Codex: a pipe session has no stdin, which is what makes
        // write_stdin answer StdinClosed rather than pretending the write landed.
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(verbatim ? { windowsVerbatimArguments: true } : {})
      });
    } catch (error) {
      await params.contextArtifactWriter?.abort().catch(() => undefined);
      throw UnifiedExecError.createProcess(error instanceof Error ? error.message : String(error));
    }

    const managed = new UnifiedExecProcess(false, child.pid ?? -1, params.batchMarker, params.contextArtifactWriter);
    managed.child = child;
    // stdout and stderr are combined into one stream, exactly as `combine_output_receivers`
    // does on the local Codex path, so interleaving is preserved in arrival order.
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      managed.openStreams += 1;
      stream.on('data', (chunk: Buffer) => managed.pushChunk(chunk));
      stream.on('end', () => managed.streamEnded());
      stream.on('error', () => managed.streamEnded());
    }
    if (managed.openStreams === 0) managed.closeOutput();

    const spawnFailure = new Promise<void>((resolve) => {
      child.once('error', (error: Error) => {
        managed.failure = error.message;
        managed.signalExit(null);
        void managed.failContextArtifact(new ContextArtifactError('WRITE_FAILED', 'Command process failed to start'))
          .finally(resolve);
        managed.closeOutput();
      });
    });
    void spawnFailure;
    child.once('exit', (code, signal) => {
      managed.signalExit(code === null && signal ? null : code);
    });

    register(managed);
    await managed.waitForEarlyExit();
    // Node reports an OS-level spawn failure (for example ENOENT for a missing
    // executable) through the ChildProcess `error` event instead of throwing
    // from spawn(). Codex's spawn_process returns that same failure from the
    // creation boundary, so it is a CreateProcess error rather than a later
    // ProcessFailed error. The event necessarily arrives before a successful
    // `spawn` event, well inside Codex's 150 ms early-exit grace window.
    if (managed.failure !== null && child.pid === undefined) {
      await spawnFailure;
      throw UnifiedExecError.createProcess(managed.failure);
    }
    return managed;
  }

  /** `EARLY_EXIT_GRACE_PERIOD`: a command that is already over must not be stored as live. */
  private async waitForEarlyExit(): Promise<void> {
    if (this.cancelled) return;
    const wait = this.cancelNotify.notified();
    try {
      await Promise.race([wait.promise, sleep(EARLY_EXIT_GRACE_PERIOD_MS)]);
    } finally {
      wait.dispose();
    }
  }

  private pushChunk(chunk: Buffer): void {
    if (chunk.length === 0) return;
    const writer = this.contextArtifactWriter;
    if (writer) {
      if (this.artifactPaused) {
        void this.failContextArtifact(new ContextArtifactError(
          'WRITE_FAILED',
          'Context artifact source produced data while storage was backpressured'
        ));
      } else {
        try {
          if (!writer.write(chunk)) {
            this.pauseOutputSources();
            this.artifactPaused = true;
            const pending = writer.waitForDrain().then(() => {
              if (this.contextArtifactWriter === writer) {
                this.artifactPaused = false;
                this.resumeOutputSources();
              }
            }).catch((error) => this.failContextArtifact(error));
            this.artifactBackpressure = pending.finally(() => {
              if (this.artifactBackpressure === pending) this.artifactBackpressure = null;
            });
          }
        } catch (error) {
          void this.failContextArtifact(error);
        }
      }
    }
    this.history.pushChunk(chunk);
    this.buffer.pushChunk(chunk);
    if (this.batchDisplay) this.displayBuffer!.pushChunk(this.batchDisplay.push(chunk));
    this.outputNotify.notifyWaiters();
  }

  private streamEnded(): void {
    this.openStreams -= 1;
    if (this.openStreams <= 0) this.closeOutput();
  }

  private closeOutput(): void {
    if (this.outputClosed) return;
    if (this.batchDisplay) this.displayBuffer!.pushChunk(this.batchDisplay.push(Buffer.alloc(0), true));
    this.outputClosed = true;
    this.outputClosedNotify.notifyWaiters();
    this.finalizeContextArtifact();
  }

  private pauseOutputSources(): void {
    if (this.pty) this.pty.pause();
    else {
      this.child?.stdout?.pause();
      this.child?.stderr?.pause();
    }
  }

  private resumeOutputSources(): void {
    if (this.pty) this.pty.resume();
    else {
      this.child?.stdout?.resume();
      this.child?.stderr?.resume();
    }
  }

  private retentionFailure(error: unknown): ContextArtifactRetention['error'] {
    if (error instanceof ContextArtifactError) return { code: error.code, message: error.message };
    return { code: 'WRITE_FAILED', message: 'Context artifact retention failed' };
  }

  private failContextArtifact(error: unknown): Promise<void> {
    const writer = this.contextArtifactWriter;
    if (!writer || this.artifactFinalized) return Promise.resolve();
    this.contextArtifactWriter = null;
    this.artifactFinalized = true;
    this.artifactPaused = false;
    this.resumeOutputSources();
    const failure = this.retentionFailure(error);
    return writer.abort().finally(() => this.resolveArtifactResult({ error: failure }));
  }

  private finalizeContextArtifact(): void {
    const writer = this.contextArtifactWriter;
    if (!writer || this.artifactFinalized) return;
    this.contextArtifactWriter = null;
    this.artifactFinalized = true;
    void (async () => {
      try {
        await this.artifactBackpressure;
        const descriptor = await writer.commit();
        this.resolveArtifactResult({ descriptor });
      } catch (error) {
        await writer.abort().catch(() => undefined);
        this.resolveArtifactResult({ error: this.retentionFailure(error) });
      } finally {
        this.artifactPaused = false;
        this.resumeOutputSources();
      }
    })();
  }

  contextArtifactResult(): Promise<ContextArtifactRetention> {
    return this.artifactResult;
  }

  private signalExit(exitCode: number | null): void {
    if (!this.exited) {
      this.exited = true;
      this.exit = exitCode;
      const completedAt = Date.now();
      this.resolveCompletion({ exitCode, completedAt, durationMs: Math.max(0, completedAt - this.startedAt) });
    }
    if (!this.cancelled) {
      this.cancelled = true;
      this.cancelNotify.notifyWaiters();
    }
  }

  /** `std::mem::take` of the shared buffer. */
  takeBuffer(): { raw: HeadTailBuffer; display?: HeadTailBuffer } {
    const drained = { raw: this.buffer, display: this.displayBuffer };
    this.buffer = new HeadTailBuffer();
    if (this.displayBuffer) this.displayBuffer = new HeadTailBuffer();
    return drained;
  }

  /** Completed output is immutable once both exit and stream closure are observed. */
  completedOutput(): Buffer | null {
    return this.hasExited() && this.outputClosed
      ? (this.displayBuffer ?? this.buffer).toBytesWithOmissionMarker() : null;
  }

  /** Independent of the unread cursor: explicit rereads include earlier delivered chunks. */
  retainedOutput(): Buffer {
    return this.history.toBytesWithOmissionMarker();
  }

  benignExit(classify: ExecCommandRequest['classifyExit']): boolean {
    // An omitted diagnostic or still-open stream cannot prove a non-zero result benign.
    return this.hasExited() && this.outputClosed && this.history.omittedBytes() === 0 &&
      (classify?.(this.exitCode(), this.retainedOutput().toString('utf8')) ?? false);
  }

  hasExited(): boolean {
    return this.exited;
  }

  exitCode(): number | null {
    return this.exit;
  }

  failureMessage(): string | null {
    return this.failure;
  }

  async write(data: string): Promise<void> {
    if (this.pty) {
      try {
        this.pty.write(data);
        return;
      } catch {
        throw UnifiedExecError.writeToStdin();
      }
    }
    // A pipe session was spawned without stdin, so there is nothing to write to. Codex
    // reaches the same answer through `StdinClosed` before ever calling write.
    throw UnifiedExecError.writeToStdin();
  }

  async interrupt(): Promise<void> {
    if (this.pty) {
      try {
        this.pty.write(INTERRUPT);
        return;
      } catch (error) {
        throw UnifiedExecError.processFailed(error instanceof Error ? error.message : String(error));
      }
    }
    const pid = this.child?.pid;
    if (pid === undefined) throw UnifiedExecError.processFailed('the process is no longer running');
    try {
      // Windows pipe children have no console for Ctrl-C. Terminate the tree before
      // its leader disappears, otherwise descendants retain the session's pipes/cwd.
      if (process.platform === 'win32') {
        if (!(await terminateProcessTree(pid, true))) throw new Error('Windows process-tree retirement unresolved; custody retained');
      }
      else process.kill(-pid, 'SIGINT');
    } catch (error) {
      // The managed session can outlive the OS process for the tiny window before Node's
      // ChildProcess `exit` event reaches us. Ctrl+C in that window used to turn a successful
      // natural exit into `kill ESRCH`, while the next empty poll immediately returned DONE.
      // "Already gone" is exactly the terminal state the interrupt was trying to reach.
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw UnifiedExecError.processFailed(error instanceof Error ? error.message : String(error));
    }
  }

  async terminate(): Promise<void> {
    // On Windows kill the tree before touching a PTY handle: pty.kill can remove
    // its leader before taskkill has enumerated the descendants.
    if (process.platform === 'win32') {
      if (this.pid <= 0 || !(await terminateProcessTree(this.pid, true))) {
        throw UnifiedExecError.processFailed('Windows process-tree retirement unresolved; custody retained');
      }
    }
    if (this.pty) {
      try {
        this.pty.kill();
      } catch {
        /* already gone */
      }
      // node-pty queues `kill()` until the pty reports ready and drops it silently if that
      // never happens, so the process tree is the authority here, not the handle. `pid` is a
      // live read for exactly this reason.
      if (process.platform !== 'win32' && this.pid > 0) await terminateProcessTree(this.pid, true);
    } else if (process.platform !== 'win32' && this.child?.pid !== undefined) {
      await terminateProcessTree(this.child.pid, true);
    }
    this.signalExit(this.exit);
    this.closeOutput();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    if (typeof timer.unref === 'function') timer.unref();
  });
}

// --------------------------------------------------------------------------- tool output

export interface ProcessCompletion {
  benignExit?: boolean;
  exitCode: number | null;
  completedAt: number;
  durationMs: number;
}

export interface ExecCommandToolOutput {
  completedSessionId?: number;
  replayed?: boolean;
  benignExit?: boolean;
  /** Exact process lifetime for recording; never serialized into the MCP response. */
  completion?: Promise<ProcessCompletion>;
  chunkId: string;
  wallTimeMs: number;
  rawOutput: Buffer;
  /** Batches alone retain a separately bounded, delimiter-free presentation stream. */
  displayOutput?: Buffer;
  truncationPolicy: TruncationPolicy;
  maxOutputTokens: number | undefined;
  /** The session id, present only while the process is still running. */
  processId: number | null;
  exitCode: number | null;
  originalTokenCount: number | null;
  /** Bytes the 1 MiB collection cap dropped, before model-facing truncation. */
  outputOmittedBytes: number | null;
  contextArtifact?: ContextArtifactDescriptor;
  contextArtifactError?: { code: string; message: string };
}

function modelOutputMaxTokens(output: ExecCommandToolOutput): number {
  return Math.min(resolveMaxTokens(output.maxOutputTokens), policyTokenBudget(output.truncationPolicy));
}

/** `ExecCommandToolOutput::truncated_output`. */
export function truncatedOutput(output: ExecCommandToolOutput, maxTokens: number): string {
  const text = (output.displayOutput ?? output.rawOutput).toString('utf8');
  const policy: TruncationPolicy = { kind: 'tokens', tokens: maxTokens };
  if (output.outputOmittedBytes === null || output.outputOmittedBytes === 0) {
    return formattedTruncateText(text, policy);
  }

  const marker = formatOutputOmissionMarker(output.outputOmittedBytes);
  if (byteLength(text) <= maxTokens * 4) {
    return text.includes(marker) ? text : `${marker}\n${text}`;
  }

  const originalTokenCount = output.originalTokenCount ?? approxTokenCount(text);
  const truncated = truncateText(text, policy);
  const omissionNotice = truncated.includes(marker) ? '' : `${marker}\n`;
  return `Warning: truncated output (original token count: ${originalTokenCount})\n${omissionNotice}\n${truncated}`;
}

/** `ExecCommandToolOutput::response_text` — exactly what the model is handed. */
export function execCommandResponseText(output: ExecCommandToolOutput): string {
  const sections: string[] = [];
  if (output.chunkId !== '') sections.push(`Chunk ID: ${output.chunkId}`);
  sections.push(`Wall time: ${(output.wallTimeMs / 1000).toFixed(4)} seconds`);
  if (output.exitCode !== null) sections.push(`Process exited with code ${output.exitCode}`);
  if (output.processId !== null) sections.push(`Process running with session ID ${output.processId}`);
  if (output.completedSessionId !== undefined) sections.push(`Completed session ID: ${output.completedSessionId}`);
  if (output.replayed) sections.push('Retained output (already completed; command was not run again):');
  if (output.benignExit) sections.push('This non-zero exit is an expected command result, not a failure.');
  if (output.originalTokenCount !== null) sections.push(`Original token count: ${output.originalTokenCount}`);
  if (output.contextArtifact) {
    sections.push(`Raw bytes: ${output.contextArtifact.rawBytes}`);
    sections.push(`Artifact ref: ${output.contextArtifact.ref}`);
    sections.push(`SHA-256: ${output.contextArtifact.sha256}`);
    sections.push('Retrieval available: true');
  } else if (output.contextArtifactError) {
    sections.push(`Raw output retention: FAILED (${output.contextArtifactError.code}: ${output.contextArtifactError.message})`);
  }
  sections.push('Output:');
  sections.push(truncatedOutput(output, modelOutputMaxTokens(output)));
  return sections.join('\n');
}

/** `ExecCommandToolOutput::code_mode_result`, which is also the tool's declared output schema. */
export function execCommandStructuredOutput(output: ExecCommandToolOutput): Record<string, unknown> {
  return {
    ...(output.chunkId === '' ? {} : { chunk_id: output.chunkId }),
    wall_time_seconds: output.wallTimeMs / 1000,
    ...(output.exitCode === null ? {} : { exit_code: output.exitCode }),
    ...(output.processId === null ? {} : { session_id: output.processId }),
    ...(output.completedSessionId === undefined ? {} : { completed_session_id: output.completedSessionId }),
    // Named for what it says (#1417): "benign" read to ChatGPT's reviewer as a verdict on risk.
    ...(output.benignExit ? { expected_exit: true } : {}),
    ...(output.replayed ? { output_replayed: true } : {}),
    ...(output.originalTokenCount === null ? {} : { original_token_count: output.originalTokenCount }),
    ...(output.contextArtifact ? {
      raw_bytes: output.contextArtifact.rawBytes,
      artifact_ref: output.contextArtifact.ref,
      sha256: output.contextArtifact.sha256,
      retrieval_available: true
    } : {}),
    ...(output.contextArtifactError ? {
      retention_error: `${output.contextArtifactError.code}: ${output.contextArtifactError.message}`
    } : {}),
    // This adapter emits structuredContent beside the text result, so both representations
    // must obey the same policy/default budget. Returning the retained raw buffer here made
    // the schema path bypass the model-visible truncation entirely.
    output: truncatedOutput(output, modelOutputMaxTokens(output))
  };
}

// --------------------------------------------------------------------------- manager

export interface ExecCommandRequest {
  /** Connector custody must bind synchronously immediately before native launch. */
  admit?: () => void;
  classifyExit?: (exitCode: number | null, rawOutput: string) => boolean;
  batchMarker?: string;
  command: string[];
  shellType: ShellType;
  hookCommand: string;
  processId: number;
  yieldTimeMs: number;
  maxOutputTokens: number | undefined;
  truncationPolicy: TruncationPolicy;
  cwd: string;
  /** The virtual path this ran in, kept only so `session status` can name it. */
  displayCwd: string;
  env: NodeJS.ProcessEnv;
  tty: boolean;
  contextArtifactWriter?: ContextArtifactWriter;
}

export interface WriteStdinRequest {
  processId: number;
  input: string;
  yieldTimeMs: number;
  maxOutputTokens: number | undefined;
  truncationPolicy: TruncationPolicy;
  maxWriteStdinYieldTimeMs?: number;
}

export interface BackgroundTerminalInfo {
  /** Tree retirement has not been confirmed, even if the leader has exited. */
  retirementPending?: true;
  processId: number;
  incarnation: number;
  command: string;
  cwd: string;
  pid: number;
  tty: boolean;
  startedAt: number;
}

interface ProcessEntry {
  retirementPending?: true;
  /** One in-flight OS retirement; publication waits for it without releasing custody. */
  retirement?: Promise<void>;
  classifyExit?: ExecCommandRequest['classifyExit'];
  batchMarker?: string;
  process: UnifiedExecProcess;
  processId: number;
  incarnation: number;
  cwd: string;
  hookCommand: string;
  tty: boolean;
  startedAt: number;
  initialExecCommandActive: boolean;
  /** Cursor into this process's own completed buffer; offers never consume bytes. */
  delivery?: { offset: number; offer?: { end: number; publication: OutputPublication } };
}

/** Local response completion, not a claim that a remote model understood the output. */
export interface OutputPublication {
  completedAt: number | null;
  failed: boolean;
}

export interface CompletedOutputPage {
  processId: number;
  command: string;
  exitCode: number | null;
  output: string;
  start: number;
  end: number;
  total: number;
  contextArtifact?: ContextArtifactDescriptor;
  contextArtifactError?: { code: string; message: string };
}

export interface BackgroundExecState {
  running: number[];
  exitedUnread: Array<{ processId: number; exitCode: number | null }>;
}

export class UnifiedExecProcessManager {
  private readonly processes = new Map<number, ProcessEntry>();
  private readonly completed = new Map<number, Pick<ExecCommandToolOutput, 'rawOutput' | 'displayOutput' | 'exitCode' | 'benignExit'> & {
    identity: object;
    artifactResult: Promise<ContextArtifactRetention>;
  }>();
  private releaseListener?: (processId: number) => void;
  private processChangeListener?: () => void;
  private readonly reservedProcessIds = new Map<number, object>();
  private nextProcessIncarnation = 1;
  private readonly maxWriteStdinYieldTimeMs: number;

  constructor(maxWriteStdinYieldTimeMs: number) {
    this.maxWriteStdinYieldTimeMs = Math.max(maxWriteStdinYieldTimeMs, MIN_EMPTY_YIELD_TIME_MS);
  }

  /** The custody registry drops ownership only when this manager really discards an id. */
  setProcessReleaseListener(listener: (processId: number) => void): void {
    this.releaseListener = listener;
  }

  /** Presentation observers may reread the manager after a process starts, exits or is discarded. */
  setProcessChangeListener(listener: () => void): void {
    this.processChangeListener = listener;
  }

  private notifyProcessChange(): void {
    this.processChangeListener?.();
  }

  /** `rand::rng().random_range(1_000..100_000)`, retried against the reservations. */
  allocateProcessId(): number {
    for (;;) {
      const processId = 1_000 + Math.floor(Math.random() * (100_000 - 1_000));
      if (this.reservedProcessIds.has(processId) || this.completed.has(processId)) continue;
      this.reservedProcessIds.set(processId, {});
      return processId;
    }
  }

  releaseProcessId(processId: number): void {
    if (this.processes.get(processId)?.retirementPending) return;
    this.reservedProcessIds.delete(processId);
    this.processes.delete(processId);
    this.completed.delete(processId);
    this.releaseListener?.(processId);
    this.notifyProcessChange();
  }

  private retainCompleted(entry: ProcessEntry): void {
    if (entry.retirementPending) return;
    const rawOutput = Buffer.from(entry.process.retainedOutput());
    const exitCode = entry.process.exitCode();
    this.processes.delete(entry.processId);
    this.reservedProcessIds.delete(entry.processId);
    this.completed.set(entry.processId, {
      identity: entry.process.identity,
      artifactResult: entry.process.contextArtifactResult(),
      rawOutput, exitCode,
      ...(entry.batchMarker ? { displayOutput: new CommandBatchDisplay(entry.batchMarker).push(rawOutput, true) } : {}),
      benignExit: entry.process.benignExit(entry.classifyExit)
    });
    this.notifyProcessChange();
    while (this.completed.size > MAX_COMPLETED_EXEC_RESULTS) this.releaseProcessId(this.completed.keys().next().value!);
  }

  async execCommand(request: ExecCommandRequest): Promise<ExecCommandToolOutput> {
    let process: UnifiedExecProcess;
    let entry: ProcessEntry | undefined;
    const reservation = this.reservedProcessIds.get(request.processId);
    const releaseReservation = (): void => {
      // A delayed launch/error cannot release a later incarnation of this numeric id.
      if (reservation && this.reservedProcessIds.get(request.processId) === reservation &&
          (!this.processes.has(request.processId) || this.processes.get(request.processId) === entry)) {
        this.releaseProcessId(request.processId);
      }
    };
    try {
      this.ensureProcessCapacity(request.processId);
    } catch (error) {
      await request.contextArtifactWriter?.abort().catch(() => undefined);
      releaseReservation();
      throw error;
    }
    try {
      // `UnifiedExecRuntime::run` prefixes every PowerShell script before it reaches the
      // process launcher so pipe-mode output is UTF-8 just like PTY output.
      const command =
        request.shellType === 'powershell' ? prefixPowershellScriptWithUtf8(request.command) : request.command;
      process = await UnifiedExecProcess.spawn({
        batchMarker: request.batchMarker,
        command,
        shellType: request.shellType,
        cwd: request.cwd,
        env: request.env,
        tty: request.tty,
        contextArtifactWriter: request.contextArtifactWriter
      }, () => {
        // PTY loading may have awaited. Recheck the exact reservation and bind the
        // caller's custody beside native spawn, with no await or observer in between.
        this.ensureProcessCapacity(request.processId);
        if (this.reservedProcessIds.get(request.processId) !== reservation || this.processes.has(request.processId)) {
          throw UnifiedExecError.createProcess('terminal session reservation changed before launch');
        }
        request.admit?.();
      }, managed => {
        entry = { process: managed, processId: request.processId, incarnation: this.nextProcessIncarnation++,
          cwd: request.displayCwd, hookCommand: request.hookCommand, tty: request.tty, startedAt: Date.now(),
          initialExecCommandActive: true, classifyExit: request.classifyExit, batchMarker: request.batchMarker };
        this.processes.set(request.processId, entry);
        void managed.completion.then(() => this.notifyProcessChange(), () => this.notifyProcessChange());
        this.notifyProcessChange();
      });
    } catch (error) {
      if (entry && this.processes.get(request.processId) === entry && !entry.process.hasExited()) {
        await this.terminateProcess(request.processId);
      }
      releaseReservation();
      throw error instanceof UnifiedExecError
        ? error
        : UnifiedExecError.createProcess(error instanceof Error ? error.message : String(error));
    }

    if (!entry || this.processes.get(request.processId) !== entry) throw UnifiedExecError.unknownProcessId(request.processId);
    const start = Date.now();
    const wallStart = performance.now();
    const deadline = start + clampYieldTime(request.yieldTimeMs);
    const collected = await collectOutputUntilDeadline(process, deadline);
    const wallTimeMs = Math.max(0, performance.now() - wallStart);
    if (this.processes.get(request.processId) !== entry) throw UnifiedExecError.unknownProcessId(request.processId);

    const visible = collected.display ?? collected.raw;
    const originalTokenCount = approxTokensFromByteCount(visible.totalBytes());
    const outputOmittedBytes = visible.omittedBytes() === 0 ? null : visible.omittedBytes();
    const rawOutput = collected.raw.toBytesWithOmissionMarker();
    const chunkId = generateChunkId();

    const failure = process.failureMessage();
    if (failure !== null) {
      this.releaseProcessId(request.processId);
      throw UnifiedExecError.processFailed(failure);
    }

    let responseProcessId: number | null;
    let exitCode: number | null;
    // Early leader exit does not prove tree retirement either. Join the shared
    // operation before refreshing or publishing any initial result.
    if (entry.retirement) await entry.retirement;
    if (this.processes.get(request.processId) !== entry) throw UnifiedExecError.unknownProcessId(request.processId);
    const status = this.refreshProcessState(request.processId);
    if (status.kind === 'alive') {
      responseProcessId = status.processId;
      exitCode = status.exitCode;
    } else if (status.kind === 'exited') {
      responseProcessId = null;
      exitCode = status.exitCode;
    } else {
      throw UnifiedExecError.unknownProcessId(request.processId);
    }

    const artifact = responseProcessId === null ? await process.contextArtifactResult() : {};
    const response = {
      ...(responseProcessId === null ? { completedSessionId: request.processId } : {
        completion: process.completion.then(async completion => {
          if (!process.outputClosed) {
            const closed = process.outputClosedNotify.notified();
            try { await raceWithTimeout([closed], POST_EXIT_CLOSE_WAIT_CAP_MS); } finally { closed.dispose(); }
          }
          return { ...completion, benignExit: process.benignExit(request.classifyExit) };
        })
      }),
      benignExit: process.benignExit(request.classifyExit),
      chunkId,
      wallTimeMs,
      rawOutput,
      ...(collected.display ? { displayOutput: collected.display.toBytesWithOmissionMarker() } : {}),
      truncationPolicy: request.truncationPolicy,
      maxOutputTokens: request.maxOutputTokens,
      processId: responseProcessId,
      exitCode,
      originalTokenCount,
      outputOmittedBytes,
      ...(artifact.descriptor ? { contextArtifact: artifact.descriptor } : {}),
      ...(artifact.error ? { contextArtifactError: artifact.error } : {})
    };
    if (responseProcessId !== null) {
      const entry = this.processes.get(request.processId);
      if (entry?.process === process) entry.initialExecCommandActive = false;
    }
    return response;
  }

  async writeStdin(request: WriteStdinRequest): Promise<ExecCommandToolOutput> {
    const replay = async (identity?: object): Promise<ExecCommandToolOutput | null> => {
      const saved = this.completed.get(request.processId);
      if (!saved) return null;
      if (identity && saved.identity !== identity) throw UnifiedExecError.unknownProcessId(request.processId);
      if (request.input !== '') throw UnifiedExecError.processFailed('Process already completed; no input was sent. Use empty chars to read its retained output.');
      const { artifactResult, identity: _identity, ...visibleSaved } = saved;
      const artifact = await artifactResult;
      return { ...visibleSaved, chunkId: generateChunkId(), wallTimeMs: 0, processId: null,
        completedSessionId: request.processId, replayed: true, originalTokenCount: approxTokenCount((saved.displayOutput ?? saved.rawOutput).toString('utf8')),
        outputOmittedBytes: null, truncationPolicy: request.truncationPolicy, maxOutputTokens: request.maxOutputTokens,
        ...(artifact.descriptor ? { contextArtifact: artifact.descriptor } : {}),
        ...(artifact.error ? { contextArtifactError: artifact.error } : {}) };
    };
    const saved = await replay();
    if (saved) return saved;
    const entry = this.processes.get(request.processId);
    if (!entry) throw UnifiedExecError.unknownProcessId(request.processId);
    if (entry.retirementPending) throw UnifiedExecError.processFailed('Process-tree retirement unresolved; custody retained');
    const locked = entry.process;

    // Reads and writes against one session must not overlap: they share a draining buffer.
    const release = await locked.interactionLock.lock();
    try {
      const saved = await replay(locked.identity);
      if (saved) return saved;
      const current = this.processes.get(request.processId);
      if (!current || current.process !== locked) throw UnifiedExecError.unknownProcessId(request.processId);
      const { process, tty } = { process: current.process, tty: current.tty };

      let statusAfterWrite: ProcessStatus | null = null;
      if (request.input !== '') {
        if (process.hasExited()) throw UnifiedExecError.processFailed('Process already completed; no input was sent. Use empty chars to read its retained output.');
        if (!tty) {
          if (request.input === INTERRUPT) {
            if (globalThis.process.platform === 'win32') {
              await this.retireProcess(current, () => process.interrupt());
            } else {
              await process.interrupt();
            }
          } else {
            throw UnifiedExecError.stdinClosed();
          }
        } else {
          try {
            await process.write(request.input);
            // A brief window so the child's reaction is more likely to land in the poll below.
            await sleep(100);
          } catch (error) {
            const status = this.refreshProcessState(request.processId);
            if (status.kind === 'exited') {
              statusAfterWrite = status;
            } else if (error instanceof UnifiedExecError && error.kind === 'process_failed') {
              await this.retireProcess(current, () => process.terminate());
              this.releaseProcessId(request.processId);
              throw error;
            } else {
              throw error;
            }
          }
        }
      }

      const maxEmptyYield = Math.max(
        request.maxWriteStdinYieldTimeMs ?? this.maxWriteStdinYieldTimeMs,
        MIN_EMPTY_YIELD_TIME_MS
      );
      const base = Math.max(request.yieldTimeMs, MIN_YIELD_TIME_MS);
      const yieldTimeMs =
        request.input === ''
          ? Math.min(Math.max(base, MIN_EMPTY_YIELD_TIME_MS), maxEmptyYield)
          : Math.min(base, MAX_YIELD_TIME_MS);

      const start = Date.now();
      const wallStart = performance.now();
      // Empty calls are polls, not collection windows. Once the process produces anything,
      // returning it immediately saves the caller another multi-second connector round trip;
      // bytes that arrive later remain in the draining buffer for the next poll. Non-empty
      // writes keep Codex's collection-window behavior so one interactive response is gathered.
      const collected = await collectOutputUntilDeadline(process, start + yieldTimeMs, request.input === '');
      const wallTimeMs = Math.max(0, performance.now() - wallStart);

      const visible = collected.display ?? collected.raw;
      const originalTokenCount = approxTokensFromByteCount(visible.totalBytes());
      const outputOmittedBytes = visible.omittedBytes() === 0 ? null : visible.omittedBytes();
      // An explicit poll may replay an offered-but-unacknowledged page, but must not
      // repeat earlier pages that this caller has already acknowledged automatically.
      const deliveredOffset = current.delivery?.offset ?? 0;
      const rawOutput = deliveredOffset > 0
        ? visible.toBytesWithOmissionMarker().subarray(deliveredOffset)
        : collected.raw.toBytesWithOmissionMarker();
      const chunkId = generateChunkId();

      const failure = process.failureMessage();
      if (failure !== null) {
        this.releaseProcessId(request.processId);
        throw UnifiedExecError.processFailed(failure);
      }

      if (current.retirement) await current.retirement;
      const status = statusAfterWrite ?? this.refreshProcessState(request.processId);
      let responseProcessId: number | null;
      let exitCode: number | null;
      if (status.kind === 'alive') {
        responseProcessId = status.processId;
        exitCode = status.exitCode;
      } else if (status.kind === 'exited') {
        responseProcessId = null;
        exitCode = status.exitCode;
      } else if (process.hasExited()) {
        responseProcessId = null;
        exitCode = process.exitCode();
      } else {
        throw UnifiedExecError.unknownProcessId(request.processId);
      }

      const artifact = responseProcessId === null ? await process.contextArtifactResult() : {};
      return {
        ...(responseProcessId === null ? { completedSessionId: request.processId } : {}),
        benignExit: process.benignExit(current.classifyExit),
        chunkId,
        wallTimeMs,
        rawOutput,
        ...(collected.display ? { displayOutput: deliveredOffset > 0 ? rawOutput : collected.display.toBytesWithOmissionMarker() } : {}),
        truncationPolicy: request.truncationPolicy,
        maxOutputTokens: request.maxOutputTokens,
        processId: responseProcessId,
        exitCode,
        originalTokenCount,
        outputOmittedBytes,
        ...(artifact.descriptor ? { contextArtifact: artifact.descriptor } : {}),
        ...(artifact.error ? { contextArtifactError: artifact.error } : {})
      };
    } finally {
      release();
    }
  }

  /** Live sessions, oldest id first. */
  listProcesses(): BackgroundTerminalInfo[] {
    return [...this.processes.values()]
      .filter((entry) => entry.retirementPending || !entry.process.hasExited())
      .sort((left, right) => left.processId - right.processId)
      .map((entry) => ({
        ...(entry.retirementPending ? { retirementPending: true as const } : {}),
        processId: entry.processId,
        incarnation: entry.incarnation,
        command: entry.hookCommand,
        cwd: entry.cwd,
        pid: entry.process.pid,
        tty: entry.tty,
        startedAt: entry.startedAt
      }));
  }

  /** Non-destructive obligation view for a caller-owned set of retained sessions. */
  backgroundState(processIds: ReadonlySet<number>): BackgroundExecState {
    const running: number[] = [];
    const exitedUnread: Array<{ processId: number; exitCode: number | null }> = [];
    for (const entry of this.processes.values()) {
      if (entry.initialExecCommandActive) continue;
      if (!processIds.has(entry.processId)) continue;
      if (entry.process.hasExited() && !entry.retirementPending) {
        exitedUnread.push({ processId: entry.processId, exitCode: entry.process.exitCode() });
      } else {
        running.push(entry.processId);
      }
    }
    return {
      running: running.sort((left, right) => left - right),
      exitedUnread: exitedUnread.sort((left, right) => left.processId - right.processId)
    };
  }

  /** Exited rows not handled by the starting exec; polling releases these rows. */
  exitedUnread(processIds: ReadonlySet<number>): Array<{ processId: number; exitCode: number | null }> {
    return this.backgroundState(processIds).exitedUnread;
  }

  /** A later owner call acknowledges a successfully published page, even within one request ID. */
  async acknowledgeCompletedOutput(processIds: ReadonlySet<number>, startedAt: number, except?: number): Promise<number[]> {
    const retired: number[] = [];
    for (const id of processIds) {
      if (id === except) continue; // Explicit polling still owns its normal result path.
      const entry = this.processes.get(id);
      if (!entry?.delivery?.offer || entry.retirementPending) continue;
      const release = await entry.process.interactionLock.lock();
      try {
        if (this.processes.get(id) !== entry || entry.retirementPending) continue;
        const offered = entry.delivery?.offer;
        if (!offered || offered.publication.failed || offered.publication.completedAt === null ||
            startedAt <= offered.publication.completedAt) continue;
        const output = entry.process.completedOutput();
        if (output === null) continue;
        entry.delivery = { offset: offered.end };
        if (offered.end >= output.length) {
          this.retainCompleted(entry);
          retired.push(id);
        }
      } finally { release(); }
    }
    return retired;
  }

  /**
   * Offer one bounded page without draining the process. A broken response reoffers the
   * same bytes; an older concurrent response cannot advance a newer delivery cursor.
   */
  async offerCompletedOutput(
    processIds: ReadonlySet<number>, publication: OutputPublication, maxBytes: number
  ): Promise<CompletedOutputPage | null> {
    if (publication.failed || maxBytes < 4) return null;
    for (const { processId } of this.backgroundState(processIds).exitedUnread) {
      const entry = this.processes.get(processId);
      if (!entry) continue;
      const release = await entry.process.interactionLock.lock();
      try {
        if (this.processes.get(processId) !== entry || entry.initialExecCommandActive) continue;
        const output = entry.process.completedOutput();
        if (output === null) continue;
        const artifact = await entry.process.contextArtifactResult();
        const delivery = entry.delivery ??= { offset: 0 };
        // An in-flight or published offer owns this page until failure or later receipt.
        if (delivery.offer && !delivery.offer.publication.failed) continue;
        const start = delivery.offset;
        let end = Math.min(output.length, start + Math.floor(maxBytes));
        // Do not split a UTF-8 character across separately rendered MCP responses.
        while (end > start && end < output.length && (output[end]! & 0xc0) === 0x80) end--;
        if (end === start && output.length > start) continue;
        delivery.offer = { end, publication };
        return { processId, command: entry.hookCommand, exitCode: entry.process.exitCode(),
          output: output.subarray(start, end).toString('utf8'), start, end, total: output.length,
          ...(artifact.descriptor ? { contextArtifact: artifact.descriptor } : {}),
          ...(artifact.error ? { contextArtifactError: artifact.error } : {}) };
      } finally { release(); }
    }
    return null;
  }

  /** Publish one shared operation before native retirement can wake any observer. */
  private retireProcess(entry: ProcessEntry, retire: () => Promise<void>): Promise<void> {
    if (!entry.retirement) {
      entry.retirementPending = true;
      entry.retirement = Promise.resolve().then(retire).then(() => {
        delete entry.retirementPending;
      }).finally(() => {
        // Failure retains pending custody, but permits an explicit later cleanup retry.
        delete entry.retirement;
        this.notifyProcessChange();
      });
    }
    return entry.retirement;
  }

  async terminateProcess(processId: number, expectedIncarnation?: number): Promise<boolean> {
    const entry = this.processes.get(processId);
    if (!entry) return false;
    // Renderer actions carry the exact live incarnation they displayed. Refuse a stale row after
    // natural exit, and refuse ABA reuse of the same numeric id without consuming retained output.
    if (expectedIncarnation !== undefined &&
        (entry.incarnation !== expectedIncarnation || (entry.process.hasExited() && !entry.retirementPending))) return false;
    if (!entry.process.hasExited() || entry.retirementPending) {
      // Claim before awaiting the OS helper. A partial kill can emit leader exit while
      // this call is suspended; neither polling nor cleanup may mistake that for proof.
      await this.retireProcess(entry, () => entry.process.terminate());
    }
    await entry.process.contextArtifactResult();
    const current = this.processes.get(processId);
    if (current && current.process === entry.process) {
      // Match Codex's InitialExecCommandGuard: the initial exec response still
      // owns this entry until it has refreshed the process's terminal state.
      // Removing it here would turn a successful concurrent termination into
      // an UnknownProcessId error in that original exec_command call.
      if (current.initialExecCommandActive) return true;
      this.releaseProcessId(processId);
    }
    return true;
  }

  async terminateAllProcesses(): Promise<void> {
    // All siblings get their cleanup attempt. Failed trees keep their exact manager
    // entry and owner, and shutdown receives a failure instead of a false success.
    const completedArtifacts = [...this.completed.values()].map(entry => entry.artifactResult);
    const results = await Promise.allSettled([...this.processes.keys()].map(id => this.terminateProcess(id)));
    // A process can have moved into bounded completed history while its artifact fsync/rename
    // is still finishing. Shutdown must not drop that retained row before evidence custody settles.
    await Promise.all(completedArtifacts);
    for (const id of new Set([...this.reservedProcessIds.keys(), ...this.completed.keys()])) this.releaseProcessId(id);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Process-tree retirement unresolved; custody retained');
  }

  private refreshProcessState(processId: number): ProcessStatus {
    const entry = this.processes.get(processId);
    if (!entry) return { kind: 'unknown' };
    if (entry.retirementPending) throw UnifiedExecError.processFailed('Process-tree retirement unresolved; custody retained');
    const exitCode = entry.process.exitCode();
    if (entry.process.hasExited()) {
      this.retainCompleted(entry);
      return { kind: 'exited', exitCode };
    }
    return { kind: 'alive', exitCode, processId: entry.processId };
  }

  /** Capacity is admission, never garbage collection: every retained row still owes output. */
  private ensureProcessCapacity(requestProcessId: number): void {
    // Reservations participate in the hard cap, so concurrent exec_command calls cannot
    // each observe one free slot and collectively insert a 65th live process.
    if (this.reservedProcessIds.size > MAX_UNIFIED_EXEC_PROCESSES) {
      throw UnifiedExecError.createProcess(
        `too many retained terminal sessions (limit ${MAX_UNIFIED_EXEC_PROCESSES}); drain a returned session with write_stdin before starting another`
      );
    }
    if (!this.reservedProcessIds.has(requestProcessId)) {
      throw UnifiedExecError.createProcess('terminal session reservation was lost before launch');
    }
  }
}

type ProcessStatus =
  | { kind: 'alive'; exitCode: number | null; processId: number }
  | { kind: 'exited'; exitCode: number | null }
  | { kind: 'unknown' };

/**
 * `collect_output_until_deadline`, port for port.
 *
 * The post-exit grace is the subtle part: once the process has signalled exit, the loop stops
 * waiting the full deadline and gives the output stream at most 50 ms more to close, so a
 * command that finished in 20 ms does not spend the whole 10 s yield window proving it.
 */
async function collectOutputUntilDeadline(
  process: UnifiedExecProcess,
  deadline: number,
  returnOnFirstOutput = false
): Promise<{ raw: HeadTailBuffer; display?: HeadTailBuffer }> {
  const collected = new HeadTailBuffer();
  let display: HeadTailBuffer | undefined;
  let exitSignalReceived = process.cancelled;
  let postExitDeadline: number | null = null;

  for (;;) {
    // Drained and re-armed in one synchronous step, so a chunk arriving between the two
    // cannot be missed by the wait that follows.
    const drained = process.takeBuffer();
    if (drained.display) {
      display ??= new HeadTailBuffer();
      display.pushBuffer(drained.display);
    }
    const hasDrainedOutput = drained.raw.retainedBytes() > 0 || drained.raw.omittedBytes() > 0;
    const waitForOutput = hasDrainedOutput ? null : process.outputNotify.notified();

    if (!hasDrainedOutput) {
      exitSignalReceived ||= process.cancelled;
      if (exitSignalReceived && process.outputClosed) {
        waitForOutput?.dispose();
        break;
      }
      const now = Date.now();
      const remaining = Math.max(0, deadline - now);
      if (remaining === 0) {
        waitForOutput?.dispose();
        break;
      }

      if (exitSignalReceived) {
        postExitDeadline ??= now + Math.min(remaining, POST_EXIT_CLOSE_WAIT_CAP_MS);
        const closeWaitRemaining = Math.max(0, postExitDeadline - now);
        if (closeWaitRemaining === 0) {
          waitForOutput?.dispose();
          break;
        }
        const closed = process.outputClosedNotify.notified();
        const timedOut = await raceWithTimeout([waitForOutput, closed], closeWaitRemaining);
        waitForOutput?.dispose();
        closed.dispose();
        if (timedOut) break;
        continue;
      }

      const exitNotified = process.cancelNotify.notified();
      const timedOut = await raceWithTimeout([waitForOutput, exitNotified], remaining);
      waitForOutput?.dispose();
      exitNotified.dispose();
      if (timedOut) break;
      exitSignalReceived ||= process.cancelled;
      continue;
    }

    collected.pushBuffer(drained.raw);
    if (returnOnFirstOutput) break;
    exitSignalReceived ||= process.cancelled;
    if (Date.now() >= deadline) break;
  }

  return { raw: collected, display };
}

/** Resolves true when the timeout won the race. */
async function raceWithTimeout(
  waits: ReadonlyArray<{ promise: Promise<void> } | null>,
  timeoutMs: number
): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), Math.max(0, timeoutMs));
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    const races = waits.filter((wait): wait is { promise: Promise<void> } => wait !== null).map((wait) =>
      wait.promise.then(() => false)
    );
    return await Promise.race([...races, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
