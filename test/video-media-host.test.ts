import { it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { admitMediaRuntime, MediaRuntime, runMediaProcess } from '../src/main/video-editing/media-runtime.js';
import { inspectArtifact } from '../src/main/video-editing/producers.js';
import { createAssetIngestor } from '../src/main/video-editing/workflow-ingestion.js';
import { MediaImages } from '../src/main/video-editing/media-images.js';
import { collectMediaOutput } from '../src/main/video-editing/media-output.js';
import { ResolveEvidenceReader } from '../src/main/video-editing/inspection.js';
import { reviewedDocument } from './fixtures/video-editing.js';
import { workRequest } from './fixtures/video-workflow.js';
it.skipIf(!process.env.COS_TEST_FFPROBE || !process.env.COS_TEST_FFMPEG)('opt-in host runtime proves only generated video/audio and positioned/reference decode',async()=>{
 const root=await fs.mkdtemp(path.join(tmpdir(),'cos-host-media-'));
 try {
  const admission=await admitMediaRuntime({ffprobePath:process.env.COS_TEST_FFPROBE!,ffmpegPath:process.env.COS_TEST_FFMPEG!});
  const generate=async(args:string[])=>runMediaProcess({executable:admission.ffmpeg.path,args:['-hide_banner','-nostdin','-threads','1',...args],cwd:root,timeoutMs:10000,maxStdout:8192,maxStderr:262144});
  const video=path.join(root,'purpose-video.mp4'),audio=path.join(root,'purpose-audio.wav');
  await generate(['-f','lavfi','-i','color=size=64x36:rate=24000/1001:duration=2.002','-c:v','mpeg4','-threads','1','-movflags','+faststart',video]);
  await generate(['-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=2.002','-c:a','pcm_s16le',audio]);
  const runtime=new MediaRuntime(admission),access=(p:string)=>fs.realpath(p);
  const source={jobId:'host-job',assetId:'video',artifact:await inspectArtifact(video,access)};
  const probe=await runtime.probe(source,access);
  expect(probe.technical.streams[0]!.avgFrameRate).toEqual({numerator:24000,denominator:1001});
  const frame=await runtime.positionedFrame(source,probe.technical,{frameIndex:12,streamIndex:0},access);
  expect(frame.verifiedFrameIndex).toBe(12);expect(frame.position).toBe('OBSERVED_TIMESTAMP');expect(frame.actual!.timestamp).toEqual({numerator:12012,denominator:24000});
  const music=await runtime.probe({jobId:'host-job',assetId:'audio',artifact:await inspectArtifact(audio,access)},access);
  expect(music.technical.streams[0]!.sampleRate).toBe(48000);
  const request=workRequest(root);request.assets.forEach(a=>{a.usable=undefined;a.resolveMediaId=undefined;a.path=a.kind==='audio'?audio:video;});
  request.assets[3]!.kind='video';
  const cache=new MediaImages(path.join(root,'evidence'));
  const batch=await createAssetIngestor({access,runtime,frameSink:(j,h,p)=>cache.write(j,h,p)}).ingest(request);
  expect(batch.references[0]!.sampleEvidenceIds!.length).toBe(3);
  const outputJob=reviewedDocument(),checkpoint=outputJob.checkpoints[0]!;
  const reader=new ResolveEvidenceReader(async()=>({job_id:'purpose-render',operation_id:checkpoint.operationId,timeline_unique_id:checkpoint.timelineId,
    status:'Complete',verified:true,artifact_exists:true,output_path_matches_expected:true,expected_output_path:video,output_path:video}));
  const output=await collectMediaOutput(outputJob,checkpoint.operationId,'purpose-render',{reader,runtime,access,frameSink:(j,h,p)=>cache.write(j,h,p)});
  expect(output.completePositionedSamples).toBe(true);expect(output.technicalStatus).toBe('DEVIATED');expect(output.creative).toBe('UNAVAILABLE');
  if(process.env.COS_TEST_MEDIA_REPORT) await fs.writeFile(process.env.COS_TEST_MEDIA_REPORT,JSON.stringify({admission,video:source.artifact,audio:await inspectArtifact(audio,access),technical:probe.technical,frame:{...frame,png:undefined},referenceSamples:batch.references[0]!.sampleEvidenceIds,output:{technicalStatus:output.technicalStatus,samples:output.samples,completePositionedSamples:output.completePositionedSamples,lineage:'synthetic render-status/verified-checkpoint fixture; actual generated-file probe and decode; not live Resolve acceptance'},assetsPolicy:'generated-only; removed after test; no Resolve calls'}));
 } finally {await fs.rm(root,{recursive:true,force:true});}
},120000);
