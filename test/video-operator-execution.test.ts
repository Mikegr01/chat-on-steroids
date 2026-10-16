import { beforeEach,afterEach,it,expect } from 'vitest';
import { initDurableStore,resetDurableForTests } from '../src/main/durable.js';
import { makeTempDir,removeTempDir } from './helpers.js';
import { operatorFixture } from './fixtures/video-operator-execution.js';
import { VideoEditingStore } from '../src/main/video-editing/store.js';
import { evaluateOperatorDispatch,liveAcceptanceManifest,OperatorExecutionCoordinator,technicalAcceptance } from '../src/main/video-editing/operator-execution.js';
let dir:string;
beforeEach(async()=>{dir=await makeTempDir('cos-operator-execution-');initDurableStore(dir);});
afterEach(async()=>{resetDurableForTests();await removeTempDir(dir);});
it('admits exact native authority and deterministic stop manifest without dispatch or consumption',async()=>{
 const f=await operatorFixture(dir);
 const gate=evaluateOperatorDispatch(f.store,f.job.id,f.prepared,f.authority.id,f.context,f.readiness,101);
 expect(gate.allowed).toBe(true);
 const manifest=liveAcceptanceManifest(f.store,f.job.id,f.authority.id,f.context,f.readiness,101);
 expect(manifest).toEqual(liveAcceptanceManifest(f.store,f.job.id,f.authority.id,f.context,f.readiness,101));
 expect(manifest.stop).toBe('LIVE_ACCEPTANCE_READY');expect(manifest.operations).toHaveLength(1);
 expect(f.store.get(f.job.id)!.checkpoints).toEqual([]);expect(f.store.get(f.job.id)!.operatorAuthorizations![0]!.consumedAt).toBeUndefined();
 for(const change of [()=>{f.context.resolveProjectId='other';},()=>{f.context.timeline.subjectId='other';},()=>{delete f.context.timeline.timelineState!.ownership;},
   ()=>{f.readiness.runtimeStatus='IDENTITY_CHANGED';},()=>{f.readiness.ownerEpoch='';},()=>{f.readiness.adapter.guardVersion=0;}]) {
  const prior=structuredClone({context:f.context,readiness:f.readiness});change();
  expect(evaluateOperatorDispatch(f.store,f.job.id,f.prepared,f.authority.id,f.context,f.readiness,101).allowed).toBe(false);
  f.context=prior.context;f.readiness=prior.readiness;
 }
 expect(evaluateOperatorDispatch(f.store,f.job.id,{...f.prepared,preparedHash:'b'.repeat(64)},f.authority.id,f.context,f.readiness,101).failed).toContain('PREPARED_FINGERPRINT_CHANGED');
 expect(evaluateOperatorDispatch(f.store,f.job.id,f.prepared,f.authority.id,f.context,f.readiness,600101).failed).toContain('AUTHORITY_EXPIRED');
 expect(evaluateOperatorDispatch(f.store,f.job.id,f.prepared,'cmd_s7_test',f.context,f.readiness,101).failed).toContain('CATEGORY_C_AUTHORITY_UNAVAILABLE');
});
it('admits a reviewed fresh acceptance timeline in an existing user project, without project-name authority',async()=>{
 const f=await operatorFixture(dir, {localProjectId:null,acceptanceTimeline:true});
 f.readiness.adapter.projectName='Untitled Project 2';
 f.context.timeline.adapterDispatch!.projectName=f.readiness.adapter.projectName;
 expect(evaluateOperatorDispatch(f.store,f.job.id,f.prepared,f.authority.id,f.context,f.readiness,101).allowed).toBe(true);
 const restored=new VideoEditingStore();await restored.restore();
 expect(restored.get(f.job.id)!.localProjectId).toBeNull();
 expect(liveAcceptanceManifest(restored,f.job.id,f.authority.id,f.context,f.readiness,101).stop).toBe('LIVE_ACCEPTANCE_READY');
 for(const change of [()=>{delete f.context.timeline.timelineState!.ownership;},()=>{f.context.timeline.timelineState!.ownership!.sourceTimelineId='production';},
   ()=>{f.context.timeline.timelineState!.durationFrames=1;},()=>{f.context.timeline.subjectId='foreign';},()=>{f.context.timeline.timelineState!.resolveProjectId='foreign';}]) {
  const saved=structuredClone(f.context);change();
  expect(evaluateOperatorDispatch(f.store,f.job.id,f.prepared,f.authority.id,f.context,f.readiness,101).allowed).toBe(false);f.context=saved;
 }
 f.context.timeline.adapterDispatch!.timelineName='AI_WORK_production';
 expect(evaluateOperatorDispatch(f.store,f.job.id,f.prepared,f.authority.id,f.context,f.readiness,101).allowed).toBe(false);
 f.readiness.adapter.projectName='COS_S75_ACCEPTANCE_TEST';delete f.context.timeline.timelineState!.ownership;
 expect(evaluateOperatorDispatch(f.store,f.job.id,f.prepared,f.authority.id,f.context,f.readiness,101).allowed).toBe(false);
});
it('blocks an older installed adapter before a fallback manifest can consume authority',async()=>{
 const f=await operatorFixture(dir,{localProjectId:null,acceptanceTimeline:true});
 f.readiness.adapter.projectName='Untitled Project 2';f.readiness.adapter.guardVersion=1;
 const manifest=liveAcceptanceManifest(f.store,f.job.id,f.authority.id,f.context,f.readiness,101);
 expect(manifest.stop).toBe('BLOCKED');expect(manifest.failed).toContain('ADAPTER_GUARDED_APPEND');
 expect(f.store.get(f.job.id)!.checkpoints).toEqual([]);expect(f.store.get(f.job.id)!.operatorAuthorizations![0]!.consumedAt).toBeUndefined();
});
it('consumes authority and exact claim in one durable publication; restore and new IDs never replay',async()=>{
 const f=await operatorFixture(dir);
 const claim=await f.store.claimOperator(f.job.id,f.authority.id,f.prepared.preparedHash,f.authority.targetHash,101,f.context.timeline);
 expect(claim.operatorBinding!.authorizationId).toBe(f.authority.id);
 const restored=new VideoEditingStore();await restored.restore();
 expect(restored.get(f.job.id)!.operatorAuthorizations![0]!.consumedAt).toBe(101);
 await expect(restored.claimOperator(f.job.id,f.authority.id,f.prepared.preparedHash,f.authority.targetHash,102,f.context.timeline)).rejects.toThrow(/consumed|claimed/i);
 expect(restored.get(f.job.id)!.checkpoints).toHaveLength(1);
});
it('requires native confirmation and rechecks state after claim before any curated mutation',async()=>{
 const f=await operatorFixture(dir);let calls=0,reads=0;
 const boundary={capture:async()=>{reads++;return {context:f.context,readiness:f.readiness};},assertOwner:async()=>{},
  call:async()=>{calls++;return {requested:true,executed:true,verified:true,error:null};},observe:async()=>[]};
 const c=new OperatorExecutionCoordinator(f.store,boundary);
 const manifest=liveAcceptanceManifest(f.store,f.job.id,f.authority.id,f.context,f.readiness,101);
 expect((await c.execute(manifest,async()=>false,101)).status).toBe('FAILED_BEFORE_MUTATION');expect(calls).toBe(0);
 reads=0;boundary.capture=async()=>{reads++;if(reads>=3)f.context.timeline.timelineState!.durationFrames=1;return {context:f.context,readiness:f.readiness};};
 expect((await c.execute(manifest,async()=>true,101)).status).toBe('FAILED_BEFORE_MUTATION');expect(calls).toBe(0);
 expect(f.store.get(f.job.id)!.operatorAuthorizations![0]!.consumedAt).toBe(101);
});
it('classifies observed exact and deviated state; acknowledgement alone cannot verify',async()=>{
 const f=await operatorFixture(dir);let calls=0;
 const after=structuredClone(f.context.timeline);after.id='after-execution';after.observedAt=200;
 after.timelineState!.durationFrames=48;after.timelineState!.items=f.job.candidates[0]!.plan.clips.map((c,i)=>({uniqueId:`item-${i}`,mediaUniqueId:f.job.media.find(m=>m.id===c.mediaId)!.resolveMediaId!,mediaType:c.mediaType,track:c.track,source:c.source,timeline:c.timeline}));
 const boundary={capture:async()=>({context:f.context,readiness:f.readiness}),assertOwner:async()=>{},call:async()=>{calls++;return {requested:true,executed:true,verified:true,error:null};},
  observe:async()=>{const current=f.store.get(f.job.id)!;await f.store.put({...current,evidence:[...current.evidence,after]});return [after.id];}};
 const manifest=liveAcceptanceManifest(f.store,f.job.id,f.authority.id,f.context,f.readiness,101);
 const c=new OperatorExecutionCoordinator(f.store,boundary);
 expect((await c.execute(manifest,async()=>true,101)).status).toBe('VERIFIED');expect(calls).toBe(1);
 const restored=new VideoEditingStore();await restored.restore();
 const recovery=new OperatorExecutionCoordinator(restored,boundary);
 expect((await recovery.reconcile(f.job.id,f.prepared.request.operationId)).status).toBe('VERIFIED');expect(calls).toBe(1);
 expect(technicalAcceptance(restored.get(f.job.id)!,f.prepared.request.operationId).status).toBe('VERIFIED');
});
it('reconciles crash/no-receipt and missing observations without invoking adapter or replacing authority',async()=>{
 const f=await operatorFixture(dir);await f.store.claimOperator(f.job.id,f.authority.id,f.prepared.preparedHash,f.authority.targetHash,101,f.context.timeline);
 const restored=new VideoEditingStore();await restored.restore();let calls=0;
 const c=new OperatorExecutionCoordinator(restored,{capture:async()=>({context:f.context,readiness:f.readiness}),assertOwner:async()=>{},call:async()=>{calls++;return {};},observe:async()=>[]});
 expect((await c.reconcile(f.job.id,f.prepared.request.operationId)).status).toBe('AMBIGUOUS');expect(calls).toBe(0);
 expect(restored.get(f.job.id)!.operatorAuthorizations![0]!.consumedAt).toBe(101);
});

it.each([
 ['wrong session',(f:any)=>{f.context.sessionId='other';}],['wrong local project',(f:any)=>{f.context.localProjectId='other';}],
 ['missing capability',(f:any)=>{f.context.capabilities.tools=[];}],['changed source hash',(f:any)=>{f.context.media[0].sha256='b'.repeat(64);}],
 ['changed media identity',(f:any)=>{f.context.media[0].resolveMediaId='other';}],['incomplete observation',(f:any)=>{f.context.timeline.timelineState.complete=false;}],
 ['stale observation',(f:any)=>{f.context.timeline.observedAt=0;}],['fixture observation',(f:any)=>{f.context.timeline.basis='fixture';}],
 ['nonempty target',(f:any)=>{f.context.timeline.timelineState.durationFrames=1;}],['duplicated target',(f:any)=>{f.context.timeline.timelineState.ownership.sourceTimelineId='personal';}],
 ['wrong timebase',(f:any)=>{f.context.timeline.timelineState.fps.numerator=25;}],['wrong convention',(f:any)=>{f.context.capabilities.sourceEnd='exclusive';}],
 ['unsafe project',(f:any)=>{f.readiness.adapter.projectName='personal';}],['missing adapter guard',(f:any)=>{f.readiness.adapter.guardVersion=0;}],
 ['changed operations',(f:any)=>{f.prepared.operations[0].arguments.segments.reverse();}],['new operation UUID',(f:any)=>{f.prepared.request.operationId='22222222-2222-4222-8222-222222222222';}]
])('blocks %s before dispatch',async(_label,change)=>{const f=await operatorFixture(dir);change(f);
 expect(evaluateOperatorDispatch(f.store,f.job.id,f.prepared,f.authority.id,f.context,f.readiness,101).allowed).toBe(false);expect(f.store.get(f.job.id)!.checkpoints).toEqual([]);});
it('keeps atomic custody when publication throws after disk replacement',async()=>{
 const f=await operatorFixture(dir);
 const {writeStrictDurableNow}=await import('../src/main/durable.js');
 const failing=new VideoEditingStore({write:async value=>{await writeStrictDurableNow('video-editing-jobs',value,1024*1024);throw new Error('post-rename failure');}});await failing.restore();
 await expect(failing.claimOperator(f.job.id,f.authority.id,f.prepared.preparedHash,f.authority.targetHash,101,f.context.timeline)).rejects.toThrow('post-rename');
 const restored=new VideoEditingStore();await restored.restore();expect(restored.get(f.job.id)!.checkpoints[0]!.operatorBinding!.authorizationId).toBe(f.authority.id);
 expect(restored.get(f.job.id)!.operatorAuthorizations![0]!.consumedAt).toBe(101);
 await expect(restored.claimOperator(f.job.id,f.authority.id,f.prepared.preparedHash,f.authority.targetHash,102,f.context.timeline)).rejects.toThrow(/consumed/);
});
it('allows only one concurrent authority/claim and rejects reordered binding',async()=>{
 const f=await operatorFixture(dir);
 await expect(f.store.claimOperator(f.job.id,f.authority.id,'0'.repeat(64),f.authority.targetHash,101,f.context.timeline)).rejects.toThrow(/binding/);
 const outcomes=await Promise.allSettled([f.store.claimOperator(f.job.id,f.authority.id,f.prepared.preparedHash,f.authority.targetHash,101,f.context.timeline),f.store.claimOperator(f.job.id,f.authority.id,f.prepared.preparedHash,f.authority.targetHash,101,f.context.timeline)]);
 expect(outcomes.filter(row=>row.status==='fulfilled')).toHaveLength(1);expect(f.store.get(f.job.id)!.checkpoints).toHaveLength(1);
});
it.each(['no-receipt','acknowledged','uncertain'] as const)('reconciles %s by complete observation only, never invoking the adapter',async receipt=>{
 const f=await operatorFixture(dir);await f.store.claimOperator(f.job.id,f.authority.id,f.prepared.preparedHash,f.authority.targetHash,101,f.context.timeline);
 if(receipt!=='no-receipt')await f.store.recordReceipt(f.job.id,f.prepared.request.operationId,{status:receipt});
 const restored=new VideoEditingStore();await restored.restore();let calls=0;
 const after=structuredClone(f.context.timeline);after.id='recover-after';after.observedAt=200;after.timelineState!.durationFrames=48;
 after.timelineState!.items=f.job.candidates[0]!.plan.clips.map((c,i)=>({uniqueId:`item-${i}`,mediaUniqueId:f.job.media.find(m=>m.id===c.mediaId)!.resolveMediaId!,mediaType:c.mediaType,track:c.track,source:c.source,timeline:c.timeline}));
 const coordinator=new OperatorExecutionCoordinator(restored,{capture:async()=>({context:f.context,readiness:f.readiness}),assertOwner:async()=>{},call:async()=>{calls++;return {};},observe:async()=>{const job=restored.get(f.job.id)!;await restored.put({...job,evidence:[...job.evidence,after]});return [after.id];}});
 expect((await coordinator.reconcile(f.job.id,f.prepared.request.operationId)).status).toBe('VERIFIED');expect(calls).toBe(0);
 expect(restored.get(f.job.id)!.operatorAuthorizations![0]!.consumedAt).toBe(101);
});
it('classifies complete deviation, confirmed unchanged target and missing critical evidence separately',async()=>{
 const f=await operatorFixture(dir);await f.store.claimOperator(f.job.id,f.authority.id,f.prepared.preparedHash,f.authority.targetHash,101,f.context.timeline);
 const empty={...f.context.timeline,id:'unchanged',observedAt:200};await f.store.put({...f.store.get(f.job.id)!,evidence:[...f.store.get(f.job.id)!.evidence,empty]});
 expect((await f.store.finishOperator(f.job.id,f.prepared.request.operationId,[empty.id])).outcome).toBe('FAILED_CONFIRMED');
 const wrong=structuredClone(empty);wrong.id='deviated';wrong.observedAt=201;wrong.timelineState!.durationFrames=1;
 await f.store.put({...f.store.get(f.job.id)!,evidence:[...f.store.get(f.job.id)!.evidence,wrong]});
 expect((await f.store.finishOperator(f.job.id,f.prepared.request.operationId,[wrong.id])).outcome).toBe('DEVIATED');
 const missing=structuredClone(wrong);missing.id='missing';missing.observedAt=202;missing.timelineState!.complete=false;
 await f.store.put({...f.store.get(f.job.id)!,evidence:[...f.store.get(f.job.id)!.evidence,missing]});
 expect((await f.store.finishOperator(f.job.id,f.prepared.request.operationId,[missing.id])).outcome).toBe('UNVERIFIED');
});
it('keeps required output acceptance distinct from creative review and rejects missing/wrong output identity',async()=>{
 const f=await operatorFixture(dir);await f.store.claimOperator(f.job.id,f.authority.id,f.prepared.preparedHash,f.authority.targetHash,101,f.context.timeline);
 const after=structuredClone(f.context.timeline);after.id='output-before';after.observedAt=200;after.timelineState!.durationFrames=48;
 after.timelineState!.items=f.job.candidates[0]!.plan.clips.map((c,i)=>({uniqueId:`item-${i}`,mediaUniqueId:f.job.media.find(m=>m.id===c.mediaId)!.resolveMediaId!,mediaType:c.mediaType,track:c.track,source:c.source,timeline:c.timeline}));
 await f.store.put({...f.store.get(f.job.id)!,evidence:[...f.store.get(f.job.id)!.evidence,after]});await f.store.finishOperator(f.job.id,f.prepared.request.operationId,[after.id]);
 expect(technicalAcceptance(f.store.get(f.job.id)!,f.prepared.request.operationId)).toMatchObject({status:'VERIFIED',creative:'UNAVAILABLE',creativeRequired:false});
 const document=f.store.get(f.job.id)!;document.workflow!.request.output.renderRequired=true;
 // Recompute the request hash only for this pure evaluator's isolated output requirement test.
 const {requestFingerprint}=await import('../src/main/video-editing/workflow-planning.js');document.workflow!.requestHash=requestFingerprint(document.workflow!.request);
 expect(technicalAcceptance(document,f.prepared.request.operationId,'wrong')).toMatchObject({status:'UNVERIFIED',renderRequired:true});
 expect(technicalAcceptance(document,f.prepared.request.operationId,'wrong').failed).toContain('OUTPUT_ARTIFACT_UNVERIFIED');
});

it('fails technical acceptance when the work explicitly requires unavailable creative review',async()=>{
 const f=await operatorFixture(dir);await f.store.claimOperator(f.job.id,f.authority.id,f.prepared.preparedHash,f.authority.targetHash,101,f.context.timeline);
 const job=f.store.get(f.job.id)!;
 job.workflow!.request.output.creativeReviewRequired=true;
 const {requestFingerprint}=await import('../src/main/video-editing/workflow-planning.js');job.workflow!.requestHash=requestFingerprint(job.workflow!.request);
 expect(technicalAcceptance(job,f.prepared.request.operationId).failed).toContain('CREATIVE_REVIEW_REQUIRED_UNAVAILABLE');
});

it('joins completed output probe/hash/positions to the exact operator execution and rejects missing required samples',async()=>{
 const f=await operatorFixture(dir);await f.store.claimOperator(f.job.id,f.authority.id,f.prepared.preparedHash,f.authority.targetHash,101,f.context.timeline);
 const after=structuredClone(f.context.timeline);after.id='render-after';after.observedAt=200;after.timelineState!.durationFrames=48;
 after.timelineState!.items=f.job.candidates[0]!.plan.clips.map((c,i)=>({uniqueId:`item-${i}`,mediaUniqueId:f.job.media.find(m=>m.id===c.mediaId)!.resolveMediaId!,mediaType:c.mediaType,track:c.track,source:c.source,timeline:c.timeline}));
 await f.store.put({...f.store.get(f.job.id)!,evidence:[...f.store.get(f.job.id)!.evidence,after]});await f.store.finishOperator(f.job.id,f.prepared.request.operationId,[after.id]);
 const job=f.store.get(f.job.id)!;job.workflow!.request.output.renderRequired=true;
 const {requestFingerprint}=await import('../src/main/video-editing/workflow-planning.js');job.workflow!.requestHash=requestFingerprint(job.workflow!.request);
 const {promises:fs}=await import('node:fs'),{createHash}=await import('node:crypto');
 const file=dir+'/output.mov';await fs.writeFile(file,'generated output fixture');
 const {ResolveEvidenceReader}=await import('../src/main/video-editing/inspection.js');
 const {collectMediaOutput}=await import('../src/main/video-editing/media-output.js');
 const reader=new ResolveEvidenceReader(async()=>({job_id:'render',operation_id:f.prepared.request.operationId,timeline_unique_id:f.prepared.request.timelineId,status:'Complete',verified:true,artifact_exists:true,output_path_matches_expected:true,expected_output_path:file,output_path:file}));
 const png=Buffer.from('synthetic port PNG bytes'),sha=createHash('sha256').update(png).digest('hex');
 const output=await collectMediaOutput(job,f.prepared.request.operationId,'render',{reader,access:p=>fs.realpath(p),
  frameSink:async()=>({path:dir+'/sample.png',sha256:sha,bytes:png.length}),runtime:{
   probe:async source=>({technical:{version:1,jobId:source.jobId,assetId:source.assetId,sourceHash:source.artifact.sha256,rawSha256:'d'.repeat(64),observedAt:200,normalizationVersion:'1',
    producer:{name:'ffprobe',version:'8.1',executableHash:'a'.repeat(64)},format:{name:'mov',duration:{numerator:2,denominator:1}},streams:[{index:0,kind:'video',width:64,height:36,frameCount:48,avgFrameRate:{numerator:24,denominator:1},nominalFrameRate:{numerator:24,denominator:1}}]}}),
   positionedFrame:async(source,_technical,requested)=>({sourceHash:source.artifact.sha256,png,requested,actual:{timestamp:{numerator:requested.frameIndex,denominator:24}},position:'OBSERVED_TIMESTAMP',confidence:1,verifiedFrameIndex:requested.frameIndex,
    producer:{name:'ffmpeg',version:'8.1',executableHash:'b'.repeat(64)},decodeSha256:'c'.repeat(64),image:{width:64,height:36,bytes:png.length,sha256:sha},
    positionProof:{sourceHash:source.artifact.sha256,executableHash:'a'.repeat(64),producerVersion:'8.1',rawSha256:'d'.repeat(64),observedAt:200,decodedFrames:48,classification:'INDEPENDENT_DECODED_PTS_MATCH'}})
  }});
 expect(technicalAcceptance(output.document,f.prepared.request.operationId,'render')).toMatchObject({status:'VERIFIED',creative:'UNAVAILABLE'});
 const wrong=structuredClone(output.document);wrong.evidence=wrong.evidence.filter(row=>row.framePosition!==47);
 expect(technicalAcceptance(wrong,f.prepared.request.operationId,'render').failed).toContain('POSITIONED_OUTPUT_EVIDENCE_MISSING');
 expect(technicalAcceptance(output.document,f.prepared.request.operationId,'other').failed).toContain('OUTPUT_ARTIFACT_UNVERIFIED');
});

it('rejects restored claim evidence rebound away from the native prepared intent',async()=>{
 const f=await operatorFixture(dir);await f.store.claimOperator(f.job.id,f.authority.id,f.prepared.preparedHash,f.authority.targetHash,101,f.context.timeline);
 const job=f.store.get(f.job.id)!,alternate={...job.evidence.find(row=>row.id===f.prepared.request.beforeEvidenceIds[0])!,id:'alternate-before',observedAt:13};job.evidence.push(alternate);
 const {checkpointIntent}=await import('../src/main/video-editing/identity.js');
 const checkpoint=job.checkpoints[0]!;const changed=checkpointIntent(job,checkpoint.planId,checkpoint.timelineId,'assemble',[alternate.id],checkpoint.operationId);
 job.checkpoints[0]={...changed,operatorBinding:checkpoint.operatorBinding};
 const restored=new VideoEditingStore({read:async()=>({kind:'valid',value:{version:1,jobs:[job]}})});
 await expect(restored.restore()).rejects.toThrow(/join|intent/);
});

it('requires a durable fresh pre-dispatch observation instead of relying only on an old preparation',async()=>{
 const f=await operatorFixture(dir);
 await expect(f.store.claimOperator(f.job.id,f.authority.id,f.prepared.preparedHash,f.authority.targetHash,101)).rejects.toThrow(/fresh observation/i);
});

it('reports stale post-state consistently against the fresh claim observation',async()=>{
 const f=await operatorFixture(dir);f.context.timeline.observedAt=150;
 await f.store.claimOperator(f.job.id,f.authority.id,f.prepared.preparedHash,f.authority.targetHash,151,f.context.timeline);
 const after=structuredClone(f.context.timeline);after.id='old-post';after.observedAt=100;after.timelineState!.durationFrames=48;
 after.timelineState!.items=f.job.candidates[0]!.plan.clips.map((c,i)=>({uniqueId:`item-${i}`,mediaUniqueId:f.job.media.find(m=>m.id===c.mediaId)!.resolveMediaId!,mediaType:c.mediaType,track:c.track,source:c.source,timeline:c.timeline}));
 const coordinator=new OperatorExecutionCoordinator(f.store,{capture:async()=>({context:f.context,readiness:f.readiness}),assertOwner:async()=>{},call:async()=>{throw new Error('No replay');},
  observe:async()=>{const current=f.store.get(f.job.id)!;await f.store.put({...current,evidence:[...current.evidence,after]});return [after.id];}});
 const result=await coordinator.reconcile(f.job.id,f.prepared.request.operationId);
 expect(result.status).toBe('UNVERIFIED');expect(result.verification!.status).toBe('UNVERIFIED');expect(result.failed).toContain('AFTER_OBSERVATION_NOT_FRESH');
 expect(technicalAcceptance(f.store.get(f.job.id)!,f.prepared.request.operationId).failed).toContain('AFTER_OBSERVATION_NOT_FRESH');
});
