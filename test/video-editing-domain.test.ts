import { describe, expect, it } from 'vitest';
import { videoEditingDocumentSchema, referenceProfileSchema } from '../src/shared/video-editing.js';
import { validateDocument, validatePlan } from '../src/main/video-editing/validation.js';
import { videoDocument } from './fixtures/video-editing.js';

describe('S7.5 domain admission', () => {
  it('retains missing reference observations instead of filling them', () => {
    const profile = referenceProfileSchema.parse(videoDocument().references[0]);
    expect(profile.status).toBe('partial');
    expect(profile.color).toBeUndefined();
  });

  it('rejects arbitrary fields, invalid confidence and unbounded payloads', () => {
    const job = videoDocument();
    expect(videoEditingDocumentSchema.safeParse({ ...job, eval: 'mutate' }).success).toBe(false);
    job.evidence[0]!.confidence = 1.1;
    expect(videoEditingDocumentSchema.safeParse(job).success).toBe(false);
    job.evidence[0]!.confidence = 1;
    job.objective = 'x'.repeat(96001);
    expect(videoEditingDocumentSchema.safeParse(job).success).toBe(false);
  });

  it('accepts an internally joined document and deterministic frame intent', () => {
    const job = validateDocument(videoDocument());
    expect(validatePlan(job.candidates[0]!.plan, job)).toEqual([]);
  });

  it('rejects duplicate identities and unknown evidence parents', () => {
    const job = videoDocument();
    job.evidence.push({ ...job.evidence[0]! });
    expect(() => validateDocument(job)).toThrow(/duplicate/i);
    job.evidence.pop();
    job.evidence[0]!.basis = 'inferred';
    job.evidence[0]!.parents = ['missing'];
    expect(() => validateDocument(job)).toThrow(/parent/i);
  });

  it('rejects cyclic inferred provenance and manufactured measured lineage', () => {
    const job = videoDocument();
    job.evidence[0]!.basis = 'inferred'; job.evidence[0]!.parents = ['media-observation'];
    job.evidence[1]!.basis = 'inferred'; job.evidence[1]!.parents = ['ref-observation'];
    expect(() => validateDocument(job)).toThrow(/cycle/i);
    job.evidence[1]!.basis = 'measured';
    expect(() => validateDocument(job)).toThrow(/root/i);
  });

  it('rejects wrong-subject source and reference observations', () => {
    const job = videoDocument();
    job.references[0]!.evidenceIds = ['media-observation'];
    expect(() => validateDocument(job)).toThrow(/subject/i);
  });

  it('rejects reversed ranges and source ranges beyond the known media', () => {
    const job = videoDocument();
    job.candidates[0]!.plan.clips[0]!.source.end = 0;
    expect(videoEditingDocumentSchema.safeParse(job).success).toBe(false);
    job.candidates[0]!.plan.clips[0]!.source.end = 600;
    expect(validatePlan(job.candidates[0]!.plan, job)).toContain('SOURCE_RANGE:clip-1');
  });

  it('keeps unsupported creative requirements visible and infeasible', () => {
    const job = videoDocument(); job.candidates[0]!.plan.features.push('title');
    expect(validateDocument(job).candidates[0]!.plan.features).toContain('title');
    expect(validatePlan(job.candidates[0]!.plan, job)).toContain('UNSUPPORTED_FEATURE:title');
  });

  it('does not infer a missing timebase or silently retime media', () => {
    const job = videoDocument(); delete job.media[0]!.fps;
    expect(validatePlan(job.candidates[0]!.plan, job)).toContain('INCOMPLETE_MEDIA:media-1');
    job.media[0]!.fps = { numerator: 25, denominator: 1 };
    expect(validatePlan(job.candidates[0]!.plan, job)).toContain('RETIME_UNSUPPORTED:clip-1');
  });

  it('rejects same-track overlap, duration mismatch and visual gaps', () => {
    const job = videoDocument(); const plan = job.candidates[0]!.plan;
    plan.clips.push({ ...plan.clips[0]!, id: 'clip-2' });
    expect(validatePlan(plan, job)).toContain('TRACK_OVERLAP:clip-2');
    plan.clips.pop(); plan.clips[0]!.timeline.end = 200;
    expect(validatePlan(plan, job)).toContain('DURATION_MISMATCH:clip-1');
    expect(validatePlan(plan, job)).toContain('VISUAL_COVERAGE');
  });

  it('keeps source choices inside evidence-backed usable ranges', () => {
    const job = videoDocument(); job.media[0]!.usableRanges[0]!.end = 120;
    expect(validatePlan(job.candidates[0]!.plan, job)).toContain('SOURCE_NOT_USABLE:clip-1');
  });

  it('rejects a revised candidate without its exact review/delta lineage artifact', () => {
    const job = videoDocument(); const next = structuredClone(job.candidates[0]!);
    next.id = 'candidate-revision'; next.plan.id = 'plan-revision'; next.plan.parentPlanId = 'plan-1'; next.plan.revision = 1;
    job.candidates.push(next);
    expect(() => validateDocument(job)).toThrow(/revision artifact/i);
  });

  it('bounds music observations to actual media duration and orders sections', () => {
    const job = videoDocument(); job.media[0]!.music = { beatsMs: [20001], sections: [], evidenceIds: ['media-observation'] };
    expect(() => validateDocument(job)).toThrow(/music duration/i);
  });

  it('requires the plan to retain all source and reference provenance', () => {
    const job = videoDocument(); job.candidates[0]!.plan.evidenceIds = ['ref-observation'];
    expect(() => validateDocument(job)).toThrow(/plan provenance/i);
  });

  it('does not treat an unavailable reference as understood editing evidence', () => {
    const job = videoDocument(); job.references[0]!.status = 'unavailable'; delete job.references[0]!.pacing;
    expect(validatePlan(job.candidates[0]!.plan, job)).toContain('REFERENCE_UNAVAILABLE:profile-1');
  });
});
