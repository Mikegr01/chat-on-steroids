import { z } from 'zod';
import { videoIdSchema } from '../../shared/video-editing.js';
import { unique, validateDocument, validatePlan } from './validation.js';

const weightsSchema = z.array(z.object({ criterion: videoIdSchema, weight: z.number().min(0).max(100) }).strict())
  .min(1).max(30).refine(rows => rows.some(row => row.weight > 0), 'At least one positive weight is required');

export interface CandidateComparison {
  candidateId: string; planId: string; score: number | null; blockers: string[];
}

/** Scores are explicit judgments with provenance. Ranking never grants execution authority. */
export function compareCandidates(document: unknown, rawWeights: unknown): CandidateComparison[] {
  const job = validateDocument(document);
  if (job.candidates.filter(row => row.plan.revision === 0).length < 2) throw new Error('Candidate comparison requires at least two alternatives');
  return assessCandidates(job, rawWeights);
}

/** A workflow can assess one submitted design without pretending it compared alternatives. */
export function assessCandidates(document: unknown, rawWeights: unknown): CandidateComparison[] {
  const job = validateDocument(document);
  const weights = weightsSchema.parse(rawWeights);
  unique(weights.map(row => row.criterion), 'weight criteria');
  const roots = job.candidates.filter(row => row.plan.revision === 0);
  if (!roots.length) throw new Error('Candidate assessment requires a design');
  const total = weights.reduce((sum, row) => sum + row.weight, 0);
  return roots.map(candidate => {
    const blockers = validatePlan(candidate.plan, job);
    let weighted = 0;
    for (const weight of weights) {
      if (!weight.weight) continue;
      const score = candidate.scores.find(row => row.criterion === weight.criterion);
      if (!score) blockers.push(`MISSING_SCORE:${weight.criterion}`);
      else weighted += weight.weight * score.value;
    }
    return { candidateId: candidate.id, planId: candidate.plan.id,
      score: blockers.length ? null : weighted / total, blockers };
  }).sort((a, b) => {
    if (a.score === null && b.score !== null) return 1;
    if (a.score !== null && b.score === null) return -1;
    if (a.score !== null && b.score !== null && a.score !== b.score) return b.score - a.score;
    return a.planId < b.planId ? -1 : a.planId > b.planId ? 1 : 0;
  });
}
