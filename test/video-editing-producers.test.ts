import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { makeTempDir, removeTempDir } from './helpers.js';
import { inspectArtifact, produceMedia, produceTimeline, produceCapturedFrame } from '../src/main/video-editing/producers.js';
import { timelinePage } from './fixtures/video-observation.js';

let dir: string;
beforeEach(async () => { dir = await makeTempDir('cos-video-producers-'); });
afterEach(async () => { await removeTempDir(dir); });
const stamp = { id: 'evidence-1', subjectId: 'media-1', observedAt: 10 };
const source = { name: 'cos-davinci-resolve', version: '1.0.1' };
it('hashes real bounded source bytes and preserves canonical identity', async () => {
  const file = path.join(dir, 'source.mov'); await fs.writeFile(file, 'actual bytes');
  const result = await inspectArtifact(file, async p => fs.realpath(p));
  expect(result).toEqual({ path: await fs.realpath(file), bytes: 12,
    sha256: createHash('sha256').update('actual bytes').digest('hex') });
});
it('rejects oversized, missing and revoked artifacts explicitly', async () => {
  const file = path.join(dir, 'source.mov'); await fs.writeFile(file, 'oversize');
  await expect(inspectArtifact(file, async p => p, 2)).rejects.toThrow(/bound/i);
  await expect(inspectArtifact(path.join(dir, 'absent'), async p => p)).rejects.toThrow();
  let calls = 0;
  await expect(inspectArtifact(file, async p => { if (++calls > 1) throw new Error('revoked'); return p; })).rejects.toThrow('revoked');
});
it('normalizes observed media properties without inventing beats, scenes or missing fields', () => {
  const artifact = { path: 'D:/source.mov', bytes: 10, sha256: 'a'.repeat(64) };
  const result = produceMedia({ unique_id: 'pool-1', path: artifact.path,
    properties: { Frames: '480', FPS: '24', Resolution: '1920x1080', 'Video Codec': 'H.264',
      'Audio Codec': 'PCM', 'Audio Ch': '2' } }, artifact, stamp, source);
  expect(result.asset).toMatchObject({ id: 'media-1', resolveMediaId: 'pool-1', durationFrames: 480,
    width: 1920, height: 1080, video: true, audio: true, audioChannels: 2 });
  expect(result.evidence).toMatchObject({ basis: 'measured', producer: source, observedAt: 10, locator: artifact });
  expect(result.availability.container).toBe('UNKNOWN');
  expect(result.availability.beats).toBe('UNAVAILABLE');
  expect(result.asset.music).toBeUndefined(); expect(result.asset.sceneRanges).toEqual([]);
});
it('keeps unknown stream presence distinct from false and rejects malformed identity', () => {
  const artifact = { path: 'D:/source.mov', bytes: 10, sha256: 'a'.repeat(64) };
  const result = produceMedia({ unique_id: 'pool-1', path: artifact.path, properties: {} }, artifact, stamp, source);
  expect(result.asset.video).toBeUndefined(); expect(result.availability.video).toBe('UNKNOWN');
  expect(result.asset.status).toBe('partial');
  expect(() => produceMedia({ unique_id: '', path: artifact.path, properties: {} }, artifact, stamp, source)).toThrow();
  expect(() => produceMedia({ unique_id: 'pool-1', path: 'D:/wrong.mov', properties: {} }, artifact, stamp, source)).toThrow(/path/i);
});
it('normalizes exact observed source bounds and absolute record placement with ownership provenance', () => {
  const result = produceTimeline([timelinePage()], { ...stamp, subjectId: 'owned-timeline-1' });
  expect(result.evidence.timelineState).toMatchObject({ complete: true, durationFrames: 240, startFrame: 86400,
    ownership: { creationOperationId: 'prepare-1', sourceTimelineId: null },
    items: [{ source: { start: 0, end: 240 }, timeline: { start: 0, end: 240 }, mediaUniqueId: 'pool-1' }] });
  expect(result.evidence.acquisition!.rawSha256).toMatch(/^[a-f0-9]{64}$/);
});
it('never turns missing pages, lost tracks or unobserved source bounds into complete inspection', () => {
  const page = timelinePage(); page.total = 2;
  expect(produceTimeline([page], { ...stamp, subjectId: page.unique_id }).status).toBe('UNVERIFIED');
  page.total = 1; page.inspection_errors = ['TRACK_UNAVAILABLE']; page.complete = false;
  expect(produceTimeline([page], { ...stamp, subjectId: page.unique_id }).evidence.timelineState!.complete).toBe(false);
  page.inspection_errors = []; page.complete = true; page.items[0]!.source_end = 300;
  expect(produceTimeline([page], { ...stamp, subjectId: page.unique_id }).status).toBe('UNVERIFIED');
});
it('rejects changed snapshots, wrong subject and malformed raw observations', () => {
  const page = timelinePage(); const second = structuredClone(page); second.offset = 1; second.snapshot_sha256 = 'e'.repeat(64);
  expect(() => produceTimeline([page, second], { ...stamp, subjectId: page.unique_id })).toThrow(/snapshot/i);
  expect(() => produceTimeline([page], stamp)).toThrow(/identity/i);
  expect(() => produceTimeline([{ ...page, fps: -1 }], { ...stamp, subjectId: page.unique_id })).toThrow();
});
it('does not certify clip placement outside the observed timeline duration or tracks', () => {
  const page = timelinePage(); page.duration_frames = 120;
  expect(produceTimeline([page], { ...stamp, subjectId: page.unique_id }).status).toBe('UNVERIFIED');
  page.duration_frames = 240; page.items[0]!.track_index = 2;
  expect(produceTimeline([page], { ...stamp, subjectId: page.unique_id }).status).toBe('UNVERIFIED');
});
it('decodes real still bytes but refuses to invent a frame position from current-frame capture', async () => {
  const file = path.join(dir, 'frame.png'); await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ffffff' } }).png().toFile(file);
  const result = await produceCapturedFrame({ requested: true, executed: true, verified: true,
    after: { path: file, exists: true, non_empty: true, timeline_unique_id: 'owned-timeline-1', project_unique_id: 'resolve-project-1' } },
    { ...stamp, subjectId: 'owned-timeline-1' }, async p => fs.realpath(p));
  expect(result.evidence.locator!.bytes).toBeGreaterThan(0);
  expect(result.evidence.framePosition).toBeUndefined(); expect(result.availability.framePosition).toBe('UNVERIFIED');
  expect(result.evidence.subjectId).toBe('owned-timeline-1');
});
it('requires complete PNG decoding rather than trusting image header dimensions', async () => {
  const file = path.join(dir, 'truncated.png');
  const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ffffff' } }).png().toBuffer();
  await fs.writeFile(file, bytes.subarray(0, 64));
  await expect(produceCapturedFrame({ requested: true, executed: true, verified: true,
    after: { path: file, exists: true, non_empty: true, timeline_unique_id: 'owned-timeline-1', project_unique_id: 'resolve-project-1' } },
    { ...stamp, subjectId: 'owned-timeline-1' }, async p => fs.realpath(p))).rejects.toThrow();
});
it('does not relabel a timeline still as a positioned rendered-output sample', async () => {
  await expect(produceCapturedFrame({ requested: true, executed: true, verified: true,
    after: { path: 'D:/unused.png', exists: true, non_empty: true, timeline_unique_id: 'owned-timeline-1', project_unique_id: 'resolve-project-1' } },
    { ...stamp, subjectId: 'render-1' }, async p => p)).rejects.toThrow(/identity/i);
});
