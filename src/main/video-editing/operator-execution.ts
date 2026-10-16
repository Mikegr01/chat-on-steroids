import { z } from 'zod';
import { videoIdSchema } from '../../shared/video-editing.js';
import { VideoEditingStore } from './store.js';
import { preparedWorkflow } from './workflow-preview.js';
import { evaluateWorkflowAuthorization, workflowGuardContextSchema } from './workflow-guards.js';
import { assertOperatorBinding } from './operator-authorization.js';
import { fingerprint } from './workflow-planning.js';
import { canonicalJson } from './identity.js';
import { verifyExecution, type PreparedExecution } from './execution.js';
import { outputEvidenceRequirements } from './workflow-output.js';
import { sameRate, validateDocument } from './validation.js';
import { acceptanceTargetIsolation, VIDEO_ACCEPTANCE_GUARD_VERSION } from '../../shared/video-acceptance-target.js';

const readinessSchema=z.object({runtimeStatus:z.string().max(64),ownerEpoch:z.string().max(1024),adapter:z.object({
  guardVersion:z.number().int(),sourceEnd:z.string().max(32),snapshotSha256:z.string().regex(/^[a-f0-9]{64}$/),projectName:z.string().min(1).max(128)}).strict()}).strict();
export type DispatchReadiness=z.infer<typeof readinessSchema>;
type Context=z.infer<typeof workflowGuardContextSchema>;
/** First acceptance permits only a tiny two/three-clip video cut in an explicitly isolated acceptance target.
 * Inclusive source-end is an explicit test hypothesis; post-state must independently prove it. */
export function evaluateOperatorDispatch(store:VideoEditingStore,jobId:string,prepared:PreparedExecution,authorizationId:string,
 rawContext:unknown,rawReadiness:unknown,now=Date.now()) {
 const base=evaluateWorkflowAuthorization(store,jobId,prepared,rawContext,{kind:'operator',operatorId:'operator-ipc',preparedHash:prepared.preparedHash},true);
 const check=(id:string,passed:boolean,explanation:string)=>base.guards.push({id,status:passed?'pass':'fail',explanation});
 const job=store.get(jobId),context=workflowGuardContextSchema.safeParse(rawContext),readiness=readinessSchema.safeParse(rawReadiness);
 const authority=job?.operatorAuthorizations?.find(row=>row.id===authorizationId);
 let bound=false;try{if(job&&authority){assertOperatorBinding(job,authority);bound=true;}}catch{ /* Exact join failure is a guard. */ }
 check('CATEGORY_C_AUTHORITY_UNAVAILABLE',!!authority&&authority.kind==='operator-explicit','Only the exact native-issued operator authority is eligible. S7/fixture/unattended authority is unavailable.');
 check('PREPARED_FINGERPRINT_CHANGED',base.guards.some(row=>row.id==='PREPARED_FINGERPRINT'&&row.status==='pass'),'Durable selected preparation and ordered operation UUID must remain exact.');
 check('AUTHORITY_BINDING',bound,'Job/plan/preparation/project/timeline/state/ordered operations must bind the native authority.');
 check('AUTHORITY_EXPIRED',!!authority&&now>=authority.issuedAt&&now<authority.expiresAt,'Authority must be within its ten-minute issuance interval.');
 check('AUTHORITY_CONSUMED',!!authority&&authority.consumedAt===undefined,'Consumed authority cannot grant another invocation.');
 check('PRE_STATE_CHANGED',!!authority&&context.success&&fingerprint(context.data.timeline.timelineState)===authority.targetHash,'Current complete owned empty state must equal the operator-reviewed initial state.');
 check('OPERATION_ALREADY_CLAIMED',!!job&&!job.checkpoints.some(row=>row.operationId===prepared.request.operationId),'Exact operation UUID must be unused.');
 check('AMBIGUOUS_PRIOR_EXECUTION',!!job&&!job.checkpoints.some(row=>row.state!=='verified'),'Any unresolved prior execution blocks dispatch.');
 check('OWNER_EPOCH',readiness.success&&!!readiness.data.ownerEpoch,'Exact live session, permissions, plugin publication and runtime incarnation required.');
 check('MEDIA_RUNTIME_IDENTITY',readiness.success&&readiness.data.runtimeStatus==='CONFIGURED','Separately admitted probe/decode binary identities must be current.');
 check('ADAPTER_GUARDED_APPEND',readiness.success&&readiness.data.adapter.guardVersion===VIDEO_ACCEPTANCE_GUARD_VERSION&&readiness.data.adapter.sourceEnd==='inclusive'&&prepared.capabilities.sourceEnd==='inclusive','Update the curated adapter to guard version 2 before issuing/consuming authority: project/snapshot/fresh-empty ownership and acceptance isolation must be enforced immediately before inclusive append.');
 check('ACCEPTANCE_TARGET_ISOLATION',readiness.success&&context.success&&acceptanceTargetIsolation(readiness.data.adapter.projectName,context.data.timeline.adapterDispatch?.timelineName??''),
   'Use a dedicated COS_S75_ACCEPTANCE project or a dedicated AI_WORK_Kosmosyn_S7.5_Acceptance_ timeline. Both require exact fresh adapter ownership, complete empty state and reviewed snapshot/native authority.');
 const plan=job?.candidates.find(row=>row.plan.id===prepared.request.planId)?.plan;
 check('FIRST_ACCEPTANCE_SCOPE',!!job?.workflow&&!!plan&&plan.revision===0&&plan.features.length===1&&plan.features[0]==='cut'&&plan.clips.length>=2&&plan.clips.length<=3&&
   plan.clips.every(row=>row.mediaType==='video'&&row.track===1)&&plan.timeline.durationFrames<=96&&sameRate(plan.timeline.fps,{numerator:24,denominator:1})&&
   !job.workflow.request.output.renderRequired&&!job.workflow.request.output.creativeReviewRequired&&job.workflow.request.target.width<=1920&&job.workflow.request.target.height<=1080,
   'First acceptance is two/three video cuts, track one, at most four seconds at 24 fps; no render/effects/revision/unattended refinement.');
 check('PRODUCTION_EVIDENCE',!!job&&job.workflow?.planner?.kind!=='fixture'&&job.workflow?.capabilities.acceptance!=='fixture'&&job.evidence.every(row=>row.basis!=='fixture'), 'Fixture evidence cannot grant production execution; technical observations must be measured and explicit operator usability retains its derivation.');
 check('OUTPUT_EVIDENCE_NOT_CONFIGURED',!!job&&prepared.requiredAfterEvidence.length>0&&prepared.operations.length===1&&
   outputEvidenceRequirements(job,prepared).samples.every(index=>index<=1000),'Complete post-state and bounded technical evidence plan are required. Render is deliberately excluded from this first scenario.');
 base.failed=base.guards.filter(row=>row.status==='fail').map(row=>row.id);base.allowed=base.failed.length===0;
 return base;
}
/** Serializable exact stop point. Fingerprint excludes observation wall-clock and random read IDs. */
export function liveAcceptanceManifest(store:VideoEditingStore,jobId:string,authorizationId:string,context:unknown,readiness:unknown,now=Date.now()) {
 const job=store.get(videoIdSchema.parse(jobId));if(!job)throw new Error('Unknown video job');
 const prepared=preparedWorkflow(job),gate=evaluateOperatorDispatch(store,jobId,prepared,authorizationId,context,readiness,now);
 const current=workflowGuardContextSchema.parse(context),admitted=readinessSchema.parse(readiness);
 const plan=job.candidates.find(row=>row.plan.id===prepared.request.planId)!.plan;
 const payload={version:1 as const,jobId,sessionId:job.sessionId,localProjectId:job.localProjectId,resolveProjectId:job.resolveProjectId,
  timelineId:prepared.request.timelineId,planId:plan.id,planHash:fingerprint(plan),preparedHash:prepared.preparedHash,authorizationId,
  authority:job.operatorAuthorizations?.find(row=>row.id===authorizationId),operationIds:prepared.operations.map(row=>row.operationId),
  operations:prepared.operations,initialState:current.timeline.timelineState,adapter:admitted.adapter,ownerEpoch:admitted.ownerEpoch,
  assets:job.media.filter(row=>plan.clips.some(clip=>clip.mediaId===row.id)).map(row=>({id:row.id,path:row.path,sha256:row.sha256,resolveMediaId:row.resolveMediaId})),
  expectedPostState:{durationFrames:plan.timeline.durationFrames,fps:plan.timeline.fps,clips:outputEvidenceRequirements(job,prepared).expectedClips},
  output:{renderRequired:false,creativeRequired:false,requirements:outputEvidenceRequirements(job,prepared)},
  recovery:['Never resend a claimed operation, even without a receipt.','Reconcile by complete current observation only.','Consumed authority remains consumed.','Preserve the dedicated target and all evidence; no automatic rollback/delete.','A new version/revision requires a new job, target and native authority.']};
 const acceptanceId=fingerprint(payload);
 return {...payload,acceptanceId,manifestHash:acceptanceId,guards:gate.guards,failed:gate.failed,stop:gate.allowed?'LIVE_ACCEPTANCE_READY' as const:'BLOCKED' as const,
  mutationPerformed:false as const,next:'Separate native confirmation of this exact manifest is required before dispatch.'};
}
export type LiveAcceptanceManifest=ReturnType<typeof liveAcceptanceManifest>;
export interface OperatorExecutionBoundary {
 capture():Promise<{context:Context;readiness:DispatchReadiness}>;
 assertOwner():Promise<void>;
 call(operation:PreparedExecution['operations'][number],guard:{projectId:string;snapshotSha256:string}):Promise<unknown>;
 observe(prepared:PreparedExecution):Promise<string[]>;
}
/** No scheduler, default consent, retry or second ledger. Production calls are supplied only by the curated runtime factory. */
export class OperatorExecutionCoordinator {
 constructor(private readonly store:VideoEditingStore,private readonly boundary:OperatorExecutionBoundary){}
 async execute(manifest:LiveAcceptanceManifest,confirm:(detail:string)=>Promise<boolean>,now=Date.now()) {
  const job=this.store.get(manifest.jobId);if(!job)throw new Error('Unknown video job');
  const prepared=preparedWorkflow(job);
  const acquire=async()=>{await this.boundary.assertOwner();const fresh=await this.boundary.capture();await this.boundary.assertOwner();return fresh;};
  const first=await acquire(),review=liveAcceptanceManifest(this.store,job.id,manifest.authorizationId,first.context,first.readiness,now);
  if(review.stop!=='LIVE_ACCEPTANCE_READY'||review.manifestHash!==manifest.manifestHash) return {status:'FAILED_BEFORE_MUTATION' as const,failed:[...review.failed,'MANIFEST_CHANGED']};
  if(!await confirm(canonicalJson(review)))return {status:'FAILED_BEFORE_MUTATION' as const,failed:['NATIVE_OPERATOR_CANCELLED']};
  // Refresh after native dialog; caller passes a fixed time only in deterministic tests.
  const currentNow=process.env.VITEST==='true'?now:Date.now();
  const second=await acquire(),ready=liveAcceptanceManifest(this.store,job.id,manifest.authorizationId,second.context,second.readiness,currentNow);
  if(ready.stop!=='LIVE_ACCEPTANCE_READY'||ready.manifestHash!==manifest.manifestHash) return {status:'FAILED_BEFORE_MUTATION' as const,failed:[...ready.failed,'STALE_PREFLIGHT']};
  const authority=ready.authority!;
  const claim=await this.store.claimOperator(job.id,authority.id,ready.preparedHash,authority.targetHash,currentNow,second.context.timeline,()=>this.boundary.assertOwner());
  let attempted=false;
  try{
   const last=await acquire();
   const checkpoint=this.store.get(job.id)!.checkpoints.find(row=>row.operationId===claim.operationId)!;
   const consumed=this.store.get(job.id)!.operatorAuthorizations!.find(row=>row.id===authority.id)!;
   if(checkpoint.operatorBinding?.authorizationId!==authority.id||consumed.consumedAt!==checkpoint.operatorBinding.claimedAt||
     consumed.expiresAt<=(process.env.VITEST==='true'?now:Date.now())||fingerprint(last.context.timeline.timelineState)!==authority.targetHash||
     last.readiness.ownerEpoch!==ready.ownerEpoch||last.readiness.runtimeStatus!=='CONFIGURED'||canonicalJson(last.readiness.adapter)!==canonicalJson(ready.adapter)) throw new Error('Final target/owner/authority changed');
   const finalGuards=evaluateWorkflowAuthorization(this.store,job.id,prepared,last.context,{kind:'operator',operatorId:'operator-ipc',preparedHash:prepared.preparedHash},true);
   if(finalGuards.failed.some(id=>id!=='TARGET_CUSTODY_CONSUMED'))throw new Error('Final production predicate failed');
   assertOperatorBinding(this.store.get(job.id)!,consumed);
   await this.boundary.assertOwner();attempted=true;
   const result=await this.boundary.call(prepared.operations[0]!,{projectId:job.resolveProjectId,snapshotSha256:last.readiness.adapter.snapshotSha256});
   const acknowledged=z.object({requested:z.literal(true),executed:z.literal(true),verified:z.literal(true),error:z.null()}).passthrough().safeParse(result);
   const rejected=z.object({requested:z.literal(true),executed:z.literal(false),verified:z.literal(false),error:z.object({code:z.enum(['TARGET_PROJECT_MISMATCH','PRE_STATE_CHANGED','TARGET_NOT_AI_OWNED','TARGET_NOT_EMPTY','CAPABILITY_UNAVAILABLE'])}).passthrough()}).passthrough().safeParse(result);
   await this.store.recordReceipt(job.id,claim.operationId,{status:acknowledged.success?'acknowledged':rejected.success?'failed-before-mutation':'uncertain',resultSha256:fingerprint(result)});
  }catch{
   const checkpoint=this.store.get(job.id)!.checkpoints.find(row=>row.operationId===claim.operationId)!;
   if(!checkpoint.receipt) await this.store.recordReceipt(job.id,claim.operationId,{status:attempted?'uncertain':'failed-before-mutation'});
  }
  if(!attempted){const checkpoint=await this.store.finishOperator(job.id,claim.operationId,[],'FAILED_BEFORE_MUTATION');return {status:'FAILED_BEFORE_MUTATION' as const,checkpoint,failed:['FINAL_DISPATCH_GUARD']};}
  return this.reconcile(job.id,claim.operationId);
 }
 /** Explicit read-only recovery: Cases A/B/C all observe, none dispatch. Verified claims return unchanged. */
 async reconcile(jobId:string,operationId:string) {
  const job=this.store.get(jobId),checkpoint=job?.checkpoints.find(row=>row.operationId===operationId);
  if(!job||!checkpoint?.operatorBinding)throw new Error('Exact operator execution claim required');
  if(checkpoint.state==='verified')return {status:'VERIFIED' as const,checkpoint,failed:[]};
  try{
   await this.boundary.assertOwner();const ids=await this.boundary.observe(preparedWorkflow(job));await this.boundary.assertOwner();
   const verification=verifyExecution(this.store.get(jobId)!,{...checkpoint,state:'claimed',beforeEvidenceIds:[...checkpoint.beforeEvidenceIds,checkpoint.operatorBinding.preflightEvidenceId]},ids);
   const settled=await this.store.finishOperator(jobId,operationId,ids);
   return {status:settled.outcome!,checkpoint:settled,verification,failed:verification.blockers};
  }catch{
   const settled=await this.store.finishOperator(jobId,operationId,[]);
   return {status:'AMBIGUOUS' as const,checkpoint:settled,verification:{status:'UNVERIFIED' as const},failed:['AFTER_OBSERVATION_UNAVAILABLE']};
  }
 }
}
/** Deterministic acceptance is independent of creative perception. Required render evidence fails closed. */
export function technicalAcceptance(raw:unknown,operationId:string,renderId?:string) {
 const job=validateDocument(raw),checkpoint=job.checkpoints.find(row=>row.operationId===operationId);
 if(!checkpoint)throw new Error('Unknown execution');
 const beforeEvidenceIds=checkpoint.operatorBinding?[...checkpoint.beforeEvidenceIds,checkpoint.operatorBinding.preflightEvidenceId]:checkpoint.beforeEvidenceIds;
 const verification=verifyExecution(job,{...checkpoint,state:'claimed',beforeEvidenceIds},checkpoint.afterEvidenceIds),failed=[...verification.blockers];
 if(!checkpoint.operatorBinding)failed.push('OPERATOR_EXECUTION_LINEAGE_REQUIRED');
 if(checkpoint.state!=='verified')failed.push('EXECUTION_UNVERIFIED');
 const request=job.workflow?.request;
 if(request?.output.creativeReviewRequired)failed.push('CREATIVE_REVIEW_REQUIRED_UNAVAILABLE');
 const plan=job.candidates.find(row=>row.plan.id===checkpoint.planId)!.plan;
 if(request?.output.renderRequired){
  const artifacts=job.evidence.filter(row=>row.subject==='render'&&row.subjectId===renderId&&row.renderState?.operationId===operationId&&row.renderState.timelineId===checkpoint.timelineId&&row.renderReceiptEvidenceId);
  const artifact=artifacts.length===1?artifacts[0]:undefined,video=artifact?.technical?.streams.filter(row=>row.kind==='video');
  if(!artifact?.locator||!artifact.renderState?.completed||artifact.basis!=='measured')failed.push('OUTPUT_ARTIFACT_UNVERIFIED');
  if(artifact?.renderState&&(artifact.renderState.durationFrames!==plan.timeline.durationFrames||!sameRate(artifact.renderState.fps,plan.timeline.fps)))failed.push('OUTPUT_TIMING_MISMATCH');
  if(!video||video.length!==1||!video[0]!.width||!video[0]!.height||!artifact?.technical?.format.name)failed.push('OUTPUT_FORMAT_UNVERIFIED');
  else if(video[0]!.width!==request.target.width||video[0]!.height!==request.target.height||!artifact.technical.format.name.split(',').includes(request.output.container))failed.push('OUTPUT_FORMAT_MISMATCH');
  const samples=outputEvidenceRequirements(job,preparedWorkflow(job)).samples;
  if(!artifact||samples.some(index=>!job.evidence.some(row=>row.subject==='frame'&&row.subjectId===renderId&&row.framePosition===index&&row.mediaSample?.sourceHash===artifact.locator?.sha256&&row.mediaSample?.positionProof?.classification==='INDEPENDENT_DECODED_PTS_MATCH')))failed.push('POSITIONED_OUTPUT_EVIDENCE_MISSING');
 }
 return {jobId:job.id,planId:plan.id,operationId,timelineId:checkpoint.timelineId,renderId,status:!failed.length?'VERIFIED' as const:verification.status==='DEVIATED'||failed.some(id=>id==='OUTPUT_TIMING_MISMATCH'||id==='OUTPUT_FORMAT_MISMATCH')?'DEVIATED' as const:'UNVERIFIED' as const,
  failed:[...new Set(failed)],creative:'UNAVAILABLE' as const,creativeRequired:request?.output.creativeReviewRequired??false,renderRequired:request?.output.renderRequired??false};
}
