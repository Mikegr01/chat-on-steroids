import type { VideoEditingDocument, VideoWorkflow } from '../../shared/video-editing.js';
import { requestFingerprint, compareWorkCandidates, designIdentity } from './workflow-planning.js';
import { canonicalJson } from './identity.js';
import { prepareExecution } from './execution.js';
import { assertSourceUsabilityMutable } from './source-usability.js';
import { assertCapabilityAdmissionMutable, assertCapabilityConfirmationMutable, isCapabilityConfirmationAuthorityValid } from './source-end-admission.js';
import { validateLegacyPreparedRecovery } from './legacy-prepared-recovery.js';

const transitions: Record<VideoWorkflow['phase'], VideoWorkflow['phase'][]> = {
  requested: ['ingesting'], ingesting: ['evidence-ready', 'blocked'], 'evidence-ready': ['planning', 'blocked'],
  planning: ['candidates-ready', 'blocked'], 'candidates-ready': ['selected'], selected: ['prepared', 'blocked'],
  prepared: [], blocked: ['ingesting', 'planning', 'prepared', 'blocked'],
};
export function validateWorkflowShape(job: VideoEditingDocument): void {
  const state = job.workflow;
  if (!state) {
    if (!job.evidence.length || !job.references.length || !job.media.length || !job.candidates.length) throw new Error('Legacy domain artifacts cannot be empty');
    return;
  }
  const request = state.request;
  if (request.id !== job.id || request.sessionId !== job.sessionId || request.localProjectId !== job.localProjectId ||
    request.resolveProjectId !== job.resolveProjectId || request.objective !== job.objective || request.maxRevisions !== job.maxRevisions ||
    state.requestHash !== requestFingerprint(request)) throw new Error('Work request identity/fingerprint mismatch');
  const ingested = !['requested', 'ingesting'].includes(state.phase) && !(state.phase === 'blocked' && state.blockedAt === 'ingesting');
  if (ingested && (job.media.length !== request.assets.filter(row => row.role !== 'reference').length ||
    job.references.length !== request.assets.filter(row => row.role === 'reference').length)) throw new Error('Workflow ingestion incomplete');
  for (const asset of job.media) if (!request.assets.some(row => row.id === asset.id && row.role !== 'reference')) throw new Error('Unexpected workflow media');
  for (const reference of job.references) if (!request.assets.some(row => row.id === reference.referenceId && row.role === 'reference')) throw new Error('Unexpected workflow reference');
  if (state.phase === 'blocked' && (!state.blockedAt || !state.blockers.length) || state.phase !== 'blocked' && (state.blockedAt || state.blockers.length)) throw new Error('Workflow blockage mismatch');
  if (state.phase === 'planning' && (!state.planner || !state.planningInputHash)) throw new Error('Active planner binding missing');
  if (['candidates-ready', 'selected', 'prepared'].includes(state.phase) && (!state.planner || !state.planningInputHash || !job.candidates.length || state.comparison.length !== job.candidates.length)) throw new Error('Workflow candidate custody incomplete');
  if (state.selection && !state.comparison.some(row => row.candidateId === state.selection!.candidateId && row.score !== null && !row.blockers.length)) throw new Error('Selected candidate infeasible or missing');
  if (['selected', 'prepared'].includes(state.phase) && !state.selection) throw new Error('Workflow selection missing');
  if (state.phase === 'prepared' && !state.prepared) throw new Error('Workflow preparation missing');
  if (state.prepared && job.candidates.find(row => row.id === state.selection?.candidateId)?.plan.id !== state.prepared.request.planId) throw new Error('Prepared selection mismatch');
}
/** Restore/publish validates derived snapshots without introducing another authority. */
export function validateWorkflowDerived(job: VideoEditingDocument): void {
  const state = job.workflow;
  if (!state) return;
  validateLegacyPreparedRecovery(job);
  if (state.comparison.length) {
    if (!state.prepared && !state.planner) throw new Error('Planner provenance missing');
    for (const candidate of job.candidates) {
      const { id: _id, rootPlanId: _root, revision: _revision, parentPlanId: _parent, ...plan } = candidate.plan;
      const hash = designIdentity(state.planningInputHash!, state.planner!, { plan, rationale: candidate.rationale, risks: candidate.risks, scores: candidate.scores });
      if (candidate.id !== `candidate-${hash}` || candidate.plan.id !== `plan-${hash}` || candidate.plan.rootPlanId !== candidate.plan.id || candidate.plan.revision !== 0) throw new Error('Candidate identity fingerprint mismatch');
    }
    if (canonicalJson(compareWorkCandidates(job, state.capabilities)) !== canonicalJson(state.comparison)) throw new Error('Comparison fingerprint mismatch');
  }
  if (state.prepared) {
    const prepared = prepareExecution(job, state.prepared.request, state.prepared.capabilities);
    if (prepared.preparedHash !== state.prepared.preparedHash || prepared.intentHash !== state.prepared.intentHash ||
      state.phase === 'prepared' && prepared.state !== 'ready' ||
      canonicalJson(compareWorkCandidates(job, state.prepared.capabilities)) !== canonicalJson(state.comparison)) throw new Error('Prepared/comparison fingerprint mismatch');
  }
}
export function preserveWorkflow(before: VideoEditingDocument, after: VideoEditingDocument, advancing: boolean): void {
  const old = before.workflow, next = after.workflow;
  if (!old && !next) return;
  if (!old || !next || canonicalJson(old.request) !== canonicalJson(next.request) || old.requestHash !== next.requestHash) throw new Error('Work request immutable');
  if (canonicalJson(old.legacyPreparedRecovery ?? null) !== canonicalJson(next.legacyPreparedRecovery ?? null)) throw new Error('Legacy recovery requires its owner');
  if (canonicalJson(old.capabilities) !== canonicalJson(next.capabilities)) throw new Error('Workflow capabilities immutable');
  if (!advancing) { if (canonicalJson(old) !== canonicalJson(next)) throw new Error('Workflow transition requires its owner'); return; }
  if (canonicalJson(old.sourceUsability ?? []) !== canonicalJson(next.sourceUsability ?? [])) throw new Error('Source usability requires its owner');
  if (canonicalJson(old.capabilityAdmission ?? null) !== canonicalJson(next.capabilityAdmission ?? null)) throw new Error('Capability admission requires its owner');
  if (canonicalJson(old.capabilityConfirmation ?? null) !== canonicalJson(next.capabilityConfirmation ?? null)) throw new Error('Capability confirmation requires its owner');
  if (next.revision !== old.revision + 1 || !transitions[old.phase].includes(next.phase)) throw new Error('Invalid workflow transition');
  for (const key of ['planner', 'planningInputHash', 'selection', 'prepared'] as const)
    if (old[key] && canonicalJson(old[key]) !== canonicalJson(next[key])) throw new Error(`Workflow ${key} immutable`);
  if (old.comparison.length && canonicalJson(old.comparison) !== canonicalJson(next.comparison)) throw new Error('Comparison immutable');
}
/** Restore recognizes only an exact committed source-decision transition, never a general same-phase rewrite. */
export function preserveSourceUsability(before: VideoEditingDocument, after: VideoEditingDocument): void {
  assertSourceUsabilityMutable(before); assertSourceUsabilityMutable(after);
  const old = before.workflow!, next = after.workflow!;
  if (next.revision !== old.revision + 1 || canonicalJson({ ...old, sourceUsability: undefined, comparison: undefined, revision: 0 }) !==
    canonicalJson({ ...next, sourceUsability: undefined, comparison: undefined, revision: 0 })) throw new Error('Invalid source usability transition');
  const changed = (next.sourceUsability ?? []).filter(row => canonicalJson(row) !==
    canonicalJson(old.sourceUsability?.find(prior => prior.binding.assetId === row.binding.assetId) ?? null));
  if (changed.length !== 1 || changed[0]!.revision !== next.revision ||
    (old.sourceUsability ?? []).some(row => !next.sourceUsability?.some(value => value.binding.assetId === row.binding.assetId)))
    throw new Error('Source usability custody regressed');
}
export function preserveCapabilityAdmission(before: VideoEditingDocument, after: VideoEditingDocument): void {
  assertCapabilityAdmissionMutable(before); assertCapabilityAdmissionMutable(after);
  const old = before.workflow!, next = after.workflow!;
  if (next.revision !== old.revision + 1) throw new Error('Invalid capability admission revision');
  if (!next.capabilityAdmission || next.capabilityAdmission.revision !== next.revision) throw new Error('Capability admission custody regressed');
  if (canonicalJson({ ...old, capabilityAdmission: undefined, revision: 0, phase: 'selected', blockedAt: undefined, blockers: [] }) !==
    canonicalJson({ ...next, capabilityAdmission: undefined, revision: 0, phase: 'selected', blockedAt: undefined, blockers: [] }))
    throw new Error('Invalid capability admission transition: immutable state changed');
}
export function preserveCapabilityConfirmation(before: VideoEditingDocument, after: VideoEditingDocument): void {
  assertCapabilityConfirmationMutable(before); assertCapabilityConfirmationMutable(after);
  const old = before.workflow!, next = after.workflow!;
  if (next.revision !== old.revision + 1) throw new Error('Invalid capability confirmation revision');
  if (!next.capabilityConfirmation) throw new Error('Capability confirmation custody regressed');
  if (isCapabilityConfirmationAuthorityValid(before)) throw new Error('Capability admission already confirmed; no authority may be replayed');
  if (!isCapabilityConfirmationAuthorityValid(after, next.capabilityConfirmation)) throw new Error('Current independently authenticated capability confirmation required');
  if (canonicalJson({ ...old, capabilityConfirmation: undefined, revision: 0, phase: 'selected', blockedAt: undefined, blockers: [] }) !==
    canonicalJson({ ...next, capabilityConfirmation: undefined, revision: 0, phase: 'selected', blockedAt: undefined, blockers: [] }))
    throw new Error('Invalid capability confirmation transition: immutable state changed');
}
