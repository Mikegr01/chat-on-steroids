import { it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { admitMediaRuntime, MediaRuntime, runMediaProcess, mediaRuntimeDiagnostics } from '../src/main/video-editing/media-runtime.js';
import { normalizeProbe } from '../src/main/video-editing/media-probe.js';
import { inspectArtifact } from '../src/main/video-editing/producers.js';

const access = (p: string) => fs.realpath(p);
async function setup() {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'cos-media-'));
  const probe = path.join(dir, 'probe.exe'), ffmpeg = path.join(dir, 'encoder.exe'), source = path.join(dir, 'source.mov');
  await fs.writeFile(probe, 'probe executable'); await fs.writeFile(ffmpeg, 'encoder executable'); await fs.writeFile(source, 'approved media');
  const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const raw = { format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '2.002', size: '14' },
    streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 16, height: 16,
      avg_frame_rate: '24000/1001', r_frame_rate: '24000/1001', time_base: '1/24000', duration: '2.002', nb_frames: '48' },
      { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, channel_layout: 'stereo', duration: '2.002' }] };
  const calls: Array<{ executable: string; args: string[] }> = [];
  const runner = async (executable: string, args: string[]) => {
    calls.push({ executable, args });
    if (args.includes('-version')) return { stdout: Buffer.from(`${executable === probe ? 'ffprobe' : 'ffmpeg'} version 8.1 test\n`), stderr: Buffer.alloc(0) };
    if(args.includes('-show_frames')) return {stdout:Buffer.from(JSON.stringify({frames:Array.from({length:48},(_,index)=>({stream_index:0,pts:index*1001}))})),stderr:Buffer.alloc(0)};
    return args.includes('-show_streams') ? { stdout: Buffer.from(JSON.stringify(raw)), stderr: Buffer.alloc(0) } :
      { stdout: png, stderr: Buffer.from('[Parsed_showinfo_1] config in time_base: 1/24000\n[Parsed_showinfo_1] n: 0 pts: 12012 pts_time:0.5005 duration: 1001\n') };
  };
  return { dir, probe, ffmpeg, source, raw, calls, runner, png, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}
it('rejects relative, missing and unconfigured executable paths', async () => {
  await expect(admitMediaRuntime({ ffprobePath: 'ffprobe', ffmpegPath: 'ffmpeg' })).rejects.toThrow(/absolute/);
  await expect(admitMediaRuntime({ ffprobePath: path.resolve('missing-probe'), ffmpegPath: path.resolve('missing-ffmpeg') })).rejects.toThrow();
  expect(await mediaRuntimeDiagnostics(null)).toMatchObject({ status: 'NOT_CONFIGURED' });
});
it('admits separate executable identities and proven capabilities', async () => {
  const f = await setup(); try {
    const config = await admitMediaRuntime({ ffprobePath: f.probe, ffmpegPath: f.ffmpeg }, f.runner);
    expect(config.ffprobe.path).toBe(await access(f.probe)); expect(config.ffprobe.sha256).not.toBe(config.ffmpeg.sha256);
    expect(config.ffprobe.version).toBe('8.1'); expect(config.capabilities).toMatchObject({ jsonProbe: 'SUPPORTED', pngFrames: 'SUPPORTED' });
    expect(JSON.parse(JSON.stringify(config))).toEqual(config);
  } finally { await f.cleanup(); }
});
it('rejects missing ffmpeg and directories before returning trusted state',async()=>{
 const f=await setup();try{
  await expect(admitMediaRuntime({ffprobePath:f.probe,ffmpegPath:path.join(f.dir,'absent')},f.runner)).rejects.toThrow();
  await expect(admitMediaRuntime({ffprobePath:f.dir,ffmpegPath:f.ffmpeg},f.runner)).rejects.toThrow();
  await expect(admitMediaRuntime({ffprobePath:f.probe,ffmpegPath:f.dir},f.runner)).rejects.toThrow();
 }finally{await f.cleanup();}
});
it('rejects unsupported probe/PNG capabilities and changes during admission',async()=>{
 const f=await setup();try{
  await expect(admitMediaRuntime({ffprobePath:f.probe,ffmpegPath:f.ffmpeg},async(exe,args)=>args.includes('-show_streams')?
    {stdout:Buffer.from(JSON.stringify({streams:[{index:0,codec_type:'audio'}]})),stderr:Buffer.alloc(0)}:f.runner(exe,args))).rejects.toThrow(/unsupported/);
  await expect(admitMediaRuntime({ffprobePath:f.probe,ffmpegPath:f.ffmpeg},async(exe,args)=>exe===f.ffmpeg&&!args.includes('-version')?
    {stdout:f.png,stderr:Buffer.alloc(0)}:f.runner(exe,args))).rejects.toThrow(/capability/);
  await expect(admitMediaRuntime({ffprobePath:f.probe,ffmpegPath:f.ffmpeg},async(exe,args)=>{const result=await f.runner(exe,args);
    if(exe===f.ffmpeg&&!args.includes('-version'))await fs.writeFile(f.probe,'changed during admission');return result;})).rejects.toThrow(/identity/);
 }finally{await f.cleanup();}
});
it('refuses malformed versions, absent capabilities and changed executable bytes', async () => {
  const f = await setup(); try {
    await expect(admitMediaRuntime({ ffprobePath: f.probe, ffmpegPath: f.ffmpeg }, async () => ({ stdout: Buffer.from('bad'), stderr: Buffer.alloc(0) }))).rejects.toThrow(/version/);
    const config = await admitMediaRuntime({ ffprobePath: f.probe, ffmpegPath: f.ffmpeg }, f.runner);
    await fs.writeFile(f.probe, 'replacement');
    expect(await mediaRuntimeDiagnostics(config)).toMatchObject({status:'IDENTITY_CHANGED',ffprobe:{status:'IDENTITY_CHANGED'},ffmpeg:{status:'CONFIGURED'}});
    await expect(new MediaRuntime(config, f.runner).probe({ jobId: 'job', assetId: 'a', artifact: await inspectArtifact(f.source, access) }, access)).rejects.toThrow(/identity/i);
  } finally { await f.cleanup(); }
});
it('normalizes exact rational rates, separate streams and unavailable semantic channels', async () => {
  const f = await setup(); try {
    const config = await admitMediaRuntime({ ffprobePath: f.probe, ffmpegPath: f.ffmpeg }, f.runner);
    const artifact = await inspectArtifact(f.source, access), result = await new MediaRuntime(config, f.runner).probe({ jobId: 'job', assetId: 'a', artifact }, access);
    expect(result.technical.streams[0]!.avgFrameRate).toEqual({ numerator: 24000, denominator: 1001 });
    expect(result.technical.streams[1]!.sampleRate).toBe(48000);
    expect(result.technical.producer.executableHash).toBe(config.ffprobe.sha256);
    expect(result.technical.rawSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.semantic).toEqual({ scenes: 'UNAVAILABLE', beats: 'UNAVAILABLE', sections: 'UNAVAILABLE', energy: 'UNAVAILABLE' });
  } finally { await f.cleanup(); }
});
it('rejects malformed/inconsistent probe output and preserves absent facts', async () => {
  const f = await setup(); try {
    const config = await admitMediaRuntime({ ffprobePath: f.probe, ffmpegPath: f.ffmpeg }, f.runner);
    const request = { jobId: 'job', assetId: 'a', artifact: await inspectArtifact(f.source, access) };
    expect(normalizeProbe({ streams: [{ index: 0, codec_type: 'audio' }] }, request, config.ffprobe).streams[0]).toMatchObject({ kind: 'audio' });
    expect(normalizeProbe({ streams: [{ index: 0, codec_type: 'video', avg_frame_rate: '0/0' }] }, request, config.ffprobe).streams[0]!.avgFrameRate).toBeUndefined();
    expect(() => normalizeProbe({ streams: [{ index: 0, codec_type: 'video', avg_frame_rate: '24/not-a-number' }] }, request, config.ffprobe)).toThrow();
    expect(() => normalizeProbe({ streams: [{ index: 0, codec_type: 'video' }, { index: 0, codec_type: 'audio' }] }, request, config.ffprobe)).toThrow(/duplicate/i);
  } finally { await f.cleanup(); }
});
it('refuses an asset identity mismatch before invoking a producer', async () => {
  const f = await setup(); try {
    const config = await admitMediaRuntime({ ffprobePath: f.probe, ffmpegPath: f.ffmpeg }, f.runner);
    const runtime = new MediaRuntime(config, f.runner), artifact = await inspectArtifact(f.source, access), count = f.calls.length;
    await expect(runtime.probe({ jobId: 'job', assetId: 'a', artifact: { ...artifact, sha256: '0'.repeat(64) } }, access)).rejects.toThrow(/source|identity/i);
    expect(f.calls).toHaveLength(count);
  } finally { await f.cleanup(); }
});
it('records decoded PTS separately from the request and bounds/decodes the PNG', async () => {
  const f = await setup(); try {
    const config = await admitMediaRuntime({ ffprobePath: f.probe, ffmpegPath: f.ffmpeg }, f.runner);
    const runtime = new MediaRuntime(config, f.runner), request = { jobId: 'job', assetId: 'a', artifact: await inspectArtifact(f.source, access) };
    const technical = (await runtime.probe(request, access)).technical;
    const frame = await runtime.frame(request, technical, { frameIndex: 12, streamIndex: 0 }, access);
    expect(frame.requested.frameIndex).toBe(12); expect(frame.actual!.timestamp).toEqual({ numerator: 12012, denominator: 24000 });
    expect(frame.image.sha256).toMatch(/^[a-f0-9]{64}$/); expect(frame.sourceHash).toBe(request.artifact.sha256);
    expect(frame.producer.executableHash).toBe(config.ffmpeg.sha256); expect(frame.image.width).toBe(16);
    const args = f.calls.at(-1)!.args; expect(args).toContain('pipe:0'); expect(args).not.toContain(request.artifact.path);
    await expect(runtime.frame(request, technical, { frameIndex: 10000, streamIndex: 0 }, access)).rejects.toThrow(/range|bound/i);
  } finally { await f.cleanup(); }
});
it('does not invent actual position when decode diagnostics cannot prove it', async () => {
  const f = await setup(); try {
    const config = await admitMediaRuntime({ ffprobePath: f.probe, ffmpegPath: f.ffmpeg }, f.runner);
    const request = { jobId: 'job', assetId: 'a', artifact: await inspectArtifact(f.source, access) };
    const technical = (await new MediaRuntime(config, f.runner).probe(request, access)).technical;
    const frame = await new MediaRuntime(config, async () => ({ stdout: f.png, stderr: Buffer.alloc(0) })).frame(request, technical, { frameIndex: 0, streamIndex: 0 }, access);
    expect(frame.actual).toBeUndefined(); expect(frame.position).toBe('UNVERIFIED');
  } finally { await f.cleanup(); }
});
it('uses non-shell processes with bounded timeout, diagnostics, output and exit checks', async () => {
  const base = { executable: process.execPath, cwd: process.cwd(), timeoutMs: 1000, maxStdout: 128, maxStderr: 128 };
  await expect(runMediaProcess({ ...base, args: ['-e', 'setTimeout(()=>{},5000)'], timeoutMs: 50 })).rejects.toThrow(/timeout/i);
  await expect(runMediaProcess({ ...base, args: ['-e', 'process.stdout.write("x".repeat(1000))'] })).rejects.toThrow(/bound/i);
  await expect(runMediaProcess({ ...base, args: ['-e', 'process.stderr.write("x".repeat(1000))'] })).rejects.toThrow(/bound/i);
  await expect(runMediaProcess({ ...base, args: ['-e', 'process.exit(2)'] })).rejects.toThrow(/exit/i);
  expect((await runMediaProcess({ ...base, args: ['-e', 'process.stdout.write(process.argv[1])', '$(echo unsafe);literal'] })).stdout.toString()).toBe('$(echo unsafe);literal');
});

it('establishes frame index only by independently enumerated decoded PTS and refuses duplicate positions',async()=>{
 const f=await setup();try{
  const admission=await admitMediaRuntime({ffprobePath:f.probe,ffmpegPath:f.ffmpeg},f.runner);
  const source={jobId:'job',assetId:'a',artifact:await inspectArtifact(f.source,access)};
  const runtime=new MediaRuntime(admission,f.runner),technical=(await runtime.probe(source,access)).technical;
  const sample=await runtime.positionedFrame(source,technical,{frameIndex:12,streamIndex:0},access);
  expect(sample.verifiedFrameIndex).toBe(12);expect(sample.positionProof!.rawSha256).toMatch(/^[a-f0-9]{64}$/);
  const duplicate=new MediaRuntime(admission,async(exe,args)=>args.includes('-show_frames')?
    {stdout:Buffer.from(JSON.stringify({frames:Array.from({length:48},()=>({stream_index:0,pts:12012}))})),stderr:Buffer.alloc(0)}:f.runner(exe,args));
  expect((await duplicate.positionedFrame(source,technical,{frameIndex:12,streamIndex:0},access)).verifiedFrameIndex).toBeUndefined();
 }finally{await f.cleanup();}
});
