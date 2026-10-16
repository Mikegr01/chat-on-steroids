import type { VideoEditingDocument } from '../../shared/video-editing.js';
import { prepareExecution, preparedPreview, type PreparedExecution } from './execution.js';
import { outputEvidenceRequirements } from './workflow-output.js';
import { canonicalJson } from './identity.js';

export function workflowPreview(job: VideoEditingDocument, prepared: PreparedExecution) {
  const request = job.workflow!.request, candidate = job.candidates.find(row => row.plan.id === prepared.request.planId)!, plan = candidate.plan;
  const warnings = ['CREATIVE_REVIEW_UNAVAILABLE', 'POSITIONED_RENDER_OUTPUT_EVIDENCE_REQUIRED', 'OUTPUT_RENDER_FORMAT_UNVERIFIED',
    ...prepared.productionBlockers, ...prepared.blockers, ...job.workflow!.blockers, ...job.workflow!.comparison.flatMap(row => row.blockers)];
  if (job.workflow!.planner?.kind === 'fixture') warnings.push('FIXTURE_PLANNER_NO_PRODUCTION_INTELLIGENCE');
  if (job.evidence.some(row => row.basis === 'fixture')) warnings.push('FIXTURE_EVIDENCE');
  if (request.assets.some(row => row.usable) || job.workflow!.sourceUsability?.length) warnings.push('USABLE_RANGES_ARE_OPERATOR_SELECTIONS');
  for (const asset of job.media) for (const field of ['fps', 'durationFrames', 'video', 'audio'] as const)
    if (asset[field] === undefined) warnings.push(`UNKNOWN:${asset.id}:${field}`);
  return { version: 1, jobId: job.id, state: job.workflow!.phase, requestHash: job.workflow!.requestHash, preparedHash: prepared.preparedHash,
    summary: { candidateId: job.workflow!.selection!.candidateId, planId: plan.id, durationFrames: plan.timeline.durationFrames,
      fps: plan.timeline.fps, width: request.target.width, height: request.target.height, objective: request.objective,
      rationale: candidate.rationale, risks: candidate.risks },
    clips: plan.clips.map(clip => ({ ...clip, sourcePath: job.media.find(row => row.id === clip.mediaId)!.path,
      referenceProfileIds: plan.referenceProfileIds })),
    referenceLinkage: job.references.filter(row => plan.referenceProfileIds.includes(row.id)),
    styleConstraints: request.style, creativeStatus: 'UNVERIFIED', outputRequirements: request.output,
    comparison: job.workflow!.comparison, selection: job.workflow!.selection,
    warnings: [...new Set(warnings)].sort(), operations: prepared.operations, timelineId: prepared.request.timelineId,
    safetyPredicates: prepared.predicates, versionBehavior: prepared.versionBehavior,
    outputEvidence: outputEvidenceRequirements(job, prepared), executionPreview: preparedPreview(prepared) };
}
export function preparedWorkflow(job: VideoEditingDocument) {
  const saved = job.workflow?.prepared;
  if (!saved) throw new Error('Workflow has no preparation');
  const prepared = prepareExecution(job, saved.request, saved.capabilities);
  if (prepared.preparedHash !== saved.preparedHash || prepared.intentHash !== saved.intentHash) throw new Error('Prepared workflow fingerprint mismatch');
  return prepared;
}
export function serializeWorkflowPreview(preview: ReturnType<typeof workflowPreview>) {
  const serialized = canonicalJson(preview);
  if (Buffer.byteLength(serialized) > 1024 * 1024) throw new Error('Preview byte bound');
  return serialized;
}
