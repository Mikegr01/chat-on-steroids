import { z } from 'zod';
import { adapterCutCapabilitiesSchema, mediaAssetSchema, videoEvidenceSchema, videoIdSchema } from '../../shared/video-editing.js';
import { videoDecisionProofSchema } from './authority.js';
import { preparedWorkflow } from './workflow-preview.js';
import { VideoEditingStore } from './store.js';
import { canonicalJson } from './identity.js';
import { sameRate } from './validation.js';
import type { PreparedExecution } from './execution.js';
import { capabilityAdmissionBlockers } from './source-end-admission.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const executionAuthorizationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixture'), preparedHash: hash }).strict(),
  z.object({ kind: z.literal('operator'), operatorId: videoIdSchema, preparedHash: hash }).strict(),
  z.object({ kind: z.literal('s7'), preparedHash: hash, proof: videoDecisionProofSchema }).strict(),
]);
export const workflowGuardContextSchema = z.object({ jobId: videoIdSchema, sessionId: videoIdSchema,
  localProjectId: videoIdSchema.nullable(), resolveProjectId: videoIdSchema, timeline: videoEvidenceSchema,
  media: z.array(mediaAssetSchema).max(100), capabilities: adapterCutCapabilitiesSchema }).strict();
/** Shared preparation predicates; the native operator gate adds exact authority and first-acceptance scope.
 * Default/legacy callers retain the production firewall. This result itself grants no dispatch token. */
export function evaluateWorkflowAuthorization(store: VideoEditingStore, id: string, prepared: PreparedExecution,
  rawContext: unknown, rawAuthority: unknown, operatorDispatch = false) {
  const guards: Array<{ id: string; status: 'pass' | 'fail'; explanation: string }> = [];
  const check = (id: string, passed: boolean, explanation: string) => guards.push({ id, status: passed ? 'pass' : 'fail', explanation });
  const job = store.get(id), context = workflowGuardContextSchema.safeParse(rawContext), authority = executionAuthorizationSchema.safeParse(rawAuthority);
  check('WORKFLOW_PREPARED', job?.workflow?.phase === 'prepared', 'Existing durable selected preparation required.');
  check('CAPABILITY_CONFIRMATION_AUTHORITY', !!job && capabilityAdmissionBlockers(job).length === 0,
    'Historical confirmation metadata cannot authorize current execution; exact authenticated admission required.');
  check('GUARD_CONTEXT', context.success, 'Current bounded observation snapshot required.');
  check('AUTHORITY_CONTRACT', authority.success, 'Authority kind and exact prepared fingerprint required.');
  let expected: PreparedExecution | undefined;
  try { if (job) expected = preparedWorkflow(job); } catch { /* Exact fingerprint guard below reports this. */ }
  let identical = false;
  try { identical = !!expected && canonicalJson(prepared) === canonicalJson(expected); } catch { /* Invalid JSON cannot be authority. */ }
  check('PREPARED_FINGERPRINT', identical, 'Prepared operation sequence must equal the durable selected plan compilation.');
  const current = context.success ? context.data : undefined;
  const auth = authority.success ? authority.data : undefined;
  check('WORK_IDENTITY', !!job && current?.jobId === job.id && current?.sessionId === job.sessionId && current?.localProjectId === job.localProjectId && current?.resolveProjectId === job.resolveProjectId,
    'Current job, local session/project and Resolve project must join exactly.');
  const before = job?.evidence.find(row => row.id === expected?.request.beforeEvidenceIds[0]);
  const timeline = current?.timeline, state = timeline?.timelineState, original = before?.timelineState;
  check('TARGET_IDENTITY', !!job && timeline?.subject === 'timeline' && timeline.subjectId === expected?.request.timelineId && state?.resolveProjectId === job.resolveProjectId,
    'Observed timeline must be the exact prepared target in the exact Resolve project.');
  check('TARGET_OWNERSHIP', !!state?.ownership && !!original?.ownership && canonicalJson(state.ownership) === canonicalJson(original.ownership) && state.ownership.sourceTimelineId === null,
    'Actual ownership receipt must retain the fresh adapter-owned version identity.');
  check('TARGET_EMPTY_COMPATIBLE', !!state?.complete && state.items.length === 0 && state.durationFrames === 0 && !!original && state.startFrame === original.startFrame && sameRate(state.fps, original.fps),
    'Complete empty target, start frame and timebase must remain compatible.');
  check('OBSERVATION_FRESH', !!timeline && !!before && timeline.observedAt >= before.observedAt && timeline.basis !== 'inferred', 'After-await preflight observations cannot predate the admitted before state.');
  const candidate = job?.candidates.find(row => row.plan.id === expected?.request.planId);
  const used = job?.media.filter(row => candidate?.plan.clips.some(clip => clip.mediaId === row.id)) ?? [];
  const mediaFields = ['id', 'path', 'sha256', 'resolveMediaId', 'fps', 'durationFrames', 'video', 'audio', 'width', 'height'] as const;
  check('CURRENT_MEDIA', !!current && used.length > 0 && used.every(asset => {
    const rows = current.media.filter(row => row.id === asset.id);
    return rows.length === 1 && mediaFields.every(key => canonicalJson({ value: asset[key] }) === canonicalJson({ value: rows[0]![key] }));
  }), 'Current approved source content and technical/media-pool identities must match all selected assets.');
  check('ADAPTER_CAPABILITIES', !!current && !!expected && expected.capabilities.tools.every(tool => current.capabilities.tools.includes(tool)),
    'Current admitted adapter exposure must retain every negotiated capability.');
  check('FRAME_END_ACCEPTANCE', !!current && !!expected && current.capabilities.sourceEnd === expected.capabilities.sourceEnd && current.capabilities.sourceEnd !== 'unknown',
    'Prepared and current source-end convention must match; production acceptance remains pending.');
  let consumed = true;
  try { consumed = !job || !expected || store.consumedTarget(job.resolveProjectId, expected.request.timelineId).length > 0; } catch { /* Unhealthy custody fails closed. */ }
  check('TARGET_CUSTODY_CONSUMED', !consumed, 'No claimed, verified or ambiguous assembly may already consume this project/timeline.');
  check('AUTHORITY_FINGERPRINT', !!auth && auth.preparedHash === expected?.preparedHash, 'Authorization must name the exact prepared artifact.');
  if (auth?.kind === 'fixture') check('FIXTURE_AUTHORITY_UNAVAILABLE', process.env.NODE_ENV === 'test' && process.env.VITEST === 'true', 'Fixture authority exists only inside tests.');
  else {
    if (!operatorDispatch || auth?.kind!=='operator') check('LIVE_EXECUTION_ACCEPTANCE_PENDING', false, 'Legacy and autonomous production execution remain closed.');
    if (!operatorDispatch || auth?.kind!=='operator') check('FRAME_END_LIVE_ACCEPTANCE_PENDING', false, 'Live AppendToTimeline source-end acceptance is pending.');
    check('PRODUCTION_EVIDENCE_MEASURED', !!timeline && timeline.basis === 'measured' && !!job && job.evidence.every(row => row.basis !== 'fixture'), 'Fixture evidence cannot grant production execution.');
    if (auth?.kind === 'operator' && !operatorDispatch) check('OPERATOR_LIVE_EXECUTION_UNAVAILABLE', false, 'Operator intent is defined; live execution admission is not implemented.');
    if (auth?.kind === 's7') check('CAUSAL_PROOF_SESSION', auth.proof.sessionId === job?.sessionId, 'Causal proof must name this durable session.');
    if (auth?.kind === 's7') check('S7_FINAL_LIVE_CANARY_DEFERRED', false, 'Final S7 live acceptance is deferred; Category C production cannot execute.');
  }
  const failed = guards.filter(guard => guard.status === 'fail').map(guard => guard.id);
  return { allowed: failed.length === 0, guards, failed };
}
