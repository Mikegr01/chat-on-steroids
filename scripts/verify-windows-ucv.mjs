import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// verify:ci is shared by PR acceptance and publication on every supported OS.
// Only Windows compiles/loads this native boundary. --load-only audits the staged
// artifact without repairing a missing or broken DLL before its failure is observed.
if (process.argv.slice(2).some(arg => arg !== '--load-only')) throw new Error('Unknown Windows native verification argument');
if (process.platform !== 'win32') {
  console.log('Windows UCV native gate: not applicable on this host');
} else {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const run = args => {
    const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  };
  if (!process.argv.includes('--load-only')) run(['scripts/build-windows-ucv.mjs', process.arch]);
  run(['node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=1', 'test/video-windows-ucv-native.test.ts']);
}
