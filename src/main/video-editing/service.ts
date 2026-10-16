import { z } from 'zod';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { workRequestSchema, videoIdSchema, sourceUsabilityInputSchema, legacyPreparedRecoveryInputSchema, nativeVideoExecutionInputSchema, type VideoEditingDocument } from '../../shared/video-editing.js';
import { getConfig, effectiveCapabilities } from '../config.js';
import { getSession } from '../session/store.js';
import { app } from 'electron';
import { currentCall } from '../mcp/call-context.js';
import { createGuardedResolveReader, approvedVideoArtifactAccess, readAdmittedWorkflowCapabilities, readAdmittedWorkflowEpoch, readAdmittedWorkflowAdapterInfo, createGuardedResolveDispatch, createNativeResolveAccess } from './runtime-inspection.js';
import { VideoEditingStore } from './store.js';
import { VideoWorkflowCoordinator } from './workflow.js';
import { createAssetIngestor } from './workflow-ingestion.js';
import { createOperatorPlanner, fingerprint } from './workflow-planning.js';
import { MediaRuntime, mediaRuntimeDiagnostics } from './media-runtime.js';
import { mediaRuntimeOperator, mediaRuntimePathsSchema } from './media-runtime-operator.js';
import { MediaImages } from './media-images.js';
import { operatorPreflight } from './operator-preflight.js';
import { preparedWorkflow, workflowPreview, serializeWorkflowPreview } from './workflow-preview.js';
import { collectMediaOutput } from './media-output.js';
import { liveAcceptanceManifest,OperatorExecutionCoordinator,technicalAcceptance, type OperatorExecutionBoundary } from './operator-execution.js';
import { createOperatorAuthorization } from './operator-authorization.js';
import { assertSourceUsabilityMutable, sourceUsabilityBinding, validateSourceUsabilityInput, effectiveSourceUsableRanges } from './source-usability.js';
import { assertCapabilityAdmissionMutable, assertCapabilityConfirmationMutable, effectiveSourceEnd, createCapabilityAdmissionReceipt, isCapabilityConfirmationAuthorityValid } from './source-end-admission.js';
import { consumeCapabilityOperatorProof, type CapabilityOperatorContext, type CapabilityOperatorReview } from './capability-operator-proof.js';
import { consumeNativeExecutionPrincipal, type NativeExecutionReview } from './native-execution-principal.js';

const id = videoIdSchema;
export const videoActionSchema = z.discriminatedUnion('action', [
  z.object({ action:z.literal('create'),request:workRequestSchema,sourceEnd:z.enum(['unknown','inclusive','exclusive']).default('unknown') }).strict(),
  z.object({ action:z.literal('inspect'),jobId:id }).strict(),
  z.object({action:z.literal('sample'),jobId:id,evidenceId:id}).strict(),
  z.object({ action:z.literal('ingest'),jobId:id }).strict(),
  z.object({ action:z.literal('source-usability'),jobId:id }).strict(),
  sourceUsabilityInputSchema.extend({ action:z.literal('set-usable-ranges'),jobId:id }).strict(),
  z.object({ action:z.literal('submit'),jobId:id,designs:z.array(z.unknown()).min(2).max(20),
    provider:z.object({ id,version:id,configuration:z.record(z.string(),z.string().max(2000)) }).strict() }).strict(),
  z.object({ action:z.literal('select'),jobId:id,candidateId:id }).strict(),
  z.object({ action:z.literal('prepare'),jobId:id,timelineId:id }).strict(),
  legacyPreparedRecoveryInputSchema.extend({ action:z.literal('recover-legacy-prepared'),jobId:id }).strict(),
  z.object({ action:z.literal('preview'),jobId:id }).strict(),
  z.object({ action:z.literal('preflight'),jobId:id,authorizationId:z.string().uuid().optional() }).strict(),
  z.object({action:z.literal('collect-output'),jobId:id,operationId:z.string().uuid(),renderId:id}).strict(),
  z.object({action:z.literal('live-manifest'),jobId:id,authorizationId:z.string().uuid()}).strict(),
  z.object({action:z.literal('execute'),jobId:id,authorizationId:z.string().uuid(),manifestHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  z.object({action:z.literal('reconcile'),jobId:id,operationId:z.string().uuid()}).strict(),
  z.object({action:z.literal('technical-acceptance'),jobId:id,operationId:z.string().uuid(),renderId:id.optional()}).strict(),
  z.object({ action:z.literal('runtime') }).strict(),
  z.object({ action:z.literal('media-runtime-status') }).strict(),
  z.object({ action:z.literal('media-runtime-refresh') }).strict(),
  mediaRuntimePathsSchema.extend({action:z.literal('media-runtime-admit')}).strict(),
  z.object({ action:z.literal('capability-status'),jobId:id }).strict(),
  z.object({ action:z.literal('readmit-source-end'),jobId:id,expectedRevision:z.number().int().nonnegative() }).strict(),
  z.object({ action:z.literal('readmit-capabilities'),jobId:id,expectedRevision:z.number().int().nonnegative() }).strict(),
]);
let store = new VideoEditingStore(); let ready:Promise<void>|undefined;
export async function videoStore() {
  if(!ready) { ready=store.restore(); void ready.catch(()=>{ ready=undefined; }); }
  await ready; return store;
}
export function resetVideoStoreForTests(): void {
  store = new VideoEditingStore();
  ready = undefined;
}
let cache:MediaImages|undefined;
const images=()=>cache??=new MediaImages(path.join(app.getPath('userData'),'video-evidence'));
type ProjectScope = string | null;
/** Trusted durable session scope: missing/undefined and explicit null are standalone.
 * This is not authority by itself; caller session/conversation identity stays exact. */
function normalizeSessionProjectId(session:{projectId?:ProjectScope}):ProjectScope {
  return session.projectId ?? null;
}
function binding(session:NonNullable<Awaited<ReturnType<typeof getSession>>>) {
  return fingerprint({id:session.id,projectId:normalizeSessionProjectId(session),conversationId:session.conversationId,chatIds:session.chatIds,
    retiredChatAt:session.retiredChatAt,lastCommittedResumeHandoffId:session.lastCommittedResumeHandoffId});
}
function sessionGuard(parent:NonNullable<ReturnType<typeof currentCall>>,expected:string,epoch?:string,runtime?:string) {
  return async()=>{
    const session=await getSession(parent.caller.sessionId!);
    if(!session||currentCall()!==parent||binding(session)!==expected||getConfig().readOnly||!effectiveCapabilities(getConfig()).read) throw new Error('Video session owner/epoch or permission changed');
    if(epoch!==undefined && readAdmittedWorkflowEpoch()!==epoch || runtime!==undefined && fingerprint(getConfig().mediaRuntime)!==runtime) throw new Error('Video adapter/runtime owner epoch changed');
  };
}
function previewJob(job:VideoEditingDocument) {
  const result=workflowPreview(job,preparedWorkflow(job));serializeWorkflowPreview(result);return result;
}
async function exactJob(jobId:string) {
  const parent=currentCall(); if(!parent?.caller.sessionId) throw new Error('Exact admitted local session required');
  const ledger=await videoStore(),job=ledger.get(jobId),session=await getSession(parent.caller.sessionId);
  if(!job||!session||session.id!==parent.caller.sessionId||job.sessionId!==session.id||job.localProjectId!==normalizeSessionProjectId(session)||session.conversationId!==parent.caller.conversationId||currentCall()!==parent) throw new Error('Video job/current session/project mismatch');
  return {parent,ledger,job,assertOwner:sessionGuard(parent,binding(session))};
}
// Private shared seam after exact scope validation. Native execution additionally admits its
// one-use principal before shared execute; durable authority remains owned by the coordinator.
interface ValidatedVideoExecutionContext {
  ledger: VideoEditingStore; job: VideoEditingDocument; boundary: OperatorExecutionBoundary;
}
function executionContext(job: VideoEditingDocument, ledger: VideoEditingStore, assertPrincipal: () => Promise<void>,
  resolve: ReturnType<typeof createNativeResolveAccess>): ValidatedVideoExecutionContext {
  const prepared = preparedWorkflow(job), { reader, access, epoch } = resolve;
  const admission = getConfig().mediaRuntime, runtimeBinding = fingerprint(admission);
  const runtime = admission ? new MediaRuntime(admission) : undefined;
  const assertOwner = async () => {
    await assertPrincipal();
    if (fingerprint(getConfig().mediaRuntime) !== runtimeBinding) throw new Error('Video runtime owner epoch changed');
  };
  const capture = async () => {
    await assertOwner();
    const timeline = (await reader.timeline(prepared.request.timelineId, { id: `preflight-${randomUUID()}`, observedAt: Date.now() })).evidence;
    const acquired = await createAssetIngestor({ access, reader, runtime }).ingest(job.workflow!.request); await assertOwner();
    const status = (await mediaRuntimeDiagnostics(admission)).status; await assertOwner();
    const capabilities = { ...resolve.capabilities, sourceEnd: timeline.adapterDispatch?.sourceEnd ?? 'unknown' as const };
    return { context: { jobId: job.id, sessionId: job.sessionId, localProjectId: job.localProjectId, resolveProjectId: job.resolveProjectId,
        timeline, media: acquired.media, capabilities },
      readiness: { runtimeStatus: status, ownerEpoch: fingerprint({ epoch, runtimeBinding, session: job.sessionId, project: job.localProjectId }),
        adapter: timeline.adapterDispatch ? { guardVersion: timeline.adapterDispatch.guardVersion, sourceEnd: timeline.adapterDispatch.sourceEnd,
          snapshotSha256: timeline.adapterDispatch.snapshotSha256, projectName: timeline.adapterDispatch.projectName }
          : { guardVersion: 0, sourceEnd: 'unknown', snapshotSha256: '0'.repeat(64), projectName: 'UNKNOWN' } } };
  };
  const boundary: OperatorExecutionBoundary = { capture, assertOwner, call: resolve.call, observe: async () => {
    const result = (await reader.timeline(prepared.request.timelineId, { id: `after-${randomUUID()}`, observedAt: Date.now() })).evidence;
    await assertOwner(); const current = ledger.get(job.id)!; await ledger.put({ ...current, evidence: [...current.evidence, result] }); return [result.id];
  } };
  return { job, ledger, boundary };
}
async function executionManifest(context: ValidatedVideoExecutionContext, authorizationId: string) {
  const fresh = await context.boundary.capture(); await context.boundary.assertOwner();
  return liveAcceptanceManifest(context.ledger, context.job.id, authorizationId, fresh.context, fresh.readiness);
}
async function executeReviewedAcceptance(context: ValidatedVideoExecutionContext, authorizationId: string,
  reviewedManifestHash: string, confirm: (detail: string) => Promise<boolean>) {
  const manifest = await executionManifest(context, authorizationId);
  if (manifest.manifestHash !== reviewedManifestHash) throw new Error('Exact reviewed live manifest changed');
  return new OperatorExecutionCoordinator(context.ledger, context.boundary).execute(manifest, detail =>
    confirm(`Execute this FIRST guarded Resolve acceptance now? This mutates only the reviewed dedicated AI-owned empty target. One-shot authority is consumed before dispatch; interruption never grants replay.\n${detail}`));
}
export async function videoAction(raw:unknown, confirm:(detail:string)=>Promise<boolean>) {
  const action=videoActionSchema.parse(raw),parent=currentCall();
  if(!parent?.caller.sessionId) throw new Error('Exact admitted local session required');
  if(action.action==='runtime') return mediaRuntimeDiagnostics(getConfig().mediaRuntime);
  if(action.action==='media-runtime-status'||action.action==='media-runtime-refresh'||action.action==='media-runtime-admit') {
    const session=await getSession(parent.caller.sessionId);
    if(!session||session.id!==parent.caller.sessionId||session.conversationId!==parent.caller.conversationId) throw new Error('Media runtime/current local session mismatch');
    const assertOwner=sessionGuard(parent,binding(session));await assertOwner();
    const result=action.action==='media-runtime-admit'
      ? await mediaRuntimeOperator.admit({ffprobePath:action.ffprobePath,ffmpegPath:action.ffmpegPath},confirm,assertOwner)
      : await mediaRuntimeOperator.status();
    await assertOwner();return result;
  }
  if(action.action==='create') {
    const session=await getSession(parent.caller.sessionId);
    // Project scope is optional; exact connector-proven session ownership never is.
    if(!session||session.id!==parent.caller.sessionId||action.request.sessionId!==session.id||action.request.localProjectId!==normalizeSessionProjectId(session)||session.conversationId!==parent.caller.conversationId||currentCall()!==parent) throw new Error('Request/current local session/project mismatch');
    const assertOwner=sessionGuard(parent,binding(session),readAdmittedWorkflowEpoch());
    const capabilities={...readAdmittedWorkflowCapabilities(),sourceEnd:action.sourceEnd};
    const coordinator=new VideoWorkflowCoordinator(await videoStore(),{ingestor:createAssetIngestor({access:approvedVideoArtifactAccess()}),capabilities,assertOwner});
    return coordinator.request(action.request);
  }
  const {job,ledger,assertOwner:assertSession}=await exactJob(action.jobId);
  if(action.action==='inspect') return job;
  if(!job.workflow) throw new Error('Workflow required');
  if(action.action==='recover-legacy-prepared') {
    await assertSession();
    let epoch:string|undefined;
    const assertOwner=async()=>{ await assertSession(); if(epoch!==undefined && readAdmittedWorkflowEpoch()!==epoch) throw new Error('Video adapter owner epoch changed'); };
    const {action:_action,jobId:_job,...input}=action;
    return ledger.recoverLegacyPrepared(job.id,input,{sessionId:parent.caller.sessionId,localProjectId:job.localProjectId,
      conversationId:parent.caller.conversationId!},async timelineId=>{
        // Exact durable replay needs no adapter. Only a new invalidation acquires read custody.
        try { epoch=readAdmittedWorkflowEpoch(); const reader=createGuardedResolveReader();
          return (await reader.timeline(timelineId,{id:`recovery-${randomUUID()}`,observedAt:Date.now()})).evidence; }
        catch { throw new Error('LEGACY_RECOVERY_TARGET_INSPECTION_FAILED'); }
      },assertOwner);
  }
  if(action.action==='source-usability') {
    assertSourceUsabilityMutable(job); await assertSession();
    return { jobId:job.id,revision:job.workflow.revision,requestHash:job.workflow.requestHash,
      sources:job.workflow.request.assets.filter(row=>row.role==='source'&&row.kind==='video').map(row=>({
        binding:sourceUsabilityBinding(job,row.id),ranges:effectiveSourceUsableRanges(job,row.id),
        decision:job.workflow!.sourceUsability?.find(decision=>decision.binding.assetId===row.id) })) };
  }
  if(action.action==='set-usable-ranges') {
    const {action:_action,jobId:_job,...rawInput}=action,input=validateSourceUsabilityInput(job,rawInput);
    await assertSession();
    if(!await confirm(`Set explicit usable source ranges for job ${job.id}, session ${job.sessionId}?\nAsset: ${input.binding.assetId}\nResolve media: ${input.binding.resolveMediaId}\nPath: ${input.binding.path}\nSHA256: ${input.binding.sha256}\nEvidence: ${input.binding.evidenceHash}\nMeasured frames: ${input.binding.frameCount}\nHalf-open ranges: ${JSON.stringify(input.ranges)}\nJob revision: ${input.expectedRevision}\nThis is a source constraint decision; it grants no execution authority.`)) return {cancelled:true};
    await assertSession(); return ledger.setSourceUsability(job.id,input,assertSession);
  }
  if(action.action==='capability-status') {
    await assertSession();
    const adapter = readAdmittedWorkflowAdapterInfo();
    const trustedCtx = {
      epoch: adapter.ready ? adapter.epoch : undefined,
      adapterSourceEnd: adapter.sourceEnd,
      guardVersion: adapter.guardVersion,
    };
    const effective = effectiveSourceEnd(job, trustedCtx);
    const admission = job.workflow.capabilityAdmission ?? null;
    const confirmation = job.workflow.capabilityConfirmation ?? null;
    const confirmationAuthorityValid = isCapabilityConfirmationAuthorityValid(job);
    const admissionFingerprint = admission?.capabilityFingerprint ?? null;
    const confirmationId = confirmation?.id ?? null;
    const confirmationFingerprint = confirmation?.confirmationFingerprint ?? null;
    const confirmationMatchesAdmission = confirmationAuthorityValid;
    const currentAdapterMatch = Boolean(
      adapter.ready &&
      adapter.sourceEnd === 'inclusive' &&
      adapter.guardVersion === 2 &&
      (!admission || admission.adapterEpoch === adapter.epoch)
    );
    const preparationEligible = Boolean(
      job.workflow.selection &&
      !job.workflow.prepared &&
      job.checkpoints.length === 0 &&
      (!job.operatorAuthorizations || job.operatorAuthorizations.length === 0) &&
      effective === 'inclusive'
    );
    const preparationBlockedByConfirmation = Boolean(
      job.workflow.capabilities.sourceEnd !== 'inclusive' &&
      admission &&
      !confirmationAuthorityValid
    );
    return {
      jobId: job.id,
      phase: job.workflow.phase,
      blockedAt: job.workflow.blockedAt,
      blockers: job.workflow.blockers,
      revision: job.workflow.revision,
      originalSourceEnd: job.workflow.capabilities.sourceEnd,
      effectiveSourceEnd: effective,
      currentAdapter: adapter,
      currentAdmission: admission,
      admissionFingerprint,
      nativeConfirmation: confirmation,
      confirmationId,
      confirmationFingerprint,
      confirmationMatchesAdmission,
      confirmationAuthorityValid,
      confirmationRequired: preparationBlockedByConfirmation,
      currentAdapterMatch,
      preparationEligible,
      preparationBlockedByConfirmation,
    };
  }
  if(action.action==='readmit-source-end' || action.action==='readmit-capabilities') {
    assertCapabilityAdmissionMutable(job);
    if(job.workflow.revision !== action.expectedRevision) {
      throw new Error(`Job revision changed: expected ${action.expectedRevision}, actual ${job.workflow.revision}`);
    }
    const adapter = readAdmittedWorkflowAdapterInfo();
    if(!adapter.ready) throw new Error('ADAPTER_OFFLINE: curated DaVinci Resolve adapter not ready');
    if(adapter.sourceEnd !== 'inclusive') throw new Error(`ADAPTER_SOURCE_END_UNVERIFIED: trusted adapter convention is ${adapter.sourceEnd}, required inclusive`);
    if(adapter.guardVersion !== 2) throw new Error(`ADAPTER_GUARD_VERSION_UNSUPPORTED: guard version is ${adapter.guardVersion}, required 2`);
    await assertSession();
    if(job.workflow.capabilityAdmission && job.workflow.capabilityAdmission.adapterEpoch === adapter.epoch && job.workflow.capabilityAdmission.sourceEnd === 'inclusive') {
      return {
        status: 'already-admitted',
        job,
        capabilityAdmission: job.workflow.capabilityAdmission,
        confirmationRequired: !isCapabilityConfirmationAuthorityValid(job),
      };
    }
    await assertSession();
    const updated = await ledger.setCapabilityAdmission(job.id, adapter, assertSession);
    return {
      status: 'admitted-pending-operator-confirmation',
      job: updated,
      capabilityAdmission: updated.workflow!.capabilityAdmission,
      confirmationRequired: true,
    };
  }
  if(action.action==='technical-acceptance')return technicalAcceptance(job,action.operationId,action.renderId);
  if(action.action==='preview') return previewJob(job);
  if(action.action==='sample') {
    const record=job.evidence.find(row=>row.id===action.evidenceId);
    if(!record?.mediaSample?.image || !record.locator) throw new Error('Admitted sampled image required');
    const original=job.evidence.find(row=>row.technical?.sourceHash===record.mediaSample!.sourceHash)?.locator;
    const access=approvedVideoArtifactAccess();
    if(!original || await access(original.path)!==original.path) throw new Error('Sample source permission unavailable');
    const png=await images().read(record.locator);await assertSession();
    return {png,provenance:{jobId:job.id,evidenceId:record.id,sourceHash:record.mediaSample.sourceHash,image:record.mediaSample.image,
      requestedFrame:record.mediaSample.requestedFrame,actualTimestamp:record.mediaSample.actualTimestamp,position:record.mediaSample.position,
      producer:record.producer,executableHash:record.mediaSample.executableHash}};
  }
  const needsReader=['ingest','prepare','preflight','collect-output','live-manifest','execute','reconcile'].includes(action.action);
  const access=approvedVideoArtifactAccess(),reader=needsReader?createGuardedResolveReader():undefined,admission=getConfig().mediaRuntime;
  const epoch=needsReader?readAdmittedWorkflowEpoch():undefined,runtimeBinding=fingerprint(admission);
  const assertOwner=async()=>{await assertSession();if(epoch!==undefined && readAdmittedWorkflowEpoch()!==epoch||fingerprint(getConfig().mediaRuntime)!==runtimeBinding) throw new Error('Video adapter/runtime owner epoch changed');};
  const runtime=admission ? new MediaRuntime(admission) : undefined;
  if(['live-manifest','execute','reconcile'].includes(action.action)) {
    const context = executionContext(job, ledger, assertOwner, { reader: reader!, access, epoch: epoch!,
      capabilities: readAdmittedWorkflowCapabilities(), call: createGuardedResolveDispatch() });
    if(action.action==='reconcile'){await ledger.restore();return new OperatorExecutionCoordinator(ledger,context.boundary).reconcile(job.id,action.operationId);}
    if(action.action==='live-manifest'||action.action==='execute') {
      if(action.action==='live-manifest')return executionManifest(context,action.authorizationId);
      return executeReviewedAcceptance(context,action.authorizationId,action.manifestHash,confirm);
    }
  }
  let planner;
  if(action.action==='submit') {
    planner=createOperatorPlanner(action.provider.id,action.designs);
    planner.descriptor={...action.provider,kind:'external'};
  }
  const coordinator=new VideoWorkflowCoordinator(ledger,{ingestor:createAssetIngestor({access,reader,runtime,frameSink:(j,h,b)=>(images().write(j,h,b))}),
    planner,capabilities:job.workflow.capabilities,assertOwner,epoch:epoch?()=>epoch:undefined});
  switch(action.action) {
    case 'ingest':
      if(!runtime) throw new Error('MEDIA_RUNTIME_NOT_CONFIGURED: configure explicit executables in operator controls');
      return coordinator.ingest(job.id);
    case 'submit': return coordinator.plan(job.id);
    case 'select':
      if(!await confirm(`Select candidate ${action.candidateId} for job ${job.id}? This grants no execution authority.`)) return {cancelled:true};
      await assertOwner(); return coordinator.select(job.id,action.candidateId,'operator-ipc');
    case 'prepare': {
      const target=(await reader!.timeline(action.timelineId,{id:`before-${randomUUID()}`,observedAt:Date.now()})).evidence;
      await assertOwner(); return coordinator.prepare(job.id,target);
    }
    case 'collect-output': {
      if(!runtime) throw new Error('MEDIA_RUNTIME_NOT_CONFIGURED');
      const output=await collectMediaOutput(job,action.operationId,action.renderId,{reader:reader!,runtime,access,frameSink:(j,h,b)=>(images().write(j,h,b))});
      await assertOwner();await ledger.put(output.document);
      return {...output,document:undefined};
    }
    case 'preflight': {
      const prepared=preparedWorkflow(job);
      const timeline=(await reader!.timeline(prepared.request.timelineId,{id:`preflight-${randomUUID()}`,observedAt:Date.now()})).evidence;
      const acquired=await createAssetIngestor({access,reader,runtime}).ingest(job.workflow.request);
      await assertOwner();
      const runtimeStatus=(await mediaRuntimeDiagnostics(admission)).status;
      await assertOwner();
      const diagnostics=operatorPreflight(ledger,job.id,action.authorizationId,{jobId:job.id,sessionId:job.sessionId,
        localProjectId:job.localProjectId,resolveProjectId:job.resolveProjectId,timeline,media:acquired.media,capabilities:{...readAdmittedWorkflowCapabilities(),sourceEnd:timeline.adapterDispatch?.sourceEnd??'unknown'}},
        runtimeStatus,Date.now(),fingerprint({epoch,runtimeBinding,session:job.sessionId,project:job.localProjectId}));
      return {diagnostics,output:coordinator.preview(job.id).outputEvidence, liveBoundary:'STOP_BEFORE_MUTATION'};
    }
  }
}
/** Called only from a native operator-confirmed IPC route, never from MCP/provider output. */
export async function authorizeVideoJob(jobId:string, preparedHash:string, confirm:(detail:string)=>Promise<boolean>) {
  const ledger=await videoStore(),job=ledger.get(videoIdSchema.parse(jobId)); if(!job) throw new Error('Unknown video job');
  const prepared=preparedWorkflow(job);
  if(prepared.preparedHash!==preparedHash) throw new Error('Operator preview fingerprint changed');
  if(!await confirm(`Authorize one proposed operation for job ${job.id}, plan ${prepared.request.planId}, project ${job.resolveProjectId}, timeline ${prepared.request.timelineId}?\nFingerprint: ${preparedHash}\nExpires in ten minutes. Live execution still requires separate acceptance; this does not mutate Resolve.`)) return {cancelled:true};
  const current=ledger.get(jobId)!; if(preparedWorkflow(current).preparedHash!==preparedHash) throw new Error('Operator preview changed');
  return ledger.issueOperatorAuthorization(createOperatorAuthorization(current,'operator-ipc'));
}
/** Only the fixed operator IPC route can supply a main-owned OS authentication proof. */
let capabilityConfirmationPending = false;
export async function confirmCapabilityAdmissionJob(
  jobId: string,
  expectedFingerprint: string,
  review: CapabilityOperatorReview,
  assertRenderer: () => void = () => {}
) {
  if (capabilityConfirmationPending) throw new Error('Capability confirmation already pending');
  capabilityConfirmationPending = true;
  try {
    return await confirmCurrentCapabilityAdmission(jobId, expectedFingerprint, review, assertRenderer);
  } finally { capabilityConfirmationPending = false; }
}
async function confirmCurrentCapabilityAdmission(
  jobId: string, expectedFingerprint: string, review: CapabilityOperatorReview, assertRenderer: () => void
) {
  assertRenderer();
  const ledger = await videoStore(), job = ledger.get(videoIdSchema.parse(jobId));
  if (!job) throw new Error('Unknown video job');
  if (!job.workflow) throw new Error('Workflow required');
  assertCapabilityConfirmationMutable(job);
  const admission = job.workflow.capabilityAdmission;
  if (!admission) throw new Error('Capability admission required before operator confirmation');
  if (admission.capabilityFingerprint !== expectedFingerprint) {
    throw new Error(`Capability admission fingerprint mismatch: expected ${expectedFingerprint}, actual ${admission.capabilityFingerprint}`);
  }
  const adapter = readAdmittedWorkflowAdapterInfo();
  if (!adapter.ready) throw new Error('ADAPTER_OFFLINE: curated DaVinci Resolve adapter not ready');
  if (adapter.sourceEnd !== 'inclusive') throw new Error(`ADAPTER_SOURCE_END_UNVERIFIED: trusted adapter convention is ${adapter.sourceEnd}, required inclusive`);
  if (adapter.guardVersion !== 2) throw new Error(`ADAPTER_GUARD_VERSION_UNSUPPORTED: guard version is ${adapter.guardVersion}, required 2`);
  if (admission.adapterEpoch !== adapter.epoch) throw new Error('ADAPTER_EPOCH_CHANGED: adapter epoch changed; fresh admission required');

  if (isCapabilityConfirmationAuthorityValid(job)) {
    throw new Error('Capability admission already confirmed; no authority may be replayed');
  }

  const session = await getSession(job.sessionId);
  if (!session || session.id !== job.sessionId || normalizeSessionProjectId(session) !== job.localProjectId)
    throw new Error('Capability confirmation session/project mismatch');
  if (getConfig().readOnly || !effectiveCapabilities(getConfig()).read) throw new Error('Capability confirmation permission unavailable');
  const context: CapabilityOperatorContext = Object.freeze({
    jobId: job.id, sessionId: job.sessionId, conversationId: session.conversationId ?? null,
    localProjectId: job.localProjectId, resolveProjectId: job.resolveProjectId,
    capabilityFingerprint: expectedFingerprint, admissionRevision: admission.revision,
    workflowRevision: job.workflow.revision, adapterEpoch: admission.adapterEpoch,
    adapterVersion: admission.adapterVersion, sourceEnd: admission.sourceEnd, guardVersion: admission.guardVersion,
    sessionBinding: binding(session),
  });
  const currentState = async () => {
    assertRenderer();
    const current = ledger.get(jobId), currentSession = await getSession(context.sessionId);
    assertRenderer();
    const live = readAdmittedWorkflowAdapterInfo();
    if (!current || !currentSession || current.sessionId !== context.sessionId || current.id !== context.jobId ||
      currentSession.id !== context.sessionId || binding(currentSession) !== context.sessionBinding ||
      current.localProjectId !== context.localProjectId || current.resolveProjectId !== context.resolveProjectId ||
      current.workflow?.revision !== context.workflowRevision ||
      fingerprint(current.workflow.capabilityAdmission) !== fingerprint(admission) ||
      !live.ready || live.epoch !== context.adapterEpoch || live.sourceEnd !== context.sourceEnd ||
      live.guardVersion !== context.guardVersion || live.adapterVersion !== context.adapterVersion ||
      getConfig().readOnly || !effectiveCapabilities(getConfig()).read)
      throw new Error('Capability admission/session/adapter changed during confirmation');
    assertCapabilityConfirmationMutable(current);
    return current;
  };
  await currentState();

  const detail = `Confirm operator readmission of verified inclusive source-end convention for job ${job.id}?\n` +
    `Session: ${job.sessionId}\n` +
    `Capability fingerprint: ${expectedFingerprint}\n` +
    `Adapter version: ${admission.adapterVersion}\n` +
    `Guard version: ${admission.guardVersion}\n` +
    `Adapter epoch: ${admission.adapterEpoch}\n` +
    `Admission revision: ${admission.revision}\n\n` +
    `This creates a durable operator confirmation receipt. It grants no execution authority and does not mutate Resolve.`;

  const proof = await review(detail, context, currentState);
  if (proof === null || proof === false) {
    return { cancelled: true };
  }
  const authentication = consumeCapabilityOperatorProof(proof, context);
  const current = await currentState();
  const receipt = createCapabilityAdmissionReceipt(current, 'operator-ipc', context.conversationId ?? undefined, authentication.verifiedAt, authentication);
  const updated = await ledger.confirmCapabilityAdmission(current.id, receipt, context.workflowRevision, async () => {
    await currentState();
    const now = Date.now();
    if (now < authentication.verifiedAt || now >= authentication.expiresAt)
      throw new Error('Independent operator authentication expired before publication');
  });
  return { status: 'confirmed', receipt, job: updated };
}
export async function inspectVideoJob(jobId:string) {
  const ledger=await videoStore(),job=ledger.get(videoIdSchema.parse(jobId)); if(!job) throw new Error('Unknown video job');
  let nativeExecution: { eligible: boolean; expectedPreparedHash?: string; authorizationId?: string; reviewedManifestHash?: string } = { eligible: false };
  const authority = job.operatorAuthorizations?.find(row => row.consumedAt === undefined && Date.now() >= row.issuedAt && Date.now() < row.expiresAt);
  if (nativeExecutionAvailable(job, authority?.id)) {
    try {
      const context = await nativeExecutionContext(job, ledger, () => {}), manifest = await executionManifest(context, authority!.id);
      if (manifest.stop === 'LIVE_ACCEPTANCE_READY') nativeExecution = { eligible: true, expectedPreparedHash: manifest.preparedHash,
        authorizationId: authority!.id, reviewedManifestHash: manifest.manifestHash };
    } catch { /* Inspection remains readable; unproved native execution stays unavailable. */ }
  }
  return {job, capabilityAuthority: { confirmationValid: isCapabilityConfirmationAuthorityValid(job), sourceEnd: effectiveSourceEnd(job) },
    preview:job.workflow?.phase==='prepared' ? previewJob(job) : undefined, nativeExecution};
}
function nativeExecutionAvailable(job: VideoEditingDocument, authorizationId?: string) {
  const authority = job.operatorAuthorizations?.find(row => row.id === authorizationId);
  return job.nativeExecutionEligible === true && job.workflow?.phase === 'prepared' && !!job.workflow.prepared &&
    job.checkpoints.length === 0 && !!authority && authority.consumedAt === undefined && Date.now() >= authority.issuedAt && Date.now() < authority.expiresAt;
}
async function nativeExecutionContext(job: VideoEditingDocument, ledger: VideoEditingStore, assertRenderer: () => void) {
  assertRenderer();
  if (currentCall() || job.nativeExecutionEligible !== true) throw new Error('Native execution unavailable for this job');
  const session = await getSession(job.sessionId), adapter = readAdmittedWorkflowAdapterInfo(), preparedHash = preparedWorkflow(job).preparedHash;
  if (!session || session.id !== job.sessionId || normalizeSessionProjectId(session) !== job.localProjectId || !adapter.ready)
    throw new Error('Native execution session/project/adapter mismatch');
  const expected = binding(session), revision = job.workflow!.revision;
  const assertOwner = async () => {
    assertRenderer();
    const currentSession = await getSession(job.sessionId), current = ledger.get(job.id), config = getConfig(), live = readAdmittedWorkflowAdapterInfo();
    assertRenderer();
    if (currentCall() || !currentSession || binding(currentSession) !== expected || !current || current.nativeExecutionEligible !== true ||
      current.workflow?.revision !== revision || preparedWorkflow(current).preparedHash !== preparedHash || config.readOnly || !effectiveCapabilities(config).read ||
      !live.ready || live.epoch !== adapter.epoch) throw new Error('Native execution scope/owner changed');
  };
  await assertOwner();
  return executionContext(job, ledger, assertOwner, createNativeResolveAccess(assertOwner));
}
/** Only fixed native IPC supplies the fresh main-owned UCV review and renderer lifecycle. */
export async function executeNativeVideoJob(raw: unknown, review: NativeExecutionReview,
  confirm: (detail: string) => Promise<boolean>, assertRenderer: () => void) {
  assertRenderer(); const input = nativeVideoExecutionInputSchema.parse(raw), ledger = await videoStore(), job = ledger.get(input.jobId);
  if (!job || !nativeExecutionAvailable(job, input.authorizationId)) throw new Error('Native execution unavailable: eligible new job and current unused authority required');
  if (preparedWorkflow(job).preparedHash !== input.expectedPreparedHash) throw new Error('Native prepared fingerprint changed');
  let authentication: ReturnType<typeof consumeNativeExecutionPrincipal> | undefined;
  const assertPrincipal = () => {
    assertRenderer();
    if (authentication && (Date.now() < authentication.verifiedAt || Date.now() >= authentication.expiresAt))
      throw new Error('Native execution principal expired');
  };
  const context = await nativeExecutionContext(job, ledger, assertPrincipal), manifest = await executionManifest(context, input.authorizationId);
  if (manifest.stop !== 'LIVE_ACCEPTANCE_READY') throw new Error(`Native execution blocked: ${manifest.failed.join(', ')}`);
  if (manifest.manifestHash !== input.reviewedManifestHash) throw new Error('Exact reviewed live manifest changed');
  const session = await getSession(job.sessionId); await context.boundary.assertOwner();
  const scope = Object.freeze({ jobId: job.id, sessionId: job.sessionId, localProjectId: job.localProjectId, resolveProjectId: job.resolveProjectId,
    preparedHash: input.expectedPreparedHash, authorizationId: input.authorizationId, manifestHash: manifest.manifestHash,
    workflowRevision: job.workflow!.revision, sessionBinding: binding(session!), adapterEpoch: readAdmittedWorkflowAdapterInfo().epoch });
  const proof = await review(`Verify native execution admission for job ${job.id}.\nPrepared: ${scope.preparedHash}\nReviewed manifest: ${scope.manifestHash}\nSeparate final execution confirmation follows.`, scope, context.boundary.assertOwner);
  if (proof === null) return { cancelled: true };
  authentication = consumeNativeExecutionPrincipal(proof, scope);
  await context.boundary.assertOwner();
  return executeReviewedAcceptance(context, input.authorizationId, input.reviewedManifestHash, confirm);
}
