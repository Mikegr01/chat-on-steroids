import { expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { defaultConfig, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { mediaRuntimeOperator } from '../src/main/video-editing/media-runtime-operator.js';

it.skipIf(!process.env.COS_TEST_FFPROBE || !process.env.COS_TEST_FFMPEG)('admits approved external host identities through the supported service into isolated config only', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'cos-s75-operator-host-'));
  const paths = { ffprobePath: process.env.COS_TEST_FFPROBE!, ffmpegPath: process.env.COS_TEST_FFMPEG! };
  // Compute SHA256 dynamically from the supplied binaries — no hardcoded hashes.
  const hashes = {
    ffprobe: createHash('sha256').update(await fs.readFile(paths.ffprobePath)).digest('hex'),
    ffmpeg: createHash('sha256').update(await fs.readFile(paths.ffmpegPath)).digest('hex'),
  };
  try {
    initConfigPath(root); await saveConfig(defaultConfig());
    expect(await mediaRuntimeOperator.status()).toMatchObject({ status: 'NOT_CONFIGURED' });
    const confirm = vi.fn(async (_detail: string) => true);
    expect(await mediaRuntimeOperator.admit(paths, confirm, async () => {})).toMatchObject({ status: 'CONFIGURED', capabilities: { jsonProbe: 'SUPPORTED', pngFrames: 'SUPPORTED', decodedFramePositions: 'SUPPORTED' } });
    expect(confirm).toHaveBeenCalledOnce();
    expect(getConfig().mediaRuntime?.ffprobe.sha256).toBe(hashes.ffprobe); expect(getConfig().mediaRuntime?.ffmpeg.sha256).toBe(hashes.ffmpeg);
    const before = await fs.readFile(path.join(root, 'config.json'), 'utf8');
    await expect(mediaRuntimeOperator.admit({ ...paths, ffmpegPath: path.join(root, 'missing.exe') }, async () => true, async () => {})).rejects.toThrow();
    expect(await fs.readFile(path.join(root, 'config.json'), 'utf8')).toBe(before);
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Error('simulated disk failure'));
    try { await expect(mediaRuntimeOperator.admit(paths, async () => true, async () => {})).rejects.toThrow('disk failure'); }
    finally { rename.mockRestore(); }
    expect(await fs.readFile(path.join(root, 'config.json'), 'utf8')).toBe(before);
    expect(getConfig().mediaRuntime?.ffprobe.sha256).toBe(hashes.ffprobe);
    console.log(JSON.stringify({ isolatedConfig: root, status: 'CONFIGURED', hashes, resolveMutations: 0, productionConfigWritten: false }));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 30000);
