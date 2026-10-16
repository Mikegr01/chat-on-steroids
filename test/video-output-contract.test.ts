import { expect, it } from 'vitest';
import { admitFrameSample, creativeReviewAvailability, admitPerceptualFindings, deterministicWorkflowReview } from '../src/main/video-editing/workflow-output.js';
import { reviewedDocument } from './fixtures/video-editing.js';

function sample() {
  return { version: 1, renderId: 'render-1', artifactEvidenceId: 'render', sampleEvidenceId: 'frame-120',
    requested: { frameIndex: 120, fps: { numerator: 24, denominator: 1 } },
    actual: { frameIndex: 120, timestampMs: 5000 }, image: { sha256: 'c'.repeat(64), width: 1280, height: 720 },
    producer: { name: 'fixture-decoder', version: '1' }, confidence: 1, decode: 'decoded', position: 'verified' };
}
it('joins positioned frame evidence to exact render artifact, actual index, hash and timebase', () => {
  expect(admitFrameSample(reviewedDocument(), sample()).evidenceBasis).toBe('fixture');
});
it('keeps unavailable positions explicit instead of fabricating decoded samples', () => {
  const missing = { version: 1, renderId: 'render-1', artifactEvidenceId: 'render',
    requested: sample().requested, producer: sample().producer, confidence: 0, decode: 'unavailable', position: 'unavailable' };
  expect(admitFrameSample(reviewedDocument(), missing).sample.actual).toBeUndefined();
  expect(() => admitFrameSample(reviewedDocument(), { ...missing, position: 'verified' })).toThrow();
});
it('rejects wrong render lineage, index, timestamp, image hash and unknown metadata', () => {
  const job = reviewedDocument();
  expect(() => admitFrameSample(job, { ...sample(), renderId: 'other' })).toThrow();
  expect(() => admitFrameSample(job, { ...sample(), actual: { frameIndex: 119 } })).toThrow();
  expect(() => admitFrameSample(job, { ...sample(), actual: { frameIndex: 120, timestampMs: 1 } })).toThrow();
  expect(() => admitFrameSample(job, { ...sample(), image: { ...sample().image, sha256: 'd'.repeat(64) } })).toThrow();
  delete job.evidence.find(row => row.id === 'render')!.renderState;
  expect(() => admitFrameSample(job, sample())).toThrow();
});
it('requires an actual perceptual provider and findings linked to actual output samples', () => {
  expect(creativeReviewAvailability()).toEqual({ status: 'UNAVAILABLE', reason: 'PERCEPTUAL_REVIEWER_UNAVAILABLE' });
  const job = reviewedDocument();
  expect(() => admitPerceptualFindings(job, 'review-1', { name: 'fixture-reviewer', version: '1' },
    [{ criterion: 'rhythm', status: 'pass', explanation: 'invented', evidenceIds: ['ref-observation'] }])).toThrow();
});
it('separates deterministic source/timing deviation from unavailable perceptual review', () => {
  const job = reviewedDocument(); job.evidence.find(row => row.id === 'after')!.timelineState!.items[0]!.source.start = 1;
  const result = deterministicWorkflowReview(job, job.checkpoints[0]!.operationId, ['after'], job.reviews[0]!);
  expect(result.timeline.blockers).toContain('TIMELINE_INTENT_MISMATCH');
  expect(result.output!.creative.status).toBe('UNAVAILABLE'); expect(result.output!.evaluation.verdict).toBe('inconclusive');
});
it('cannot combine timeline verification with a different operation output review', () => {
  const job = reviewedDocument(), operationId = '22222222-2222-4222-8222-222222222222';
  job.checkpoints.push({ ...job.checkpoints[0]!, operationId });
  for (const row of [...job.evidence].filter(row => row.subjectId === 'render-1')) {
    const copy = structuredClone(row); copy.id += '-2'; copy.subjectId = 'render-2';
    if (copy.renderState) copy.renderState.operationId = operationId;
    job.evidence.push(copy);
  }
  const review = structuredClone(job.reviews[0]!); review.id = 'review-2'; review.operationId = operationId;
  review.renderId = 'render-2'; review.artifactEvidenceId = 'render-2';
  review.samples = review.samples.map(row => ({ ...row, evidenceId: `${row.evidenceId}-2` }));
  review.findings = review.findings.map(row => ({ ...row, evidenceIds: row.evidenceIds.map(id => `${id}-2`) }));
  job.reviews.push(review);
  expect(() => deterministicWorkflowReview(job, job.checkpoints[0]!.operationId, ['after'], review)).toThrow(/operation/i);
});
