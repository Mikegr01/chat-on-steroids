import { expect, it } from 'vitest';
import { admitPerception } from '../src/main/video-editing/perception.js';
import { videoDocument } from './fixtures/video-editing.js';

const result = { version: 1, subject: 'media', subjectId: 'media-1', status: 'partial',
  producer: { name: 'external-perception', version: '1' },
  observations: [{ channel: 'activity', value: 'camera pans left', confidence: 0.7, evidenceIds: ['media-observation'],
    source: { start: 24, end: 48 }, region: { x: 0, y: 0, width: 1, height: 1 } }] };
it('retains bounded timestamp/region/confidence evidence without creating execution authority', () => {
  const admitted = admitPerception(videoDocument(), result);
  expect(admitted).toEqual(result); expect(admitted).not.toHaveProperty('operations');
});
it('keeps unavailable perception empty and rejects detached evidence and impossible timestamps', () => {
  expect(admitPerception(videoDocument(), { ...result, status: 'unavailable', observations: [] }).observations).toEqual([]);
  expect(() => admitPerception(videoDocument(), { ...result, status: 'unavailable' })).toThrow(/unavailable/i);
  expect(() => admitPerception(videoDocument(), { ...result, observations: [{ ...result.observations[0]!, evidenceIds: ['missing'] }] })).toThrow(/evidence/i);
  expect(() => admitPerception(videoDocument(), { ...result, observations: [{ ...result.observations[0]!, source: { start: 480, end: 500 } }] })).toThrow(/range/i);
});
