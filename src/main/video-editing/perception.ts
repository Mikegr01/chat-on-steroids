import { z } from 'zod';
import { videoIdSchema, perceptionObservationSchema } from '../../shared/video-editing.js';
import { validateDocument, evidenceFor } from './validation.js';
import { canonicalJson } from './identity.js';

export const perceptionResultSchema = z.object({ version: z.literal(1), subject: z.enum(['reference', 'media']), subjectId: videoIdSchema,
  status: z.enum(['partial', 'complete', 'unavailable']),
  producer: z.object({ name: videoIdSchema, version: videoIdSchema }).strict(),
  observations: z.array(perceptionObservationSchema).max(500) }).strict();
export type PerceptionResult = z.infer<typeof perceptionResultSchema>;
/** Future real vision/audio providers implement this port. No default or synthetic perception engine. */
export interface PerceptionProducer {
  analyze(request: { subject: 'reference' | 'media'; subjectId: string; evidenceIds: string[];
    channels: Array<PerceptionResult['observations'][number]['channel']> }): Promise<unknown>;
}
export function admitPerception(document: unknown, raw: unknown): PerceptionResult {
  const job = validateDocument(document);
  if (Buffer.byteLength(canonicalJson(raw)) > 1024 * 1024) throw new Error('Perception byte bound');
  const result = perceptionResultSchema.parse(raw);
  if (result.status === 'unavailable' && result.observations.length) throw new Error('Unavailable perception carries observations');
  const asset = result.subject === 'media' ? job.media.find(row => row.id === result.subjectId) : undefined;
  if (result.subject === 'media' ? !asset : !job.references.some(row => row.referenceId === result.subjectId))
    throw new Error('Unknown perception subject');
  for (const row of result.observations) {
    evidenceFor(job, row.evidenceIds, result.subject, result.subjectId);
    if (asset && (!asset.durationFrames || row.source.end > asset.durationFrames)) throw new Error('Perception source range unavailable');
  }
  return result;
}
