import { it,expect,vi } from 'vitest';
import { operatorFixture } from './fixtures/video-operator-execution.js';
import { initDurableStore,resetDurableForTests } from '../src/main/durable.js';
import { makeTempDir,removeTempDir } from './helpers.js';
it('exposes an exact no-mutation manifest, requires native confirmation, and joins actual service dispatch/observation/custody',async()=>{
 const dir=await makeTempDir('cos-live-service-');initDurableStore(dir);
 try{
  const f=await operatorFixture(dir);
  const parent={caller:{sessionId:f.job.sessionId,conversationId:'chat-A'}},session={id:f.job.sessionId,projectId:f.job.localProjectId,conversationId:'chat-A',chatIds:['chat-A']};
  let mutations=0;
  const timeline=async(_id:string,stamp:{id:string;observedAt:number})=>{
   const row=structuredClone(f.context.timeline);row.id=stamp.id;row.observedAt=stamp.observedAt;
   row.adapterDispatch={guardVersion:2,sourceEnd:'inclusive',snapshotSha256:'a'.repeat(64),projectName:'COS_S75_ACCEPTANCE_TEST'};
   if(mutations){row.timelineState!.durationFrames=48;row.timelineState!.items=f.job.candidates[0]!.plan.clips.map((c,i)=>({uniqueId:`item-${i}`,mediaUniqueId:f.job.media.find(m=>m.id===c.mediaId)!.resolveMediaId!,mediaType:c.mediaType,track:c.track,source:c.source,timeline:c.timeline}));}
   return {evidence:row};
  };
  vi.doMock('../src/main/mcp/call-context.js',()=>({currentCall:()=>parent}));
  vi.doMock('../src/main/session/store.js',()=>({getSession:async()=>session}));
  vi.doMock('../src/main/config.js',()=>({getConfig:()=>({readOnly:false,mediaRuntime:{test:'admitted'}}),effectiveCapabilities:()=>({read:true})}));
  vi.doMock('../src/main/app-identity.js',()=>({resolveCustomUserData:()=>dir}));
  vi.doMock('../src/main/video-editing/runtime-inspection.js',()=>({createGuardedResolveReader:()=>({timeline}),approvedVideoArtifactAccess:()=>async(p:string)=>p,
   readAdmittedWorkflowEpoch:()=> 'curated:1',readAdmittedWorkflowCapabilities:()=>f.context.capabilities,
   createGuardedResolveDispatch:()=>async()=>{mutations++;return {requested:true,executed:true,verified:true,error:null};}}));
  vi.doMock('../src/main/video-editing/workflow-ingestion.js',()=>({createAssetIngestor:()=>({ingest:async()=>({media:f.job.media,evidence:f.job.evidence,references:f.job.references})})}));
  vi.doMock('../src/main/video-editing/media-runtime.js',()=>({MediaRuntime:class {},mediaRuntimeDiagnostics:async()=>({status:'CONFIGURED'}),admitMediaRuntime:async()=>{throw new Error('Admission outside this dispatch fixture');}}));
  const {videoAction,videoStore}=await import('../src/main/video-editing/service.js');
  // Native authorizations use real wall time in this service test.
  const {createOperatorAuthorization}=await import('../src/main/video-editing/operator-authorization.js');
  const store=await videoStore();await store.issueOperatorAuthorization(createOperatorAuthorization(f.job,'operator-ipc',Date.now()));
  const authority=store.get(f.job.id)!.operatorAuthorizations!.at(-1)!;
  const confirm=vi.fn(async()=>false);
  const manifest=await videoAction({action:'live-manifest',jobId:f.job.id,authorizationId:authority.id},confirm) as {stop:string;manifestHash:string};
  expect(manifest.stop).toBe('LIVE_ACCEPTANCE_READY');expect(confirm).not.toHaveBeenCalled();expect(mutations).toBe(0);
  expect(await videoAction({action:'execute',jobId:f.job.id,authorizationId:authority.id,manifestHash:manifest.manifestHash},confirm)).toMatchObject({status:'FAILED_BEFORE_MUTATION'});
  expect(mutations).toBe(0);expect(store.get(f.job.id)!.checkpoints).toEqual([]);
  confirm.mockResolvedValue(true);
  expect(await videoAction({action:'execute',jobId:f.job.id,authorizationId:authority.id,manifestHash:manifest.manifestHash},confirm)).toMatchObject({status:'VERIFIED'});
  expect(mutations).toBe(1);expect(store.get(f.job.id)!.operatorAuthorizations!.at(-1)!.consumedAt).toBeDefined();
  expect(await videoAction({action:'technical-acceptance',jobId:f.job.id,operationId:f.prepared.request.operationId},confirm)).toMatchObject({status:'VERIFIED',creative:'UNAVAILABLE'});
 }finally{resetDurableForTests();await removeTempDir(dir);}
});
