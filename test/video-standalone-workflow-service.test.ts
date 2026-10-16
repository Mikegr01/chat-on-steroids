import { it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { operatorFixture } from './fixtures/video-operator-execution.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { makeTempDir, removeTempDir } from './helpers.js';

it('creates, ingests, submits, selects and prepares standalone work through Core service, then restores preview/preflight/manifest ownership', async () => {
  const dir = await makeTempDir('cos-standalone-service-'); initDurableStore(dir);
  try {
    // Exact private acceptance IDs may be supplied from ignored local evidence;
    // committed fixtures use synthetic IDs and never contact Resolve.
    const scope = process.env.COS_VIDEO_ACCEPTANCE_FIXTURE
      ? JSON.parse(await fs.readFile(process.env.COS_VIDEO_ACCEPTANCE_FIXTURE, 'utf8'))
      : { sessionId:'acceptance-session',conversationId:'acceptance-chat',resolveProjectId:'acceptance-project',timelineId:'acceptance-timeline',creationOperationId:'acceptance-creation' };
    const f = await operatorFixture(dir, { ...scope,localProjectId:null,acceptanceTimeline:true });
    const batch = { media:f.job.media,references:f.job.references,evidence:f.job.evidence.filter(e => e.id !== f.prepared.request.beforeEvidenceIds[0]) };
    const designs = f.job.candidates.map(candidate => {
      const {id:_id,rootPlanId:_root,parentPlanId:_parent,revision:_rev,...plan}=candidate.plan;
      return {plan,rationale:candidate.rationale,risks:candidate.risks,scores:candidate.scores};
    });
    // Retire only this fixture's generated ledger so the service performs real creation.
    await fs.rm(path.join(dir,'state','video-editing-jobs.json'));
    const parent={caller:{sessionId:scope.sessionId,conversationId:scope.conversationId}};
    const session={id:scope.sessionId,conversationId:scope.conversationId,chatIds:[scope.conversationId]};
    expect('projectId' in session).toBe(false);
    const timeline=async(_id:string,stamp:{id:string;observedAt:number})=>({evidence:{...f.context.timeline,...stamp,
      adapterDispatch:{...f.context.timeline.adapterDispatch,guardVersion:2,sourceEnd:'inclusive',snapshotSha256:'a'.repeat(64),projectName:'Untitled Project 2'}}});
    vi.doMock('../src/main/mcp/call-context.js',()=>({currentCall:()=>parent}));
    vi.doMock('../src/main/session/store.js',()=>({getSession:async()=>session}));
    vi.doMock('../src/main/config.js',()=>({getConfig:()=>({readOnly:false,mediaRuntime:{test:'admitted'}}),effectiveCapabilities:()=>({read:true})}));
    vi.doMock('../src/main/app-identity.js',()=>({resolveCustomUserData:()=>dir}));
    vi.doMock('../src/main/video-editing/runtime-inspection.js',()=>({createGuardedResolveReader:()=>({timeline}),approvedVideoArtifactAccess:()=>async(p:string)=>p,
      readAdmittedWorkflowEpoch:()=> 'curated:1',readAdmittedWorkflowCapabilities:()=>f.context.capabilities,
      createGuardedResolveDispatch:()=>async()=>{throw new Error('No mutation allowed in preparation fixture');}}));
    vi.doMock('../src/main/video-editing/workflow-ingestion.js',()=>({createAssetIngestor:()=>({ingest:async()=>structuredClone(batch)})}));
    vi.doMock('../src/main/video-editing/media-runtime.js',()=>({MediaRuntime:class {},mediaRuntimeDiagnostics:async()=>({status:'CONFIGURED'}),admitMediaRuntime:async()=>{throw new Error('Runtime admission outside fixture');}}));
    let {videoAction,videoStore}=await import('../src/main/video-editing/service.js');
    const call=(raw:unknown)=>videoAction(raw,async()=>true) as Promise<any>;
    const request={...f.request}; delete (request as any).localProjectId;
    expect(await call({action:'create',request,sourceEnd:'inclusive'})).toMatchObject({sessionId:scope.sessionId,localProjectId:null,workflow:{phase:'requested'}});
    vi.resetModules();
    (await import('../src/main/durable.js')).initDurableStore(dir);
    ({videoAction,videoStore}=await import('../src/main/video-editing/service.js'));
    expect((await call({action:'inspect',jobId:request.id})).localProjectId).toBeNull();
    expect(await call({action:'ingest',jobId:request.id})).toMatchObject({workflow:{phase:'evidence-ready'}});
    const planned=await call({action:'submit',jobId:request.id,designs,provider:{id:'operator-designs',version:'1',configuration:{}}});
    expect(planned.workflow.phase).toBe('candidates-ready');
    await call({action:'select',jobId:request.id,candidateId:planned.candidates[0].id});
    const prepared=await call({action:'prepare',jobId:request.id,timelineId:scope.timelineId});
    expect(prepared.document).toMatchObject({sessionId:scope.sessionId,localProjectId:null,resolveProjectId:scope.resolveProjectId,workflow:{phase:'prepared'}});
    const ledger=await videoStore();await ledger.restore();
    expect((await call({action:'inspect',jobId:request.id})).localProjectId).toBeNull();
    expect(await call({action:'preview',jobId:request.id})).toEqual(prepared.preview);
    const {createOperatorAuthorization}=await import('../src/main/video-editing/operator-authorization.js');
    const authority=await ledger.issueOperatorAuthorization(createOperatorAuthorization(ledger.get(request.id)!,'operator-ipc'));
    const preflight=await call({action:'preflight',jobId:request.id,authorizationId:authority.id});
    expect(preflight.diagnostics.failed).not.toContain('WORK_IDENTITY');
    expect((await call({action:'live-manifest',jobId:request.id,authorizationId:authority.id})).stop).toBe('LIVE_ACCEPTANCE_READY');
    expect(ledger.get(request.id)!.checkpoints).toEqual([]);
    expect(ledger.get(request.id)!.operatorAuthorizations![0]!.consumedAt).toBeUndefined();
  } finally { resetDurableForTests(); await removeTempDir(dir); }
});
