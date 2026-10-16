import { z } from 'zod';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { videoEvidenceSchema, mediaAssetSchema, videoIdSchema, type VideoEvidence } from '../../shared/video-editing.js';
import { canonicalJson } from './identity.js';
import { unique } from './validation.js';
import { selectedFileMediaSchema } from './media-inventory.js';

const id = videoIdSchema, frame = z.number().int().nonnegative().max(1_000_000_000);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const artifactSchema = z.object({ path: z.string().min(1).max(4096), sha256: hash,
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
const stampSchema = z.object({ id, subjectId: id, observedAt: z.number().int().nonnegative() }).strict();
type Stamp = z.infer<typeof stampSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
/** The caller supplies current approved-path/capability checks, rechecked throughout acquisition. */
export type ArtifactAccess = (path: string) => Promise<string>;
export type Availability = 'KNOWN' | 'UNKNOWN' | 'UNAVAILABLE' | 'UNVERIFIED';
const producer = { name: 'cos-video-observation', version: '1' };

function bounded(raw: unknown): void {
  if (Buffer.byteLength(canonicalJson(raw)) > 1024 * 1024) throw new Error('Raw observation exceeds bound');
}
function evidence(raw: unknown, stamp: Stamp, subject: VideoEvidence['subject'], tool: string,
  source = producer, extra: Partial<VideoEvidence> = {}): VideoEvidence {
  bounded(raw); stampSchema.parse(stamp);
  return videoEvidenceSchema.parse({ id: stamp.id, subjectId: stamp.subjectId, subject, basis: 'measured',
    producer: source, observedAt: stamp.observedAt, confidence: 1, parents: [],
    acquisition: { tool, rawSha256: createHash('sha256').update(canonicalJson(raw)).digest('hex') }, ...extra });
}
function fileIdentity(stat: Awaited<ReturnType<typeof fs.stat>>) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}
/** Streaming content identity: no decoder, media import, or unbounded readFile. */
export async function inspectArtifact(input: string, access: ArtifactAccess, maxBytes = 256 * 1024 * 1024): Promise<Artifact> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 256 * 1024 * 1024) throw new Error('Artifact bound invalid');
  const target = await access(input);
  const handle = await fs.open(target, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || !before.size || before.size > maxBytes) throw new Error('Artifact size/type bound');
    if (await access(input) !== target) throw new Error('Artifact path changed');
    const digest = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const read = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!read.bytesRead) throw new Error('Artifact truncated');
      digest.update(buffer.subarray(0, read.bytesRead)); offset += read.bytesRead;
      if (offset % (4 * 1024 * 1024) === 0 && await access(input) !== target) throw new Error('Artifact access changed');
    }
    const after = await handle.stat();
    if (await access(input) !== target || fileIdentity(before) !== fileIdentity(after) ||
      fileIdentity(await fs.stat(target)) !== fileIdentity(before)) throw new Error('Artifact changed during acquisition');
    return artifactSchema.parse({ path: target, bytes: offset, sha256: digest.digest('hex') });
  } finally { await handle.close(); }
}

function integer(value: unknown): number | undefined {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return;
  const result = Number(value); return Number.isSafeInteger(result) && result > 0 ? result : undefined;
}
export function produceMedia(raw: unknown, rawArtifact: Artifact, stamp: Stamp, source = producer, provenance: unknown = raw) {
  bounded(raw); const observation = selectedFileMediaSchema.parse(raw), artifact = artifactSchema.parse(rawArtifact);
  if (observation.path !== artifact.path) throw new Error('Observed media path/content mismatch');
  const props = observation.properties;
  const fps = integer(props.FPS), durationFrames = integer(props.Frames);
  const resolution = typeof props.Resolution === 'string' ? /^(\d+)\s*x\s*(\d+)$/.exec(props.Resolution) : null;
  const codec = typeof props['Video Codec'] === 'string' && props['Video Codec'].trim() ? props['Video Codec'] : undefined;
  const audioCodec = typeof props['Audio Codec'] === 'string' && props['Audio Codec'].trim() ? props['Audio Codec'] : undefined;
  const audioChannels = integer(props['Audio Ch']);
  // Absence of a codec value is not proof that a stream is absent.
  const video = codec ? true : props.Type === 'Audio' ? false : undefined;
  const audio = audioCodec || audioChannels ? true : undefined;
  const record = evidence(provenance, stamp, 'media', 'resolve_inspect', source, { locator: artifact });
  const asset = mediaAssetSchema.parse({ id: stamp.subjectId, path: artifact.path, sha256: artifact.sha256,
    resolveMediaId: observation.unique_id, status: fps && durationFrames && video !== undefined && audio !== undefined ? 'complete' : 'partial',
    video, audio, audioChannels, codec, ...(resolution ? { width: Number(resolution[1]), height: Number(resolution[2]) } : {}),
    ...(fps ? { fps: { numerator: fps, denominator: 1 } } : {}), durationFrames,
    evidenceIds: [record.id], usableRanges: [], sceneRanges: [] });
  const availability: Record<string, Availability> = { container: 'UNKNOWN', beats: 'UNAVAILABLE', sections: 'UNAVAILABLE',
    energy: 'UNAVAILABLE', scenes: 'UNAVAILABLE', usableRanges: 'UNVERIFIED' };
  for (const field of ['video', 'audio', 'audioChannels', 'fps', 'durationFrames', 'width', 'height', 'codec'] as const)
    availability[field] = asset[field] === undefined ? 'UNKNOWN' : 'KNOWN';
  return { asset, evidence: record, availability };
}

export const timelinePageSchema = z.object({ observation_version: z.literal(1), adapter_version: id,
  project_unique_id: id, unique_id: id, name: z.string().max(128), fps: z.number().positive().max(240000),
  duration_frames: frame, start_frame: frame.nullable(), total: frame.max(500), offset: frame.max(500),
  limit: z.number().int().min(1).max(100), complete: z.boolean(), snapshot_sha256: hash,
  project_name:z.string().min(1).max(128).optional(),rough_cut_guard_version:z.union([z.literal(1),z.literal(2)]).optional(),source_end:z.literal('inclusive').optional(),
  inspection_errors: z.array(id).max(100), track_counts: z.object({ video: frame.max(32).nullable(), audio: frame.max(32).nullable(), subtitle: frame.max(32).nullable() }).strict(),
  ownership: z.object({ status: z.enum(['AI_OWNED', 'UNOWNED', 'UNVERIFIED']),
    creation_operation_id: id.nullable(), source_timeline_unique_id: id.nullable() }).strict(),
  items: z.array(z.object({ unique_id: id, name: z.string().max(4096), track_type: z.enum(['video', 'audio']),
    track_index: z.number().int().min(1).max(32), start: frame, end: frame, duration: frame.positive(),
    media_unique_id: id.nullable(), source_start: frame.nullable(), source_end: frame.nullable() }).strict()).max(100),
}).passthrough();
export function produceTimeline(rawPages: unknown, stamp: Stamp) {
  bounded(rawPages);
  const pages = z.array(timelinePageSchema).min(1).max(5).parse(rawPages), first = pages[0]!;
  if (stamp.subjectId !== first.unique_id) throw new Error('Timeline identity mismatch');
  const header = ({ items: _items, offset: _offset, limit: _limit, ...page }: typeof first) => page;
  if (pages.some(page => canonicalJson(header(page)) !== canonicalJson(header(first)))) throw new Error('Timeline snapshot changed between pages');
  let offset = 0, complete = first.complete && !first.inspection_errors.length && first.track_counts.subtitle === 0 &&
    first.track_counts.video !== null && first.track_counts.audio !== null;
  const blockers = [...first.inspection_errors];
  const items: NonNullable<VideoEvidence['timelineState']>['items'] = [];
  for (const page of pages) {
    if (page.offset !== offset || page.items.length !== Math.min(page.limit, page.total - page.offset)) complete = false;
    offset += page.items.length;
    for (const row of page.items) {
      if (first.start_frame === null || row.media_unique_id === null || row.source_start === null || row.source_end === null ||
        row.end - row.start !== row.duration || row.start < first.start_frame ||
        row.end - first.start_frame > first.duration_frames ||
        row.track_index > (first.track_counts[row.track_type] ?? 0) ||
        ![row.duration, row.duration - 1].includes(row.source_end - row.source_start)) { complete = false; continue; }
      // Convert only when the observed raw range and observed duration prove its convention.
      const end = row.source_end + (row.source_end - row.source_start === row.duration - 1 ? 1 : 0);
      items.push({ uniqueId: row.unique_id, mediaUniqueId: row.media_unique_id, mediaType: row.track_type, track: row.track_index,
        source: { start: row.source_start, end }, timeline: { start: row.start - first.start_frame, end: row.end - first.start_frame } });
    }
  }
  unique(pages.flatMap(page => page.items.map(row => row.unique_id)), 'observed item identities');
  if (offset !== first.total || items.length !== first.total || first.start_frame === null) complete = false;
  if (!Number.isInteger(first.fps)) blockers.push('NONINTEGER_TIMEBASE_UNVERIFIED');
  const ownership = first.ownership.status === 'AI_OWNED' && first.ownership.creation_operation_id ?
    { creationOperationId: first.ownership.creation_operation_id, sourceTimelineId: first.ownership.source_timeline_unique_id } : undefined;
  const record = evidence(rawPages, stamp, 'timeline', 'resolve_inspect',
    { name: 'cos-davinci-resolve', version: first.adapter_version },
    Number.isInteger(first.fps) ? { ...(first.project_name&&first.rough_cut_guard_version&&first.source_end==='inclusive'?{adapterDispatch:{snapshotSha256:first.snapshot_sha256,projectName:first.project_name,...(first.rough_cut_guard_version===2?{timelineName:first.name}:{}),guardVersion:first.rough_cut_guard_version,sourceEnd:'inclusive' as const}}:{}), timelineState: { resolveProjectId: first.project_unique_id,
      fps: { numerator: first.fps, denominator: 1 }, durationFrames: first.duration_frames, complete,
      ...(first.start_frame !== null ? { startFrame: first.start_frame } : {}), ownership, items } } : {});
  if (!complete) blockers.push('TIMELINE_INSPECTION_INCOMPLETE');
  return { evidence: record, status: complete && !blockers.length ? 'VERIFIED' as const : 'UNVERIFIED' as const, blockers };
}

export async function produceCapturedFrame(raw: unknown, stamp: Stamp, access: ArtifactAccess) {
  bounded(raw);
  const receipt = z.object({ requested: z.literal(true), executed: z.boolean(), verified: z.literal(true),
    after: z.object({ path: z.string().min(1).max(4096), exists: z.literal(true), non_empty: z.literal(true),
      timeline_unique_id: id, project_unique_id: id }).passthrough() }).passthrough().parse(raw);
  if (stamp.subjectId !== receipt.after.timeline_unique_id) throw new Error('Captured timeline frame identity mismatch');
  const artifact = await inspectArtifact(receipt.after.path, access, 5 * 1024 * 1024);
  const dimensions = await decodeImageArtifact(artifact, access);
  if (dimensions.format !== 'png') throw new Error('Frame decode unavailable');
  return { evidence: evidence(raw, stamp, 'frame', 'resolve_capture_frame', producer, { locator: artifact }),
    availability: { pixels: 'KNOWN' as Availability, framePosition: 'UNVERIFIED' as Availability },
    dimensions: { width: dimensions.width, height: dimensions.height } };
}

/** Reuse full bounded decoding for local references and captured stills; never infer video position. */
export async function decodeImageArtifact(rawArtifact: Artifact, access: ArtifactAccess) {
  const artifact = artifactSchema.parse(rawArtifact);
  if (artifact.bytes > 5 * 1024 * 1024 || await access(artifact.path) !== artifact.path) throw new Error('Image artifact access/bound');
  const handle = await fs.open(artifact.path, 'r');
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== artifact.bytes || stat.size > 5 * 1024 * 1024) throw new Error('Frame artifact bound/identity changed');
    bytes = Buffer.alloc(artifact.bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error('Frame artifact truncated');
      offset += read.bytesRead;
    }
    if (fileIdentity(stat) !== fileIdentity(await handle.stat())) throw new Error('Frame artifact changed');
  } finally { await handle.close(); }
  if (bytes.length !== artifact.bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('Frame artifact changed');
  const info = await sharp(bytes, { limitInputPixels: 16_000_000 }).metadata();
  if (!info.format || !['png', 'jpeg', 'webp'].includes(info.format) || !info.width || !info.height || info.width * info.height > 16_000_000) throw new Error('Frame decode unavailable');
  await sharp(bytes, { limitInputPixels: 16_000_000, failOn: 'warning' }).raw().toBuffer();
  if (await access(artifact.path) !== artifact.path) throw new Error('Frame access changed');
  return { width: info.width, height: info.height, format: info.format };
}
