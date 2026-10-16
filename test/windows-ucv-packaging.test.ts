import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
// Exercise electron-builder's actual macro expansion, filters and copy operation.
// @ts-ignore Build dependency, deliberately used only by tests.
import { getFileMatchers, copyFiles } from 'app-builder-lib/out/fileMatcher.js';

const config: any = load(readFileSync('electron-builder.yml', 'utf8'));
const dll = 'cos-windows-ucv.dll';

describe('canonical Windows UCV resource contract', () => {
  for (const arch of ['x64', 'arm64']) {
    it(`stages exactly the production ${arch} DLL outside ASAR using effective builder rules`, async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'cos-ucv-mapping-'));
      try {
        const source = path.join(root, 'out/native/windows-ucv', arch);
        mkdirSync(source, { recursive: true });
        for (const name of [dll, 'ucv.obj', 'ucv.pdb', 'compile.cmd', 'fixture.exe', 'cos-windows-ucv.lib'])
          writeFileSync(path.join(source, name), name);
        const resources = path.join(root, 'candidate/resources');
        const matchers = getFileMatchers(config, 'extraResources', resources, {
          defaultSrc: root, globalOutDir: path.join(root, 'release'), customBuildOptions: config.win,
          macroExpander: (value: string) => value.replaceAll('${arch}', arch),
        }) ?? [];
        const ucv = matchers.filter((matcher: any) => matcher.from === source);
        expect(ucv, 'canonical mapping must populate the exact production loader directory').toHaveLength(1);
        await copyFiles(ucv);
        const destination = path.join(resources, 'windows-ucv', arch);
        expect(readdirSync(destination)).toEqual([dll]);
        expect(readFileSync(path.join(destination, dll), 'utf8')).toBe(dll);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  it('excludes native build outputs from the application archive', () => {
    const root = path.resolve('.');
    const matchers = getFileMatchers(config, 'files', path.join(root, 'candidate'), {
      defaultSrc: root, globalOutDir: path.join(root, 'release'), customBuildOptions: config.win,
      macroExpander: (value: string) => value.replaceAll('${arch}', 'x64'),
    }) ?? [];
    const application = matchers.find((matcher: any) => matcher.from === root);
    if (!application) throw new Error('Application file matcher absent');
    const filter = application.createFilter();
    const fileStat = statSync('package.json');
    expect(filter(path.join(root, 'out/main/index.js'), fileStat)).toBe(true);
    for (const name of [dll, 'compile.cmd', 'ucv.obj', 'fixture.exe'])
      expect(filter(path.join(root, 'out/native/windows-ucv/x64', name), fileStat)).toBe(false);
  });
});
