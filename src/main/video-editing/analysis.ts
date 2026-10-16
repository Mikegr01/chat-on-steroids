import { z } from 'zod';
import { videoEvidenceSchema, referenceProfileSchema, mediaAssetSchema } from '../../shared/video-editing.js';
import { validateDocument } from './validation.js';

const analysisBatchSchema = z.object({
  evidence: z.array(videoEvidenceSchema).max(1000),
  references: z.array(referenceProfileSchema).max(20), media: z.array(mediaAssetSchema).max(100),
}).strict();

/** Bounded producer admission; no file I/O, Resolve calls or implicit reanalysis. */
export function ingestAnalysis(document: unknown, rawBatch: unknown) {
  const job = validateDocument(document);
  const batch = analysisBatchSchema.parse(rawBatch);
  return validateDocument({ ...job, evidence: [...job.evidence, ...batch.evidence],
    references: [...job.references, ...batch.references], media: [...job.media, ...batch.media] });
}
