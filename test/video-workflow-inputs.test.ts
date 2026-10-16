import { beforeEach, afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import sharp from 'sharp';
import { makeTempDir, removeTempDir } from './helpers.js';
import { workRequest } from './fixtures/video-workflow.js';
import { createAssetIngestor } from '../src/main/video-editing/workflow-ingestion.js';

let dir: string;
beforeEach(async () => { dir = await makeTempDir('cos-workflow-inputs-'); });
afterEach(async () => { await removeTempDir(dir); });
async function assets() {
  const request = workRequest(dir);
  for (const asset of request.assets.filter(row => row.kind !== 'image')) await fs.writeFile(asset.path, `source bytes:${asset.id}`);
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).png().toFile(request.assets[3]!.path);
  return request;
}
it('ingests real local bytes and reference pixels without inventing video/audio analysis', async () => {
  const request = await assets();
  const result = await createAssetIngestor({ access: p => fs.realpath(p), now: () => 10 }).ingest(request);
  expect(result.media).toHaveLength(3); expect(result.references).toHaveLength(1);
  expect(result.media[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.media[0]!.durationFrames).toBeUndefined(); expect(result.media[0]!.video).toBeUndefined();
  expect(result.references[0]!.technical).toMatchObject({ width: 8, height: 8, kind: 'image' });
  expect(result.references[0]!.pacing).toBeUndefined(); expect(result.media[2]!.music).toBeUndefined();
  expect(result.evidence.find(row => row.producer.name === 'operator-range-selection')!.basis).toBe('inferred');
});
it('fails explicitly for missing files, corrupt images and revoked paths', async () => {
  const request = await assets(); await fs.unlink(request.assets[0]!.path);
  await expect(createAssetIngestor({ access: p => fs.realpath(p) }).ingest(request)).rejects.toThrow();
  await fs.writeFile(request.assets[0]!.path, 'source'); await fs.writeFile(request.assets[3]!.path, 'bad image');
  await expect(createAssetIngestor({ access: p => fs.realpath(p) }).ingest(request)).rejects.toThrow();
  await expect(createAssetIngestor({ access: async () => { throw new Error('revoked'); } }).ingest(request)).rejects.toThrow('revoked');
});
it('does not turn an asserted video reference kind into observed technical metadata', async () => {
  const request = await assets(); request.assets[3]!.kind = 'video';
  const result = await createAssetIngestor({ access: p => fs.realpath(p), now: () => 10 }).ingest(request);
  expect(result.references[0]!.technical).toBeUndefined(); expect(result.references[0]!.status).toBe('partial');
});
