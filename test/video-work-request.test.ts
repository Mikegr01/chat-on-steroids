import { expect, it } from 'vitest';
import { workRequestSchema } from '../src/shared/video-editing.js';
import { requestFingerprint } from '../src/main/video-editing/workflow-planning.js';
import { workRequest } from './fixtures/video-workflow.js';

it('admits structured work and computes a deterministic fingerprint independent of key order', () => {
  const request = workRequest();
  expect(workRequestSchema.parse(request)).toEqual(request);
  expect(requestFingerprint(request)).toEqual(requestFingerprint({ ...request, objective: request.objective }));
  expect(requestFingerprint({ ...request, target: { ...request.target, durationFrames: 241 } })).not.toBe(requestFingerprint(request));
});
it('rejects invalid format, limits and unknown executable fields', () => {
  const request = workRequest();
  expect(() => workRequestSchema.parse({ ...request, target: { ...request.target, width: 0 } })).toThrow();
  expect(() => workRequestSchema.parse({ ...request, maxRevisions: 11 })).toThrow();
  expect(() => workRequestSchema.parse({ ...request, execute: true })).toThrow();
});
it('rejects duplicate asset identity and contradictory required/forbidden content', () => {
  const request = workRequest();
  expect(() => workRequestSchema.parse({ ...request, assets: [...request.assets, request.assets[0]] })).toThrow();
  expect(() => workRequestSchema.parse({ ...request, content: { requiredAssetIds: ['source-a'], forbiddenAssetIds: ['source-a'] } })).toThrow();
  expect(() => workRequestSchema.parse({ ...request, content: { requiredAssetIds: ['missing'], forbiddenAssetIds: [] } })).toThrow();
});
it('keeps development authorization distinct from production mutation permission', () => {
  expect(workRequestSchema.parse(workRequest()).mode).toBe('prepare-only');
  expect(() => workRequestSchema.parse({ ...workRequest(), mode: 'autonomous' })).toThrow();
});
it('rejects unsupported audio references and reference inventories beyond domain bounds at request admission', () => {
  const request = workRequest(); request.assets[3]!.kind = 'audio';
  expect(() => workRequestSchema.parse(request)).toThrow();
  request.assets[3]!.kind = 'image';
  request.assets.push(...Array.from({ length: 20 }, (_, index) => ({ ...request.assets[3]!, id: `ref-${index}` })));
  expect(() => workRequestSchema.parse(request)).toThrow();
});
