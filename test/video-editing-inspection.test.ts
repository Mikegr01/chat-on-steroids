import { expect, it } from 'vitest';
import { ResolveEvidenceReader, technicalOutput } from '../src/main/video-editing/inspection.js';
import { reviewedDocument } from './fixtures/video-editing.js';
import { timelinePage } from './fixtures/video-observation.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, removeTempDir } from './helpers.js';

it('acquires bounded consistent timeline pages through inspection only', async () => {
  const full = timelinePage(); full.total = 101;
  const items = Array.from({ length: 101 }, (_, i) => ({ ...full.items[0]!, unique_id: `item-${i}`, start: 86400 + i * 240, end: 86640 + i * 240 }));
  full.duration_frames = 101 * 240;
  const calls: string[] = [];
  const reader = new ResolveEvidenceReader(async (name, args) => {
    calls.push(name); const offset = Number(args.offset ?? 0);
    return { ...full, offset, items: items.slice(offset, offset + 100) };
  });
  const result = await reader.timeline('owned-timeline-1', { id: 'observed', observedAt: 10 });
  expect(result.status).toBe('VERIFIED'); expect(result.evidence.timelineState!.items).toHaveLength(101);
  expect(calls).toEqual(['resolve_inspect', 'resolve_inspect']);
});
it('rejects snapshot drift and unbounded paging instead of guessing completeness', async () => {
  let reads = 0; const page = timelinePage(); page.total = 101;
  const reader = new ResolveEvidenceReader(async () => ({ ...page, offset: ++reads === 1 ? 0 : 100,
    snapshot_sha256: reads === 1 ? 'a'.repeat(64) : 'b'.repeat(64) }));
  await expect(reader.timeline(page.unique_id, { id: 'observed', observedAt: 10 })).rejects.toThrow();
});
it('separates real render metadata/artifact evidence from pending creative review', () => {
  const job = reviewedDocument('measured'); const result = technicalOutput(job, job.reviews[0]!);
  expect(result.technical.status).toBe('VERIFIED'); expect(result.creative.status).toBe('UNAVAILABLE');
  expect(result.review.findings.find(row => row.criterion === 'visual')!.status).toBe('unknown');
  expect(result.evaluation.verdict).toBe('inconclusive');
});
it('does not pass output from a missing artifact measurement or unpositioned still', () => {
  const job = reviewedDocument('measured'); delete job.evidence.find(row => row.id === 'render')!.renderState;
  expect(technicalOutput(job, job.reviews[0]!).technical.status).toBe('UNVERIFIED');
});
it('keeps unfinished or inferred output measurements unverified and labels fixture evidence', () => {
  const job = reviewedDocument('measured');
  const artifact = job.evidence.find(row => row.id === 'render')!;
  artifact.renderState!.completed = false; job.reviews[0]!.completed = false;
  expect(technicalOutput(job, job.reviews[0]!).technical.status).toBe('UNVERIFIED');
  artifact.renderState!.completed = true; job.reviews[0]!.completed = true;
  job.evidence.push({ ...structuredClone(artifact), id: 'render-measurement-root' });
  artifact.basis = 'inferred'; artifact.parents = ['render-measurement-root'];
  expect(technicalOutput(job, job.reviews[0]!).technical.status).toBe('UNVERIFIED');
  artifact.basis = 'fixture'; artifact.parents = [];
  expect(technicalOutput(job, job.reviews[0]!).technical.evidenceBasis).toBe('fixture');
});
it('joins real render-status identity and actual artifact bytes without inventing decoded measurements', async () => {
  const dir = await makeTempDir('cos-video-render-');
  try {
    const file = path.join(dir, 'review.mov'); await fs.writeFile(file, 'real artifact bytes');
    const operationId = '11111111-1111-4111-8111-111111111111';
    const status = { job_id: 'render-1', operation_id: operationId, timeline_unique_id: 'owned-timeline-1',
      status: 'Complete', verified: true, artifact_exists: true, output_path_matches_expected: true,
      output_path: file, expected_output_path: file };
    const reader = new ResolveEvidenceReader(async () => status);
    const output = await reader.render('render-1', operationId, 'owned-timeline-1', { id: 'render', observedAt: 10 }, async p => fs.realpath(p));
    expect(output.evidence.locator!.bytes).toBe(19); expect(output.evidence.renderState).toBeUndefined();
    const document = reviewedDocument('measured'); document.evidence = document.evidence.map(row => row.id === 'render' ? output.evidence : row);
    expect(technicalOutput(document, document.reviews[0]!).evaluation.verdict).toBe('inconclusive');
    status.operation_id = '22222222-2222-4222-8222-222222222222';
    await expect(reader.render('render-1', operationId, 'owned-timeline-1', { id: 'wrong', observedAt: 11 }, async p => fs.realpath(p))).rejects.toThrow();
  } finally { await removeTempDir(dir); }
});
it('reobserves media identity after hashing and rejects a source relink during acquisition', async () => {
  const dir = await makeTempDir('cos-video-media-');
  try {
    const file = path.join(dir, 'source.mov'); await fs.writeFile(file, 'actual source bytes');
    const canonical = await fs.realpath(file); let reads = 0;
    const reader = new ResolveEvidenceReader(async () => ({ project_unique_id: 'resolve-project-1', adapter_version: '1.0.1',
      total: 1, offset: 0, limit: 100, items: [{ unique_id: 'pool-1', path: ++reads === 1 ? canonical : `${canonical}.changed`,
        properties: { Frames: '480', FPS: '24', 'Video Codec': 'H.264', 'Audio Codec': 'PCM' } }] }));
    await expect(reader.media('pool-1', 'media-1', { id: 'observed', observedAt: 10 }, async p => fs.realpath(p))).rejects.toThrow(/changed/i);
  } finally { await removeTempDir(dir); }
});
