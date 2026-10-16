import { z } from 'zod';
import { videoIdSchema, frameRateSchema, outputReviewSchema, type ReferenceProfile, type EditPlan, type VideoEditingDocument, type OutputReview } from '../../shared/video-editing.js';
import { verifyExecution, type PreparedExecution } from './execution.js';
import { technicalOutput } from './inspection.js';
import { evidenceFor, sameRate, validateDocument } from './validation.js';

const index = z.number().int().nonnegative().max(1_000_000_000);
const producer = z.object({ name: videoIdSchema, version: videoIdSchema }).strict();
export const frameSampleSchema = z.object({ version: z.literal(1), renderId: videoIdSchema, artifactEvidenceId: videoIdSchema,
  sampleEvidenceId: videoIdSchema.optional(), requested: z.object({ frameIndex: index, fps: frameRateSchema }).strict(),
  actual: z.object({ frameIndex: index, timestampMs: z.number().nonnegative().max(1e12).optional() }).strict().optional(),
  image: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), width: z.number().int().positive().max(16384),
    height: z.number().int().positive().max(16384) }).strict().refine(row => row.width * row.height <= 16_000_000).optional(),
  producer, confidence: z.number().min(0).max(1), decode: z.enum(['decoded', 'unavailable', 'failed']),
  position: z.enum(['verified', 'unverified', 'unavailable']),
}).strict().superRefine((row, ctx) => {
  if (row.decode !== 'decoded' && (row.image || row.actual || row.sampleEvidenceId || row.position !== 'unavailable') ||
    row.decode === 'decoded' && (!row.image || !row.sampleEvidenceId) || row.position === 'verified' && !row.actual)
    ctx.addIssue({ code: 'custom', message: 'Frame decode/position receipt inconsistent' });
});
export function admitFrameSample(document: unknown, raw: unknown) {
  const job = validateDocument(document), sample = frameSampleSchema.parse(raw);
  const artifact = evidenceFor(job, [sample.artifactEvidenceId], 'render', sample.renderId)[0]!;
  if (!artifact.locator) throw new Error('Render artifact unavailable');
  let basis = artifact.basis;
  if (sample.decode === 'decoded') {
    const frame = evidenceFor(job, [sample.sampleEvidenceId!], 'frame', sample.renderId)[0]!;
    if (frame.locator?.sha256 !== sample.image!.sha256) throw new Error('Frame image hash mismatch');
    if (frame.basis === 'inferred' || basis === 'inferred') throw new Error('Decoded sample cannot be inferred');
    if (frame.basis === 'fixture') basis = 'fixture';
    if (sample.position === 'verified') {
      const measured = artifact.renderState;
      if (!measured?.completed || !sameRate(measured.fps, sample.requested.fps) || sample.requested.frameIndex >= measured.durationFrames ||
        frame.framePosition !== sample.actual!.frameIndex || sample.actual!.frameIndex !== sample.requested.frameIndex) throw new Error('Frame position/timebase unverified');
      const time = sample.actual!.frameIndex * 1000 * measured.fps.denominator / measured.fps.numerator;
      if (sample.actual!.timestampMs !== undefined && Math.abs(sample.actual!.timestampMs - time) > 1e-6) throw new Error('Frame timestamp mismatch');
    } else if (sample.actual && frame.framePosition !== sample.actual.frameIndex) throw new Error('Unverified actual frame mismatch');
  }
  return { sample, evidenceBasis: basis };
}
export function outputEvidenceRequirements(job: VideoEditingDocument, prepared: PreparedExecution) {
  const plan = job.candidates.find(row => row.plan.id === prepared.request.planId)!.plan;
  return { operationId: prepared.request.operationId, timelineId: prepared.request.timelineId,
    expectedClips: plan.clips.map(clip => ({ ...clip, resolveMediaId: job.media.find(row => row.id === clip.mediaId)!.resolveMediaId })),
    durationFrames: plan.timeline.durationFrames, fps: plan.timeline.fps,
    timeline: ['complete fresh ownership', 'exact media/source/track/placement', 'saved adapter receipt'],
    render: ['exact job/operation/timeline lineage', 'completed expected path', 'approved artifact hash', 'decoded duration/timebase/dimensions/container'],
    samples: [...new Set([0, Math.floor(plan.timeline.durationFrames / 2), plan.timeline.durationFrames - 1])],
    frameProducer: 'REQUIRES_ADMITTED_EXTERNAL_MEDIA_RUNTIME', creativeReview: 'UNAVAILABLE', creativeRequired:job.workflow?.request.output.creativeReviewRequired??false, requiredReviewChannels: job.workflow?.request.output.creativeReviewRequired?['timing','structure','visual']:['timing','structure'] };
}
export function deterministicWorkflowReview(document: unknown, operationId: string, afterIds: string[], output?: unknown) {
  const job = validateDocument(document), checkpoint = job.checkpoints.find(row => row.operationId === operationId);
  if (!checkpoint) throw new Error('Unknown execution operation');
  const review = output === undefined ? undefined : outputReviewSchema.parse(output);
  if (review && review.operationId !== operationId) throw new Error('Output review operation mismatch');
  return { timeline: verifyExecution(job, checkpoint, afterIds), output: review ? technicalOutput(job, review) : undefined,
    creative: creativeReviewAvailability() };
}
const findingsSchema = z.array(z.object({ criterion: z.enum(['pacing', 'rhythm', 'beatSync', 'look']),
  status: z.enum(['pass', 'fail', 'unknown']), explanation: z.string().min(1).max(2000),
  evidenceIds: z.array(videoIdSchema).min(1).max(100) }).strict()).min(1).max(100);
export interface PerceptualReviewer {
  descriptor: z.infer<typeof producer>;
  review(input: { references: ReferenceProfile[]; plan: EditPlan; output: OutputReview;
    samples: z.infer<typeof frameSampleSchema>[]; deterministicFindings: OutputReview['findings'] }): Promise<z.infer<typeof findingsSchema>>;
}
export function creativeReviewAvailability(reviewer?: PerceptualReviewer) {
  return reviewer ? { status: 'PENDING' as const, producer: producer.parse(reviewer.descriptor) } :
    { status: 'UNAVAILABLE' as const, reason: 'PERCEPTUAL_REVIEWER_UNAVAILABLE' };
}
/** A provider result is admitted separately from deterministic timing/timeline findings. */
export function admitPerceptualFindings(document: unknown, reviewId: string, rawProducer: unknown, raw: unknown) {
  const job = validateDocument(document), descriptor = producer.parse(rawProducer), findings = findingsSchema.parse(raw);
  const review = job.reviews.find(row => row.id === reviewId);
  if (!review) throw new Error('Unknown output review');
  for (const finding of findings) {
    const records = evidenceFor(job, finding.evidenceIds, 'frame', review.renderId);
    if (records.some(row => row.basis === 'inferred' || !row.locator || row.framePosition === undefined ||
      !review.samples.some(sample => sample.evidenceId === row.id))) throw new Error('Perceptual finding requires positioned actual output samples');
  }
  return { producer: descriptor, findings, evidenceBasis: evidenceFor(job, findings.flatMap(row => row.evidenceIds).filter((id, i, ids) => ids.indexOf(id) === i))
    .some(row => row.basis === 'fixture') ? 'fixture' as const : 'measured' as const };
}
