import { expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { defaultConfig, getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { mediaRuntimeOperator } from '../src/main/video-editing/media-runtime-operator.js';

it.skipIf(process.env.COS_VIDEO_HOST_ADMISSION !== '1')('admits approved external host identities through the supported service into isolated config only', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'cos-s75-operator-host-'));
  const bin = 'C:/Users/Admin/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1-full_build/bin';
  const paths = { ffprobePath: path.join(bin, 'ffprobe.exe'), ffmpegPath: path.join(bin, 'ffmpeg.exe') };
  const hashes = { ffprobe: '70872c3ffbc43d0b2c570f9837f54d6e9a832f4ca25463e9735b6a3ec0621478', ffmpeg: 'd1e2a156261ecc675081943197a85f08f2868784a0af499171ede89353edad31' };
  try {
    initConfigPath(root); await saveConfig(defaultConfig());
    for (const tool of ['ffprobe', 'ffmpeg'] as const) expect(createHash('sha256').update(await fs.readFile(paths[`${tool}Path`])).digest('hex')).toBe(hashes[tool]);
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
