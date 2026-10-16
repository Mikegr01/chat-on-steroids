import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import { mediaRuntimeAdmissionSchema, technicalMediaSchema, type MediaRuntimeAdmission, type MediaRuntimeDiagnostics, type TechnicalMedia } from '../../shared/media-runtime.js';
import { inspectArtifact, type ArtifactAccess } from './producers.js';
import { normalizeProbe, type MediaSource } from './media-probe.js';
const INPUT_LIMIT = 32 * 1024 * 1024, IMAGE_LIMIT = 5 * 1024 * 1024;
export interface ProcessRequest { executable: string; args: string[]; cwd: string; timeoutMs: number; maxStdout: number; maxStderr: number; input?: Buffer }
type ProcessResult = { stdout: Buffer; stderr: Buffer };
export type MediaRunner = (executable: string, args: string[], input?: Buffer) => Promise<ProcessResult>;
const active = new Set<ReturnType<typeof spawn>>();
let stopping = false;
export async function stopMediaProcesses() {
  stopping = true;
  await Promise.all([...active].map(child => new Promise<void>(resolve => { child.once('close', () => resolve()); child.kill('SIGKILL'); })));
}
/** One non-shell owner for all media subprocesses. No inherited PATH, stdin interactivity or unbounded output. */
export function runMediaProcess(request: ProcessRequest): Promise<ProcessResult> {
  if (stopping) return Promise.reject(new Error('Media runtime stopped'));
  if (!path.isAbsolute(request.executable) || !path.isAbsolute(request.cwd) || request.timeoutMs < 1 || request.timeoutMs > 30000 ||
    request.maxStdout < 1 || request.maxStdout > IMAGE_LIMIT || request.maxStderr < 1 || request.maxStderr > 1024 * 1024 ||
    (request.input?.length ?? 0) > INPUT_LIMIT) return Promise.reject(new Error('Media process request bound'));
  if (active.size >= 2) return Promise.reject(new Error('Media process concurrency bound'));
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {};
    const child = spawn(request.executable, request.args, { cwd: request.cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    active.add(child); const stdout: Buffer[] = [], stderr: Buffer[] = []; let outBytes = 0, errBytes = 0, failure: Error | undefined;
    const fail = (reason: string) => { failure ??= new Error(reason); child.kill('SIGKILL'); };
    const timer = setTimeout(() => fail('Media process timeout'), request.timeoutMs);
    child.stdout!.on('data', (chunk: Buffer) => { outBytes += chunk.length; if (outBytes > request.maxStdout) fail('Media stdout bound'); else stdout.push(chunk); });
    child.stderr!.on('data', (chunk: Buffer) => { errBytes += chunk.length; if (errBytes > request.maxStderr) fail('Media stderr bound'); else stderr.push(chunk); });
    child.on('error', error => { failure ??= error; });
    child.stdin!.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') fail('Media input failed'); });
    child.on('close', code => {
      clearTimeout(timer); active.delete(child);
      if (failure) reject(failure); else if (code !== 0) reject(new Error(`Media exit ${code}: ${Buffer.concat(stderr).toString('utf8').slice(-2000)}`));
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    child.stdin!.end(request.input);
  });
}
function runnerFor(test?: MediaRunner): MediaRunner {
  if (test) {
    if (process.env.NODE_ENV !== 'test' || process.env.VITEST !== 'true') throw new Error('Injected media runner requires tests');
    return test;
  }
  return (executable, args, input) => runMediaProcess({ executable, args, input, cwd: tmpdir(),
    timeoutMs: 10000, maxStdout: args.includes('-version') ? 8192 : (args.includes('-show_streams') || args.includes('-show_frames')) ? 1024 * 1024 : IMAGE_LIMIT, maxStderr: 256 * 1024 });
}
async function executable(input: string) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) throw new Error('Media executable absolute path required');
  await fs.access(input, fs.constants.X_OK);
  return inspectArtifact(input, p => fs.realpath(p));
}
async function verifyIdentity(identity: MediaRuntimeAdmission['ffprobe']) {
  const current = await executable(identity.path);
  if (current.path !== identity.path || current.sha256 !== identity.sha256 || current.bytes !== identity.bytes || identity.platform !== process.platform) throw new Error('Executable identity changed; re-admission required');
}
const decoderLimits = ['-threads', '1', '-max_alloc', '33554432'];
const probeArgs = ['-v', 'error', '-show_format', '-show_streams', '-of', 'json'];
export async function admitMediaRuntime(paths: { ffprobePath: string; ffmpegPath: string }, test?: MediaRunner): Promise<MediaRuntimeAdmission> {
  const run = runnerFor(test), identities = [];
  for (const [name, input] of [['ffprobe', paths.ffprobePath], ['ffmpeg', paths.ffmpegPath]] as const) {
    const artifact = await executable(input), result = await run(artifact.path, ['-version']);
    const output = result.stdout.toString('utf8'), version = new RegExp(`^${name} version ([^\\s]+)`).exec(output)?.[1];
    if (!version || output.length > 8192) throw new Error('Media version malformed');
    const identity = { ...artifact, version, versionOutput: output, platform: process.platform, admittedAt: Date.now() };
    await verifyIdentity(identity); identities.push(identity);
  }
  const [ffprobe, ffmpeg] = identities as [MediaRuntimeAdmission['ffprobe'], MediaRuntimeAdmission['ffmpeg']];
  const proof = await run(ffprobe.path, [...decoderLimits, ...probeArgs, '-f', 'lavfi', '-i', 'color=size=16x16:rate=24000/1001:duration=0.05']);
  const parsed = JSON.parse(proof.stdout.toString('utf8'));
  const technical = normalizeProbe(parsed, { jobId: 'runtime-admission', assetId: 'capability', artifact: { path: 'internal-lavfi', bytes: 1, sha256: '0'.repeat(64) } }, ffprobe, proof.stdout);
  if (!technical.streams.some(row => row.kind === 'video' && row.timeBase && row.avgFrameRate)) throw new Error('JSON rational probe capability unsupported');
  const enumeration=await run(ffprobe.path,[...decoderLimits,'-v','error','-f','lavfi','-i','color=size=16x16:rate=24000/1001:duration=0.05',
    '-read_intervals','%+#3','-show_frames','-show_entries','frame=stream_index,pts','-of','json']);
  const positionCapability=z.object({frames:z.array(z.object({stream_index:z.number().int().nonnegative(),pts:z.number().int().safe()})).min(1).max(48)}).passthrough().parse(JSON.parse(enumeration.stdout.toString('utf8')));
  if(positionCapability.frames.some((row,index,rows)=>index>0 && row.pts<=rows[index-1]!.pts)) throw new Error('Decoded position capability unsupported');
  const image = await run(ffmpeg.path, ['-hide_banner', '-nostdin', ...decoderLimits, '-f', 'lavfi', '-i', 'color=size=16x16:duration=0.05',
    '-vf', 'select=eq(n\\,0),showinfo', '-frames:v', '1', '-threads', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1']);
  const info = await sharp(image.stdout, { limitInputPixels: 256 }).raw().toBuffer({ resolveWithObject: true });
  if ((await sharp(image.stdout).metadata()).format !== 'png' || info.info.width !== 16 || info.info.height !== 16 || !image.stderr.toString().includes('pts_time:')) throw new Error('PNG/position capability unsupported');
  await verifyIdentity(ffprobe); await verifyIdentity(ffmpeg);
  return mediaRuntimeAdmissionSchema.parse({ version: 1, strategy: 'operator-managed', ffprobe, ffmpeg, capabilities: { jsonProbe: 'SUPPORTED', pngFrames: 'SUPPORTED', decodedFramePositions:'SUPPORTED' } });
}
export async function mediaRuntimeDiagnostics(raw: unknown): Promise<MediaRuntimeDiagnostics> {
  if(raw==null) return {status:'NOT_CONFIGURED' as const,ffprobe:{status:'NOT_CONFIGURED' as const},ffmpeg:{status:'NOT_CONFIGURED' as const}};
  const parsed=mediaRuntimeAdmissionSchema.safeParse(raw);
  if(!parsed.success) return {status:'UNSUPPORTED' as const,ffprobe:{status:'UNSUPPORTED' as const},ffmpeg:{status:'UNSUPPORTED' as const}};
  const inspect=async(identity:MediaRuntimeAdmission['ffprobe'])=>{
    let status:'CONFIGURED'|'IDENTITY_CHANGED'='CONFIGURED';
    try{await verifyIdentity(identity);}catch{status='IDENTITY_CHANGED';}
    return {status,path:identity.path,admittedVersion:identity.version,admittedSha256:identity.sha256};
  };
  const [ffprobe,ffmpeg]=await Promise.all([inspect(parsed.data.ffprobe),inspect(parsed.data.ffmpeg)]);
  const status=ffprobe.status==='CONFIGURED' && ffmpeg.status==='CONFIGURED'?'CONFIGURED' as const:'IDENTITY_CHANGED' as const;
  return {status,ffprobe,ffmpeg,capabilities:parsed.data.capabilities,runtime:status==='CONFIGURED'?parsed.data:undefined};
}
export class MediaRuntime {
  readonly admission: MediaRuntimeAdmission; private readonly run: MediaRunner;
  constructor(raw: unknown, test?: MediaRunner) { this.admission = mediaRuntimeAdmissionSchema.parse(raw); this.run = runnerFor(test); }
  private async input(source: MediaSource, access: ArtifactAccess, tool: 'ffprobe' | 'ffmpeg') {
    await verifyIdentity(this.admission[tool]);
    const current = await inspectArtifact(source.artifact.path, access, INPUT_LIMIT);
    if (!source.jobId || !source.assetId || current.path !== source.artifact.path || current.sha256 !== source.artifact.sha256 || current.bytes !== source.artifact.bytes) throw new Error('Source identity mismatch');
    const handle = await fs.open(current.path, 'r');
    const bytes = Buffer.alloc(current.bytes);
    try {
      if ((await handle.stat()).size !== current.bytes) throw new Error('Source identity changed');
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) throw new Error('Source truncated'); offset += read.bytesRead;
      }
      if ((await handle.stat()).size !== current.bytes) throw new Error('Source identity changed');
    } finally { await handle.close(); }
    if (bytes.length !== current.bytes || createHash('sha256').update(bytes).digest('hex') !== current.sha256 || await access(current.path) !== current.path) throw new Error('Source identity changed');
    return bytes;
  }
  private async after(source: MediaSource, access: ArtifactAccess, tool: 'ffprobe' | 'ffmpeg') {
    await verifyIdentity(this.admission[tool]);
    const after = await inspectArtifact(source.artifact.path, access, INPUT_LIMIT);
    if (after.path !== source.artifact.path || after.sha256 !== source.artifact.sha256 || after.bytes !== source.artifact.bytes) throw new Error('Source identity changed');
  }
  async probe(source: MediaSource, access: ArtifactAccess) {
    const bytes = await this.input(source, access, 'ffprobe');
    const result = await this.run(this.admission.ffprobe.path, [...decoderLimits, '-protocol_whitelist', 'pipe',
      '-format_whitelist', 'mov,matroska,avi,wav,mp3,flac,ogg', ...probeArgs, '-i', 'pipe:0'], bytes);
    if (result.stdout.length > 1024 * 1024) throw new Error('Probe JSON bound');
    const technical = normalizeProbe(JSON.parse(result.stdout.toString('utf8')), source, this.admission.ffprobe, result.stdout);
    await this.after(source, access, 'ffprobe');
    return { technical, semantic: { scenes: 'UNAVAILABLE', beats: 'UNAVAILABLE', sections: 'UNAVAILABLE', energy: 'UNAVAILABLE' } as const };
  }
  /** Stronger optional correspondence: enumerate decoded frame PTS independently, never turn seek intent into position proof. */
  async positionedFrame(source:MediaSource,technical:TechnicalMedia,requested:{frameIndex:number;streamIndex:number},access:ArtifactAccess) {
    const sample=await this.frame(source,technical,requested,access);
    const bytes=await this.input(source,access,'ffprobe');
    const result=await this.run(this.admission.ffprobe.path,[...decoderLimits,'-v','error','-protocol_whitelist','pipe',
      '-format_whitelist','mov,matroska,avi,wav,mp3,flac,ogg','-select_streams',String(requested.streamIndex),
      '-read_intervals','%+#1100','-show_frames','-show_entries','frame=stream_index,pts','-of','json','-i','pipe:0'],bytes);
    if(result.stdout.length>1024*1024) throw new Error('Frame metadata bound');
    const parsed=z.object({frames:z.array(z.object({stream_index:z.number().int().nonnegative(),
      pts:z.union([z.number().int().safe(),z.string().regex(/^-?\d+$/)]).optional()}).passthrough()).max(1100)}).passthrough().parse(JSON.parse(result.stdout.toString('utf8')));
    await this.after(source,access,'ffprobe');
    const frames=parsed.frames,stream=technical.streams.find(row=>row.index===requested.streamIndex),base=stream?.timeBase;
    const pts=frames.map(row=>row.pts===undefined?undefined:Number(row.pts)),selected=pts[requested.frameIndex];
    const actual=sample.actual?.timestamp;
    const valid=!!actual && !!base && frames.length>requested.frameIndex && frames.every(row=>row.stream_index===requested.streamIndex) &&
      pts.every((value,index)=>value!==undefined && Number.isSafeInteger(value) && value>=0 && (index===0 || value>pts[index-1]!)) && new Set(pts).size===pts.length &&
      selected!==undefined && BigInt(selected)*BigInt(base.numerator)*BigInt(actual.denominator)===BigInt(actual.numerator)*BigInt(base.denominator);
    return {...sample,verifiedFrameIndex:valid?requested.frameIndex:undefined,positionProof:{
      sourceHash:source.artifact.sha256,executableHash:this.admission.ffprobe.sha256,producerVersion:this.admission.ffprobe.version,
      rawSha256:createHash('sha256').update(result.stdout).digest('hex'),observedAt:Date.now(),decodedFrames:frames.length,
      classification:valid?'INDEPENDENT_DECODED_PTS_MATCH' as const:'UNVERIFIED' as const}};
  }
  async frame(source: MediaSource, rawTechnical: TechnicalMedia, requested: { frameIndex: number; streamIndex: number }, access: ArtifactAccess) {
    const technical = technicalMediaSchema.parse(rawTechnical), stream = technical.streams.find(row => row.index === requested.streamIndex && row.kind === 'video');
    if (technical.jobId !== source.jobId || technical.assetId !== source.assetId || technical.sourceHash !== source.artifact.sha256 ||
      technical.producer.executableHash !== this.admission.ffprobe.sha256) throw new Error('Technical source identity mismatch');
    if (!stream?.width || !stream.height || stream.width * stream.height > 16_000_000 || !Number.isInteger(requested.frameIndex) ||
      requested.frameIndex < 0 || requested.frameIndex > 1000 || stream.frameCount !== undefined && requested.frameIndex >= stream.frameCount) throw new Error('Frame range/dimension bound');
    const bytes = await this.input(source, access, 'ffmpeg');
    const result = await this.run(this.admission.ffmpeg.path, ['-hide_banner', '-nostdin', ...decoderLimits,
      '-protocol_whitelist', 'pipe', '-format_whitelist', 'mov,matroska,avi,wav,mp3,flac,ogg', '-i', 'pipe:0',
      '-map', `0:${stream.index}`, '-vf', `select=eq(n\\,${requested.frameIndex}),showinfo,scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease`,
      '-frames:v', '1', '-threads', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'], bytes);
    if (!result.stdout.length || result.stdout.length > IMAGE_LIMIT) throw new Error('Frame artifact bound/unavailable');
    const info = await sharp(result.stdout, { limitInputPixels: 2_073_600, failOn: 'warning' }).raw().toBuffer({ resolveWithObject: true });
    const metadata = await sharp(result.stdout).metadata();
    if (metadata.format !== 'png' || info.info.width > 1920 || info.info.height > 1080) throw new Error('Frame format/dimension bound');
    const lines = result.stderr.toString('utf8').split('\n').filter(line => /n:\s*0\s+pts:/.test(line));
    const pts = lines.length === 1 ? /pts:\s*(-?\d+)\s+pts_time:([\d.e+-]+)/.exec(lines[0]!) : null;
    const timebase = stream.timeBase;
    const value = pts ? Number(pts[1]) : undefined;
    const observedBase = /config in time_base:\s*(\d+)\/(\d+)/.exec(result.stderr.toString('utf8'));
    const baseMatches = !!timebase && !!observedBase && Number(observedBase[1]) === timebase.numerator && Number(observedBase[2]) === timebase.denominator;
    const actual = value !== undefined && Number.isSafeInteger(value) && value >= 0 && timebase && baseMatches && Number.isSafeInteger(value * timebase.numerator) ?
      { timestamp: { numerator: value * timebase.numerator, denominator: timebase.denominator } } : undefined;
    await this.after(source, access, 'ffmpeg');
    return { sourceHash: source.artifact.sha256, requested, actual, position: actual ? 'OBSERVED_TIMESTAMP' as const : 'UNVERIFIED' as const,
      confidence: actual ? 1 : 0, producer: { name: 'ffmpeg' as const, version: this.admission.ffmpeg.version, executableHash: this.admission.ffmpeg.sha256 },
      decodeSha256: createHash('sha256').update(result.stderr).digest('hex'), png: result.stdout,
      image: { sha256: createHash('sha256').update(result.stdout).digest('hex'), bytes: result.stdout.length, width: info.info.width, height: info.info.height } };
  }
}
