/**
 * Session-scoped immutable evidence produced by already-authorized operations.
 *
 * The raw bytes are authoritative. References are opaque identifiers resolved only inside the
 * caller's owning session; no caller-provided filesystem path ever reaches this subsystem.
 */
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';

export const MAX_CONTEXT_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const MAX_CONTEXT_ARTIFACT_SESSION_BYTES = 192 * 1024 * 1024;
export const MAX_CONTEXT_ARTIFACT_GLOBAL_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_CONTEXT_ARTIFACT_READ_BYTES = 64 * 1024;
export const MAX_CONTEXT_ARTIFACT_QUERY_BYTES = 4 * 1024;
export const MAX_CONTEXT_ARTIFACT_MATCHES = 50;
export const MAX_CONTEXT_ARTIFACT_CONTEXT_BYTES = 64 * 1024;
export const MAX_CONTEXT_ARTIFACT_SEARCH_RESULT_BYTES = 64 * 1024;

const REF = /^ctx_v1_([0-9a-f]{32})$/;
const SESSION = /^[0-9a-z-]{8,64}$/i;
const ARTIFACT = /^[0-9a-f]{32}$/;
const IO_CHUNK_BYTES = 64 * 1024;

export interface ContextArtifactDescriptor {
  version: 1;
  ref: string;
  artifactId: string;
  sha256: string;
  rawBytes: number;
  kind: 'exec-output';
  state: 'committed';
  createdAt: string;
}

interface ContextArtifactManifest extends ContextArtifactDescriptor {
  sessionId: string;
  operationId: string;
}

export interface ContextArtifactReadResult {
  ref: string;
  offset: number;
  end: number;
  total: number;
  sha256: string;
  bytes: Buffer;
}

export interface ContextArtifactSearchMatch {
  start: number;
  end: number;
  contextStart: number;
  contextEnd: number;
  bytes: Buffer;
  text: string | null;
}

export interface ContextArtifactSearchResult {
  ref: string;
  query: string;
  total: number;
  sha256: string;
  matches: ContextArtifactSearchMatch[];
}

export type ContextArtifactErrorCode =
  | 'INVALID_REQUEST'
  | 'NOT_AVAILABLE'
  | 'CORRUPT'
  | 'QUOTA_EXCEEDED'
  | 'WRITE_FAILED';

export class ContextArtifactError extends Error {
  constructor(readonly code: ContextArtifactErrorCode, message: string) {
    super(message);
    this.name = 'ContextArtifactError';
  }
}

function safeSessionId(sessionId: string): void {
  if (!SESSION.test(sessionId)) throw new ContextArtifactError('INVALID_REQUEST', 'Invalid context artifact session');
}

function artifactIdFromRef(ref: string): string {
  const match = REF.exec(ref);
  if (!match) throw new ContextArtifactError('INVALID_REQUEST', 'Invalid context artifact reference');
  return match[1]!;
}

function roundTripUtf8(bytes: Buffer): string | null {
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null;
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function insidePath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isCommittedManifest(value: unknown, sessionId: string, artifactId: string): value is ContextArtifactManifest {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<ContextArtifactManifest>;
  return row.version === 1 && row.ref === `ctx_v1_${artifactId}` && row.artifactId === artifactId &&
    typeof row.sha256 === 'string' && /^[0-9a-f]{64}$/.test(row.sha256) &&
    Number.isSafeInteger(row.rawBytes) && (row.rawBytes ?? -1) >= 0 &&
    row.kind === 'exec-output' && row.state === 'committed' && typeof row.createdAt === 'string' &&
    row.sessionId === sessionId && typeof row.operationId === 'string' && row.operationId.length > 0;
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/** One creating artifact. It has no retrievable reference until commit publishes metadata. */
export class ContextArtifactWriter {
  private rawBytes = 0;
  private hash = createHash('sha256');
  private pendingWrite: Promise<void> | null = null;
  private writeError: ContextArtifactError | null = null;
  private finished = false;
  private closed = false;
  private resolveSettled!: () => void;
  private readonly settled = new Promise<void>(resolve => { this.resolveSettled = resolve; });

  constructor(
    private readonly store: ContextArtifactStore,
    readonly sessionId: string,
    readonly operationId: string,
    readonly artifactId: string,
    private readonly temporaryRawPath: string,
    private readonly handle: Awaited<ReturnType<typeof fs.open>>
  ) {}

  /**
   * Writes in arrival order. A false return is real Node stream backpressure; the process owner
   * must pause its output sources until waitForDrain() resolves instead of building another queue.
   */
  write(chunk: Buffer): boolean {
    if (this.closed) throw new ContextArtifactError('WRITE_FAILED', 'Context artifact writer is closed');
    if (this.writeError) throw this.writeError;
    if (this.pendingWrite) {
      throw new ContextArtifactError('WRITE_FAILED', 'Context artifact source produced data while storage was backpressured');
    }
    if (chunk.length === 0) return true;
    this.store.reserveBytes(this.artifactId, this.sessionId, chunk.length);
    const position = this.rawBytes;
    this.rawBytes += chunk.length;
    this.hash.update(chunk);
    // Keep one immutable chunk alive until the positional write completes. The process owner
    // pauses both output sources immediately when this returns false, so there is never an
    // unbounded secondary queue behind HeadTailBuffer.
    const owned = Buffer.from(chunk);
    const pending = this.handle.write(owned, 0, owned.length, position).then(({ bytesWritten }) => {
      if (bytesWritten !== owned.length) {
        throw new ContextArtifactError('WRITE_FAILED', 'Context artifact storage performed a partial write');
      }
    }).catch((error) => {
      const failure = error instanceof ContextArtifactError
        ? error
        : new ContextArtifactError('WRITE_FAILED', 'Context artifact storage write failed');
      this.writeError = failure;
      throw failure;
    }).finally(() => {
      if (this.pendingWrite === pending) this.pendingWrite = null;
    });
    this.pendingWrite = pending;
    return false;
  }

  async waitForDrain(): Promise<void> {
    const pending = this.pendingWrite;
    if (pending) await pending;
    if (this.writeError) throw this.writeError;
  }

  async commit(): Promise<ContextArtifactDescriptor> {
    if (this.closed) throw new ContextArtifactError('WRITE_FAILED', 'Context artifact writer is closed');
    this.closed = true;
    try {
      await this.pendingWrite;
      if (this.writeError) throw this.writeError;
      await this.handle.sync();
      await this.handle.close();
      this.finished = true;

      const sha256 = this.hash.digest('hex');
      const createdAt = new Date().toISOString();
      const descriptor: ContextArtifactDescriptor = {
        version: 1,
        ref: `ctx_v1_${this.artifactId}`,
        artifactId: this.artifactId,
        sha256,
        rawBytes: this.rawBytes,
        kind: 'exec-output',
        state: 'committed',
        createdAt
      };
      const manifest: ContextArtifactManifest = {
        ...descriptor,
        sessionId: this.sessionId,
        operationId: this.operationId
      };
      await this.store.publish(this.artifactId, this.sessionId, this.temporaryRawPath, manifest);
      return descriptor;
    } catch (error) {
      if (!this.finished) await this.handle.close().catch(() => undefined);
      await fs.rm(this.temporaryRawPath, { force: true }).catch(() => undefined);
      this.store.releaseActiveBytes(this.artifactId, this.sessionId);
      if (error instanceof ContextArtifactError) throw error;
      throw new ContextArtifactError('WRITE_FAILED', 'Context artifact commit failed');
    } finally {
      this.resolveSettled();
    }
  }

  async abort(): Promise<void> {
    if (this.closed) {
      await this.settled;
      return;
    }
    this.closed = true;
    try {
      await this.pendingWrite?.catch(() => undefined);
      await this.handle.close().catch(() => undefined);
      await fs.rm(this.temporaryRawPath, { force: true }).catch(() => undefined);
      this.store.releaseActiveBytes(this.artifactId, this.sessionId);
    } finally {
      this.resolveSettled();
    }
  }

  /** Session deletion fences new writes, aborts open writers, and waits for an in-flight commit. */
  async retire(): Promise<void> {
    if (!this.closed) await this.abort();
    else await this.settled;
  }
}

export class ContextArtifactStore {
  private initialized: Promise<void> | null = null;
  private committedGlobalBytes = 0;
  private readonly committedSessionBytes = new Map<string, number>();
  private activeGlobalBytes = 0;
  private readonly activeSessionBytes = new Map<string, number>();
  private readonly activeArtifactBytes = new Map<string, number>();
  private readonly activeWriters = new Map<string, ContextArtifactWriter>();
  private readonly retiredSessions = new Set<string>();

  constructor(
    private readonly sessionsRoot: string,
    private readonly limits: {
      artifactBytes: number;
      sessionBytes: number;
      globalBytes: number;
    } = {
      artifactBytes: MAX_CONTEXT_ARTIFACT_BYTES,
      sessionBytes: MAX_CONTEXT_ARTIFACT_SESSION_BYTES,
      globalBytes: MAX_CONTEXT_ARTIFACT_GLOBAL_BYTES
    }
  ) {}

  async begin(options: {
    sessionId: string;
    operationId: string;
    kind: 'exec-output';
  }): Promise<ContextArtifactWriter> {
    safeSessionId(options.sessionId);
    if (!options.operationId) throw new ContextArtifactError('INVALID_REQUEST', 'Context artifact operation is required');
    if (this.retiredSessions.has(options.sessionId)) {
      throw new ContextArtifactError('NOT_AVAILABLE', 'Context artifact session is no longer available');
    }
    await this.ensureInitialized();
    const directory = await this.secureArtifactDirectory(options.sessionId, true);
    const artifactId = randomBytes(16).toString('hex');
    const temporaryRawPath = path.join(directory, `.${artifactId}.${randomBytes(8).toString('hex')}.creating`);
    const handle = await fs.open(temporaryRawPath, 'wx').catch((error) => {
      void error;
      throw new ContextArtifactError('WRITE_FAILED', 'Context artifact storage could not be opened');
    });
    if (this.retiredSessions.has(options.sessionId)) {
      await handle.close().catch(() => undefined);
      await fs.rm(temporaryRawPath, { force: true }).catch(() => undefined);
      throw new ContextArtifactError('NOT_AVAILABLE', 'Context artifact session is no longer available');
    }
    this.activeArtifactBytes.set(artifactId, 0);
    const writer = new ContextArtifactWriter(this, options.sessionId, options.operationId, artifactId, temporaryRawPath, handle);
    this.activeWriters.set(artifactId, writer);
    return writer;
  }

  async read(sessionId: string, ref: string, offset: number, length: number): Promise<ContextArtifactReadResult> {
    safeSessionId(sessionId);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > MAX_CONTEXT_ARTIFACT_READ_BYTES) {
      throw new ContextArtifactError('INVALID_REQUEST', `Read length must be 1-${MAX_CONTEXT_ARTIFACT_READ_BYTES} bytes and offset must be non-negative`);
    }
    await this.ensureInitialized();
    await this.secureArtifactDirectory(sessionId, false);
    const artifactId = artifactIdFromRef(ref);
    const manifest = await this.manifest(sessionId, artifactId);
    const raw = this.rawPath(sessionId, artifactId);
    const verified = await this.verify(raw, manifest);
    const end = Math.min(verified.size, offset + length);
    if (offset > verified.size) throw new ContextArtifactError('INVALID_REQUEST', 'Read offset is beyond the artifact');
    const bytes = Buffer.alloc(Math.max(0, end - offset));
    if (bytes.length > 0) {
      const handle = await fs.open(raw, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      try {
        let cursor = 0;
        while (cursor < bytes.length) {
          const result = await handle.read(bytes, cursor, bytes.length - cursor, offset + cursor);
          if (result.bytesRead === 0) throw new ContextArtifactError('CORRUPT', 'Context artifact changed while reading');
          cursor += result.bytesRead;
        }
      } finally { await handle.close(); }
    }
    return { ref, offset, end, total: verified.size, sha256: manifest.sha256, bytes };
  }

  async search(
    sessionId: string,
    ref: string,
    query: string,
    maxMatches = 10,
    contextBytes = 256
  ): Promise<ContextArtifactSearchResult> {
    safeSessionId(sessionId);
    const needle = Buffer.from(query, 'utf8');
    if (needle.length === 0 || needle.length > MAX_CONTEXT_ARTIFACT_QUERY_BYTES) {
      throw new ContextArtifactError('INVALID_REQUEST', `Search query must be 1-${MAX_CONTEXT_ARTIFACT_QUERY_BYTES} UTF-8 bytes`);
    }
    if (!Number.isSafeInteger(maxMatches) || maxMatches < 1 || maxMatches > MAX_CONTEXT_ARTIFACT_MATCHES ||
        !Number.isSafeInteger(contextBytes) || contextBytes < 0 || contextBytes > MAX_CONTEXT_ARTIFACT_CONTEXT_BYTES) {
      throw new ContextArtifactError('INVALID_REQUEST', 'Search bounds are invalid');
    }
    if (maxMatches * (needle.length + 2 * contextBytes) > MAX_CONTEXT_ARTIFACT_SEARCH_RESULT_BYTES) {
      throw new ContextArtifactError(
        'INVALID_REQUEST',
        `Search result bound exceeds ${MAX_CONTEXT_ARTIFACT_SEARCH_RESULT_BYTES} source bytes; reduce max_matches or context_bytes`
      );
    }
    await this.ensureInitialized();
    await this.secureArtifactDirectory(sessionId, false);
    const artifactId = artifactIdFromRef(ref);
    const manifest = await this.manifest(sessionId, artifactId);
    const raw = this.rawPath(sessionId, artifactId);
    let stat;
    try { stat = await fs.lstat(raw); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ContextArtifactError('NOT_AVAILABLE', 'Context artifact bytes are missing');
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== manifest.rawBytes) {
      throw new ContextArtifactError('CORRUPT', 'Context artifact file shape or byte count does not match committed metadata');
    }
    const positions: number[] = [];
    const hash = createHash('sha256');
    let total = 0;
    let carry = Buffer.alloc(0);
    for await (const value of createReadStream(raw, { highWaterMark: IO_CHUNK_BYTES })) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      hash.update(chunk);
      const combined = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      const base = total - carry.length;
      let from = 0;
      while (positions.length < maxMatches) {
        const found = combined.indexOf(needle, from);
        if (found < 0) break;
        const absolute = base + found;
        if (positions.length === 0 || absolute > positions[positions.length - 1]!) positions.push(absolute);
        from = found + Math.max(1, needle.length);
      }
      total += chunk.length;
      const overlap = Math.min(Math.max(0, needle.length - 1), combined.length);
      carry = overlap === 0 ? Buffer.alloc(0) : Buffer.from(combined.subarray(combined.length - overlap));
    }
    if (total !== manifest.rawBytes || hash.digest('hex') !== manifest.sha256) {
      throw new ContextArtifactError('CORRUPT', 'Context artifact digest or byte count does not match committed metadata');
    }
    const matches: ContextArtifactSearchMatch[] = [];
    for (const start of positions) {
      const end = start + needle.length;
      const contextStart = Math.max(0, start - contextBytes);
      const contextEnd = Math.min(total, end + contextBytes);
      const read = await this.readVerifiedRange(raw, contextStart, contextEnd - contextStart);
      matches.push({ start, end, contextStart, contextEnd, bytes: read, text: roundTripUtf8(read) });
    }
    return { ref, query, total, sha256: manifest.sha256, matches };
  }

  async sessionDeleting(sessionId: string): Promise<void> {
    safeSessionId(sessionId);
    await this.ensureInitialized();
    this.retiredSessions.add(sessionId);
    const active = [...this.activeWriters.entries()]
      .filter(([artifactId]) => this.activeArtifactBytes.has(artifactId))
      .map(([, writer]) => writer)
      .filter(writer => writer.sessionId === sessionId);
    await Promise.all(active.map(writer => writer.retire()));
  }

  async sessionDeleted(sessionId: string): Promise<void> {
    safeSessionId(sessionId);
    await this.sessionDeleting(sessionId);
    const committed = this.committedSessionBytes.get(sessionId) ?? 0;
    this.committedGlobalBytes = Math.max(0, this.committedGlobalBytes - committed);
    this.committedSessionBytes.delete(sessionId);
  }

  reserveBytes(artifactId: string, sessionId: string, delta: number): void {
    const currentArtifact = this.activeArtifactBytes.get(artifactId);
    if (currentArtifact === undefined) throw new ContextArtifactError('WRITE_FAILED', 'Context artifact writer is not active');
    const nextArtifact = currentArtifact + delta;
    const nextSession = (this.committedSessionBytes.get(sessionId) ?? 0) + (this.activeSessionBytes.get(sessionId) ?? 0) + delta;
    const nextGlobal = this.committedGlobalBytes + this.activeGlobalBytes + delta;
    if (nextArtifact > this.limits.artifactBytes || nextSession > this.limits.sessionBytes || nextGlobal > this.limits.globalBytes) {
      throw new ContextArtifactError('QUOTA_EXCEEDED', 'Context artifact retention quota exceeded');
    }
    this.activeArtifactBytes.set(artifactId, nextArtifact);
    this.activeSessionBytes.set(sessionId, (this.activeSessionBytes.get(sessionId) ?? 0) + delta);
    this.activeGlobalBytes += delta;
  }

  releaseActiveBytes(artifactId: string, sessionId: string): void {
    const bytes = this.activeArtifactBytes.get(artifactId);
    if (bytes === undefined) return;
    this.activeArtifactBytes.delete(artifactId);
    this.activeWriters.delete(artifactId);
    this.activeGlobalBytes = Math.max(0, this.activeGlobalBytes - bytes);
    const nextSession = Math.max(0, (this.activeSessionBytes.get(sessionId) ?? 0) - bytes);
    if (nextSession === 0) this.activeSessionBytes.delete(sessionId);
    else this.activeSessionBytes.set(sessionId, nextSession);
  }

  async publish(
    artifactId: string,
    sessionId: string,
    temporaryRawPath: string,
    manifest: ContextArtifactManifest
  ): Promise<void> {
    const bytes = this.activeArtifactBytes.get(artifactId);
    if (bytes === undefined || bytes !== manifest.rawBytes) {
      throw new ContextArtifactError('WRITE_FAILED', 'Context artifact byte accounting changed before commit');
    }
    const directory = this.artifactDirectory(sessionId);
    const raw = this.rawPath(sessionId, artifactId);
    const manifestPath = this.manifestPath(sessionId, artifactId);
    const temporaryManifest = path.join(directory, `.${artifactId}.${randomBytes(8).toString('hex')}.json.creating`);
    await fs.rename(temporaryRawPath, raw);
    try {
      const handle = await fs.open(temporaryManifest, 'wx');
      try {
        await handle.writeFile(JSON.stringify(manifest), 'utf8');
        await handle.sync();
      } finally { await handle.close(); }
      await fs.rename(temporaryManifest, manifestPath);
      await syncDirectory(directory);
      this.releaseActiveBytes(artifactId, sessionId);
      this.committedSessionBytes.set(sessionId, (this.committedSessionBytes.get(sessionId) ?? 0) + bytes);
      this.committedGlobalBytes += bytes;
    } catch (error) {
      await fs.rm(temporaryManifest, { force: true }).catch(() => undefined);
      await fs.rm(manifestPath, { force: true }).catch(() => undefined);
      await fs.rm(raw, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private artifactDirectory(sessionId: string): string {
    return path.join(this.sessionsRoot, sessionId, 'context-artifacts');
  }

  private async secureArtifactDirectory(sessionId: string, create: boolean): Promise<string> {
    const sessionDirectory = path.join(this.sessionsRoot, sessionId);
    let sessionStat;
    try { sessionStat = await fs.lstat(sessionDirectory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ContextArtifactError('NOT_AVAILABLE', 'Context artifact session is not available');
      }
      throw error;
    }
    if (!sessionStat.isDirectory() || sessionStat.isSymbolicLink()) {
      throw new ContextArtifactError('CORRUPT', 'Context artifact session path is not a regular directory');
    }
    const rootReal = await fs.realpath(this.sessionsRoot);
    const sessionReal = await fs.realpath(sessionDirectory);
    if (!insidePath(rootReal, sessionReal)) {
      throw new ContextArtifactError('CORRUPT', 'Context artifact session escapes the session store');
    }

    const directory = this.artifactDirectory(sessionId);
    if (create) {
      try { await fs.mkdir(directory); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    let artifactStat;
    try { artifactStat = await fs.lstat(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ContextArtifactError('NOT_AVAILABLE', 'Context artifact storage is not available');
      }
      throw error;
    }
    if (!artifactStat.isDirectory() || artifactStat.isSymbolicLink()) {
      throw new ContextArtifactError('CORRUPT', 'Context artifact storage is not a regular directory');
    }
    const artifactReal = await fs.realpath(directory);
    if (!samePath(artifactReal, path.join(sessionReal, 'context-artifacts'))) {
      throw new ContextArtifactError('CORRUPT', 'Context artifact storage escapes the owning session');
    }
    return directory;
  }

  private rawPath(sessionId: string, artifactId: string): string {
    return path.join(this.artifactDirectory(sessionId), `${artifactId}.bin`);
  }

  private manifestPath(sessionId: string, artifactId: string): string {
    return path.join(this.artifactDirectory(sessionId), `${artifactId}.json`);
  }

  private async ensureInitialized(): Promise<void> {
    this.initialized ??= this.initialize();
    return this.initialized;
  }

  private async initialize(): Promise<void> {
    let sessions: string[] = [];
    try { sessions = await fs.readdir(this.sessionsRoot); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return;
    }
    for (const sessionId of sessions) {
      if (!SESSION.test(sessionId)) continue;
      try {
        const sessionStat = await fs.lstat(path.join(this.sessionsRoot, sessionId));
        if (!sessionStat.isDirectory() || sessionStat.isSymbolicLink()) continue;
      } catch { continue; }
      const directory = this.artifactDirectory(sessionId);
      let names: string[];
      try {
        const artifactStat = await fs.lstat(directory);
        if (!artifactStat.isDirectory() || artifactStat.isSymbolicLink()) continue;
        names = await fs.readdir(directory);
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const name of names) {
        if (name.startsWith('.') && name.includes('.creating')) {
          await fs.rm(path.join(directory, name), { force: true }).catch(() => undefined);
        }
      }
      let sessionBytes = 0;
      const refreshed = await fs.readdir(directory).catch(() => [] as string[]);
      for (const name of refreshed) {
        const match = /^([0-9a-f]{32})\.bin$/.exec(name);
        if (!match) continue;
        const artifactId = match[1]!;
        try {
          await fs.stat(this.manifestPath(sessionId, artifactId));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            await fs.rm(this.rawPath(sessionId, artifactId), { force: true }).catch(() => undefined);
            continue;
          }
          throw error;
        }
        try {
          const stat = await fs.lstat(this.rawPath(sessionId, artifactId));
          if (stat.isFile() && !stat.isSymbolicLink()) sessionBytes += stat.size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      if (sessionBytes > 0) this.committedSessionBytes.set(sessionId, sessionBytes);
      this.committedGlobalBytes += sessionBytes;
    }
  }

  private async manifest(sessionId: string, artifactId: string): Promise<ContextArtifactManifest> {
    if (!ARTIFACT.test(artifactId)) throw new ContextArtifactError('INVALID_REQUEST', 'Invalid context artifact reference');
    let raw: string;
    try { raw = await fs.readFile(this.manifestPath(sessionId, artifactId), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ContextArtifactError('NOT_AVAILABLE', 'Context artifact is not available to this session');
      }
      throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw new ContextArtifactError('CORRUPT', 'Context artifact metadata is corrupt'); }
    if (!isCommittedManifest(parsed, sessionId, artifactId)) {
      throw new ContextArtifactError('CORRUPT', 'Context artifact metadata is invalid or belongs to another session');
    }
    return parsed;
  }

  private async verify(raw: string, manifest: ContextArtifactManifest): Promise<{ size: number }> {
    let stat;
    try { stat = await fs.lstat(raw); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ContextArtifactError('NOT_AVAILABLE', 'Context artifact bytes are missing');
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ContextArtifactError('CORRUPT', 'Context artifact is not a regular immutable file');
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const value of createReadStream(raw, { highWaterMark: IO_CHUNK_BYTES })) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      hash.update(chunk);
    }
    if (bytes !== manifest.rawBytes || bytes !== stat.size || hash.digest('hex') !== manifest.sha256) {
      throw new ContextArtifactError('CORRUPT', 'Context artifact digest or byte count does not match committed metadata');
    }
    return { size: bytes };
  }

  private async readVerifiedRange(raw: string, offset: number, length: number): Promise<Buffer> {
    const buffer = Buffer.alloc(length);
    if (length === 0) return buffer;
    const handle = await fs.open(raw, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      let cursor = 0;
      while (cursor < length) {
        const result = await handle.read(buffer, cursor, length - cursor, offset + cursor);
        if (result.bytesRead === 0) throw new ContextArtifactError('CORRUPT', 'Context artifact changed while reading');
        cursor += result.bytesRead;
      }
      return buffer;
    } finally { await handle.close(); }
  }
}
