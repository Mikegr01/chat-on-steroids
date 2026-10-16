import path from 'node:path';
import { createHash } from 'node:crypto';
import { sourceUsabilityBindingSchema, sourceUsabilityInputSchema, type VideoEditingDocument,
  type SourceUsabilityDecision, type SourceUsabilityInput } from '../../shared/video-editing.js';
import { canonicalJson } from './identity.js';

/** Durable measured identity only. Usability is operator intent, never a consequence of frame count. */
export function sourceUsabilityBinding(job: VideoEditingDocument, assetId: string) {
  const input = job.workflow?.request.assets.find(row => row.id === assetId && row.role === 'source' && row.kind === 'video');
  const asset = job.media.find(row => row.id === assetId);
  if (!input || !asset || !asset.resolveMediaId || asset.resolveMediaId !== input.resolveMediaId ||
    !path.isAbsolute(asset.path) || asset.status === 'unavailable' || !asset.durationFrames || !asset.fps || !asset.video)
    throw new Error('Source usability requires exact ingested video source');
  const records = asset.evidenceIds.map(id => job.evidence.find(row => row.id === id));
  if (records.some(row => !row || row.subject !== 'media' || row.subjectId !== assetId)) throw new Error('Source evidence missing');
  const measured = records.filter(row => row!.basis === 'measured').map(row => row!);
  const sameLocator = (row: typeof measured[number]) => row.locator?.path === asset.path && row.locator.sha256 === asset.sha256;
  const probe = asset.technical, videos = probe?.streams.filter(row => row.kind === 'video');
  if (!probe || probe.jobId !== job.id || probe.assetId !== asset.id || probe.sourceHash !== asset.sha256 ||
    videos?.length !== 1 || !videos[0]!.frameCount || asset.durationFrames > videos[0]!.frameCount ||
    !measured.some(row => sameLocator(row) && row.acquisition?.tool === 'resolve_inspect') ||
    !measured.some(row => sameLocator(row) && row.producer.name === 'ffprobe' && row.acquisition?.tool === 'ffprobe' &&
      row.acquisition.rawSha256 === probe.rawSha256 && canonicalJson(row.technical) === canonicalJson(probe)))
    throw new Error('Source usability requires durable measured Resolve and hash-bound probe evidence');
  const evidenceHash = createHash('sha256').update(canonicalJson({
    media: { id: asset.id, path: asset.path, sha256: asset.sha256, resolveMediaId: asset.resolveMediaId,
      fps: asset.fps, durationFrames: asset.durationFrames, technical: probe },
    evidence: measured.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  })).digest('hex');
  return sourceUsabilityBindingSchema.parse({ jobId: job.id, assetId, resolveMediaId: asset.resolveMediaId,
    path: asset.path, sha256: asset.sha256, frameCount: videos[0]!.frameCount, evidenceHash });
}

export function assertSourceUsabilityMutable(job: VideoEditingDocument) {
  const state = job.workflow;
  if (!state || !(['evidence-ready', 'candidates-ready'].includes(state.phase) || state.phase === 'blocked' && state.blockedAt === 'planning') ||
    state.selection || state.prepared || job.operatorAuthorizations?.length || job.checkpoints.length || job.reviews.length || job.revisions.length)
    throw new Error('Source usability requires pre-selection evidence without authority or execution custody');
}

export function canonicalSourceRanges(job: VideoEditingDocument, input: SourceUsabilityInput) {
  const ranges = input.ranges.map(row => ({ ...row })).sort((a, b) => a.start - b.start || a.end - b.end);
  const asset = job.media.find(row => row.id === input.binding.assetId)!;
  const requested = job.workflow!.request.assets.find(row => row.id === asset.id)!.usable?.ranges;
  for (let i = 0; i < ranges.length; i++) {
    const row = ranges[i]!;
    if (i && row.start < ranges[i - 1]!.end) throw new Error('Usable ranges overlap or duplicate');
    if (row.end > input.binding.frameCount || row.end > asset.durationFrames!) throw new Error('Usable range exceeds measured frame count');
    const duration = asset.technical?.format.duration;
    if (duration && row.end * asset.fps!.denominator / asset.fps!.numerator > duration.numerator / duration.denominator)
      throw new Error('Usable range exceeds measured duration');
    if (requested && !requested.some(bound => bound.start <= row.start && bound.end >= row.end))
      throw new Error('Usable range widens immutable request constraint');
  }
  return ranges;
}

export function validateSourceUsabilityInput(job: VideoEditingDocument, raw: unknown) {
  assertSourceUsabilityMutable(job);
  const input = sourceUsabilityInputSchema.parse(raw);
  if (canonicalJson(input.binding) !== canonicalJson(sourceUsabilityBinding(job, input.binding.assetId)))
    throw new Error('Source usability evidence binding changed');
  const ranges = canonicalSourceRanges(job, input);
  const previous = job.workflow!.sourceUsability?.find(row => row.binding.assetId === input.binding.assetId);
  const identical = previous && canonicalJson(previous.binding) === canonicalJson(input.binding) && canonicalJson(previous.ranges) === canonicalJson(ranges);
  if (input.expectedRevision > job.workflow!.revision || input.expectedRevision !== job.workflow!.revision && !identical)
    throw new Error('Workflow owner/revision changed');
  return { ...input, ranges };
}

export function validateSourceUsabilityDecision(job: VideoEditingDocument, decision: SourceUsabilityDecision) {
  if (decision.sessionId !== job.sessionId || decision.localProjectId !== job.localProjectId || decision.resolveProjectId !== job.resolveProjectId ||
    decision.revision > job.workflow!.revision || canonicalJson(decision.binding) !== canonicalJson(sourceUsabilityBinding(job, decision.binding.assetId)))
    throw new Error('Source usability owner/evidence binding mismatch');
  const ranges = canonicalSourceRanges(job, { binding: decision.binding, ranges: decision.ranges, expectedRevision: decision.revision });
  if (canonicalJson(ranges) !== canonicalJson(decision.ranges)) throw new Error('Source usability ranges not canonical');
}

/** One range authority: an explicit decision narrows existing request bounds or establishes omitted ones. */
export function effectiveSourceUsableRanges(job: VideoEditingDocument, assetId: string) {
  const decision = job.workflow?.sourceUsability?.find(row => row.binding.assetId === assetId);
  if (!decision) return job.media.find(row => row.id === assetId)?.usableRanges ?? [];
  try { validateSourceUsabilityDecision(job, decision); return decision.ranges; }
  catch { return []; } // Changed/unknown evidence never lends stale usability to plan feasibility.
}
