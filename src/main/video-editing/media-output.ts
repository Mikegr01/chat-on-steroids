import { randomUUID } from 'node:crypto';
import { frameRateSchema, videoEvidenceSchema, type VideoEvidence } from '../../shared/video-editing.js';
import { technicalMediaSchema, type TechnicalMedia } from '../../shared/media-runtime.js';
import { validateDocument, sameRate } from './validation.js';
import { ResolveEvidenceReader } from './inspection.js';
import type { Artifact, ArtifactAccess } from './producers.js';
import type { MediaRuntime } from './media-runtime.js';
import type { MediaSource } from './media-probe.js';
import { admitFrameSample } from './workflow-output.js';
interface OutputPorts {
 reader:ResolveEvidenceReader;access:ArtifactAccess;
 runtime:{probe(source:MediaSource,access:ArtifactAccess):Promise<{technical:TechnicalMedia}>;
   positionedFrame(source:MediaSource,technical:TechnicalMedia,requested:{frameIndex:number;streamIndex:number},access:ArtifactAccess):Promise<Awaited<ReturnType<MediaRuntime['positionedFrame']>>>};
 frameSink(jobId:string,sourceHash:string,png:Buffer):Promise<Artifact>;
}
/** Read-only collection from a completed exact render receipt; never starts a render or edits a timeline. */
export async function collectMediaOutput(raw:unknown,operationId:string,renderId:string,ports:OutputPorts) {
 const job=validateDocument(raw),checkpoint=job.checkpoints.find(row=>row.operationId===operationId);
 if(!checkpoint || checkpoint.state!=='verified') throw new Error('Verified execution operation required before output collection');
 const plan=job.candidates.find(row=>row.plan.id===checkpoint.planId)!.plan;
 const receipt=(await ports.reader.render(renderId,operationId,checkpoint.timelineId,{id:`render-status-${randomUUID()}`,observedAt:Date.now()},ports.access)).evidence;
 const source={jobId:job.id,assetId:renderId,artifact:receipt.locator!};
 const probe=technicalMediaSchema.parse((await ports.runtime.probe(source,ports.access)).technical);
 if(probe.jobId!==job.id || probe.assetId!==renderId || probe.sourceHash!==source.artifact.sha256) throw new Error('Output probe identity mismatch');
 const videos=probe.streams.filter(row=>row.kind==='video'),video=videos.length===1?videos[0]:undefined;
 const rate=frameRateSchema.safeParse(video?.avgFrameRate),nominal=frameRateSchema.safeParse(video?.nominalFrameRate);
 const measurable=rate.success && nominal.success && sameRate(rate.data,nominal.data) && !!video?.frameCount;
 const artifact=videoEvidenceSchema.parse({id:`render-probe-${randomUUID()}`,subject:'render',subjectId:renderId,basis:'measured',parents:[],
   producer:{name:'ffprobe',version:probe.producer.version},observedAt:probe.observedAt,confidence:1,locator:receipt.locator,technical:probe,
   acquisition:{tool:'ffprobe',rawSha256:probe.rawSha256},renderReceiptEvidenceId:measurable?receipt.id:undefined,
   renderState:measurable?{operationId,timelineId:checkpoint.timelineId,completed:true,fps:rate.data,durationFrames:video.frameCount}:undefined});
 const evidence:VideoEvidence[]=[receipt,artifact],samples:Array<ReturnType<typeof admitFrameSample>['sample']>=[];
 if(measurable) for(const frameIndex of [...new Set([0,Math.floor(video.frameCount!/2),video.frameCount!-1])]) {
   if(frameIndex>1000) continue; // Explicit missing required samples prevents a complete technical-output pass.
   const decoded=await ports.runtime.positionedFrame(source,probe,{frameIndex,streamIndex:video.index},ports.access);
   if(decoded.sourceHash!==source.artifact.sha256) throw new Error('Output frame source mismatch');
   const image=await ports.frameSink(job.id,source.artifact.sha256,decoded.png);
   if(image.sha256!==decoded.image.sha256 || image.bytes!==decoded.image.bytes) throw new Error('Output frame artifact mismatch');
   const time=decoded.actual?.timestamp;
   const indexMatches=decoded.verifiedFrameIndex===frameIndex && !!time &&
     BigInt(time.numerator)*BigInt(rate.data.numerator)===BigInt(frameIndex)*BigInt(rate.data.denominator)*BigInt(time.denominator);
   const id=`render-frame-${randomUUID()}`;
   evidence.push(videoEvidenceSchema.parse({id,subject:'frame',subjectId:renderId,basis:'measured',parents:[],
    producer:{name:'ffmpeg',version:decoded.producer.version},observedAt:Date.now(),confidence:decoded.confidence,locator:image,
    framePosition:indexMatches?decoded.verifiedFrameIndex:undefined,mediaSample:{sourceHash:decoded.sourceHash,requestedFrame:frameIndex,
      actualTimestamp:decoded.actual?.timestamp,position:decoded.position,executableHash:decoded.producer.executableHash,
      decodeSha256:decoded.decodeSha256,image:decoded.image,positionProof:decoded.positionProof}}));
   const sample={version:1,renderId,artifactEvidenceId:artifact.id,sampleEvidenceId:id,requested:{frameIndex,fps:rate.data},
    actual:indexMatches?{frameIndex,timestampMs:time.numerator*1000/time.denominator}:undefined,image:{sha256:decoded.image.sha256,width:decoded.image.width,height:decoded.image.height},
    producer:{name:'ffmpeg',version:decoded.producer.version},confidence:decoded.confidence,decode:'decoded',position:indexMatches?'verified':'unverified'};
   const document={...job,evidence:[...job.evidence,...evidence]};
   samples.push(admitFrameSample(document,sample).sample);
 }
 const document=validateDocument({...job,evidence:[...job.evidence,...evidence]});
 const technicalStatus=!measurable?'UNVERIFIED':video.frameCount!==plan.timeline.durationFrames||!sameRate(rate.data,plan.timeline.fps)?'DEVIATED':'VERIFIED';
 return {document,artifactEvidenceId:artifact.id,technical:probe,samples,technicalStatus,creative:'UNAVAILABLE' as const,
   completePositionedSamples:measurable && samples.length===new Set([0,Math.floor(video.frameCount!/2),video.frameCount!-1]).size && samples.every(row=>row.position==='verified'),
   lineage:{jobId:job.id,operationId,planId:plan.id,timelineId:checkpoint.timelineId,renderId},scope:'Decoded timing and independently matched frame positions; creative/content review remains unavailable.'};
}
