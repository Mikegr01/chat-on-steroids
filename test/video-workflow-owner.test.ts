import { it,expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { initDurableStore,resetDurableForTests } from '../src/main/durable.js';
import { setupWorkflow,workflowCapabilities } from './fixtures/video-workflow-runtime.js';
import { VideoWorkflowCoordinator } from '../src/main/video-editing/workflow.js';
it('rejects an owner epoch changed during acquisition, even when selected session returns to A',async()=>{
 const root=await fs.mkdtemp(path.join(tmpdir(),'cos-video-owner-'));initDurableStore(root);
 try{
  const f=await setupWorkflow(root);let epoch=0,selected='A';
  const coordinator=new VideoWorkflowCoordinator(f.store,{capabilities:workflowCapabilities,
    assertOwner:async()=>{if(selected!=='A'||epoch!==0) throw new Error('Owner epoch changed');},
    ingestor:{ingest:async request=>{const batch=await f.ingestor.ingest(request);selected='B';epoch++;selected='A';return batch;}}});
  await coordinator.request(f.request);
  await expect(coordinator.ingest(f.request.id)).rejects.toThrow(/owner epoch/i);
  expect(f.store.get(f.request.id)!.evidence).toEqual([]);
 }finally{resetDurableForTests();await fs.rm(root,{recursive:true,force:true});}
});
