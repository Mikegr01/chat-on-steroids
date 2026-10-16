import { it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createAssetIngestor } from '../src/main/video-editing/workflow-ingestion.js';
import { workRequest } from './fixtures/video-workflow.js';
import { VideoEditingStore } from '../src/main/video-editing/store.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { setupWorkflow, workflowCapabilities, workflowTarget } from './fixtures/video-workflow-runtime.js';
import { VideoWorkflowCoordinator } from '../src/main/video-editing/workflow.js';
import { fixturePlanner } from './fixtures/video-workflow.js';
import { createOperatorPlanner, requestFingerprint } from '../src/main/video-editing/workflow-planning.js';
import { operatorPreflight } from '../src/main/video-editing/operator-preflight.js';
import { validateDocument } from '../src/main/video-editing/validation.js';
import { createOperatorAuthorization } from '../src/main/video-editing/operator-authorization.js';

it('joins technical video/reference/audio facts without inventing semantic analysis', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'cos-probe-ingest-'));
  try {
    const request = workRequest(dir); request.assets[3]!.kind = 'video'; request.assets[3]!.path = path.join(dir, 'ref.mov');
    request.assets.forEach(asset => { asset.usable = undefined; });
    for (const asset of request.assets) await fs.writeFile(asset.path, 'tiny video bytes');
    const runtime = { async probe(source: { jobId: string; assetId: string; artifact: { sha256: string } }) {
      return { semantic: { scenes: 'UNAVAILABLE', beats: 'UNAVAILABLE', sections: 'UNAVAILABLE', energy: 'UNAVAILABLE' } as const,
        technical: { version: 1 as const, jobId: source.jobId, assetId: source.assetId, sourceHash: source.artifact.sha256,
        rawSha256: 'c'.repeat(64), observedAt: 10, normalizationVersion: '1' as const,
        producer: { name: 'ffprobe' as const, version: '8.1', executableHash: 'b'.repeat(64) },
        format: { duration: { numerator: 2002, denominator: 1000 }, name: source.assetId === 'music' ? 'wav' : 'mov' },
        streams: source.assetId === 'music' ? [{ index: 0, kind: 'audio' as const, codec: 'pcm_s16le', sampleRate: 48000, channels: 2 }] :
          [{ index: 0, kind: 'video' as const, width: 1280, height: 720, codec: 'h264', frameCount: 48,
            avgFrameRate: { numerator: 24000, denominator: 1001 }, nominalFrameRate: { numerator: 24000, denominator: 1001 }, timeBase: { numerator: 1, denominator: 24000 } }] } };
    }, async frame() { throw new Error('decoder unavailable'); } };
    const ingestor = createAssetIngestor({ access: p => fs.realpath(p), runtime });
    const result = await ingestor.ingest(request);
    expect(result.media[0]!.fps).toEqual({ numerator: 24000, denominator: 1001 });
    expect(result.media[0]!.durationFrames).toBe(48); expect(result.media[2]!.technical!.streams[0]!.sampleRate).toBe(48000);
    expect(result.references[0]!.technicalProbe!.sourceHash).toBe(result.evidence.find(e=>e.subjectId==='reference')!.locator!.sha256);
    const variable=await createAssetIngestor({access:p=>fs.realpath(p),runtime:{...runtime,probe:async source=>{
      const result=await runtime.probe(source);
      for(const stream of result.technical.streams) if(stream.kind==='video') stream.nominalFrameRate={numerator:30000,denominator:1001};
      return result;
    }}}).ingest(request);
    expect(variable.media[0]!.fps).toBeUndefined();
    expect(variable.media[0]!.technical!.streams[0]!.avgFrameRate).toEqual({numerator:24000,denominator:1001});
    expect(result.references[0]!.sampleStatus).toBe('UNAVAILABLE'); expect(result.media.every(a=>a.music===undefined && a.sceneRanges.length===0)).toBe(true);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
it('durably issues exact expiring operator authority and consumes once across restart', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'cos-operator-auth-')); initDurableStore(dir);
  try {
    const f = await setupWorkflow(dir);
    // Synthetic measured-port responses test production authority invariants; never live proof.
    const ingestor = { async ingest(request: typeof f.request) { const batch = await f.ingestor.ingest(request);
      batch.evidence.forEach(e=>{ if(e.basis==='fixture') e.basis='measured'; }); return batch; } };
    const batch = await ingestor.ingest(f.request);
    const capabilities={...workflowCapabilities,acceptance:'unverified' as const};
    const input = { request: f.request, requestHash: requestFingerprint(f.request), ...batch, capabilities };
    const coordinator = new VideoWorkflowCoordinator(f.store, { ingestor, capabilities,
      planner: createOperatorPlanner('editor-1', await fixturePlanner.plan(input)) });
    await coordinator.request(f.request); await coordinator.ingest(f.request.id); const plans = await coordinator.plan(f.request.id);
    await coordinator.select(f.request.id, plans.candidates[0]!.id, 'editor-1');
    const target = workflowTarget(); target.basis='measured';
    const job = (await coordinator.prepare(f.request.id,target)).document;
    const overrun=structuredClone(job);overrun.media[0]!.technical={version:1,jobId:job.id,assetId:job.media[0]!.id,sourceHash:job.media[0]!.sha256,
      rawSha256:'c'.repeat(64),observedAt:10,normalizationVersion:'1',producer:{name:'ffprobe',version:'8.1',executableHash:'b'.repeat(64)},
      format:{duration:{numerator:1,denominator:1}},streams:[{index:0,kind:'video'}]};
    const sourceRecord=overrun.evidence.find(e=>e.id===overrun.media[0]!.evidenceIds[0])!;
    const probeRecord={...sourceRecord,id:'probe-duration',technical:overrun.media[0]!.technical,producer:{name:'ffprobe',version:'8.1'},acquisition:{tool:'ffprobe',rawSha256:'c'.repeat(64)}};
    overrun.evidence.push(probeRecord);overrun.media[0]!.evidenceIds.push(probeRecord.id);
    expect(()=>validateDocument(overrun)).toThrow(/measured duration/);
    probeRecord.technical={...probeRecord.technical,jobId:'other'};
    expect(()=>validateDocument(overrun)).toThrow(/provenance/);
    const authority = createOperatorAuthorization(job, 'operator-ipc', 100);
    expect(authority.jobId).toBe(job.id); expect(authority.planId).toBe(job.workflow!.prepared!.request.planId);
    expect(authority.preparedHash).toBe(job.workflow!.prepared!.preparedHash);
    expect(authority.expiresAt).toBe(600100);
    const wrong = structuredClone(job); wrong.workflow!.selection!.candidateId='other';
    expect(()=>createOperatorAuthorization(wrong,'operator-ipc',100)).toThrow();
    const fixtureCapabilityJob=structuredClone(job); fixtureCapabilityJob.workflow!.capabilities.acceptance='fixture';
    expect(()=>createOperatorAuthorization(fixtureCapabilityJob,'operator-ipc',100)).toThrow(/fixture/i);
    const fixtureJob = structuredClone(job); fixtureJob.evidence[0]!.basis='fixture';
    expect(()=>createOperatorAuthorization(fixtureJob,'operator-ipc',100)).toThrow(/fixture/i);
    await f.store.issueOperatorAuthorization(authority);
    const context={jobId:job.id,sessionId:job.sessionId,localProjectId:job.localProjectId,resolveProjectId:job.resolveProjectId,timeline:target,media:job.media,capabilities};
    const flight=operatorPreflight(f.store,job.id,authority.id,context,'CONFIGURED',101);
    expect(flight.guards.find(row=>row.id==='AUTHORITY_BINDING')?.status).toBe('pass');
    expect(flight.allowed).toBe(false);expect(flight.failed).not.toContain('S7_FINAL_LIVE_CANARY_DEFERRED');
    expect(flight.failed).toContain('ADAPTER_GUARDED_APPEND');
    expect(operatorPreflight(f.store,job.id,authority.id,context,'CONFIGURED',600101).failed).toContain('AUTHORITY_EXPIRED');
    const restored = new VideoEditingStore(); await restored.restore();
    await expect(restored.consumeOperatorAuthorization(job.id, authority.id, authority.preparedHash, authority.targetHash, 600101)).rejects.toThrow(/expired/i);
    await expect(restored.consumeOperatorAuthorization(job.id, authority.id, '0'.repeat(64), authority.targetHash, 101)).rejects.toThrow(/binding/i);
    await restored.consumeOperatorAuthorization(job.id,authority.id,authority.preparedHash,authority.targetHash,101);
    const resumed = new VideoEditingStore(); await resumed.restore();
    await expect(resumed.consumeOperatorAuthorization(job.id,authority.id,authority.preparedHash,authority.targetHash,102)).rejects.toThrow(/consumed/i);
  } finally { resetDurableForTests(); await fs.rm(dir,{recursive:true,force:true}); }
});
