import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
// @ts-ignore Packaging helpers are plain Node ESM.
import { auditPackageContent, isReviewedDevelopmentFile, reviewedPackageRoots } from '../scripts/check-package-content.mjs';

const require = createRequire(import.meta.url);
const { getNodeModuleFileMatcher } = require('app-builder-lib/out/fileMatcher');
const asar = require('@electron/asar');
const root = path.resolve(import.meta.dirname, '..');
const config = load(readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')) as any;
function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

describe('reviewed package development content', () => {
  it('uses builder selection to exclude only the 340 unexported Zod tests and retain every other package file', () => {
    for (const platform of ['win', 'mac', 'linux']) {
      const matcher = getNodeModuleFileMatcher(root, root, (value: string) => value, config[platform], {
        config, debugLogger: { isEnabled: false }
      });
      const accepts = matcher.createFilter();
      const files = reviewedPackageRoots.flatMap((relative: string) => walk(path.join(root, relative)));
      const rejected = files.filter((file: string) => !accepts(file, statSync(file)))
        .map((file: string) => path.relative(root, file).replaceAll(path.sep, '/')).sort();
      const reviewed = files.map((file: string) => path.relative(root, file).replaceAll(path.sep, '/'))
        .filter(isReviewedDevelopmentFile).sort();
      expect(reviewed).toHaveLength(340);
      expect(rejected).toEqual(reviewed);
      // Neighboring names and another dependency's similarly named directory are untouched.
      for (const relative of ['node_modules/other/src/v3/tests/example.ts',
        'node_modules/zod/src/v4/core/tests-runtime.ts', 'node_modules/katex/contrib/auto-render/auto-render.ts',
        'node_modules/katex/contrib/auto-render/test/auto-render-spec.ts',
        'node_modules/katex/contrib/render-a11y-string/test/render-a11y-string-spec.ts']) {
        expect(accepts(path.join(root, relative), { isDirectory: () => false })).toBe(true);
      }
    }
  });

  it('rejects actual ASAR development content and missing required files', async () => {
    const temporary = mkdtempSync(path.join(os.tmpdir(), 'cos-content-'));
    try {
      const source = path.join(temporary, 'source');
      mkdirSync(path.join(source, 'node_modules/zod/src/v3/tests'), { recursive: true });
      writeFileSync(path.join(source, 'node_modules/zod/src/v3/tests/example.test.ts'), 'test fixture');
      const archive = path.join(temporary, 'app.asar');
      await asar.createPackage(source, archive);
      expect(() => auditPackageContent(archive)).toThrow(/1 reviewed development files; missing runtime\/legal files:/);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
