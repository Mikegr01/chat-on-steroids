import { videoEditingDocumentSchema, editPlanSchema, VIDEO_DOCUMENT_MAX_BYTES,
  type VideoEditingDocument, type VideoEvidence, type FrameRate, type EditPlan, type ExecutionCheckpoint } from '../../shared/video-editing.js';
import { canonicalJson, checkpointIntent } from './identity.js';
import { validateWorkflowShape } from './workflow-state.js';
import { effectiveSourceUsableRanges, validateSourceUsabilityDecision } from './source-usability.js';

export function sameRate(a: FrameRate, b: FrameRate): boolean {
  return a.numerator * b.denominator === b.numerator * a.denominator;
}

export function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
}

export function evidenceFor(job: VideoEditingDocument, ids: readonly string[], subject?: VideoEvidence['subject'], subjectId?: string): VideoEvidence[] {
  unique(ids, 'evidence references');
  return ids.map(id => {
    const record = job.evidence.find(row => row.id === id);
    if (!record) throw new Error(`Unknown evidence: ${id}`);
    if ((subject && record.subject !== subject) || (subjectId && record.subjectId !== subjectId))
      throw new Error(`Evidence subject mismatch: ${id}`);
    return record;
  });
}

export function validateDocument(raw: unknown): VideoEditingDocument {
  const job = videoEditingDocumentSchema.parse(raw);
  validateWorkflowShape(job);
  if (Buffer.byteLength(JSON.stringify(job)) > VIDEO_DOCUMENT_MAX_BYTES) throw new Error('Video document byte limit');
  for (const [label, ids] of [
    ['evidence', job.evidence.map(row => row.id)], ['references', job.references.map(row => row.id)],
    ['media', job.media.map(row => row.id)], ['candidates', job.candidates.map(row => row.id)],
    ['plans', job.candidates.map(row => row.plan.id)], ['operations', job.checkpoints.map(row => row.operationId)],
    ['reviews', job.reviews.map(row => row.id)], ['revisions', job.revisions.map(row => row.id)],
  ] as const) unique(ids, label);
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (row: VideoEvidence): void => {
    if (visiting.has(row.id)) throw new Error('Evidence cycle');
    if (visited.has(row.id)) return;
    visiting.add(row.id);
    unique(row.parents, 'evidence parents');
    if (row.basis !== 'inferred' && row.parents.length) throw new Error('Measured/fixture evidence must be a root');
    if (row.basis === 'inferred' && !row.parents.length) throw new Error('Inferred evidence requires parents');
    for (const id of row.parents) {
      const parent = job.evidence.find(value => value.id === id);
      if (!parent) throw new Error(`Unknown evidence parent: ${id}`);
      visit(parent);
    }
    visiting.delete(row.id); visited.add(row.id);
  };
  for (const row of job.evidence) {
    visit(row);
    if (row.technical && (row.technical.jobId !== job.id || row.technical.assetId !== row.subjectId || row.technical.sourceHash !== row.locator?.sha256 ||
      row.producer.name !== 'ffprobe' || row.producer.version !== row.technical.producer.version || row.acquisition?.rawSha256 !== row.technical.rawSha256))
      throw new Error('Technical evidence provenance mismatch');
    if(row.renderReceiptEvidenceId) {
      const receipt=job.evidence.find(e=>e.id===row.renderReceiptEvidenceId);
      if(row.subject!=='render'||!row.technical||!row.renderState||receipt?.subject!=='render'||receipt.subjectId!==row.subjectId||receipt.locator?.sha256!==row.locator?.sha256 ||
        receipt.producer.name!=='cos-resolve-render-artifact'||receipt.basis!=='measured') throw new Error('Decoded render receipt provenance mismatch');
    }
    if(row.mediaSample?.image && (row.mediaSample.image.sha256!==row.locator?.sha256 || row.mediaSample.image.bytes!==row.locator.bytes)) throw new Error('Sample image provenance mismatch');
    if(row.subject==='frame' && row.mediaSample) {
      if(!job.evidence.some(e=>e.subject==='render' && e.subjectId===row.subjectId && e.locator?.sha256===row.mediaSample!.sourceHash)) throw new Error('Output sample source mismatch');
      if(row.framePosition!==undefined && (!row.mediaSample.positionProof || row.mediaSample.positionProof.classification!=='INDEPENDENT_DECODED_PTS_MATCH' ||
        row.mediaSample.positionProof.sourceHash!==row.mediaSample.sourceHash || row.framePosition!==row.mediaSample.requestedFrame)) throw new Error('Output frame position provenance mismatch');
    }
    if (row.mediaSample && (row.producer.name !== 'ffmpeg' || !row.locator || !['reference','frame'].includes(row.subject) ||
      (row.mediaSample.position === 'OBSERVED_TIMESTAMP') !== !!row.mediaSample.actualTimestamp)) throw new Error('Frame sample provenance mismatch');
  }
  for (const profile of job.references) {
    const records = evidenceFor(job, profile.evidenceIds, 'reference', profile.referenceId);
    if (profile.technicalProbe && !records.some(row=>row.technical && canonicalJson(row.technical)===canonicalJson(profile.technicalProbe))) throw new Error('Reference probe provenance mismatch');
    for(const sampleId of profile.sampleEvidenceIds ?? []) {
      const sample=records.find(row=>row.id===sampleId);
      if(!sample?.mediaSample || sample.mediaSample.sourceHash!==profile.technicalProbe?.sourceHash) throw new Error('Reference sample source mismatch');
    }
    const observations = [profile.pacing, profile.rhythm, profile.transitions, profile.cameraMotion,
      profile.framing, profile.text, profile.musicSync, profile.color];
    if (profile.status === 'unavailable' && (observations.some(Boolean) || profile.energy || profile.sections || profile.observations?.length))
      throw new Error('Unavailable reference carries observations');
    for (const row of [...observations, ...(profile.energy ?? []), ...(profile.sections ?? []), ...(profile.observations ?? [])])
      if (row) evidenceFor(job, row.evidenceIds, 'reference', profile.referenceId);
    if (profile.sections?.some((row, index, rows) => index > 0 && row.startMs < rows[index - 1]!.endMs))
      throw new Error('Reference sections overlap or are unordered');
    if (profile.energy?.some((row, index, rows) => index > 0 && row.atMs <= rows[index - 1]!.atMs))
      throw new Error('Reference energy positions must increase');
  }
  for (const asset of job.media) {
    const records = evidenceFor(job, asset.evidenceIds, 'media', asset.id);
    if (asset.technical && (asset.technical.sourceHash !== asset.sha256 || !records.some(row=>row.technical && canonicalJson(row.technical)===canonicalJson(asset.technical)))) throw new Error('Media probe provenance mismatch');
    if (!records.some(row => row.locator?.path === asset.path && row.locator.sha256 === asset.sha256))
      throw new Error(`Media content provenance mismatch: ${asset.id}`);
    for (const observation of asset.observations ?? []) {
      evidenceFor(job, observation.evidenceIds, 'media', asset.id);
      if (!asset.durationFrames || observation.source.end > asset.durationFrames) throw new Error('Perception range exceeds observed duration');
    }
    if (asset.status === 'unavailable' && asset.observations?.length) throw new Error('Unavailable media carries perception');
    for (const range of [...asset.usableRanges, ...asset.sceneRanges]) {
      evidenceFor(job, range.evidenceIds, 'media', asset.id);
      if (asset.durationFrames !== undefined && range.end > asset.durationFrames) throw new Error('Media range exceeds duration');
      const duration=asset.technical?.format.duration;
      if(duration && asset.fps && range.end*asset.fps.denominator/asset.fps.numerator > duration.numerator/duration.denominator) throw new Error('Media range exceeds measured duration');
    }
    if (asset.music) {
      evidenceFor(job, asset.music.evidenceIds, 'media', asset.id);
      if (!asset.audio) throw new Error('Music evidence without audio stream');
      if (asset.music.beatsMs.some((value, index, rows) => index > 0 && value <= rows[index - 1]!)) throw new Error('Music beats must increase');
      for (const row of asset.music.sections) evidenceFor(job, row.evidenceIds, 'media', asset.id);
      if (asset.music.sections.some((row, index, rows) => index > 0 && row.startMs < rows[index - 1]!.endMs))
        throw new Error('Music sections overlap or are unordered');
      if (asset.fps && asset.durationFrames) {
        const durationMs = asset.durationFrames * 1000 * asset.fps.denominator / asset.fps.numerator;
        if (asset.music.beatsMs.some(value => value >= durationMs) || asset.music.sections.some(row => row.endMs > durationMs))
          throw new Error('Music duration exceeds source duration');
      }
    }
  }
  for (const candidate of job.candidates) {
    const plan = candidate.plan;
    unique(plan.clips.map(row => row.id), 'clip identities'); unique(plan.features, 'features');
    unique(plan.referenceProfileIds, 'reference profiles');
    for (const id of plan.referenceProfileIds) if (!job.references.some(row => row.id === id)) throw new Error('Unknown reference profile');
    evidenceFor(job, plan.evidenceIds);
    for (const clip of plan.clips) {
      if (!job.media.some(row => row.id === clip.mediaId)) throw new Error('Unknown media asset');
      evidenceFor(job, clip.evidenceIds, 'media', clip.mediaId);
    }
    const sourceRefs = [...plan.clips.flatMap(row => row.evidenceIds),
      ...job.references.filter(row => plan.referenceProfileIds.includes(row.id)).flatMap(row => row.evidenceIds)];
    if (sourceRefs.some(id => !plan.evidenceIds.includes(id))) throw new Error('Plan provenance omits source/reference evidence');
    unique(candidate.scores.map(row => row.criterion), 'score criteria');
    for (const score of candidate.scores) evidenceFor(job, score.evidenceIds);
    if (plan.revision === 0) {
      if (plan.rootPlanId !== plan.id || plan.parentPlanId !== undefined) throw new Error('Invalid root plan');
    } else {
      const parent = job.candidates.find(row => row.plan.id === plan.parentPlanId)?.plan;
      if (!parent || parent.rootPlanId !== plan.rootPlanId || plan.revision !== parent.revision + 1 || plan.revision > job.maxRevisions)
        throw new Error('Invalid plan lineage or revision bound');
      if (job.revisions.filter(row => row.nextPlanId === plan.id).length !== 1) throw new Error('Missing or duplicate revision artifact');
    }
  }
  unique((job.workflow?.sourceUsability ?? []).map(row => row.binding.assetId), 'source usability decisions');
  for (const decision of job.workflow?.sourceUsability ?? []) validateSourceUsabilityDecision(job, decision);
  for (const checkpoint of job.checkpoints) {
    if (!job.candidates.some(row => row.plan.id === checkpoint.planId) || checkpoint.resolveProjectId !== job.resolveProjectId)
      throw new Error('Checkpoint plan/project mismatch');
    evidenceFor(job, checkpoint.beforeEvidenceIds, 'timeline', checkpoint.timelineId);
    evidenceFor(job, checkpoint.afterEvidenceIds, 'timeline', checkpoint.timelineId);
    if (checkpoint.intentHash !== checkpointIntent(job, checkpoint.planId, checkpoint.timelineId, checkpoint.step,
      checkpoint.beforeEvidenceIds, checkpoint.operationId).intentHash) throw new Error('Checkpoint intent hash mismatch');
  }
  for (const review of job.reviews) {
    const checkpoint = job.checkpoints.find(row => row.operationId === review.operationId);
    if (!checkpoint || checkpoint.planId !== review.planId || checkpoint.timelineId !== review.timelineId)
      throw new Error('Review execution lineage mismatch');
    const artifact = evidenceFor(job, [review.artifactEvidenceId], 'render', review.renderId)[0]!;
    if (artifact.renderState && (artifact.renderState.operationId !== review.operationId || artifact.renderState.timelineId !== review.timelineId))
      throw new Error('Output measurement lineage mismatch');
    unique(review.findings.map(row => row.id), 'review findings');
    unique(review.samples.map(row => String(row.frame)), 'sample positions');
    for (const sample of review.samples) {
      const record = evidenceFor(job, [sample.evidenceId], 'frame', review.renderId)[0]!;
      if (sample.frame >= review.durationFrames || record.framePosition !== sample.frame) throw new Error('Output sample position mismatch');
    }
    for (const finding of review.findings) {
      const records = evidenceFor(job, finding.evidenceIds);
      if (records.some(row => !['render', 'frame'].includes(row.subject) || row.subjectId !== review.renderId))
        throw new Error('Review finding must cite actual output evidence');
    }
  }
  for (const revision of job.revisions) {
    const review = job.reviews.find(row => row.id === revision.reviewId);
    const next = job.candidates.find(row => row.plan.id === revision.nextPlanId)?.plan;
    if (!review || review.planId !== revision.parentPlanId || !next || next.parentPlanId !== revision.parentPlanId || next.revision !== revision.number)
      throw new Error('Revision lineage mismatch');
    unique(revision.findingIds, 'revision findings');
    for (const id of revision.findingIds) if (!review.findings.some(row => row.id === id && row.status === 'fail'))
      throw new Error('Revision requires failed review findings');
  }
  return job;
}

/** Complete measured state is necessary; a timeline ID or adapter RPC Boolean is insufficient. */
export function checkpointEvidenceBlockers(job: VideoEditingDocument, checkpoint: ExecutionCheckpoint): string[] {
  const plan = job.candidates.find(row => row.plan.id === checkpoint.planId)!.plan;
  const before = evidenceFor(job, checkpoint.beforeEvidenceIds, 'timeline', checkpoint.timelineId);
  const after = evidenceFor(job, checkpoint.afterEvidenceIds, 'timeline', checkpoint.timelineId);
  const blockers: string[] = [];
  if (checkpoint.step !== 'assemble') return ['CHECKPOINT_STEP_NOT_IMPLEMENTED'];
  if (!before.length || !after.length) blockers.push('TIMELINE_STATE_MISSING');
  for (const row of [...before, ...after]) {
    const state = row.timelineState;
    if (row.basis === 'inferred') blockers.push('TIMELINE_STATE_NOT_MEASURED');
    if (!state) { blockers.push('TIMELINE_STATE_MISSING'); continue; }
    if (!state.complete) blockers.push('TIMELINE_INSPECTION_INCOMPLETE');
    if (state.resolveProjectId !== job.resolveProjectId || !sameRate(state.fps, plan.timeline.fps)) blockers.push('TIMELINE_OWNER_OR_TIMEBASE_MISMATCH');
    unique(state.items.map(item => item.uniqueId), 'observed timeline items');
    if (before.includes(row)) {
      if (state.items.length || state.durationFrames !== 0) blockers.push('TARGET_NOT_EMPTY');
    } else {
      const expected = plan.clips.map(clip => ({ mediaUniqueId: job.media.find(asset => asset.id === clip.mediaId)!.resolveMediaId,
        mediaType: clip.mediaType, track: clip.track, source: clip.source, timeline: clip.timeline }));
      const actual = state.items.map(({ uniqueId: _id, ...item }) => item);
      const order = (a: { mediaType: string; track: number; timeline: { start: number } }, b: typeof a) =>
        (a.mediaType < b.mediaType ? -1 : a.mediaType > b.mediaType ? 1 : 0) || a.track - b.track || a.timeline.start - b.timeline.start;
      if (state.durationFrames !== plan.timeline.durationFrames || canonicalJson(actual.sort(order)) !== canonicalJson(expected.sort(order)))
        blockers.push('TIMELINE_INTENT_MISMATCH');
    }
  }
  return [...new Set(blockers)];
}

/** Feasibility is computed, never restored from an authored validation flag. */
export function validatePlan(raw: unknown, job: VideoEditingDocument): string[] {
  const plan: EditPlan = editPlanSchema.parse(raw);
  const blockers: string[] = [];
  for (const feature of plan.features) if (feature !== 'cut') blockers.push(`UNSUPPORTED_FEATURE:${feature}`);
  for (const id of plan.referenceProfileIds) {
    const profile = job.references.find(row => row.id === id);
    if (!profile || profile.status === 'unavailable') blockers.push(`REFERENCE_UNAVAILABLE:${id}`);
  }
  const lanes = new Map<string, Array<{ start: number; end: number; id: string }>>();
  for (const clip of plan.clips) {
    const asset = job.media.find(row => row.id === clip.mediaId);
    if (!asset) { blockers.push(`UNKNOWN_MEDIA:${clip.mediaId}`); continue; }
    try { evidenceFor(job, clip.evidenceIds, 'media', asset.id); } catch { blockers.push(`SOURCE_EVIDENCE:${clip.id}`); }
    if (asset.status === 'unavailable' || !asset.fps || !asset.durationFrames) blockers.push(`INCOMPLETE_MEDIA:${asset.id}`);
    if (!asset.resolveMediaId) blockers.push(`MEDIA_NOT_IMPORTED:${asset.id}`);
    if (!(clip.mediaType === 'video' ? asset.video : asset.audio)) blockers.push(`MISSING_STREAM:${clip.id}`);
    if (asset.durationFrames !== undefined && clip.source.end > asset.durationFrames) blockers.push(`SOURCE_RANGE:${clip.id}`);
    if (!effectiveSourceUsableRanges(job, asset.id).some(range => range.start <= clip.source.start && range.end >= clip.source.end)) blockers.push(`SOURCE_NOT_USABLE:${clip.id}`);
    if (asset.fps && !sameRate(asset.fps, plan.timeline.fps)) blockers.push(`RETIME_UNSUPPORTED:${clip.id}`);
    if (clip.source.end - clip.source.start !== clip.timeline.end - clip.timeline.start) blockers.push(`DURATION_MISMATCH:${clip.id}`);
    if (clip.timeline.end > plan.timeline.durationFrames) blockers.push(`TIMELINE_RANGE:${clip.id}`);
    const key = `${clip.mediaType}:${clip.track}`;
    const lane = lanes.get(key) ?? []; lane.push({ ...clip.timeline, id: clip.id }); lanes.set(key, lane);
  }
  for (const lane of lanes.values()) {
    lane.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let end = 0;
    for (const clip of lane) { if (clip.start < end) blockers.push(`TRACK_OVERLAP:${clip.id}`); end = Math.max(end, clip.end); }
  }
  const visual = plan.clips.filter(row => row.mediaType === 'video').sort((a, b) => a.timeline.start - b.timeline.start);
  let covered = 0;
  for (const row of visual) { if (row.timeline.start > covered) break; covered = Math.max(covered, row.timeline.end); }
  if (covered !== plan.timeline.durationFrames) blockers.push('VISUAL_COVERAGE');
  return [...new Set(blockers)];
}
