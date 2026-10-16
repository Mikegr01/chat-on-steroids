import { dialog } from 'electron';
import { z } from 'zod';
import { workRequestSchema } from '../../shared/video-editing.js';
import { getConfig } from '../config.js';
import { videoAction } from '../video-editing/service.js';
import { guard, ok, type SurfaceRegistrar } from './kernel.js';
import { toolDeclaration } from './tool-declarations.js';
export function registerVideoEditingTool(reg:SurfaceRegistrar) {
  if(!reg.exposedCaps.read || reg.ctx.readOnly) return;
  reg.register('video_editing',toolDeclaration('video_editing',()=>({
    title:'Video editing operator workflow',
    description:'Exact session/chat owns jobs; request.sessionId matches; localProjectId null/omitted standalone, exact otherwise. Native select then prepare. Before selection: set-usable-ranges takes source-usability binding,expectedRevision,half-open ranges; missing ranges unusable. recover-legacy-prepared: expectedRevision/preparedHash/operationId; only receiptless, unauthorized/unexecuted legacy, fresh guard-2 precondition match; still needs native receipt/fresh prepare. Runtime: absolute paths/native confirmation; no PATH/install. Execute: native IPC authority, separate confirmation, fresh empty AI-owned guard-2 target. Reconcile never replays. S7/Category C closed.',
    inputSchema:z.object({action:z.enum(['create','inspect','ingest','source-usability','set-usable-ranges','submit','select','prepare','recover-legacy-prepared','preview','preflight','runtime','media-runtime-status','media-runtime-refresh','media-runtime-admit','collect-output','sample','live-manifest','execute','reconcile','technical-acceptance','capability-status','readmit-source-end','readmit-capabilities']),
      // Echo the bounded read context; the service owns strict evidence-binding validation.
      binding:z.unknown().optional(),expectedRevision:z.number().int().nonnegative().max(1_000_000_000).optional(),ranges:z.array(z.unknown()).min(1).max(100).optional(),
      preparedHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),
      ffprobePath:z.string().min(1).max(4096).optional(),ffmpegPath:z.string().min(1).max(4096).optional(),
      // Publish the owner's scope fields within discovery limits; service validates the complete request/refinements.
      manifestHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),jobId:z.string().max(128).optional(),evidenceId:z.string().max(128).optional(),authorizationId:z.string().uuid().optional(),operationId:z.string().uuid().optional(),renderId:z.string().max(128).optional(),request:z.object({sessionId:workRequestSchema.shape.sessionId,localProjectId:workRequestSchema.shape.localProjectId}).passthrough().optional(),sourceEnd:z.enum(['unknown','inclusive','exclusive']).optional(),
      designs:z.array(z.unknown()).min(2).max(20).optional(),provider:z.unknown().optional(),candidateId:z.string().max(128).optional(),timelineId:z.string().max(128).optional()}).strict(),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}
  })),action=>reg.guarded('read','video_editing',()=>guard('video_editing',async()=>{
    if(getConfig().readOnly) throw new Error('Video workflow preparation unavailable in read-only mode');
    const result=await videoAction(action,async detail=>(await dialog.showMessageBox({type:'question',title:'S7.5 operator control',message:detail,
      buttons:['Confirm reviewed operation','Cancel'],defaultId:1,cancelId:1,noLink:true})).response===0);
    if(action.action==='sample' && result && 'png' in result && Buffer.isBuffer(result.png)) {
      if(result.png.length>5*1024*1024) throw new Error('Video sample image bound');
      return {content:[{type:'text' as const,text:JSON.stringify(result.provenance)},
        {type:'image' as const,mimeType:'image/png',data:result.png.toString('base64')}]};
    }
    const output=JSON.stringify(result);
    if(Buffer.byteLength(output)>1024*1024) throw new Error('Video preparation response bound');
    return ok(output);
  })));
}
