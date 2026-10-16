import { expect, it, vi } from 'vitest';
import { buildSync } from 'esbuild';
import { readFileSync } from 'node:fs';

const boundary = vi.hoisted(() => ({ api: undefined as any, invoke: vi.fn(async () => ({ ok: true })) }));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => { if (name === 'api') boundary.api = api; } },
  ipcRenderer: { invoke: boundary.invoke }, webUtils: {},
}));

it('the shipped fixed preload action accepts no job/context/HWND/proof and invokes only the validation channel', async () => {
  await import('../src/preload/index.js');
  await boundary.api.validateWindowsVerification({ jobId: 's75-absent-scope-live-acceptance-20261010', hwnd: 123, proof: {} });
  expect(boundary.invoke).toHaveBeenCalledExactlyOnceWith('video:validate-ucv', undefined);
});
it('production bootstrap compilation contains the real native verifier wiring and validation terminal, without diagnostic entrypoints', () => {
  const built = buildSync({ entryPoints: ['src/main/index.ts'], bundle: true, platform: 'node', format: 'esm',
    packages: 'external', write: false, metafile: true });
  const inputs = Object.keys(built.metafile!.inputs), code = built.outputFiles[0]!.text;
  for (const file of ['src/main/video-editing/ucv-validation.ts', 'src/main/video-editing/capability-operator-proof.ts',
    'src/main/video-editing/operator-verification.ts', 'src/main/video-editing/windows-ucv-bridge.ts']) expect(inputs).toContain(file);
  expect(inputs.some(p => p.startsWith('src/diagnostics/'))).toBe(false);
  expect(code).toContain('authenticateCapability: authenticateWindowsOperator');
  expect(code).toContain('"video:validate-ucv"');
  expect(code).toContain('CosUcvVerify');
  expect(code).toContain('function createCapabilityOperatorProofStore');
  expect(readFileSync('src/renderer/index.html', 'utf8')).toContain('id="ucvValidationRun"');
  expect(readFileSync('src/renderer/main.ts', 'utf8')).toContain('initUcvValidationControls(api)');
});
