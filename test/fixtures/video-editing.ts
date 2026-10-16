import type { VideoEditingDocument } from '../../src/shared/video-editing.js';
import { checkpointIntent } from '../../src/main/video-editing/identity.js';

/** Deterministic external observations; never a live Resolve/provider acceptance fixture. */
export function videoDocument(): VideoEditingDocument {
  const producer = { name: 'fixture-probe', version: '1' };
  return {
    version: 1, id: 'job-1', sessionId: 'local-session-1', localProjectId: 'local-project-1',
    resolveProjectId: 'resolve-project-1', objective: 'A ten second reference-driven montage', maxRevisions: 2,
    evidence: [
      { id: 'ref-observation', subject: 'reference', subjectId: 'reference-1', basis: 'fixture', producer,
        observedAt: 1, confidence: 0.8, parents: [] },
      { id: 'media-observation', subject: 'media', subjectId: 'media-1', basis: 'fixture', producer,
        observedAt: 1, confidence: 1, parents: [], locator: { path: 'D:/fixtures/source.mp4', sha256: 'a'.repeat(64), bytes: 100 } },
    ],
    references: [{ id: 'profile-1', referenceId: 'reference-1', status: 'partial', evidenceIds: ['ref-observation'],
      pacing: { shotDurationsMs: [1000, 2000], confidence: 0.8, evidenceIds: ['ref-observation'] } }],
    media: [{ id: 'media-1', path: 'D:/fixtures/source.mp4', sha256: 'a'.repeat(64), resolveMediaId: 'pool-1',
      status: 'complete', video: true, audio: true, fps: { numerator: 24, denominator: 1 }, durationFrames: 480,
      evidenceIds: ['media-observation'], usableRanges: [{ start: 0, end: 480, evidenceIds: ['media-observation'] }], sceneRanges: [] }],
    candidates: [{ id: 'candidate-1', rationale: 'Long shots follow the supplied reference', risks: [],
      scores: [{ criterion: 'reference-fit', value: 0.8, evidenceIds: ['ref-observation'] }],
      plan: { id: 'plan-1', rootPlanId: 'plan-1', revision: 0, referenceProfileIds: ['profile-1'],
        evidenceIds: ['ref-observation', 'media-observation'], features: ['cut'],
        timeline: { name: 'Candidate one', fps: { numerator: 24, denominator: 1 }, durationFrames: 240 },
        clips: [{ id: 'clip-1', mediaId: 'media-1', mediaType: 'video', track: 1,
          source: { start: 0, end: 240 }, timeline: { start: 0, end: 240 }, evidenceIds: ['media-observation'] }] } }],
    checkpoints: [], reviews: [], revisions: [],
  };
}

export function reviewedDocument(basis: 'fixture' | 'measured' = 'fixture'): VideoEditingDocument {
  const job = videoDocument();
  const producer = { name: 'render-probe', version: '1' };
  job.evidence.push(
    { id: 'before', subject: 'timeline', subjectId: 'owned-timeline-1', basis, producer, observedAt: 2, confidence: 1, parents: [],
      timelineState: { resolveProjectId: job.resolveProjectId, fps: { numerator: 24, denominator: 1 }, durationFrames: 0, complete: true, items: [] } },
    { id: 'after', subject: 'timeline', subjectId: 'owned-timeline-1', basis, producer, observedAt: 3, confidence: 1, parents: [],
      timelineState: { resolveProjectId: job.resolveProjectId, fps: { numerator: 24, denominator: 1 }, durationFrames: 240, complete: true,
        items: [{ uniqueId: 'resolve-item-1', mediaUniqueId: 'pool-1', mediaType: 'video', track: 1,
          source: { start: 0, end: 240 }, timeline: { start: 0, end: 240 } }] } },
    { id: 'render', subject: 'render', subjectId: 'render-1', basis, producer, observedAt: 4, confidence: 1, parents: [],
      locator: { path: 'D:/fixtures/review.mp4', sha256: 'b'.repeat(64), bytes: 1000 },
      renderState: { operationId: '11111111-1111-4111-8111-111111111111', timelineId: 'owned-timeline-1',
        completed: true, fps: { numerator: 24, denominator: 1 }, durationFrames: 240 } },
    ...[0, 120, 239].map(framePosition => ({ id: `frame-${framePosition}`, subject: 'frame' as const,
      subjectId: 'render-1', basis, producer, observedAt: 4, confidence: 1, parents: [], framePosition,
      locator: { path: `D:/fixtures/frame-${framePosition}.png`, sha256: 'c'.repeat(64), bytes: 100 } })),
  );
  job.checkpoints.push({ ...checkpointIntent(job, 'plan-1', 'owned-timeline-1', 'assemble', ['before'],
    '11111111-1111-4111-8111-111111111111'), state: 'verified', afterEvidenceIds: ['after'] });
  job.reviews.push({ id: 'review-1', planId: 'plan-1', operationId: job.checkpoints[0]!.operationId,
    timelineId: 'owned-timeline-1', renderId: 'render-1', artifactEvidenceId: 'render', completed: true,
    fps: { numerator: 24, denominator: 1 }, durationFrames: 240,
    samples: [0, 120, 239].map(frame => ({ frame, evidenceId: `frame-${frame}` })),
    findings: [
      { id: 'timing-finding', criterion: 'timing', status: 'pass', explanation: 'Duration matches', evidenceIds: ['render'] },
      { id: 'structure-finding', criterion: 'structure', status: 'pass', explanation: 'Three samples inspected', evidenceIds: ['frame-0', 'frame-120', 'frame-239'] },
      { id: 'visual-finding', criterion: 'visual', status: 'pass', explanation: 'Samples show intended material', evidenceIds: ['frame-0', 'frame-120', 'frame-239'] },
    ] });
  return job;
}
