import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ResolveEvidenceReader } from '../src/main/video-editing/inspection.js';
import { produceMedia } from '../src/main/video-editing/producers.js';
import { createAssetIngestor } from '../src/main/video-editing/workflow-ingestion.js';
import { VideoWorkflowCoordinator } from '../src/main/video-editing/workflow.js';
import { VideoEditingStore } from '../src/main/video-editing/store.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { workRequest } from './fixtures/video-workflow.js';
import { workflowCapabilities } from './fixtures/video-workflow-runtime.js';
import { makeTempDir, removeTempDir } from './helpers.js';

// Real pool IDs reproduce the supplied topology; bytes/properties are synthetic test evidence.
const ids = ['51af0976-6837-4a92-9c4a-81f17bf6081e', '45f82df4-c365-4c06-a943-c3b01f82b35f'];
let dir: string;
beforeEach(async () => { dir = await makeTempDir('cos-media-discovery-'); initDurableStore(dir); });
afterEach(async () => { resetDurableForTests(); await removeTempDir(dir); });
async function fixture(total = 245, positions = [123, 178]) {
  const files = [path.join(dir, 'a', 'source.mp4'), path.join(dir, 'b', 'source.mp4')];
  const hashes: string[] = [];
  for (const [index, file] of files.entries()) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const bytes = Buffer.from(`synthetic fixture source ${index}`);
    await fs.writeFile(file, bytes); hashes.push(createHash('sha256').update(bytes).digest('hex'));
  }
  const properties: Record<string, string> = { Type: 'Video', Frames: '24', FPS: '24', Resolution: '64x36', 'Video Codec': 'H.264' };
  const rows = Array.from({ length: total }, (_, index) => ({ unique_id: `other-${index}`, name: 'source.mp4',
    path: path.join(dir, `unread-other-${index}.mp4`), folder: 'Master', properties_status: 'KNOWN', properties }));
  positions.forEach((position, index) => { rows[position] = { ...rows[position]!, unique_id: ids[index]!, path: files[index]! }; });
  const calls: number[] = [];
  const page = (offset: number) => ({ project_unique_id: 'resolve-project-1', adapter_version: '1.0.3',
    total, offset, limit: 100, items: rows.slice(offset, offset + 100) });
  const reader = new ResolveEvidenceReader(async (name, args) => {
    expect(name).toBe('resolve_inspect'); expect(args.selector).toBe('media'); expect(args.limit).toBe(100);
    calls.push(Number(args.offset)); return page(Number(args.offset));
  });
  return { rows, files, hashes, reader, calls, page };
}
const access = (file: string) => fs.realpath(file);
const read = (reader: ResolveEvidenceReader, id = ids[0]!) => reader.media(id, 'source-a', { id: 'identity-a', observedAt: 10 }, access);
function requestFor(f: Awaited<ReturnType<typeof fixture>>) {
  const request = workRequest(dir);
  request.assets = request.assets.slice(0, 2).map((row, index) => ({ ...row, path: f.files[index]!, resolveMediaId: ids[index]!,
    usable: { operatorId: 'editor-1', ranges: [{ start: 0, end: 24 }] } }));
  request.assets.push({ id: 'reference', role: 'reference', kind: 'video', path: f.files[0]! });
  return request;
}
function timelines(f: Awaited<ReturnType<typeof fixture>>, count = 13) {
  for (let index = 100; index < 100 + count; index++) f.rows[index] = { ...f.rows[index]!,
    unique_id: `timeline-${index}`, path: '', properties: { Type: 'Timeline' } };
}

it.each([1, 2, 13])('enumerates %i empty-path Timeline rows beside exact A/B without reading non-files', async count => {
  const f = await fixture(); timelines(f, count);
  const accessed: string[] = [];
  const batch = await createAssetIngestor({ reader: f.reader, access: async file => {
    accessed.push(file); return access(file);
  } }).ingest(requestFor(f));
  expect(batch.media.map(row => row.resolveMediaId)).toEqual(ids);
  expect(batch.media.map(row => row.sha256)).toEqual(f.hashes);
  expect(accessed.every(file => f.files.includes(file))).toBe(true);
  expect(f.calls).toEqual([0, 100, 200, 0, 100, 200]);
  expect(f.page(200).items).toHaveLength(45);
});
it.each(['', 'nonempty'])('rejects a selected Timeline with %s path before artifact access', async representation => {
  const f = await fixture(); timelines(f);
  if (representation) f.rows[100]!.path = f.files[0]!;
  let accessed = false;
  await expect(f.reader.media('timeline-100', 'source-a', { id: 'identity', observedAt: 10 }, async file => {
    accessed = true; return access(file);
  })).rejects.toThrow(/selected.*file|file.*source/i);
  expect(accessed).toBe(false);
});
it.each(['Video', 'Audio', 'Still', 'Unknown', 'Compound', 'Fusion', ''])('fails closed on empty-path %s rows', async type => {
  const f = await fixture(); f.rows[123] = { ...f.rows[123]!, path: '', properties: type ? { Type: type } : {} };
  let accessed = false;
  await expect(f.reader.media(ids[0]!, 'source-a', { id: 'identity', observedAt: 10 }, async file => {
    accessed = true; return access(file);
  })).rejects.toThrow(/Media/i);
  expect(accessed).toBe(false);
});
it('rejects an empty-path Timeline whose property status is unavailable', async () => {
  const f = await fixture(); timelines(f); f.rows[100]!.properties_status = 'UNAVAILABLE';
  await expect(read(f.reader)).rejects.toThrow(/Media/i);
});
it('fails closed on an unrelated unknown empty-path inventory entity', async () => {
  const f = await fixture(); f.rows[100] = { ...f.rows[100]!, path: '', properties: { Type: 'UnprovenVirtual' } };
  await expect(read(f.reader)).rejects.toThrow(/Media page/i);
});
it('rejects relative selected paths before artifact access', async () => {
  const f = await fixture(); f.rows[123]!.path = 'relative.mp4'; let accessed = false;
  await expect(f.reader.media(ids[0]!, 'source-a', { id: 'identity', observedAt: 10 }, async file => {
    accessed = true; return access(file);
  })).rejects.toThrow(/selected.*file/i);
  expect(accessed).toBe(false);
});
it('cannot produce Timeline artifact evidence even through the direct producer', async () => {
  const f = await fixture();
  const artifact = { path: f.files[0]!, sha256: f.hashes[0]!, bytes: 26 };
  expect(() => produceMedia({ ...f.rows[123]!, properties: { Type: 'Timeline' } }, artifact,
    { id: 'identity', subjectId: 'source-a', observedAt: 10 })).toThrow(/file-backed source/i);
  expect(() => produceMedia({ ...f.rows[123]!, unique_id: ' padded ' }, artifact,
    { id: 'identity', subjectId: 'source-a', observedAt: 10 })).toThrow(/file-backed source/i);
});
it('rejects duplicate Timeline IDs across pages including equal rows', async () => {
  const f = await fixture(); timelines(f); f.rows[244] = { ...f.rows[100]! };
  await expect(read(f.reader)).rejects.toThrow(/duplicate|ambiguous/i);
});
it.each(['name', 'type', 'path', 'folder', 'properties', 'status'])('rejects second-pass Timeline %s drift', async change => {
  const f = await fixture(); timelines(f); let reads = 0;
  const reader = new ResolveEvidenceReader(async (_name, args) => {
    if (++reads === 4) {
      const row = f.rows[100]!;
      if (change === 'name') row.name = 'changed';
      else if (change === 'type') { row.properties = { Type: 'Video' }; row.path = f.files[0]!; }
      else if (change === 'path') row.path = f.files[0]!;
      else if (change === 'folder') row.folder = 'changed';
      else if (change === 'properties') row.properties = { ...row.properties, FPS: '25' };
      else row.properties_status = 'UNAVAILABLE';
    }
    return f.page(Number(args.offset));
  }); await expect(read(reader)).rejects.toThrow(/changed|invalid/i);
});
it.each(['key', 'value', 'nested', 'count', 'name', 'folder', 'status'])('rejects malformed inventory %s bounds', async change => {
  const f = await fixture(); timelines(f); const row = f.rows[100]!;
  if (change === 'key') row.properties = { ['x'.repeat(129)]: 'value' };
  else if (change === 'value') row.properties = { Type: 'Timeline', Duration: 'x'.repeat(4097) };
  else if (change === 'nested') Object.assign(row, { properties: { Type: 'Timeline', nested: {} } });
  else if (change === 'count') row.properties = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`key-${index}`, 'value']));
  else if (change === 'name') row.name = 'x'.repeat(4097);
  else if (change === 'folder') row.folder = 'x'.repeat(4097);
  else row.properties_status = 'invented';
  await expect(read(f.reader)).rejects.toThrow(/Media/i);
});
it('includes empty-path Timeline rows in stable deterministic provenance', async () => {
  const f = await fixture(); timelines(f); const first = await read(f.reader);
  expect(await read(f.reader)).toEqual(first);
  f.rows[100]!.name = 'renamed';
  expect((await read(f.reader)).evidence.acquisition!.rawSha256).not.toBe(first.evidence.acquisition!.rawSha256);
});

it.each([0, 123, 244])('discovers the exact target at index %i through complete bounded pages', async position => {
  const f = await fixture(245, [position, position === 178 ? 179 : 178]);
  const result = await read(f.reader);
  expect(result.asset.resolveMediaId).toBe(ids[0]); expect(result.asset.path).toBe(await access(f.files[0]!));
  expect(result.asset.sha256).toBe(f.hashes[0]); expect(result.evidence.locator!.sha256).toBe(f.hashes[0]);
  expect(result.asset.fps).toEqual({ numerator: 24, denominator: 1 }); expect(result.asset.durationFrames).toBe(24);
  expect(result.asset.width).toBe(64); expect(result.asset.height).toBe(36); expect(result.asset.codec).toBe('H.264');
  expect(f.calls).toEqual([0, 100, 200, 0, 100, 200]);
});
it.each([[123, 178], [1, 244]])('joins both job sources at %j in one shared acquisition', async (first, second) => {
  const f = await fixture(245, [first, second]);
  const request = requestFor(f);
  const ingestor = createAssetIngestor({ access, reader: f.reader, now: () => 10 });
  const batch = await ingestor.ingest(request);
  expect(batch.media.map(row => row.resolveMediaId)).toEqual(ids); expect(batch.media.map(row => row.sha256)).toEqual(f.hashes);
  expect(batch.evidence.filter(row => row.basis === 'measured' && row.subject === 'media')).toHaveLength(2);
  expect(f.calls).toEqual([0, 100, 200, 0, 100, 200]); expect(batch.media).toHaveLength(2);
  expect(JSON.stringify(batch)).not.toContain('other-');
});
it('rejects a missing exact ID after full coverage without reading unrelated files', async () => {
  const f = await fixture(); await expect(read(f.reader, 'missing')).rejects.toThrow(/missing|ambiguous/i);
  expect(f.calls).toEqual([0, 100, 200]);
});
it.each(['same', 'path', 'properties'])('rejects duplicate target IDs including %s evidence', async conflict => {
  const f = await fixture(); f.rows[244] = { ...f.rows[123]!,
    ...(conflict === 'path' ? { path: f.files[1]! } : conflict === 'properties' ? { properties: { ...f.rows[123]!.properties, FPS: '25' } } : {}) };
  await expect(read(f.reader)).rejects.toThrow(/duplicate|ambiguous/i);
});
it.each(['total', 'regressing-total', 'offset', 'short', 'repeat', 'project', 'adapter', 'incomplete'])('fails closed on inconsistent %s pagination', async change => {
  const f = await fixture(); const reader = new ResolveEvidenceReader(async (_name, args) => {
    const offset = Number(args.offset), page = f.page(offset);
    if (offset !== 100) return page;
    switch (change) {
      case 'total': return { ...page, total: 246 };
      case 'regressing-total': return { ...page, total: 244 };
      case 'offset': return { ...page, offset: 0 };
      case 'short': return { ...page, items: page.items.slice(0, 99) };
      case 'repeat': return { ...page, items: f.page(0).items };
      case 'project': return { ...page, project_unique_id: 'other-project' };
      case 'adapter': return { ...page, adapter_version: 'other-adapter' };
      case 'incomplete': return { ...page, complete: false };
    }
  }); await expect(read(reader)).rejects.toThrow(/Media/i);
});
it('bounds each raw page before retaining any target payload', async () => {
  const f = await fixture(); const reader = new ResolveEvidenceReader(async () => ({ ...f.page(0), oversized: 'x'.repeat(1024 * 1024) }));
  await expect(read(reader)).rejects.toThrow(/bound/i);
});
it('bounds aggregate selected payload independently of page sizes', async () => {
  const f = await fixture(245, [1, 123]);
  Object.assign(f.rows[1]!, { opaque: 'x'.repeat(600000) });
  Object.assign(f.rows[123]!, { opaque: 'x'.repeat(600000) });
  await expect(f.reader.mediaBatch(ids.map((id, index) => ({ mediaPoolId: id, mediaId: `source-${index}`,
    stamp: { id: `identity-${index}`, observedAt: 10 } })), access)).rejects.toThrow(/selected observation bound/i);
});
it('produces deterministic bounded provenance from a stable scan', async () => {
  const f = await fixture(); const first = await read(f.reader), second = await read(f.reader);
  expect(first).toEqual(second); expect(first.evidence.acquisition!.rawSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(first)).not.toContain('other-');
});
it('refuses a pool beyond the adapter-native 10000 item ceiling on its first page', async () => {
  const f = await fixture(); let calls = 0;
  const reader = new ResolveEvidenceReader(async () => { calls++; return { ...f.page(0), total: 10001 }; });
  await expect(read(reader)).rejects.toThrow(/Media discovery bound/i); expect(calls).toBe(1);
});
it('covers the maximum 10000 item inventory in exactly 200 bounded calls', async () => {
  const f = await fixture(10000, [9998, 9999]); await read(f.reader);
  expect(f.calls).toHaveLength(200); expect(Math.max(...f.calls)).toBe(9900);
});
it.each(['path', 'properties', 'other-row', 'order'])('rejects %s drift across artifact acquisition', async change => {
  const f = await fixture(); let reads = 0;
  const reader = new ResolveEvidenceReader(async (_name, args) => {
    if (++reads === 4) {
      if (change === 'path') f.rows[123]!.path = f.files[1]!;
      else if (change === 'properties') f.rows[123]!.properties = { ...f.rows[123]!.properties, FPS: '25' };
      else if (change === 'other-row') f.rows[3]!.name = 'changed';
      else [f.rows[3], f.rows[4]] = [f.rows[4]!, f.rows[3]!];
    }
    return f.page(Number(args.offset));
  }); await expect(read(reader)).rejects.toThrow(/changed/i);
});
it.each(['path', 'hash'])('does not join an exact Resolve ID to conflicting local %s evidence', async conflict => {
  const f = await fixture(); const request = requestFor(f);
  let calls = 0;
  const reader = new ResolveEvidenceReader(async (_name, args) => {
    if (++calls === 4 && conflict === 'hash') await fs.writeFile(f.files[0]!, 'different bytes');
    const page = f.page(Number(args.offset));
    if (conflict === 'path') page.items = page.items.map(row => row.unique_id === ids[0] ? { ...row, path: f.files[1]! } : row);
    return page;
  });
  await expect(createAssetIngestor({ access, reader }).ingest(request)).rejects.toThrow(/match|changed/i);
});
it.each([24, 25])('joins paginated identities with independent hash-bound %i fps probe evidence', async fps => {
  const f = await fixture(), request = requestFor(f); timelines(f);
  const runtime = { async probe(source: { jobId: string; assetId: string; artifact: { sha256: string } }) {
    return { technical: { version: 1 as const, jobId: source.jobId, assetId: source.assetId, sourceHash: source.artifact.sha256,
      rawSha256: 'c'.repeat(64), observedAt: 10, normalizationVersion: '1' as const,
      producer: { name: 'ffprobe' as const, version: '8.1', executableHash: 'b'.repeat(64) },
      format: { duration: { numerator: 1, denominator: 1 }, name: 'mov,mp4' },
      streams: [{ index: 0, kind: 'video' as const, width: 64, height: 36, codec: 'h264', pixelFormat: 'yuv420p', frameCount: 24,
        avgFrameRate: { numerator: fps, denominator: 1 }, nominalFrameRate: { numerator: fps, denominator: 1 },
        timeBase: { numerator: 1, denominator: 12288 } }] },
      semantic: { scenes: 'UNAVAILABLE', beats: 'UNAVAILABLE', sections: 'UNAVAILABLE', energy: 'UNAVAILABLE' } as const };
  }, async frame() { throw new Error('fixture decoder unavailable'); } };
  const acquired = createAssetIngestor({ access, reader: f.reader, runtime }).ingest(request);
  if (fps !== 24) { await expect(acquired).rejects.toThrow(/timebase conflict/i); return; }
  const batch = await acquired;
  for (const [index, asset] of batch.media.entries()) {
    expect(asset.resolveMediaId).toBe(ids[index]); expect(asset.sha256).toBe(f.hashes[index]);
    expect(asset.technical!.sourceHash).toBe(asset.sha256); expect(asset.technical!.jobId).toBe(request.id);
    expect(asset.technical!.assetId).toBe(asset.id); expect(asset.fps).toEqual({ numerator: 24, denominator: 1 });
    expect(asset.video).toBe(true); expect(asset.audio).toBe(false); expect(asset.durationFrames).toBe(24);
    expect(asset.width).toBe(64); expect(asset.height).toBe(36); expect(asset.codec).toBe('h264');
    expect(asset.technical!.streams[0]!.pixelFormat).toBe('yuv420p');
  }
});
it('restores and retries the SAME blocked ingestion job with no authority or execution custody', async () => {
  const f = await fixture(); timelines(f); const request = requestFor(f); request.localProjectId = null;
  request.id = 's75-absent-scope-live-acceptance-20261010';
  const store = new VideoEditingStore(); await store.restore();
  const broken = new VideoWorkflowCoordinator(store, { capabilities: workflowCapabilities,
    ingestor: createAssetIngestor({ access, reader: new ResolveEvidenceReader(async (_name, args) => {
      const page = f.page(Number(args.offset));
      // Reproduce the prior installed page schema's deterministic empty-path rejection.
      if (page.items.some(row => !row.path)) throw new Error('Media page receipt invalid or incomplete');
      return page;
    }) }) });
  await broken.request(request); const blocked = await broken.ingest(request.id);
  expect(blocked.workflow!.phase).toBe('blocked'); expect(blocked.workflow!.blockedAt).toBe('ingesting');
  expect(blocked.checkpoints).toEqual([]); expect(blocked.evidence).toEqual([]);
  resetDurableForTests(); initDurableStore(dir);
  const restored = new VideoEditingStore(); await restored.restore();
  expect(restored.get(request.id)).toEqual(blocked);
  const resumed = new VideoWorkflowCoordinator(restored, { capabilities: workflowCapabilities, ingestor: createAssetIngestor({ access, reader: f.reader }) });
  const job = await resumed.ingest(request.id);
  expect(job.id).toBe(request.id); expect(job.workflow!.phase).toBe('evidence-ready'); expect(job.workflow!.blockedAt).toBeUndefined();
  expect(job.workflow!.requestHash).toBe(blocked.workflow!.requestHash); expect(job.localProjectId).toBeNull();
  expect(job.checkpoints).toEqual([]); expect(job.candidates).toEqual([]); expect(job.workflow!.prepared).toBeUndefined();
  expect(f.calls).toEqual([0, 100, 200, 0, 100, 200]);
});
