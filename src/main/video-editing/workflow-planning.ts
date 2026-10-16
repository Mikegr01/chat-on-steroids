import { createHash } from 'node:crypto';
import { z } from 'zod';
import { workRequestSchema, editPlanSchema, editCandidateSchema, plannerDescriptorSchema,
  type WorkRequest, type VideoEditingDocument, type EditCandidate } from '../../shared/video-editing.js';
import { canonicalJson } from './identity.js';
import { assessCandidates } from './planning.js';
import { sameRate } from './validation.js';
import { DAVINCI_PUBLIC_TOOLS } from '../plugins/davinci.js';

export function fingerprint(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
export function requestFingerprint(raw: unknown): string { return fingerprint(workRequestSchema.parse(raw)); }
const designSchema = editCandidateSchema.omit({ id: true, plan: true }).extend({
  plan: editPlanSchema.omit({ id: true, rootPlanId: true, parentPlanId: true, revision: true }),
}).strict();
export interface PlanningInput {
  request: WorkRequest; requestHash: string; evidence: VideoEditingDocument['evidence'];
  media: VideoEditingDocument['media']; references: VideoEditingDocument['references'];
  capabilities: z.infer<typeof import('../../shared/video-editing.js').adapterCutCapabilitiesSchema>;
}
export interface CandidatePlanner {
  descriptor: z.infer<typeof plannerDescriptorSchema>;
  plan(input: PlanningInput): Promise<z.infer<typeof designSchema>[]>;
}
/** A real nonmutating operator path: freeze structured submissions, never generate judgments. */
export function createOperatorPlanner(operatorId: string, rawDesigns: unknown): CandidatePlanner {
  plannerDescriptorSchema.shape.id.parse(operatorId);
  if (Buffer.byteLength(canonicalJson(rawDesigns)) > 1024 * 1024) throw new Error('Operator designs byte bound');
  const designs = z.array(designSchema).min(1).max(20).parse(rawDesigns);
  const descriptor = plannerDescriptorSchema.parse({ id: operatorId, version: '1', kind: 'operator',
    configuration: { submittedDesignHash: fingerprint(designs) } });
  return { descriptor, async plan() { return structuredClone(designs); } };
}
export function designIdentity(inputHash: string, descriptor: CandidatePlanner['descriptor'], design: unknown) {
  return fingerprint({ inputHash, descriptor, design: designSchema.parse(design) });
}
/** Content identities, not mutation authority. No built-in intelligence/provider fallback. */
export function admitDesigns(input: PlanningInput, planner: CandidatePlanner['descriptor'], raw: unknown): EditCandidate[] {
  const descriptor = plannerDescriptorSchema.parse(planner);
  if (Buffer.byteLength(canonicalJson(raw)) > 1024 * 1024) throw new Error('Planner output byte bound');
  const designs = z.array(designSchema).min(1).max(20).parse(raw);
  const identities = designs.map(design => designIdentity(fingerprint(input), descriptor, design));
  if (new Set(identities).size !== identities.length) throw new Error('Duplicate candidate design');
  return designs.map((design, index) => ({ ...design, id: `candidate-${identities[index]}`,
    plan: { ...design.plan, id: `plan-${identities[index]}`, rootPlanId: `plan-${identities[index]}`, revision: 0 } }));
}

/** Declared capabilities constrain translation; live exposure is supplied separately by admission. */
export function compareWorkCandidates(job: VideoEditingDocument, capabilities: PlanningInput['capabilities']) {
  const request = job.workflow!.request;
  return assessCandidates(job, request.weights).map(row => {
    const plan = job.candidates.find(candidate => candidate.id === row.candidateId)!.plan;
    const blockers = [...row.blockers];
    if (plan.timeline.durationFrames !== request.target.durationFrames || !sameRate(plan.timeline.fps, request.target.fps)) blockers.push('REQUEST_DURATION_OR_TIMEBASE_MISMATCH');
    for (const feature of request.features) {
      if (feature !== 'cut') blockers.push(`UNSUPPORTED_REQUEST:${feature}`);
      if (!plan.features.includes(feature)) blockers.push(`REQUEST_FEATURE_OMITTED:${feature}`);
    }
    if (request.titles.length) blockers.push('UNSUPPORTED_REQUEST:title');
    for (const id of request.content.requiredAssetIds) if (!plan.clips.some(clip => clip.mediaId === id)) blockers.push(`REQUIRED_CONTENT_MISSING:${id}`);
    for (const clip of plan.clips) {
      if (request.content.forbiddenAssetIds.includes(clip.mediaId)) blockers.push(`FORBIDDEN_CONTENT:${clip.mediaId}`);
      const asset = job.media.find(value => value.id === clip.mediaId)!;
      if (clip.mediaType === 'video') {
        if (!asset.width || !asset.height) blockers.push(`FORMAT_UNVERIFIED:${clip.id}`);
        else if (asset.width * request.target.height !== asset.height * request.target.width) blockers.push(`ASPECT_CONVERSION_UNSUPPORTED:${clip.id}`);
        const duration = clip.timeline.end - clip.timeline.start;
        if (request.pacing && (duration < request.pacing.minShotFrames || duration > request.pacing.maxShotFrames)) blockers.push(`PACING_CONSTRAINT:${clip.id}`);
      }
    }
    for (const tool of ['resolve_inspect', 'resolve_assemble_rough_cut', ...(request.output.renderRequired ? ['resolve_render_review', 'resolve_render_status'] : [])])
      if (!capabilities.tools.includes(tool)) blockers.push(`ADAPTER_CAPABILITY_MISSING:${tool}`);
    if (capabilities.tools.some(tool => !(DAVINCI_PUBLIC_TOOLS as readonly string[]).includes(tool))) blockers.push('UNREVIEWED_ADAPTER_CAPABILITY');
    return { ...row, score: blockers.length ? null : row.score, blockers: [...new Set(blockers)] };
  }).sort((a, b) => (a.score === null ? 1 : 0) - (b.score === null ? 1 : 0) ||
    (b.score ?? 0) - (a.score ?? 0) || a.planId.localeCompare(b.planId, 'en'));
}
