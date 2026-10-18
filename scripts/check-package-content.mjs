// Audit the real ASAR without extracting it or running an installer. Keep these reviewed
// test directories separate from source exports, locale resources, types and legal files.
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
export const reviewedPackageRoots = [
  'node_modules/zod',
  'node_modules/@anthropic-ai/mcpb/node_modules/zod',
  'node_modules/katex'
];

export function isReviewedDevelopmentFile(file) {
  return /^(?:node_modules\/zod|node_modules\/@anthropic-ai\/mcpb\/node_modules\/zod)\/src\/(?:v3|v4\/(?:classic|core|mini))\/tests\//.test(file);
}

export function auditPackageContent(archive) {
  const nativePath = file => file.replaceAll('/', path.sep);
  const files = asar.listPackage(archive)
    .map(file => file.replaceAll('\\', '/').replace(/^\//, ''))
    .filter(file => !asar.statFile(archive, nativePath(file), false).files);
  const present = new Set(files);
  const extract = file => asar.extractFile(archive, nativePath(file));
  const required = [];
  for (const root of reviewedPackageRoots) {
    required.push(`${root}/package.json`, `${root}/LICENSE`);
    if (!present.has(`${root}/package.json`)) continue;
    const manifest = JSON.parse(extract(`${root}/package.json`));
    // Preserve every concrete runtime/source export, including @zod/source. Types follow
    // builder's existing defaults. Wildcard resources are checked separately below.
    function exportsToFiles(value, condition) {
      if (typeof value === 'string') {
        if (condition !== 'types' && !value.includes('*')) required.push(`${root}/${value.replace(/^\.\//, '')}`);
      } else if (value && typeof value === 'object') {
        for (const [key, target] of Object.entries(value)) exportsToFiles(target, key);
      }
    }
    exportsToFiles(manifest.exports);
  }
  for (const root of reviewedPackageRoots.slice(0, 2)) {
    required.push(`${root}/v4/locales/en.cjs`, `${root}/src/v4/locales/en.ts`);
  }
  required.push('node_modules/katex/dist/katex.min.css', 'node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2');
  // KaTeX's catch-all export exposes these tests. The release policy preserves exported
  // files even when the application's runtime does not use them.
  required.push('node_modules/katex/contrib/auto-render/test/auto-render-spec.ts',
    'node_modules/katex/contrib/render-a11y-string/test/render-a11y-string-spec.ts');
  const unwanted = files.filter(isReviewedDevelopmentFile);
  const missing = [...new Set(required)].filter(file => !present.has(file));
  if (unwanted.length || missing.length) {
    throw new Error(`Package content failed: ${unwanted.length} reviewed development files; missing runtime/legal files: ${missing.join(', ')}\n${unwanted.join('\n')}`);
  }
  return { developmentFiles: 0, requiredFiles: [...new Set(required)].length, totalFiles: files.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/check-package-content.mjs <app.asar>');
  console.log(JSON.stringify(auditPackageContent(path.resolve(process.argv[2]))));
}
