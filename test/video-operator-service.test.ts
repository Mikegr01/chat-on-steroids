import {it,expect,vi} from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {initDurableStore,resetDurableForTests} from '../src/main/durable.js';
import {preparedFixture} from './fixtures/video-workflow-runtime.js';
import {videoAction} from '../src/main/video-editing/service.js';
const state=vi.hoisted(()=>({parent:null as unknown,session:null as unknown}));
vi.mock('../src/main/mcp/call-context.js',()=>({currentCall:()=>state.parent}));
vi.mock('../src/main/session/store.js',()=>({getSession:async()=>state.session}));
vi.mock('../src/main/config.js',()=>({getConfig:()=>({readOnly:false,mediaRuntime:null}),effectiveCapabilities:()=>({read:true})}));
vi.mock('../src/main/app-identity.js',()=>({resolveCustomUserData:()=>process.cwd()}));
vi.mock('../src/main/video-editing/runtime-inspection.js',()=>({createGuardedResolveReader:()=>{throw new Error('Resolve offline');},
 readAdmittedWorkflowEpoch:()=>{throw new Error('Resolve offline');},readAdmittedWorkflowCapabilities:()=>{throw new Error('Resolve offline');},
 approvedVideoArtifactAccess:()=>async(p:string)=>fs.realpath(p)}));
it('keeps durable preview readable offline but rejects a different exact session/project',async()=>{
 const root=await fs.mkdtemp(path.join(tmpdir(),'cos-video-service-'));initDurableStore(root);
 try{
  const fixture=await preparedFixture(root);
  state.parent={caller:{sessionId:fixture.request.sessionId,conversationId:'chat-A'}};
  state.session={id:fixture.request.sessionId,projectId:fixture.request.localProjectId,conversationId:'chat-A',chatIds:['chat-A']};
  expect(await videoAction({action:'preview',jobId:fixture.request.id},async()=>true)).toEqual(fixture.preview);
  state.session={...(state.session as object),projectId:'foreign'};
  await expect(videoAction({action:'inspect',jobId:fixture.request.id},async()=>true)).rejects.toThrow(/mismatch/i);
  state.parent=null;await expect(videoAction({action:'runtime'},async()=>true)).rejects.toThrow(/session/i);
 }finally{resetDurableForTests();await fs.rm(root,{recursive:true,force:true});}
});
