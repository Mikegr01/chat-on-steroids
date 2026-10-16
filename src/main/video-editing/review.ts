import { checkpointEvidenceBlockers, evidenceFor, sameRate, validateDocument } from './validation.js';

export interface ReviewEvaluation {
  verdict: 'pass' | 'fail' | 'inconclusive';
  evidenceBasis: 'measured' | 'fixture' | 'inferred';
  blockers: string[]; deviations: string[];
}

/** Reviews admitted output observations; it does not create measurements or call Resolve. */
export function evaluateOutputReview(document: unknown, reviewId: string): ReviewEvaluation {
  const job = validateDocument(document);
  const review = job.reviews.find(row => row.id === reviewId);
  if (!review) throw new Error('Unknown output review');
  const plan = job.candidates.find(row => row.plan.id === review.planId)!.plan;
  const checkpoint = job.checkpoints.find(row => row.operationId === review.operationId)!;
  const blockers: string[] = [], deviations: string[] = [];
  if (checkpoint.state !== 'verified') blockers.push('EXECUTION_UNVERIFIED');
  blockers.push(...checkpointEvidenceBlockers(job, checkpoint));
  if (!review.completed) blockers.push('OUTPUT_INCOMPLETE');
  const artifact = evidenceFor(job, [review.artifactEvidenceId], 'render', review.renderId)[0]!;
  if (!artifact.locator) blockers.push('OUTPUT_ARTIFACT_MISSING');
  if (!artifact.renderState) blockers.push('OUTPUT_MEASUREMENT_MISSING');
  else if (artifact.renderState.completed !== review.completed || artifact.renderState.durationFrames !== review.durationFrames ||
    !sameRate(artifact.renderState.fps, review.fps)) blockers.push('OUTPUT_MEASUREMENT_MISMATCH');
  const outputRecords = evidenceFor(job, [review.artifactEvidenceId, ...review.samples.map(row => row.evidenceId)]);
  const executionRecords = evidenceFor(job, [...checkpoint.beforeEvidenceIds, ...checkpoint.afterEvidenceIds]);
  const records = [...outputRecords, ...executionRecords,
    ...review.findings.flatMap(row => evidenceFor(job, row.evidenceIds))];
  const evidenceBasis = records.some(row => row.basis === 'inferred') ? 'inferred' :
    records.some(row => row.basis === 'fixture') ? 'fixture' : 'measured';
  if (evidenceBasis === 'inferred') blockers.push('OUTPUT_NOT_MEASURED');
  if (outputRecords.some(row => !row.locator)) blockers.push('OUTPUT_SAMPLE_ARTIFACT_MISSING');
  const requiredFrames = new Set([0, Math.floor(review.durationFrames / 2), review.durationFrames - 1]);
  if ([...requiredFrames].some(frame => !review.samples.some(row => row.frame === frame))) blockers.push('OUTPUT_SAMPLES_INCOMPLETE');
  for (const criterion of ['timing', 'structure', 'visual'] as const) {
    const findings = review.findings.filter(row => row.criterion === criterion);
    if (!findings.length) blockers.push(`REVIEW_CHANNEL_MISSING:${criterion}`);
    if (findings.some(row => row.status === 'unknown')) blockers.push(`REVIEW_CHANNEL_UNKNOWN:${criterion}`);
    if (findings.some(row => row.status === 'fail')) deviations.push(`REVIEW_FAILED:${criterion}`);
    if (criterion !== 'timing' && findings.some(row => !row.evidenceIds.some(id =>
      review.samples.some(sample => sample.evidenceId === id)))) blockers.push(`REVIEW_CHANNEL_UNSAMPLED:${criterion}`);
  }
  if (review.durationFrames !== plan.timeline.durationFrames) deviations.push('OUTPUT_DURATION_MISMATCH');
  if (!sameRate(review.fps, plan.timeline.fps)) deviations.push('OUTPUT_TIMEBASE_MISMATCH');
  return { verdict: blockers.length ? 'inconclusive' : deviations.length ? 'fail' : 'pass', evidenceBasis,
    blockers: [...new Set(blockers)], deviations };
}
