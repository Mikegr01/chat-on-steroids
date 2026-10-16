import { randomUUID } from 'node:crypto';
import { operatorAuthorizationSchema, type OperatorAuthorization } from '../../shared/video-operator.js';
import type { VideoEditingDocument } from '../../shared/video-editing.js';
import { validateDocument } from './validation.js';
import { preparedWorkflow } from './workflow-preview.js';
import { fingerprint } from './workflow-planning.js';
import { capabilityAdmissionBlockers } from './source-end-admission.js';
export function operatorBinding(job: VideoEditingDocument) {
  const prepared = preparedWorkflow(job);
  const before = job.evidence.find(row=>row.id===prepared.request.beforeEvidenceIds[0])!;
  return { jobId: job.id, planId: prepared.request.planId, resolveProjectId: job.resolveProjectId,
    timelineId: prepared.request.timelineId, preparedHash: prepared.preparedHash,
    targetHash: fingerprint(before.timelineState), operationHash: fingerprint(prepared.operations) };
}
export function createOperatorAuthorization(raw: unknown, origin: 'operator-ipc', now = Date.now()): OperatorAuthorization {
  const job = validateDocument(raw);
  if (origin !== 'operator-ipc' || job.workflow?.phase !== 'prepared' || preparedWorkflow(job).state !== 'ready') throw new Error('Operator selected preparation required');
  const blockers = capabilityAdmissionBlockers(job);
  if (blockers.length) throw new Error(`Capability confirmation authority unavailable: ${blockers.join(', ')}`);
  if (job.workflow?.capabilities.acceptance==='fixture' || job.workflow?.planner?.kind==='fixture' || job.evidence.some(row=>row.basis==='fixture')) throw new Error('Fixture evidence cannot issue production operator authority');
  if (job.checkpoints.length) throw new Error('Consumed or ambiguous execution cannot be reauthorized');
  return operatorAuthorizationSchema.parse({ id: randomUUID(), kind: 'operator-explicit', provenance: origin,
    ...operatorBinding(job), issuedAt: now, expiresAt: now + 600000 });
}
export function assertOperatorBinding(job: VideoEditingDocument, auth: OperatorAuthorization) {
  const expected = operatorBinding(job);
  if (Object.entries(expected).some(([key, value])=> auth[key as keyof OperatorAuthorization] !== value)) throw new Error('Operator authorization binding changed');
}
