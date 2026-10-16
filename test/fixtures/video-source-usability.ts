import { setupWorkflow, workflowCapabilities } from './video-workflow-runtime.js';
import { VideoWorkflowCoordinator } from '../../src/main/video-editing/workflow.js';
import { createAssetIngestor } from '../../src/main/video-editing/workflow-ingestion.js';
import { ResolveEvidenceReader } from '../../src/main/video-editing/inspection.js';
import { promises as fs } from 'node:fs';

/** Synthetic measured ports reproduce the standalone two-source live topology. No live calls. */
export async function sourceUsabilityFixture(dir: string, createTime = false, sourceEnd: 'inclusive' | 'unknown' = 'inclusive') {
  const f = await setupWorkflow(dir);
  f.request.localProjectId = null;
  f.request.assets = f.request.assets.filter(row => row.role !== 'music');
  for (const row of f.request.assets) row.usable = createTime && row.role === 'source'
    ? { operatorId: 'editor', ranges: [{ start: 0, end: 12 }] } : undefined;
  f.request.target = { durationFrames: 48, fps: { numerator: 24, denominator: 1 }, width: 64, height: 36 };
  f.request.pacing = undefined; f.request.output.renderRequired = false;
  const reader = new ResolveEvidenceReader(async () => ({ project_unique_id: f.request.resolveProjectId,
    adapter_version: '1.0.3', total: 2, offset: 0, limit: 100,
    items: await Promise.all(f.request.assets.filter(row => row.role === 'source').map(async row => ({
      unique_id: row.resolveMediaId, path: await fs.realpath(row.path),
      properties: { Frames: '24', FPS: '24', Resolution: '64x36', 'Video Codec': 'H.264', Type: 'Video' } }))) }));
  const ingestor = createAssetIngestor({ reader, access: p => fs.realpath(p), now: () => 10,
    runtime: { async probe(source) { return { semantic: {} as any, technical: {
      version: 1, jobId: source.jobId, assetId: source.assetId, sourceHash: source.artifact.sha256,
      rawSha256: 'c'.repeat(64), observedAt: 10, normalizationVersion: '1',
      producer: { name: 'ffprobe', version: '8.1', executableHash: 'b'.repeat(64) },
      format: { duration: { numerator: 1, denominator: 1 }, name: 'mov' },
      streams: [{ index: 0, kind: 'video', codec: 'h264', pixelFormat: 'yuv420p', width: 64, height: 36,
        frameCount: 24, avgFrameRate: { numerator: 24, denominator: 1 }, nominalFrameRate: { numerator: 24, denominator: 1 } }],
    } }; }, async frame() { throw new Error('No frame mutation'); } } });
  const planner = { descriptor: { id: 'operator-designs', version: '1', kind: 'operator' as const, configuration: {} },
    async plan(input: any) { return [false, true].map(reverse => ({
      plan: { referenceProfileIds: input.references.map((r: any) => r.id), evidenceIds: input.evidence.map((r: any) => r.id), features: ['cut' as const],
        timeline: { name: 'Acceptance', fps: input.request.target.fps, durationFrames: 48 },
        clips: (reverse ? ['source-b', 'source-a'] : ['source-a', 'source-b']).map((mediaId, i) => ({
          id: `clip-${mediaId}`, mediaId, mediaType: 'video' as const, track: 1, source: { start: 0, end: 24 },
          timeline: { start: i * 24, end: (i + 1) * 24 }, evidenceIds: input.media.find((r: any) => r.id === mediaId).evidenceIds })) },
      rationale: 'Explicit A/B alternative', risks: [], scores: [{ criterion: 'operator-preference', value: 1, evidenceIds: input.evidence.map((r: any) => r.id) }] })); } };
  const coordinator = new VideoWorkflowCoordinator(f.store, { ingestor, planner, capabilities: { ...workflowCapabilities, sourceEnd, acceptance: 'unverified' } });
  await coordinator.request(f.request); await coordinator.ingest(f.request.id);
  return { ...f, ingestor, planner, coordinator };
}
