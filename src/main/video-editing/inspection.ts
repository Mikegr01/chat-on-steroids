import { z } from 'zod';
import { createHash } from 'node:crypto';
import { videoEvidenceSchema, outputReviewSchema, type OutputReview, type VideoEditingDocument } from '../../shared/video-editing.js';
import { timelinePageSchema, produceTimeline, produceMedia, inspectArtifact, type ArtifactAccess } from './producers.js';
import { mediaInventoryRowSchema, selectedFileMediaSchema } from './media-inventory.js';
import { canonicalJson } from './identity.js';
import { evaluateOutputReview } from './review.js';
import { validateDocument, sameRate } from './validation.js';

export type ResolveReadCall = (name: 'resolve_inspect' | 'resolve_render_status', args: Record<string, unknown>) => Promise<unknown>;
// Matches adapter 1.0.3's existing MEDIA_OBSERVATION_LIMIT and public page limit.
export const MEDIA_DISCOVERY_LIMITS = { pageSize: 100, items: 10_000, pages: 100, selectedBytes: 1024 * 1024 } as const;
const mediaPageSchema = z.object({ project_unique_id: z.string().min(1).max(128), adapter_version: z.string().min(1).max(128),
  total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), offset: z.number().int().nonnegative(),
  limit: z.literal(MEDIA_DISCOVERY_LIMITS.pageSize), complete: z.literal(true).optional(),
  inspection_errors: z.array(z.never()).optional(),
  items: z.array(mediaInventoryRowSchema).max(MEDIA_DISCOVERY_LIMITS.pageSize) }).passthrough();
type MediaSelection = { mediaPoolId: string; mediaId: string; stamp: { id: string; observedAt: number } };
function bounded(raw: unknown) {
  if (Buffer.byteLength(canonicalJson(raw)) > 1024 * 1024) throw new Error('Observation exceeds bound');
}
/** Acquisition port has no mutation method; interpretation remains in the domain validators. */
export class ResolveEvidenceReader {
  constructor(private readonly call: ResolveReadCall) {}
  async timeline(timelineId: string, stamp: { id: string; observedAt: number }) {
    const pages: z.infer<typeof timelinePageSchema>[] = [];
    let offset = 0;
    do {
      const raw = await this.call('resolve_inspect', { selector: 'timeline', timeline_unique_id: timelineId, offset, limit: 100 });
      bounded(raw); const page = timelinePageSchema.parse(raw);
      if (page.offset !== offset || page.limit !== 100 || page.unique_id !== timelineId ||
        page.items.length !== Math.min(100, page.total - offset)) throw new Error('Timeline page receipt mismatch');
      pages.push(page); offset += page.items.length;
      if (pages.length >= 5 && offset < page.total) throw new Error('Timeline page bound');
      if (offset >= page.total) break;
    } while (true);
    return produceTimeline(pages, { ...stamp, subjectId: timelineId });
  }
  async media(mediaPoolId: string, mediaId: string, stamp: { id: string; observedAt: number }, access: ArtifactAccess) {
    return (await this.mediaBatch([{ mediaPoolId, mediaId, stamp }], access))[0]!;
  }
  /** One job acquisition, retaining only exact selections, bounded IDs and ordered page digests.
   * The adapter walks folders without a snapshot token or enforced ID uniqueness. Finding all
   * targets cannot prove uniqueness: cover the inventory, then repeat after hashing artifacts.
   * Page equality proves the observations, not an atomic Resolve snapshot between reads. */
  async mediaBatch(selections: MediaSelection[], access: ArtifactAccess) {
    if (!selections.length || selections.length > 100 || selections.some(row => !row.mediaPoolId)) throw new Error('Media selection bound/identity invalid');
    const wanted = new Set(selections.map(row => row.mediaPoolId));
    const selected = new Map<string, z.infer<typeof mediaPageSchema>['items'][number]>();
    const scan = async (expected?: { projectId: string; adapterVersion: string; total: number; pages: string[] }) => {
      const seen = new Set<string>(), pages: string[] = [];
      let identity: { projectId: string; adapterVersion: string; total: number } | undefined, selectedBytes = 0;
      for (let offset = 0; pages.length < MEDIA_DISCOVERY_LIMITS.pages; offset += MEDIA_DISCOVERY_LIMITS.pageSize) {
        const raw = await this.call('resolve_inspect', { selector: 'media', offset, limit: MEDIA_DISCOVERY_LIMITS.pageSize });
        bounded(raw); const parsed = mediaPageSchema.safeParse(raw);
        if (!parsed.success) throw new Error('Media page receipt invalid or incomplete');
        const page = parsed.data;
        if (page.total > MEDIA_DISCOVERY_LIMITS.items) throw new Error('Media discovery bound: inventory exceeds 10000 items');
        if (page.offset !== offset || offset > page.total || page.items.length !== Math.min(MEDIA_DISCOVERY_LIMITS.pageSize, page.total - offset))
          throw new Error('Media page receipt mismatch');
        const current = { projectId: page.project_unique_id, adapterVersion: page.adapter_version, total: page.total };
        identity ??= current;
        if (canonicalJson(current) !== canonicalJson(identity)) throw new Error('Media inventory identity/total changed during pagination');
        const digest = createHash('sha256').update(canonicalJson(raw)).digest('hex');
        if (expected && (canonicalJson(current) !== canonicalJson({ projectId: expected.projectId, adapterVersion: expected.adapterVersion, total: expected.total }) ||
          digest !== expected.pages[pages.length])) throw new Error('Media observation changed during artifact acquisition');
        pages.push(digest);
        for (const row of page.items) {
          if (seen.has(row.unique_id)) throw new Error('Media identity duplicate or ambiguous');
          seen.add(row.unique_id);
          if (!expected && wanted.has(row.unique_id)) {
            selectedBytes += Buffer.byteLength(canonicalJson(row));
            if (selectedBytes > MEDIA_DISCOVERY_LIMITS.selectedBytes) throw new Error('Media selected observation bound');
            selected.set(row.unique_id, row);
          }
        }
        if (offset + page.items.length === page.total) return { ...identity, pages };
      }
      throw new Error('Media discovery page bound');
    };
    const first = await scan();
    if (selected.size !== wanted.size) throw new Error('Media identity missing or ambiguous after complete discovery');
    // Validate every exact selection before any artifact access. Enumeration validity
    // alone grants no permission to canonicalize/hash/probe a non-file pool entity.
    for (const row of selected.values()) if (!selectedFileMediaSchema.safeParse(row).success)
      throw new Error('Selected media is not a file-backed source');
    const artifacts = new Map<string, Awaited<ReturnType<typeof inspectArtifact>>>();
    for (const [id, row] of selected) artifacts.set(id, await inspectArtifact(row.path, access));
    const repeated = await scan(first);
    // Hashing is bounded/streamed by the approved artifact owner; a source edit during the
    // second scan must not publish the first hash as current job evidence.
    for (const [id, row] of selected) {
      const checked = await inspectArtifact(row.path, access);
      if (canonicalJson(checked) !== canonicalJson(artifacts.get(id))) throw new Error('Media artifact path/content changed');
    }
    return selections.map(({ mediaPoolId, mediaId, stamp }) => {
      const observation = selected.get(mediaPoolId)!, artifact = artifacts.get(mediaPoolId)!;
      const result = produceMedia({ ...observation, path: artifact.path }, artifact, { ...stamp, subjectId: mediaId },
        { name: 'cos-davinci-resolve', version: first.adapterVersion }, { selection: observation, discovery: [first, repeated] });
      return { ...result, resolveProjectId: first.projectId };
    });
  }
  async render(jobId: string, operationId: string, timelineId: string, stamp: { id: string; observedAt: number }, access: ArtifactAccess) {
    const raw = await this.call('resolve_render_status', { job_id: jobId }); bounded(raw);
    const status = z.object({ job_id: z.literal(jobId), operation_id: z.literal(operationId), timeline_unique_id: z.literal(timelineId),
      status: z.literal('Complete'), verified: z.literal(true), artifact_exists: z.literal(true),
      output_path_matches_expected: z.literal(true), expected_output_path: z.string().min(1), output_path: z.string().min(1) }).passthrough().parse(raw);
    const artifact = await inspectArtifact(status.output_path, access);
    if (await access(status.expected_output_path) !== artifact.path) throw new Error('Render expected path mismatch');
    const repeated = await this.call('resolve_render_status', { job_id: jobId }); bounded(repeated);
    if (canonicalJson(repeated) !== canonicalJson(raw)) throw new Error('Render observation changed during artifact acquisition');
    const record = videoEvidenceSchema.parse({ id: stamp.id, subject: 'render', subjectId: jobId, basis: 'measured',
      producer: { name: 'cos-resolve-render-artifact', version: '1' }, observedAt: stamp.observedAt, confidence: 1,
      parents: [], locator: artifact, acquisition: { tool: 'resolve_render_status',
        rawSha256: createHash('sha256').update(canonicalJson([raw, repeated])).digest('hex') } });
    // Resolve queue status has no decoded duration/timebase/frame-position proof.
    return { evidence: record, availability: { artifact: 'KNOWN', durationFrames: 'UNAVAILABLE', fps: 'UNAVAILABLE',
      frames: 'UNAVAILABLE', creative: 'UNAVAILABLE' } as const };
  }
}

/** Connect structured output to the existing reviewer while keeping perception explicitly pending. */
export function technicalOutput(document: unknown, rawReview: unknown) {
  const job = validateDocument(document), review = outputReviewSchema.parse(rawReview);
  const plan = job.candidates.find(row => row.plan.id === review.planId)?.plan;
  if (!plan) throw new Error('Unknown output plan');
  const artifact = job.evidence.find(row => row.id === review.artifactEvidenceId);
  const known = !!artifact?.renderState?.completed && review.completed && !!artifact.locator && artifact.basis !== 'inferred';
  const mismatch = known && (artifact!.renderState!.durationFrames !== plan.timeline.durationFrames ||
    !sameRate(artifact!.renderState!.fps, plan.timeline.fps));
  review.findings = [
    { id: `${review.id}:timing`, criterion: 'timing', status: !known ? 'unknown' : mismatch ? 'fail' : 'pass',
      explanation: known ? 'Measured output duration/timebase compared to the selected plan.' : 'Output duration/timebase measurement unavailable.',
      evidenceIds: [review.artifactEvidenceId] },
    { id: `${review.id}:structure`, criterion: 'structure', status: 'unknown',
      explanation: 'Rendered source/content correspondence has not been inspected.', evidenceIds: [review.artifactEvidenceId] },
    { id: `${review.id}:visual`, criterion: 'visual', status: 'unknown',
      explanation: 'Creative/perceptual review producer is unavailable.', evidenceIds: [review.artifactEvidenceId] },
  ];
  const next: VideoEditingDocument = { ...job, reviews: [...job.reviews.filter(row => row.id !== review.id), review] };
  const evaluation = evaluateOutputReview(next, review.id);
  return { review: review as OutputReview, evaluation,
    technical: { status: known ? mismatch ? 'DEVIATED' as const : 'VERIFIED' as const : 'UNVERIFIED' as const,
      evidenceBasis: artifact?.basis ?? 'unknown',
      scope: 'Completed output duration and timebase only; execution/artifacts remain subject to full review admission.' },
    creative: { status: 'UNAVAILABLE' as const } };
}
