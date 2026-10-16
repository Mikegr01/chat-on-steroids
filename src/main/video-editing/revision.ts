import type { EditClip, EditPlan, RevisionPlan } from '../../shared/video-editing.js';
import { canonicalJson } from './identity.js';
import { evaluateOutputReview } from './review.js';
import { validateDocument, validatePlan } from './validation.js';

function applyDeltas(clips: EditClip[], deltas: RevisionPlan['deltas']): EditClip[] {
  const result = structuredClone(clips);
  for (const delta of deltas) {
    if (delta.kind === 'insert') {
      const index = delta.afterClipId === null ? -1 : result.findIndex(row => row.id === delta.afterClipId);
      if ((delta.afterClipId !== null && index < 0) || result.some(row => row.id === delta.clip.id)) throw new Error('Invalid insert delta');
      result.splice(index + 1, 0, structuredClone(delta.clip));
    } else {
      const index = result.findIndex(row => row.id === delta.clipId);
      if (index < 0) throw new Error('Unknown delta clip');
      if (delta.kind === 'remove') result.splice(index, 1);
      else {
        if (delta.clip.id !== delta.clipId) throw new Error('Replace delta must retain clip identity');
        result[index] = structuredClone(delta.clip);
      }
    }
  }
  return result;
}

function requirements(plan: EditPlan) {
  return { rootPlanId: plan.rootPlanId, referenceProfileIds: plan.referenceProfileIds, evidenceIds: plan.evidenceIds,
    features: plan.features, fps: plan.timeline.fps, durationFrames: plan.timeline.durationFrames };
}

function cutContent(plan: EditPlan) {
  return plan.clips.map(({ id: _id, evidenceIds: _evidence, ...clip }) => clip);
}

/** Proposes a new version only; never edits the parent or starts an autonomous loop. */
export function evaluateRevision(document: unknown, revisionId: string): { ready: boolean; blockers: string[] } {
  const job = validateDocument(document);
  const revision = job.revisions.find(row => row.id === revisionId);
  if (!revision) throw new Error('Unknown revision');
  const parent = job.candidates.find(row => row.plan.id === revision.parentPlanId)!.plan;
  const next = job.candidates.find(row => row.plan.id === revision.nextPlanId)!.plan;
  if (canonicalJson(requirements(parent)) !== canonicalJson(requirements(next))) throw new Error('Revision changes requirements outside clip deltas');
  if (canonicalJson(applyDeltas(parent.clips, revision.deltas)) !== canonicalJson(next.clips)) throw new Error('Revision delta does not reproduce next plan');
  const blockers: string[] = [];
  if (evaluateOutputReview(job, revision.reviewId).verdict !== 'fail') blockers.push('REVIEW_NOT_ACTIONABLE');
  if (job.candidates.some(row => row.plan.rootPlanId === next.rootPlanId && row.plan.revision < next.revision &&
      canonicalJson(cutContent(row.plan)) === canonicalJson(cutContent(next)))) blockers.push('REVISION_REPEATS_CONTENT');
  blockers.push(...validatePlan(next, job));
  return { ready: blockers.length === 0, blockers: [...new Set(blockers)] };
}
