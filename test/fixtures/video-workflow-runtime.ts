import { promises as fs } from 'node:fs';
import sharp from 'sharp';
import { VideoEditingStore } from '../../src/main/video-editing/store.js';
import { VideoWorkflowCoordinator } from '../../src/main/video-editing/workflow.js';
import { createAssetIngestor } from '../../src/main/video-editing/workflow-ingestion.js';
import { ResolveEvidenceReader } from '../../src/main/video-editing/inspection.js';
import { produceTimeline } from '../../src/main/video-editing/producers.js';
import { timelinePage } from './video-observation.js';
import { fixturePlanner, workRequest } from './video-workflow.js';

export const workflowCapabilities = { tools: ['resolve_inspect', 'resolve_assemble_rough_cut', 'resolve_render_review', 'resolve_render_status'],
  sourceEnd: 'inclusive' as const, acceptance: 'fixture' as const };
export async function setupWorkflow(dir: string, planner = fixturePlanner) {
  const request = workRequest(dir);
  for (const asset of request.assets.filter(row => row.kind !== 'image')) await fs.writeFile(asset.path, `fixture content:${asset.id}`);
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).png().toFile(request.assets[3]!.path);
  const calls: string[] = [];
  const reader = new ResolveEvidenceReader(async name => {
    calls.push(name);
    return { project_unique_id: request.resolveProjectId, adapter_version: '1.0.1', total: 3, offset: 0, limit: 100,
      items: await Promise.all(request.assets.filter(row => row.role !== 'reference').map(async asset => ({
        unique_id: asset.resolveMediaId, path: await fs.realpath(asset.path), properties: { Frames: '480', FPS: '24',
          Resolution: '1280x720', ...(asset.kind === 'video' ? { 'Video Codec': 'H.264' } : { Type: 'Audio' }), 'Audio Codec': 'PCM', 'Audio Ch': '2' } }))) };
  });
  const ingestor = createAssetIngestor({ access: p => fs.realpath(p), reader, observationBasis: 'fixture', now: () => 10 });
  const store = new VideoEditingStore(); await store.restore();
  const coordinator = new VideoWorkflowCoordinator(store, { ingestor, planner, capabilities: workflowCapabilities });
  return { store, coordinator, request, calls, ingestor };
}
export function workflowTarget() {
  const page = timelinePage(); page.items = []; page.total = 0; page.duration_frames = 0;
  const evidence = produceTimeline([page], { id: 'before', subjectId: page.unique_id, observedAt: 11 }).evidence;
  evidence.basis = 'fixture'; return evidence;
}
export async function preparedFixture(dir: string) {
  const fixture = await setupWorkflow(dir);
  await fixture.coordinator.request(fixture.request); await fixture.coordinator.ingest(fixture.request.id);
  const candidates = await fixture.coordinator.plan(fixture.request.id);
  await fixture.coordinator.select(fixture.request.id, candidates.workflow!.comparison[0]!.candidateId, 'editor-1');
  return { ...fixture, ...await fixture.coordinator.prepare(fixture.request.id, workflowTarget()) };
}
