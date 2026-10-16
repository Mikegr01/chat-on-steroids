import { expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';
import { makeTempDir, removeTempDir } from './helpers.js';
import { readWindowsBuild } from '../src/main/video-editing/windows-build.js';

// Safe native smoke only: no nonzero HWND is ever passed to the verification export.
// Windows verification must build this artifact first. Missing/unloadable DLLs fail;
// only non-Windows hosts skip the native boundary.
const dll = path.resolve('out/native/windows-ucv', process.arch, 'cos-windows-ucv.dll');
const native = it.runIf(process.platform === 'win32');
const availableStates = ['Available', 'DeviceNotPresent', 'NotConfiguredForUser', 'DisabledByPolicy', 'DeviceBusy'];
native('SDK_BRIDGE_LOADS_AND_SAFE_AVAILABILITY_ONLY_IN_NODE', async () => {
  const build = await readWindowsBuild();
  expect(Number.isSafeInteger(build)).toBe(true); expect(build).toBeGreaterThan(0);
  const k = await import('koffi'), lib = k.load(dll);
  const availability = lib.func('const char * __cdecl CosUcvAvailability()');
  const result = await new Promise((resolve, reject) => availability.async((e: Error | null, value: string) => e ? reject(e) : resolve(value)));
  expect(build! < 22000 ? ['UnsupportedBuild'] : availableStates).toContain(result);
  const verify = lib.func('const char * __cdecl CosUcvVerify(uint64_t hwnd, const char16_t *message)');
  expect(verify(0n, 'Synthetic invalid handle; cannot request verification')).toBe(build! < 22000 ? 'UnsupportedBuild' : 'InvalidWindow');
});
async function electronSmoke(artifact: 'real' | 'missing' | 'wrong-abi' | 'unloadable') {
  const dir = await makeTempDir('cos-ucv-safe-electron-');
  try {
    const require = createRequire(import.meta.url);
    const koffi = import.meta.resolve('koffi');
    const bridge = buildSync({ entryPoints: ['src/main/video-editing/windows-ucv-bridge.ts'], bundle: true,
      platform: 'node', format: 'cjs', write: false, alias: { koffi }, external: ['electron', koffi] }).outputFiles[0]!.text;
    await fs.writeFile(path.join(dir, 'bridge.cjs'), bridge);
    const staged = path.join(dir, 'out/native/windows-ucv', process.arch, 'cos-windows-ucv.dll');
    await fs.mkdir(path.dirname(staged), { recursive: true });
    if (artifact === 'real') await fs.copyFile(dll, staged);
    if (artifact === 'wrong-abi') await fs.copyFile(path.join(process.env.SystemRoot!, 'System32/kernel32.dll'), staged);
    if (artifact === 'unloadable') await fs.writeFile(staged, 'invalid native artifact');
    await fs.writeFile(path.join(dir, 'main.cjs'), `const {app}=require('electron');
app.setAppPath(__dirname);
for(const key of ['userData','sessionData','crashDumps','logs']) app.setPath(key,require('node:path').join(__dirname,key));
const report=(value,code)=>{require('node:fs').writeFileSync(require('node:path').join(__dirname,'result.json'),JSON.stringify(value));app.exit(code);};
app.whenReady().then(async()=>{
 try {
  const bridge=await require('./bridge.cjs').loadWindowsUcvBridge();
  const availability=await bridge.availability();
  const invalidWindow=await bridge.verify(0n,'Invalid handle; cannot request verification');
  report({availability,invalidWindow,liveVerificationRuns:0},0);
 } catch(error) { report({error:String(error),liveVerificationRuns:0},2); }
});`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    const exitCode = await promisify(execFile)(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, timeout: 20000 })
      .then(() => 0, (error: { code?: number }) => { if (typeof error.code !== 'number') throw error; return error.code; });
    const result = JSON.parse(await fs.readFile(path.join(dir, 'result.json'), 'utf8'));
    return { ...result, exitCode };
  } finally { await removeTempDir(dir); }
}
native('SDK_BRIDGE_LOADS_IN_REAL_ELECTRON_WITHOUT_VERIFICATION_UI', async () => {
  const result = await electronSmoke('real');
  const build = await readWindowsBuild();
  expect(result, JSON.stringify(result)).toMatchObject({ exitCode: 0, liveVerificationRuns: 0,
    invalidWindow: build! < 22000 ? 'UnsupportedBuild' : 'InvalidWindow' });
  expect(build! < 22000 ? ['UnsupportedBuild'] : availableStates).toContain(result.availability);
});
native.each(['missing', 'wrong-abi', 'unloadable'] as const)('SDK_PRODUCTION_LOADER_FAILS_CLOSED_ON_%s', async artifact => {
  const result = await electronSmoke(artifact);
  expect(result, JSON.stringify(result)).toMatchObject({ exitCode: 2, liveVerificationRuns: 0 });
  expect(result.error).toMatch(artifact === 'wrong-abi' ? /CosUcvAvailability/ : /Failed to load shared library/);
});
it('UCV_BRIDGE_HAS_NO_LEDGER_S7_RESOLVE_OR_SECRET_CAPTURE_DEPENDENCIES', async () => {
  const nativeSource = await fs.readFile('native/windows-ucv/ucv.cpp', 'utf8');
  const bridge = await fs.readFile('src/main/video-editing/windows-ucv-bridge.ts', 'utf8');
  const main = await fs.readFile('src/main/ipc.ts', 'utf8');
  for (const forbidden of ['CredUIPrompt', 'CredUnPack', 'LogonUser', 'WinBio', 'LsaLogonUser', 'KeyCredential', 'WebAuthn']) {
    expect(nativeSource).not.toContain(forbidden); expect(bridge).not.toContain(forbidden);
  }
  const imports = [...bridge.matchAll(/from ['"]([^'"]+)['"]/g)].map(value => value[1]);
  expect(imports).toEqual(['node:path', 'electron']);
  expect(nativeSource.match(/^#include .+$/gm)).toEqual([
    '#include <windows.h>', '#include <winternl.h>', '#include <UserConsentVerifierInterop.h>',
    '#include <winrt/Windows.Foundation.h>', '#include <winrt/Windows.Security.Credentials.UI.h>', '#include <atomic>',
  ]);
  expect(main).toContain("from './video-editing/operator-verification.js'");
  expect(main).not.toContain('operator-credentials');
  expect(nativeSource).toContain('winrt::guid_of<decltype(operation)>()');
  expect(nativeSource).toContain('winrt::check_hresult(interop->RequestVerificationForWindowAsync');
  expect(nativeSource).not.toContain('RequestVerificationAsync(');
});
