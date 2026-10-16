import { createHash } from 'node:crypto';
import { executionCheckpointSchema, type VideoEditingDocument, type ExecutionCheckpoint } from '../../shared/video-editing.js';

/** Canonical JSON for validated artifacts. Array order remains authored edit order. */
export function canonicalJson(value: unknown): string {
  const visiting = new Set<object>();
  const encode = (item: unknown): string => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (!item || typeof item !== 'object') throw new Error('Non-JSON artifact');
    if (visiting.has(item)) throw new Error('Cyclic artifact');
    visiting.add(item);
    const result = Array.isArray(item) ? `[${item.map(encode).join(',')}]` :
      `{${Object.entries(item).filter(([, value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, value]) => `${JSON.stringify(key)}:${encode(value)}`).join(',')}}`;
    visiting.delete(item);
    return result;
  };
  return encode(value);
}

export function checkpointIntent(job: VideoEditingDocument, planId: string, timelineId: string,
  step: ExecutionCheckpoint['step'], beforeEvidenceIds: string[], operationId: string): ExecutionCheckpoint {
  const plan = job.candidates.find(row => row.plan.id === planId)?.plan;
  if (!plan) throw new Error('Unknown checkpoint plan');
  const before = beforeEvidenceIds.map(id => {
    const evidence = job.evidence.find(row => row.id === id);
    if (!evidence || evidence.subject !== 'timeline' || evidence.subjectId !== timelineId)
      throw new Error('Checkpoint before evidence mismatch');
    return evidence;
  });
  const intent = { jobId: job.id, sessionId: job.sessionId, localProjectId: job.localProjectId,
    resolveProjectId: job.resolveProjectId, timelineId, step, plan, before,
    media: job.media.filter(row => plan.clips.some(clip => clip.mediaId === row.id)).sort((a, b) => a.id < b.id ? -1 : 1),
    references: job.references.filter(row => plan.referenceProfileIds.includes(row.id)).sort((a, b) => a.id < b.id ? -1 : 1) };
  return executionCheckpointSchema.parse({ operationId, planId, resolveProjectId: job.resolveProjectId, timelineId, step,
    intentHash: createHash('sha256').update(canonicalJson(intent)).digest('hex'), beforeEvidenceIds,
    afterEvidenceIds: [], state: 'claimed' });
}
