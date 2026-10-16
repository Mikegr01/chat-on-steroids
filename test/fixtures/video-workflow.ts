import type { WorkRequest } from '../../src/shared/video-editing.js';
import type { CandidatePlanner } from '../../src/main/video-editing/workflow-planning.js';

export function workRequest(root = 'D:/fixtures'): WorkRequest {
  return { version: 1, id: 'work-1', sessionId: 'session-1', localProjectId: 'project-1', resolveProjectId: 'resolve-project-1',
    objective: 'Ten-second travel montage, two locations and music, guided by the reference image.',
    assets: [
      { id: 'source-a', role: 'source', kind: 'video', path: `${root}/a.mov`, resolveMediaId: 'pool-a',
        usable: { operatorId: 'editor-1', ranges: [{ start: 0, end: 480 }] } },
      { id: 'source-b', role: 'source', kind: 'video', path: `${root}/b.mov`, resolveMediaId: 'pool-b',
        usable: { operatorId: 'editor-1', ranges: [{ start: 0, end: 480 }] } },
      { id: 'music', role: 'music', kind: 'audio', path: `${root}/music.wav`, resolveMediaId: 'pool-music',
        usable: { operatorId: 'editor-1', ranges: [{ start: 0, end: 240 }] } },
      { id: 'reference', role: 'reference', kind: 'image', path: `${root}/reference.png` },
    ],
    target: { durationFrames: 240, fps: { numerator: 24, denominator: 1 }, width: 1280, height: 720 },
    style: ['Use the reference as a composition guide; its creative analysis is pending.'], features: ['cut'],
    content: { requiredAssetIds: ['source-a', 'source-b'], forbiddenAssetIds: [] }, titles: [],
    pacing: { minShotFrames: 48, maxShotFrames: 192 }, output: { container: 'mov', renderRequired: true },
    weights: [{ criterion: 'operator-preference', weight: 1 }], maxRevisions: 2, mode: 'prepare-only' };
}

/** Explicit test planner. No production intelligence or fixed product style. */
export const fixturePlanner: CandidatePlanner = {
  descriptor: { id: 'fixture-designs', version: '1', kind: 'fixture', configuration: { comparison: 'two alternatives' } },
  async plan(input) {
    const evidenceIds = input.evidence.map(row => row.id);
    return [0, 1].map(alternative => {
      const order = alternative ? ['source-b', 'source-a'] : ['source-a', 'source-b'];
      const clips = order.map((mediaId, index) => ({ id: `shot-${index}`, mediaId, mediaType: 'video' as const, track: 1,
        source: { start: 0, end: 120 }, timeline: { start: index * 120, end: (index + 1) * 120 },
        evidenceIds: input.media.find(row => row.id === mediaId)!.evidenceIds }));
      return { plan: { referenceProfileIds: input.references.map(row => row.id), evidenceIds, features: ['cut' as const],
        timeline: { name: `Travel alternative ${alternative + 1}`, fps: input.request.target.fps, durationFrames: input.request.target.durationFrames },
        clips: [...clips, { id: 'music-bed', mediaId: 'music', mediaType: 'audio' as const, track: 1,
          source: { start: 0, end: 240 }, timeline: { start: 0, end: 240 }, evidenceIds: input.media.find(row => row.id === 'music')!.evidenceIds }] },
        rationale: `Operator-supplied reference and ranges; alternative ${alternative + 1} reverses the location order.`,
        risks: ['Creative rhythm/reference-fit not evaluated.'],
        scores: [{ criterion: 'operator-preference', value: alternative ? 0.9 : 0.7, evidenceIds }] };
    });
  },
};
