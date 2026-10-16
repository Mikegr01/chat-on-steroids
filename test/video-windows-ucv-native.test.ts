import { expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { makeTempDir, removeTempDir } from './helpers.js';
import { readWindowsBuild } from '../src/main/video-editing/windows-build.js';

// Safe native smoke only: no nonzero HWND is ever passed to the verification export.
// The production build compiles the DLL; platforms without this native build skip its smoke.
const dll = path.resolve('out/native/windows-ucv', process.arch, 'cos-windows-ucv.dll');
const native = process.platform === 'win32' && await fs.stat(dll).then(() => true, () => false) ? it : it.skip;
native('SDK_BRIDGE_LOADS_AND_SAFE_AVAILABILITY_ONLY_IN_NODE', async () => {
  const build = await readWindowsBuild();
  expect(Number.isSafeInteger(build)).toBe(true); expect(build).toBeGreaterThan(0);
  const k = await import('koffi'), lib = k.load(dll);
  const availability = lib.func('const char * __cdecl CosUcvAvailability()');
  const result = await new Promise((resolve, reject) => availability.async((e: Error | null, value: string) => e ? reject(e) : resolve(value)));
  expect(['Available', 'DeviceNotPresent', 'NotConfiguredForUser', 'DisabledByPolicy', 'DeviceBusy', 'InteropMissing', 'UnsupportedBuild'])
    .toContain(result);
  const verify = lib.func('const char * __cdecl CosUcvVerify(uint64_t hwnd, const char16_t *message)');
  expect(verify(0n, 'Synthetic invalid handle; cannot request verification')).toBe(build! < 22000 ? 'UnsupportedBuild' : 'InvalidWindow');
});
native('SDK_BRIDGE_LOADS_IN_REAL_ELECTRON_WITHOUT_VERIFICATION_UI', async () => {
  const dir = await makeTempDir('cos-ucv-safe-electron-');
  try {
    const require = createRequire(import.meta.url);
    await fs.writeFile(path.join(dir, 'main.cjs'), `const {app}=require('electron');
app.setPath('userData',require('node:path').join(__dirname,'state'));
app.setPath('sessionData',require('node:path').join(__dirname,'session'));
app.whenReady().then(()=>{
 const k=require(${JSON.stringify(require.resolve('koffi'))}),lib=k.load(${JSON.stringify(dll)});
 const fn=lib.func('const char * __cdecl CosUcvAvailability()');
 fn.async((error,result)=>{
  if(error){app.exit(2);return;}
  require('node:fs').writeFileSync(require('node:path').join(__dirname,'result.json'),JSON.stringify({availability:result,liveVerificationRuns:0}));
  app.exit(0);
 });
});`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    await promisify(execFile)(require('electron'), [path.join(dir, 'main.cjs')], { env, windowsHide: true, timeout: 20000 });
    const result = JSON.parse(await fs.readFile(path.join(dir, 'result.json'), 'utf8'));
    expect(result.liveVerificationRuns).toBe(0);
    expect(['Available', 'DeviceNotPresent', 'NotConfiguredForUser', 'DisabledByPolicy', 'DeviceBusy', 'InteropMissing', 'UnsupportedBuild'])
      .toContain(result.availability);
  } finally { await removeTempDir(dir); }
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
