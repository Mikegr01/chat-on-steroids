import { expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createPackage } from '@electron/asar';
// @ts-expect-error Standalone fixture tooling is outside the application bundle.
import { buildWindowFixture, fixtureEntry } from '../scripts/windows-ucv-fixture.mjs';
import { makeTempDir, removeTempDir } from './helpers.js';

it('FIXTURE_NO_PRODUCTION_STATE_OR_RECEIPT_IPC_OR_S7_OR_RESOLVE_OR_UCV_DEPENDENCY', async () => {
  const graph = await buildWindowFixture();
  expect(graph.inputs).toEqual([fixtureEntry]); expect(graph.imports).toEqual(['electron', 'node:path']);
  const source = await fs.readFile(fixtureEntry, 'utf8');
  for (const prohibited of ['ipcMain', 'preload:', 'koffi', 'RequestVerification', 'CosUcv', 'readFile', 'require('])
    expect(source).not.toContain(prohibited);
});
it.each(['static', 'dynamic', 'type'] as const)('FIXTURE_GRAPH_REJECTS_%s_PRODUCTION_IMPORT', async kind => {
  const root = await makeTempDir('cos-window-graph-');
  try {
    const filename = path.join(root, fixtureEntry); await fs.mkdir(path.dirname(filename), { recursive: true });
    const spec = '../../main/video-editing/store.js';
    const addition = kind === 'static' ? `import '${spec}';` : kind === 'dynamic' ? `void import('${spec}');` :
      `type Prohibited = typeof import('${spec}');`;
    await fs.writeFile(filename, `${await fs.readFile(fixtureEntry, 'utf8')}\n${addition}\n`);
    await expect(buildWindowFixture({ root })).rejects.toThrow('Prohibited window fixture import');
  } finally { await removeTempDir(root); }
});

const windowsOnly = process.platform === 'win32' ? it : it.skip;
windowsOnly('EXACT_ASAR_PREFLIGHT_REGRESSION: Electron fs fails; raw bytes and plain Node agree', async () => {
  const root = await makeTempDir('cos-asar-boundary-');
  try {
    const contents = path.join(root, 'input'); await fs.mkdir(contents);
    await fs.writeFile(path.join(contents, 'fixture.txt'), 'isolated ASAR boundary regression');
    const archive = path.join(root, 'fixture.asar'); await createPackage(contents, archive);
    const expected = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
    const entry = path.join(root, 'entry.cjs');
    await fs.writeFile(entry, `const {app}=require('electron'); const path=require('node:path');
for(const key of ['userData','sessionData','crashDumps','logs'])app.setPath(key,path.join(__dirname,key));
app.whenReady().then(()=>{let failure;try{require('node:fs').readFileSync(${JSON.stringify(archive)});}catch(error){failure={code:error.code,stack:error.stack};}
const sha=require('node:crypto').createHash('sha256').update(require('original-fs').readFileSync(${JSON.stringify(archive)})).digest('hex');
process.stdout.write(JSON.stringify({failure,sha,liveVerificationRuns:0}),()=>app.exit(0));});`);
    for (const name of ['userData', 'sessionData', 'crashDumps', 'logs']) await fs.mkdir(path.join(root, name));
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    const require = createRequire(import.meta.url);
    const { stdout } = await promisify(execFile)(require('electron'), [entry], { env, windowsHide: true, timeout: 20000 });
    expect(JSON.parse(stdout)).toMatchObject({ failure: { code: 'ENOENT', stack: expect.stringContaining('readFileFromArchiveSync') },
      sha: expected, liveVerificationRuns: 0 });
  } finally { await removeTempDir(root); }
}, 30000);

windowsOnly('FIXTURE_DRY_RUN_STOPS_BEFORE_VERIFICATION / ISOLATED_USERDATA / REAL_CLEAN_EXIT / INDEPENDENT_CWD', async () => {
  const cwd = await makeTempDir('cos-window-launch-cwd-');
  try {
    const { stdout } = await promisify(execFile)(process.execPath,
      [path.resolve('scripts/windows-ucv-fixture.mjs'), '--dry-run'], { cwd, windowsHide: true, timeout: 40000 });
    const evidence = JSON.parse(stdout);
    expect(evidence).toMatchObject({ exitCode: 0, processExited: true, timedOut: false, overflow: false,
      result: { appReady: true, windowConstructionAttempted: true, windowCreated: true,
        browserWindowValid: true, nativeHandleBufferValid: true, hwndDerivedFromFixtureWindow: true,
        windowsCreated: 1, windowDestroyed: true, webContentsDestroyed: true, userDataIsolated: true,
        productionStateLoaded: false, nativeModuleLoaded: false, liveVerificationRuns: 0,
        failureStage: 'STOPPED_BEFORE_VERIFICATION', failureError: null } });
    expect(evidence.result.cwd).toBe(path.resolve('.')); // Launcher elects the repository explicitly from its own path.
    const graph = JSON.parse(await fs.readFile(path.join(evidence.evidenceDirectory, 'module-graph.json'), 'utf8'));
    expect(graph.inputs).toEqual([fixtureEntry]);
    for (const prohibited of ['config.json', 'state/video-editing-jobs.json', 'state/kosmosyn-s7-authority.json', 'sessions'])
      await expect(fs.stat(path.join(evidence.evidenceDirectory, 'userData', prohibited))).rejects.toThrow();
    expect(await fs.readFile(path.join(evidence.evidenceDirectory, 'stderr.log'), 'utf8')).toBe('');
  } finally { await removeTempDir(cwd); }
}, 45000);
