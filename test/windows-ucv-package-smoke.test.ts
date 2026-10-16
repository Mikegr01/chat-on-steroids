import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildSync } from 'esbuild';
import { createPackage } from '@electron/asar';
import { describe, expect, it } from 'vitest';
// @ts-ignore Plain JavaScript packaging tool.
import { inspectPackagedWindowsUcv, probeWindowsUcv } from '../scripts/windows-ucv-package-smoke.mjs';

// Bundle the real production implementation, without executing it or importing its bootstrap.
const main = buildSync({ entryPoints: ['src/main/video-editing/operator-verification.ts'], bundle: true,
  platform: 'node', format: 'cjs', external: ['electron', 'koffi'], write: false }).outputFiles[0]!.text;
const dll = 'cos-windows-ucv.dll';
const pe = () => { const bytes = Buffer.alloc(256); bytes.write('MZ'); bytes.writeUInt32LE(64, 60);
  bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(0x8664, 68); return bytes; };

async function candidate(change: string, check: (resources: string) => void) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cos-ucv-smoke-'));
  try {
    const resources = path.join(root, 'resources'), source = path.join(root, 'archive');
    mkdirSync(path.join(resources, 'windows-ucv/x64'), { recursive: true });
    mkdirSync(path.join(source, 'out/main'), { recursive: true });
    let compiled = main;
    if (change === 'loader') compiled = compiled.replaceAll('"windows-ucv"', '"wrong-location"');
    if (change === 'bridge') compiled = compiled.replaceAll('CosUcvAvailability', 'MissingExport');
    if (change === 'gate') compiled = compiled.replace(/knownBuild >= (?:22e3|22000)/g, 'knownBuild >= 19045');
    writeFileSync(path.join(source, 'out/main/index.js'), compiled);
    if (change === 'asar') {
      mkdirSync(path.join(source, 'out/native/windows-ucv/x64'), { recursive: true });
      writeFileSync(path.join(source, 'out/native/windows-ucv/x64', dll), pe());
    }
    await createPackage(source, path.join(resources, 'app.asar'));
    if (change !== 'missing') {
      const bytes = pe(); if (change === 'arch') bytes.writeUInt16LE(0xaa64, 68);
      writeFileSync(path.join(resources, 'windows-ucv/x64', dll), bytes);
    }
    if (change === 'duplicate') writeFileSync(path.join(resources, dll), pe());
    if (change === 'compiler') writeFileSync(path.join(resources, 'windows-ucv/x64/ucv.obj'), 'private-output');
    check(resources);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('noninteractive packaged UCV smoke', () => {
  it('accepts the real bundled loader, bridge and build gate at the single external DLL location', async () => {
    await candidate('', resources => expect(inspectPackagedWindowsUcv(resources, 'x64')).toMatchObject({ arch: 'x64', bytes: 256 }));
  });
  it.each([
    ['missing', /ENOENT|Missing/], ['arch', /architecture/], ['loader', /loader target/],
    ['bridge', /bridge\/build detection/], ['gate', /build gate/], ['asar', /inside ASAR/],
    ['duplicate', /Duplicate packaged/], ['compiler', /Unexpected Windows UCV resources/],
  ])('rejects %s before native launch', async (change, message) => {
    await candidate(change as string, resources => expect(() => inspectPackagedWindowsUcv(resources, 'x64')).toThrow(message as RegExp));
  });
  function runtime(failure = '', build = 26300) {
    const calls: string[] = [];
    const koffi = { load(filename: string) {
      calls.push(filename); if (failure === 'load') throw new Error('cannot load');
      return { func(declaration: string) {
        calls.push(declaration);
        if (declaration.includes('CosUcvAvailability')) return { async(callback: Function) {
          callback(null, failure === 'availability' ? 'NativeFailure' : build < 22000 ? 'UnsupportedBuild' : 'Available');
        } };
        return (version: Buffer) => { version.writeUInt32LE(10, 4); version.writeUInt32LE(build, 12); return 0; };
      } };
    } };
    return { koffi, calls };
  }
  it('loads only the candidate DLL and checks availability without binding verification', async () => {
    const { koffi, calls } = runtime();
    await expect(probeWindowsUcv(koffi, '/candidate/resources', 'x64', path.join)).resolves.toMatchObject({
      loaded: true, availability: 'Available', build: 26300, liveVerificationRuns: 0,
    });
    expect(calls[0]).toBe(path.join('/candidate/resources', 'windows-ucv/x64', dll));
    expect(calls.join('\n')).not.toMatch(/CosUcvVerify|RequestVerification/);
  });
  it.each(['load', 'availability'])('fails the runtime gate on %s failure', async failure => {
    const { koffi } = runtime(failure);
    await expect(probeWindowsUcv(koffi, '/candidate/resources', 'x64', path.join)).rejects.toThrow();
  });
  it('preserves Windows 10 application support while reporting unsupported strong verification', async () => {
    const { koffi } = runtime('', 19045);
    await expect(probeWindowsUcv(koffi, '/candidate/resources', 'x64', path.join)).resolves.toMatchObject({ availability: 'UnsupportedBuild' });
  });
  it('requires both inspection and native-load probes in the canonical package smoke', () => {
    const source = readFileSync('scripts/smoke-packaged-runtime.mjs', 'utf8');
    expect(source).toContain('inspectPackagedWindowsUcv(resourcesDir, targetArch)');
    expect(source).toContain('await probeWindowsUcv(koffi, base, process.arch)');
    expect(source).toContain('runtime.ucv?.loaded !== true');
    expect(source).not.toMatch(/CosUcvVerify|RequestVerificationForWindowAsync/);
  });
});
