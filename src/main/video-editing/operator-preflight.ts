import { VideoEditingStore } from './store.js';
import { preparedWorkflow } from './workflow-preview.js';
import { workflowGuardContextSchema } from './workflow-guards.js';
import { evaluateOperatorDispatch } from './operator-execution.js';
import { fingerprint } from './workflow-planning.js';
/** Shared dispatch predicates projected at a read-only stop. No claim, consumption or invocation. */
export function operatorPreflight(store:VideoEditingStore,jobId:string,authorizationId:string|undefined,rawContext:unknown,runtimeStatus:string,now=Date.now(),ownerEpoch='') {
 const job=store.get(jobId);if(!job)throw new Error('Unknown video job');
 const prepared=preparedWorkflow(job),context=workflowGuardContextSchema.parse(rawContext),adapter=context.timeline.adapterDispatch;
 const result=evaluateOperatorDispatch(store,jobId,prepared,authorizationId??'',context,{runtimeStatus,ownerEpoch,
  adapter:adapter?{guardVersion:adapter.guardVersion,sourceEnd:adapter.sourceEnd,snapshotSha256:adapter.snapshotSha256,projectName:adapter.projectName}:
   {guardVersion:0,sourceEnd:'unknown',snapshotSha256:'0'.repeat(64),projectName:'UNKNOWN'}},now);
 return {...result,allowed:false,readyForNativeDispatch:result.allowed,liveBoundary:result.allowed?'LIVE_ACCEPTANCE_READY' as const:'BLOCKED' as const,
  preparedHash:prepared.preparedHash,operationHash:fingerprint(prepared.operations),recovery:'READ_ONLY_NO_REPLAY' as const};
}
