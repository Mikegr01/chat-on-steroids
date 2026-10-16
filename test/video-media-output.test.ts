import { it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { reviewedDocument } from './fixtures/video-editing.js';
import { ResolveEvidenceReader } from '../src/main/video-editing/inspection.js';
import { collectMediaOutput } from '../src/main/video-editing/media-output.js';
import { MediaImages } from '../src/main/video-editing/media-images.js';
it('joins completed render lineage to measured output probe and independent sample proof without creative PASS',async()=>{
 const root=await fs.mkdtemp(path.join(tmpdir(),'cos-output-media-'));
 try{
  const file=path.join(root,'render.mov');await fs.writeFile(file,'output');const job=reviewedDocument();
  const checkpoint=job.checkpoints[0]!,renderId='render-new';
  const reader=new ResolveEvidenceReader(async()=>({job_id:renderId,operation_id:checkpoint.operationId,timeline_unique_id:checkpoint.timelineId,
   status:'Complete',verified:true,artifact_exists:true,output_path_matches_expected:true,expected_output_path:file,output_path:file}));
  const png=await sharp({create:{width:16,height:16,channels:3,background:'#000'}}).png().toBuffer(),cache=new MediaImages(path.join(root,'cache'));
  const runtime={probe:async(source:{jobId:string;assetId:string;artifact:{sha256:string}})=>({technical:{version:1 as const,jobId:source.jobId,assetId:source.assetId,
   sourceHash:source.artifact.sha256,rawSha256:'d'.repeat(64),observedAt:10,normalizationVersion:'1' as const,
   producer:{name:'ffprobe' as const,version:'8.1',executableHash:'a'.repeat(64)},format:{name:'mov',duration:{numerator:10,denominator:1}},
   streams:[{index:0,kind:'video' as const,frameCount:240,width:1280,height:720,avgFrameRate:{numerator:24,denominator:1},nominalFrameRate:{numerator:24,denominator:1}}]}}),
   positionedFrame:async(source:{artifact:{sha256:string}},_:unknown,request:{frameIndex:number})=>({sourceHash:source.artifact.sha256,png,requested:{...request,streamIndex:0},
    actual:{timestamp:{numerator:request.frameIndex,denominator:24}},position:'OBSERVED_TIMESTAMP' as const,confidence:1,verifiedFrameIndex:request.frameIndex,
    producer:{name:'ffmpeg' as const,version:'8.1',executableHash:'b'.repeat(64)},decodeSha256:'c'.repeat(64),
    positionProof:{sourceHash:source.artifact.sha256,executableHash:'a'.repeat(64),producerVersion:'8.1',rawSha256:'d'.repeat(64),observedAt:10,decodedFrames:240,classification:'INDEPENDENT_DECODED_PTS_MATCH' as const},
    image:{width:16,height:16,sha256:createHash('sha256').update(png).digest('hex'),bytes:png.length}})};
  const ports={reader,runtime,access:(p:string)=>fs.realpath(p),frameSink:(j:string,h:string,p:Buffer)=>cache.write(j,h,p)};
  const result=await collectMediaOutput(job,checkpoint.operationId,renderId,ports);
  expect(result.samples.map(s=>s.actual?.frameIndex)).toEqual([0,120,239]);
  expect(result.samples.every(s=>s.position==='verified')).toBe(true);
  expect(result.technicalStatus).toBe('VERIFIED');expect(result.creative).toBe('UNAVAILABLE');
  expect(result.document.evidence.find(e=>e.id===result.artifactEvidenceId)!.renderReceiptEvidenceId).toBeTruthy();
  await expect(collectMediaOutput(job,'22222222-2222-4222-8222-222222222222',renderId,ports)).rejects.toThrow(/operation/i);
  const decode=runtime.positionedFrame;
  const unverified=await collectMediaOutput(job,checkpoint.operationId,'render-unverified',{...ports,reader:new ResolveEvidenceReader(async()=>({job_id:'render-unverified',operation_id:checkpoint.operationId,timeline_unique_id:checkpoint.timelineId,status:'Complete',verified:true,artifact_exists:true,output_path_matches_expected:true,expected_output_path:file,output_path:file})),runtime:{...runtime,positionedFrame:async(source,technical,requested)=>({...await decode(source,technical,requested),verifiedFrameIndex:undefined})}});
  expect(unverified.samples.every(s=>s.position==='unverified' && !s.actual)).toBe(true);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
