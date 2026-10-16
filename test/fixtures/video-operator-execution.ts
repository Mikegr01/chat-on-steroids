import { setupWorkflow, workflowCapabilities, workflowTarget } from './video-workflow-runtime.js';
import { VideoWorkflowCoordinator } from '../../src/main/video-editing/workflow.js';
import { createOperatorAuthorization } from '../../src/main/video-editing/operator-authorization.js';
import { preparedWorkflow } from '../../src/main/video-editing/workflow-preview.js';

/** Synthetic measured ports, never live Resolve evidence. */
export async function operatorFixture(dir: string, scope?: {localProjectId:string|null;acceptanceTimeline?:boolean;sessionId?:string;resolveProjectId?:string;timelineId?:string;creationOperationId?:string}) {
  const f = await setupWorkflow(dir);
  if(scope)f.request.localProjectId=scope.localProjectId;
  if(scope?.sessionId)f.request.sessionId=scope.sessionId;
  if(scope?.resolveProjectId)f.request.resolveProjectId=scope.resolveProjectId;
  f.request.target = { durationFrames: 48, fps: { numerator:24,denominator:1 },width:64,height:36 };
  f.request.output.renderRequired = false; f.request.maxRevisions=0; f.request.pacing=undefined;
  const ingestor={async ingest(request:typeof f.request){const batch=await f.ingestor.ingest(request);batch.evidence.forEach(e=>{if(e.basis==='fixture')e.basis='measured';});return batch;}};
  const capabilities={...workflowCapabilities, acceptance:'unverified' as const};
  const planner={descriptor:{id:'operator-designs',version:'1',kind:'operator' as const,configuration:{}},async plan(input:any){return [0,1].map(alternative=>({
    plan:{referenceProfileIds:input.references.map((r:any)=>r.id),evidenceIds:input.evidence.map((r:any)=>r.id),features:['cut' as const],
      timeline:{name:'Acceptance',fps:input.request.target.fps,durationFrames:48},
      clips:(alternative?['source-b','source-a']:['source-a','source-b']).map((mediaId,index)=>({id:`clip-${index}`,mediaId,mediaType:'video' as const,track:1,
        source:{start:0,end:24},timeline:{start:index*24,end:(index+1)*24},evidenceIds:input.media.find((r:any)=>r.id===mediaId).evidenceIds}))},
    rationale:'Two deterministic safe sources',risks:[],scores:[{criterion:'operator-preference',value:1,evidenceIds:input.evidence.map((r:any)=>r.id)}]}));}};
  const coordinator=new VideoWorkflowCoordinator(f.store,{ingestor,capabilities,planner});
  await coordinator.request(f.request);const ingested=await coordinator.ingest(f.request.id);if(ingested.workflow?.phase==='blocked')throw new Error(JSON.stringify(ingested.workflow.blockers));const planned=await coordinator.plan(f.request.id);
  await coordinator.select(f.request.id,planned.candidates[0]!.id,'operator-ipc');
  const before=workflowTarget();before.basis='measured';
  if(scope?.acceptanceTimeline)before.adapterDispatch={guardVersion:2,sourceEnd:'inclusive',snapshotSha256:'a'.repeat(64),projectName:'Untitled Project 2',timelineName:'AI_WORK_Kosmosyn_S7.5_Acceptance_fixture'};
  if(scope?.resolveProjectId)before.timelineState!.resolveProjectId=scope.resolveProjectId;
  if(scope?.timelineId)before.subjectId=scope.timelineId;
  if(scope?.creationOperationId)before.timelineState!.ownership!.creationOperationId=scope.creationOperationId;
  const job=(await coordinator.prepare(f.request.id,before)).document;
  const authority=await f.store.issueOperatorAuthorization(createOperatorAuthorization(job,'operator-ipc',100));
  const context={jobId:job.id,sessionId:job.sessionId,localProjectId:job.localProjectId,resolveProjectId:job.resolveProjectId,
    timeline:{...before,id:'fresh',observedAt:12},media:job.media,capabilities};
  const readiness={runtimeStatus:'CONFIGURED',ownerEpoch:'session:plugin:1',adapter:{guardVersion:2,sourceEnd:'inclusive',snapshotSha256:'a'.repeat(64),projectName:'COS_S75_ACCEPTANCE_TEST'}};
  context.timeline.adapterDispatch={...before.adapterDispatch,guardVersion:2,sourceEnd:'inclusive',snapshotSha256:readiness.adapter.snapshotSha256,projectName:readiness.adapter.projectName};
  return {...f,job,context,readiness,authority,prepared:preparedWorkflow(job)};
}
