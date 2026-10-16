import { describe, expect, it } from 'vitest';
import { evaluateOutputReview } from '../src/main/video-editing/review.js';
import { evaluateRevision } from '../src/main/video-editing/revision.js';
import { reviewedDocument } from './fixtures/video-editing.js';

function revisionDocument() {
  const job = reviewedDocument();
  job.reviews[0]!.findings[2]!.status = 'fail';
  job.reviews[0]!.findings[2]!.explanation = 'Opening source range is wrong';
  const next = structuredClone(job.candidates[0]!);
  next.id = 'candidate-revision-1'; next.plan.id = 'plan-revision-1'; next.plan.parentPlanId = 'plan-1'; next.plan.revision = 1;
  next.plan.clips[0]!.source = { start: 24, end: 264 };
  job.candidates.push(next);
  job.revisions.push({ id: 'revision-1', parentPlanId: 'plan-1', reviewId: 'review-1', nextPlanId: 'plan-revision-1',
    number: 1, reason: 'Choose a better opening from actual output review', findingIds: ['visual-finding'],
    deltas: [{ kind: 'replace', clipId: 'clip-1', clip: structuredClone(next.plan.clips[0]!) }] });
  return job;
}

describe('S7.5 actual-output review', () => {
  it('labels fixture output as fixture evidence even when review passes', () => {
    expect(evaluateOutputReview(reviewedDocument(), 'review-1')).toMatchObject({ verdict: 'pass', evidenceBasis: 'fixture' });
  });

  it('admits measured output only with timing, structure and visual evidence', () => {
    expect(evaluateOutputReview(reviewedDocument('measured'), 'review-1')).toMatchObject({ verdict: 'pass', evidenceBasis: 'measured' });
  });

  it('cannot pass from a claimed checkpoint or completed queue receipt alone', () => {
    const job = reviewedDocument(); job.checkpoints[0]!.state = 'claimed';
    expect(evaluateOutputReview(job, 'review-1')).toMatchObject({ verdict: 'inconclusive' });
    job.checkpoints[0]!.state = 'verified'; delete job.evidence.find(row => row.id === 'render')!.locator;
    expect(evaluateOutputReview(job, 'review-1').blockers).toContain('OUTPUT_ARTIFACT_MISSING');
  });

  it('requires rendered frame positions and missing review channels remain inconclusive', () => {
    const job = reviewedDocument(); job.reviews[0]!.samples.pop();
    expect(evaluateOutputReview(job, 'review-1').blockers).toContain('OUTPUT_SAMPLES_INCOMPLETE');
    job.reviews[0]!.findings.pop();
    expect(evaluateOutputReview(job, 'review-1').blockers).toContain('REVIEW_CHANNEL_MISSING:visual');
  });

  it('detects actual duration/timebase deviations independently of passing authored findings', () => {
    const job = reviewedDocument(); job.reviews[0]!.durationFrames = 241;
    job.evidence.find(row => row.id === 'render')!.renderState!.durationFrames = 241;
    job.reviews[0]!.samples[2]!.frame = 240; job.evidence.find(row => row.id === 'frame-239')!.framePosition = 240;
    expect(evaluateOutputReview(job, 'review-1').deviations).toContain('OUTPUT_DURATION_MISMATCH');
    job.reviews[0]!.fps.numerator = 25;
    job.evidence.find(row => row.id === 'render')!.renderState!.fps.numerator = 25;
    expect(evaluateOutputReview(job, 'review-1').deviations).toContain('OUTPUT_TIMEBASE_MISMATCH');
    expect(evaluateOutputReview(job, 'review-1').verdict).toBe('fail');
  });

  it('rejects cross-operation/timeline/render joins and receipt evidence in findings', () => {
    const job = reviewedDocument(); job.reviews[0]!.timelineId = 'personal-timeline';
    expect(() => evaluateOutputReview(job, 'review-1')).toThrow(/lineage/i);
    job.reviews[0]!.timelineId = 'owned-timeline-1'; job.reviews[0]!.findings[0]!.evidenceIds = ['after'];
    expect(() => evaluateOutputReview(job, 'review-1')).toThrow(/actual output/i);
  });

  it('does not promote inferred output to measured artifact evidence', () => {
    const job = reviewedDocument('measured'); const render = job.evidence.find(row => row.id === 'render')!;
    render.basis = 'inferred'; render.parents = ['after'];
    expect(evaluateOutputReview(job, 'review-1')).toMatchObject({ verdict: 'inconclusive' });
  });

  it('does not pass from bare timeline IDs without measured clip state', () => {
    const job = reviewedDocument('measured');
    delete job.evidence.find(row => row.id === 'after')!.timelineState;
    expect(evaluateOutputReview(job, 'review-1').blockers).toContain('TIMELINE_STATE_MISSING');
  });

  it('does not trust duration claims detached from the rendered artifact measurement', () => {
    const job = reviewedDocument('measured');
    delete job.evidence.find(row => row.id === 'render')!.renderState;
    expect(evaluateOutputReview(job, 'review-1').blockers).toContain('OUTPUT_MEASUREMENT_MISSING');
  });

  it('detects wrong source ranges and incomplete timeline inspection', () => {
    const job = reviewedDocument('measured');
    job.evidence.find(row => row.id === 'after')!.timelineState!.items[0]!.source.start = 1;
    expect(evaluateOutputReview(job, 'review-1').blockers).toContain('TIMELINE_INTENT_MISMATCH');
    job.evidence.find(row => row.id === 'after')!.timelineState!.complete = false;
    expect(evaluateOutputReview(job, 'review-1').blockers).toContain('TIMELINE_INSPECTION_INCOMPLETE');
  });

  it('rejects rendered measurements attributed to a different execution', () => {
    const job = reviewedDocument('measured');
    job.evidence.find(row => row.id === 'render')!.renderState!.timelineId = 'other-timeline';
    expect(() => evaluateOutputReview(job, 'review-1')).toThrow(/measurement lineage/i);
  });
});

describe('S7.5 bounded revision', () => {
  it('joins a failed actual-output review to an exact additive new version', () => {
    const job = revisionDocument();
    expect(evaluateRevision(job, 'revision-1')).toEqual({ ready: true, blockers: [] });
    expect(job.candidates[0]!.plan.clips[0]!.source.start).toBe(0);
  });

  it('stops on passing, incomplete and ambiguous review instead of iterating', () => {
    const job = revisionDocument(); job.reviews[0]!.findings[2]!.status = 'pass';
    expect(() => evaluateRevision(job, 'revision-1')).toThrow(/failed review/i);
    job.reviews[0]!.findings[2]!.status = 'fail'; job.reviews[0]!.completed = false;
    expect(evaluateRevision(job, 'revision-1').blockers).toContain('REVIEW_NOT_ACTIONABLE');
    job.reviews[0]!.completed = true; job.checkpoints[0]!.state = 'ambiguous';
    expect(evaluateRevision(job, 'revision-1').ready).toBe(false);
  });

  it('rejects exceeded revision bounds and wrong parent lineage', () => {
    const job = revisionDocument(); job.maxRevisions = 0;
    expect(() => evaluateRevision(job, 'revision-1')).toThrow(/bound/i);
    job.maxRevisions = 2; job.revisions[0]!.parentPlanId = 'unknown-plan';
    expect(() => evaluateRevision(job, 'revision-1')).toThrow(/lineage/i);
  });

  it('rejects deltas that do not reproduce the proposed next plan', () => {
    const job = revisionDocument(); job.revisions[0]!.deltas = [{ kind: 'remove', clipId: 'clip-1' }];
    expect(() => evaluateRevision(job, 'revision-1')).toThrow(/delta/i);
  });

  it('stops no-op revisions and refuses hidden requirement changes', () => {
    const job = revisionDocument(); const next = job.candidates[1]!.plan;
    next.clips[0]!.source = { ...job.candidates[0]!.plan.clips[0]!.source };
    job.revisions[0]!.deltas = [{ kind: 'replace', clipId: 'clip-1', clip: structuredClone(next.clips[0]!) }];
    expect(evaluateRevision(job, 'revision-1').blockers).toContain('REVISION_REPEATS_CONTENT');
    next.features.push('color');
    expect(() => evaluateRevision(job, 'revision-1')).toThrow(/requirements/i);
  });
});
