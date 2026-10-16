import { describe, expect, it } from 'vitest';
import { ingestAnalysis } from '../src/main/video-editing/analysis.js';
import { compareCandidates } from '../src/main/video-editing/planning.js';
import { videoDocument } from './fixtures/video-editing.js';

describe('S7.5 analysis contracts and candidate comparison', () => {
  it('admits a partial reference without adding invented style fields', () => {
    const job = videoDocument();
    const profile = { ...job.references[0]!, id: 'second-profile' };
    const next = ingestAnalysis(job, { evidence: [], references: [profile], media: [] });
    expect(next.references).toHaveLength(2);
    expect(next.references[1]!.cameraMotion).toBeUndefined();
    expect(job.references).toHaveLength(1);
  });

  it('preserves exact source-byte identity and explicit music observations', () => {
    const job = videoDocument();
    const asset = { ...job.media[0]!, id: 'music-1', video: false, evidenceIds: ['music-evidence'],
      usableRanges: [], music: { beatsMs: [0, 500, 1000], sections: [], evidenceIds: ['music-evidence'] } };
    const record = { ...job.evidence[1]!, id: 'music-evidence', subjectId: 'music-1' };
    const next = ingestAnalysis(job, { evidence: [record], references: [], media: [asset] });
    expect(next.media[1]!.music!.beatsMs).toEqual([0, 500, 1000]);
    expect(next.media[1]!.sha256).toBe('a'.repeat(64));
  });

  it('rejects unknown provenance, content mismatch and overwriting an admitted asset', () => {
    const job = videoDocument();
    expect(() => ingestAnalysis(job, { evidence: [], references: [], media: [{ ...job.media[0]!, id: 'other' }] })).toThrow(/subject/i);
    expect(() => ingestAnalysis(job, { evidence: [], references: [], media: [{ ...job.media[0]!, sha256: 'b'.repeat(64) }] })).toThrow(/duplicate/i);
    job.media[0]!.sha256 = 'b'.repeat(64);
    expect(() => ingestAnalysis(job, { evidence: [], references: [], media: [] })).toThrow(/content/i);
  });

  it('rejects unavailable references carrying observations and unordered music beats', () => {
    const job = videoDocument(); job.references[0]!.status = 'unavailable';
    expect(() => ingestAnalysis(job, { evidence: [], references: [], media: [] })).toThrow(/unavailable/i);
    job.references[0]!.status = 'partial';
    job.media[0]!.music = { beatsMs: [500, 100], sections: [], evidenceIds: ['media-observation'] };
    expect(() => ingestAnalysis(job, { evidence: [], references: [], media: [] })).toThrow(/beats/i);
  });

  it('compares distinct feasible candidates under explicit weights', () => {
    const job = videoDocument(); const second = structuredClone(job.candidates[0]!);
    second.id = 'candidate-2'; second.plan.id = 'plan-2'; second.plan.rootPlanId = 'plan-2';
    second.scores[0]!.value = 0.9; job.candidates.push(second);
    const ranked = compareCandidates(job, [{ criterion: 'reference-fit', weight: 2 }]);
    expect(ranked.map(row => row.candidateId)).toEqual(['candidate-2', 'candidate-1']);
    expect(ranked[0]!.score).toBeCloseTo(0.9);
  });

  it('puts infeasible candidates last even when their claimed quality is highest', () => {
    const job = videoDocument(); const second = structuredClone(job.candidates[0]!);
    second.id = 'candidate-2'; second.plan.id = 'plan-2'; second.plan.rootPlanId = 'plan-2';
    second.plan.features.push('transition'); second.scores[0]!.value = 1; job.candidates.push(second);
    const ranked = compareCandidates(job, [{ criterion: 'reference-fit', weight: 1 }]);
    expect(ranked[0]!.candidateId).toBe('candidate-1');
    expect(ranked[1]).toMatchObject({ score: null, blockers: ['UNSUPPORTED_FEATURE:transition'] });
  });

  it('requires alternatives and rejects empty or duplicate weighting authority', () => {
    const job = videoDocument();
    expect(() => compareCandidates(job, [{ criterion: 'reference-fit', weight: 1 }])).toThrow(/alternatives/i);
    const second = structuredClone(job.candidates[0]!);
    second.id = 'candidate-2'; second.plan.id = 'plan-2'; second.plan.rootPlanId = 'plan-2'; job.candidates.push(second);
    expect(() => compareCandidates(job, [{ criterion: 'reference-fit', weight: 0 }])).toThrow();
    expect(() => compareCandidates(job, [{ criterion: 'reference-fit', weight: 1 }, { criterion: 'reference-fit', weight: 2 }])).toThrow(/duplicate/i);
  });

  it('does not invent scores for missing requested criteria and resolves ties independently of input order', () => {
    const job = videoDocument(); const second = structuredClone(job.candidates[0]!);
    second.id = 'candidate-2'; second.plan.id = 'plan-2'; second.plan.rootPlanId = 'plan-2'; job.candidates.unshift(second);
    expect(compareCandidates(job, [{ criterion: 'reference-fit', weight: 1 }])[0]!.planId).toBe('plan-1');
    const ranked = compareCandidates(job, [{ criterion: 'music-fit', weight: 1 }]);
    expect(ranked.every(row => row.score === null && row.blockers.includes('MISSING_SCORE:music-fit'))).toBe(true);
  });
});
