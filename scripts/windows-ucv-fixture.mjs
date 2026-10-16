import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import electron from 'electron';
import { build } from 'esbuild';
import { parse } from '@babel/parser';

function inspectFixtureImports(source, filename) {
  const file = parse(source, { sourceType: 'module', sourceFilename: filename, plugins: ['typescript'], createImportExpressions: true });
  const imports = [];
  const stringValue = node => {
    if (!node || node.type !== 'StringLiteral') throw new Error('Indirect window fixture import');
    imports.push(node.value);
  };
  const visit = node => {
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source)
      stringValue(node.source);
    if (node.type === 'TSImportType') stringValue(node.argument);
    if (node.type === 'TSImportEqualsDeclaration') throw new Error('Indirect window fixture import');
    if (node.type === 'ImportExpression') stringValue(node.source);
    if (node.type === 'CallExpression') {
      if (node.callee.type === 'Identifier' && node.callee.name === 'require') stringValue(node.arguments[0]);
      if (node.callee.type === 'Identifier' && ['eval', 'Function', 'createRequire'].includes(node.callee.name))
        throw new Error('Indirect window fixture loader');
    }
    if (node.type === 'NewExpression' && node.callee.type === 'Identifier' && node.callee.name === 'Function')
      throw new Error('Indirect window fixture loader');
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) { for (const child of value) if (child?.type) visit(child); }
      else if (value && typeof value === 'object' && value.type) visit(value);
    }
  };
  visit(file);
  return [...new Set(imports)];
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const fixtureEntry = 'src/diagnostics/windows-ucv-fixture/entry.ts';

export async function buildWindowFixture({ root = repository, outfile } = {}) {
  const entry = path.join(root, fixtureEntry);
  const imports = inspectFixtureImports(await fs.readFile(entry, 'utf8'), entry);
  const allowed = new Set(['electron', 'node:path']);
  if (imports.some(spec => !allowed.has(spec))) throw new Error('Prohibited window fixture import');
  const bundle = await build({ absWorkingDir: root, entryPoints: [entry], outfile, write: Boolean(outfile), bundle: true,
    platform: 'node', format: 'cjs', metafile: true, logLevel: 'silent', plugins: [{
      name: 'window-only-fixture', setup(b) {
        b.onResolve({ filter: /.*/ }, args => {
          if (args.kind === 'entry-point' && path.resolve(args.path) === entry) return { path: entry };
          if (allowed.has(args.path)) return { path: args.path, external: true };
          throw new Error('Prohibited window fixture import');
        });
      },
    }] });
  return { inputs: Object.keys(bundle.metafile.inputs), imports, metafile: bundle.metafile };
}

export async function runWindowFixture({ cwd = repository } = {}) {
  // Protected-byte checks belong to the plain-Node caller. Electron's fs treats .asar
  // as a virtual directory; it must never hash/load installed production payload here.
  if (process.versions.electron || process.platform !== 'win32') throw new Error('Plain Node on Windows required');
  const parent = path.join(repository, 'outputs/windows11-ucv-preflight-repair');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'dry-'));
  for (const key of ['userData', 'sessionData', 'crashDumps', 'logs']) await fs.mkdir(path.join(directory, key));
  const outfile = path.join(directory, 'fixture.cjs');
  const graph = await buildWindowFixture({ outfile });
  await fs.writeFile(path.join(directory, 'module-graph.json'), JSON.stringify(graph, null, 2));
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_ENABLE_LOGGING']) delete env[key];
  const child = spawn(electron, [outfile, '--dry-run', directory],
    { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', overflow = false;
  for (const [stream, append] of [[child.stdout, value => { stdout += value; }],
    [child.stderr, value => { stderr += value; }]]) {
    let size = 0;
    stream.on('data', bytes => { size += bytes.length; if (size <= 65536) append(bytes.toString('utf8')); else overflow = true; });
  }
  // Finite process custody, no automatic retry. Only this child's process tree is retired on timeout.
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true;
    const cleanup = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    cleanup.on('error', () => child.kill());
  }, 30000);
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); resolve(code); });
  });
  await fs.writeFile(path.join(directory, 'stdout.log'), stdout);
  await fs.writeFile(path.join(directory, 'stderr.log'), stderr);
  let result = null;
  try { result = JSON.parse(stdout.trim()); } catch { /* Preserve exact process evidence below. */ }
  const evidence = { result, exitCode, processExited: true, timedOut, overflow, executable: electron,
    entry: outfile, cwd, evidenceDirectory: directory };
  await fs.writeFile(path.join(directory, 'process.json'), JSON.stringify(evidence, null, 2));
  if (exitCode !== 0 || timedOut || overflow || result?.failureError || !result?.windowDestroyed ||
      !result?.hwndDerivedFromFixtureWindow || result?.liveVerificationRuns !== 0)
    throw new Error(`Window fixture failed; evidence: ${directory}`);
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--dry-run') {
    console.error('Usage: node scripts/windows-ucv-fixture.mjs --dry-run'); process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(await runWindowFixture(), null, 2)); }
    catch (error) { console.error(error); process.exitCode = 2; }
  }
}
