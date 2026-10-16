import { z } from 'zod';
import { technicalMediaSchema } from './media-runtime.js';
import { operatorAuthorizationSchema } from './video-operator.js';

/** Creative artifacts carry observations and intent, never executable authority. */
export const VIDEO_DOCUMENT_MAX_BYTES = 1024 * 1024;
export const videoIdSchema = z.string().min(1).max(128).refine(value => value.trim() === value);
const text = z.string().min(1).max(2000);
const frame = z.number().int().nonnegative().max(1_000_000_000);
const confidence = z.number().min(0).max(1);
const refs = z.array(videoIdSchema).min(1).max(100);
export const frameRateSchema = z.object({
  numerator: z.number().int().positive().max(240_000),
  denominator: z.number().int().positive().max(10_000),
}).strict();
export const frameRangeSchema = z.object({ start: frame, end: frame }).strict()
  .refine(range => range.end > range.start, 'Range must be nonempty and half-open');
const locatedRange = z.object({ start: frame, end: frame, evidenceIds: refs }).strict()
  .refine(range => range.end > range.start, 'Range must be nonempty and half-open');
const locator = z.object({ path: z.string().min(1).max(4096), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
const timelineState = z.object({ resolveProjectId: videoIdSchema, fps: frameRateSchema, durationFrames: frame,
  startFrame: frame.optional(),
  ownership: z.object({ creationOperationId: videoIdSchema, sourceTimelineId: videoIdSchema.nullable() }).strict().optional(),
  complete: z.boolean(), items: z.array(z.object({ uniqueId: videoIdSchema, mediaUniqueId: videoIdSchema,
    mediaType: z.enum(['video', 'audio']), track: z.number().int().positive().max(32),
    source: frameRangeSchema, timeline: frameRangeSchema }).strict()).max(500) }).strict();
const renderState = z.object({ operationId: z.string().uuid(), timelineId: videoIdSchema, completed: z.boolean(),
  fps: frameRateSchema, durationFrames: frame.positive() }).strict();
export const videoEvidenceSchema = z.object({
  adapterDispatch: z.object({snapshotSha256:z.string().regex(/^[a-f0-9]{64}$/),projectName:z.string().min(1).max(128),timelineName:z.string().min(1).max(128).optional(),guardVersion:z.union([z.literal(1),z.literal(2)]),sourceEnd:z.literal('inclusive')}).strict().optional(),
  renderReceiptEvidenceId: videoIdSchema.optional(),
  mediaSample: z.object({ sourceHash: z.string().regex(/^[a-f0-9]{64}$/), requestedFrame: frame,
    actualTimestamp: z.object({ numerator: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), denominator: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().optional(),
    position: z.enum(['OBSERVED_TIMESTAMP', 'UNVERIFIED']), executableHash: z.string().regex(/^[a-f0-9]{64}$/),
    decodeSha256: z.string().regex(/^[a-f0-9]{64}$/),
    image: z.object({width:z.number().int().positive().max(1920),height:z.number().int().positive().max(1080),bytes:z.number().int().positive().max(5*1024*1024),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().optional(),
    positionProof:z.object({sourceHash:z.string().regex(/^[a-f0-9]{64}$/),executableHash:z.string().regex(/^[a-f0-9]{64}$/),producerVersion:videoIdSchema,
      rawSha256:z.string().regex(/^[a-f0-9]{64}$/),observedAt:z.number().int().nonnegative(),decodedFrames:z.number().int().nonnegative().max(1100),
      classification:z.enum(['INDEPENDENT_DECODED_PTS_MATCH','UNVERIFIED'])}).strict().optional() }).strict().optional(),
  technical: technicalMediaSchema.optional(),
  id: videoIdSchema, subject: z.enum(['reference', 'media', 'timeline', 'render', 'frame']), subjectId: videoIdSchema,
  basis: z.enum(['measured', 'inferred', 'fixture']),
  producer: z.object({ name: videoIdSchema, version: videoIdSchema }).strict(),
  observedAt: z.number().int().nonnegative(), confidence,
  parents: z.array(videoIdSchema).max(100), locator: locator.optional(), framePosition: frame.optional(),
  timelineState: timelineState.optional(), renderState: renderState.optional(),
  acquisition: z.object({ tool: videoIdSchema, rawSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
}).strict().refine(row => (!row.timelineState || row.subject === 'timeline') &&
  (!row.renderState || row.subject === 'render') && (row.framePosition === undefined || row.subject === 'frame'),
  'Structured observation must match evidence subject');
const observation = z.object({ value: text, confidence, evidenceIds: refs }).strict();
/** Producer observations carry source frame positions/regions; they never contain commands. */
export const perceptionObservationSchema = z.object({
  channel: z.enum(['pacing', 'rhythm', 'transitions', 'cameraMotion', 'framing', 'text', 'musicSync', 'color',
    'energy', 'scene', 'usable', 'activity', 'quality', 'beat', 'section']),
  value: text, confidence, evidenceIds: refs, source: frameRangeSchema,
  region: z.object({ x: confidence, y: confidence, width: confidence, height: confidence }).strict()
    .refine(row => row.width > 0 && row.height > 0 && row.x + row.width <= 1 && row.y + row.height <= 1).optional(),
}).strict();
const section = z.object({ name: text, startMs: frame, endMs: frame, evidenceIds: refs }).strict()
  .refine(value => value.endMs > value.startMs, 'Section must be nonempty');
export const referenceProfileSchema = z.object({
  technicalProbe: technicalMediaSchema.optional(),
  sampleStatus: z.enum(['AVAILABLE', 'UNAVAILABLE']).optional(),
  sampleEvidenceIds: z.array(videoIdSchema).max(3).optional(),
  id: videoIdSchema, referenceId: videoIdSchema, status: z.enum(['partial', 'complete', 'unavailable']), evidenceIds: refs,
  pacing: z.object({ shotDurationsMs: z.array(z.number().positive().max(3_600_000)).min(1).max(500),
    confidence, evidenceIds: refs }).strict().optional(),
  rhythm: observation.optional(), transitions: observation.optional(), cameraMotion: observation.optional(),
  framing: observation.optional(), text: observation.optional(), musicSync: observation.optional(), color: observation.optional(),
  energy: z.array(z.object({ atMs: frame, value: confidence, evidenceIds: refs }).strict()).min(1).max(500).optional(),
  sections: z.array(section).min(1).max(100).optional(),
  observations: z.array(perceptionObservationSchema).max(500).optional(),
  technical: z.object({ kind: z.enum(['video', 'image']), width: z.number().int().positive().max(16384).optional(),
    height: z.number().int().positive().max(16384).optional(), fps: frameRateSchema.optional(),
    durationFrames: frame.positive().optional() }).strict().optional(),
}).strict();
export const mediaAssetSchema = z.object({
  technical: technicalMediaSchema.optional(),
  id: videoIdSchema, path: z.string().min(1).max(4096), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  resolveMediaId: videoIdSchema.optional(), status: z.enum(['partial', 'complete', 'unavailable']),
  video: z.boolean().optional(), audio: z.boolean().optional(), audioChannels: z.number().int().positive().max(128).optional(),
  container: videoIdSchema.optional(), codec: videoIdSchema.optional(),
  width: z.number().int().positive().max(16384).optional(), height: z.number().int().positive().max(16384).optional(),
  fps: frameRateSchema.optional(), durationFrames: frame.positive().optional(), evidenceIds: refs,
  usableRanges: z.array(locatedRange).max(500), sceneRanges: z.array(locatedRange).max(500),
  observations: z.array(perceptionObservationSchema).max(500).optional(),
  music: z.object({ beatsMs: z.array(frame).max(5000), sections: z.array(section).max(100), evidenceIds: refs }).strict().optional(),
}).strict();
export const editClipSchema = z.object({
  id: videoIdSchema, mediaId: videoIdSchema, mediaType: z.enum(['video', 'audio']),
  track: z.number().int().positive().max(32), source: frameRangeSchema, timeline: frameRangeSchema, evidenceIds: refs,
}).strict();
export const editPlanSchema = z.object({
  id: videoIdSchema, rootPlanId: videoIdSchema, parentPlanId: videoIdSchema.optional(), revision: z.number().int().min(0).max(10),
  referenceProfileIds: refs, evidenceIds: refs,
  features: z.array(z.enum(['cut', 'transition', 'title', 'color', 'mix', 'retime'])).min(1).max(6),
  timeline: z.object({ name: z.string().min(1).max(128), fps: frameRateSchema, durationFrames: frame.positive() }).strict(),
  clips: z.array(editClipSchema).min(1).max(500),
}).strict();
export const editCandidateSchema = z.object({
  id: videoIdSchema, plan: editPlanSchema, rationale: text, risks: z.array(text).max(50),
  scores: z.array(z.object({ criterion: videoIdSchema, value: confidence, evidenceIds: refs }).strict()).min(1).max(30),
}).strict();
export const executionCheckpointSchema = z.object({
  operatorBinding: z.object({ preflightEvidenceId:videoIdSchema,snapshotSha256:z.string().regex(/^[a-f0-9]{64}$/),authorizationId:z.string().uuid(),preparedHash:z.string().regex(/^[a-f0-9]{64}$/),
    operationHash:z.string().regex(/^[a-f0-9]{64}$/),targetHash:z.string().regex(/^[a-f0-9]{64}$/),claimedAt:z.number().int().nonnegative() }).strict().optional(),
  outcome:z.enum(['VERIFIED','DEVIATED','AMBIGUOUS','UNVERIFIED','FAILED_BEFORE_MUTATION','FAILED_CONFIRMED']).optional(),
  operationId: z.string().uuid(), planId: videoIdSchema, resolveProjectId: videoIdSchema, timelineId: videoIdSchema,
  step: z.enum(['assemble', 'render']), intentHash: z.string().regex(/^[a-f0-9]{64}$/),
  beforeEvidenceIds: refs, afterEvidenceIds: z.array(videoIdSchema).max(100),
  state: z.enum(['claimed', 'verified', 'ambiguous']),
  receipt: z.object({ status: z.enum(['acknowledged', 'uncertain', 'failed-before-mutation']),
    resultSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().optional(),
}).strict().refine(value => value.state !== 'verified' || value.afterEvidenceIds.length > 0, 'Verified checkpoint requires after evidence');
export const outputReviewSchema = z.object({
  id: videoIdSchema, planId: videoIdSchema, operationId: z.string().uuid(), timelineId: videoIdSchema, renderId: videoIdSchema,
  artifactEvidenceId: videoIdSchema, completed: z.boolean(), fps: frameRateSchema, durationFrames: frame.positive(),
  samples: z.array(z.object({ frame, evidenceId: videoIdSchema }).strict()).max(100),
  findings: z.array(z.object({ id: videoIdSchema, criterion: z.enum(['timing', 'structure', 'visual']),
    status: z.enum(['pass', 'fail', 'unknown']), explanation: text, evidenceIds: refs }).strict()).min(1).max(100),
}).strict();
export const revisionPlanSchema = z.object({
  id: videoIdSchema, parentPlanId: videoIdSchema, reviewId: videoIdSchema, nextPlanId: videoIdSchema,
  number: z.number().int().min(1).max(10), reason: text, findingIds: refs,
  deltas: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('replace'), clipId: videoIdSchema, clip: editClipSchema }).strict(),
    z.object({ kind: z.literal('remove'), clipId: videoIdSchema }).strict(),
    z.object({ kind: z.literal('insert'), afterClipId: videoIdSchema.nullable(), clip: editClipSchema }).strict(),
  ])).min(1).max(500),
}).strict();
export const workRequestSchema = z.object({
  version: z.literal(1), id: videoIdSchema, sessionId: videoIdSchema, localProjectId: videoIdSchema.nullable().default(null), resolveProjectId: videoIdSchema,
  objective: z.string().min(1).max(96000),
  assets: z.array(z.object({ id: videoIdSchema, role: z.enum(['source', 'music', 'reference']),
    kind: z.enum(['video', 'audio', 'image']), path: z.string().min(1).max(4096), resolveMediaId: videoIdSchema.optional(),
    usable: z.object({ operatorId: videoIdSchema, ranges: z.array(frameRangeSchema).min(1).max(100) }).strict().optional(),
  }).strict()).min(2).max(100),
  target: z.object({ durationFrames: frame.positive(), fps: frameRateSchema,
    width: z.number().int().positive().max(16384), height: z.number().int().positive().max(16384) }).strict(),
  features: editPlanSchema.shape.features,
  style: z.array(text).max(50), content: z.object({ requiredAssetIds: z.array(videoIdSchema).max(100),
    forbiddenAssetIds: z.array(videoIdSchema).max(100) }).strict(),
  pacing: z.object({ minShotFrames: frame.positive(), maxShotFrames: frame.positive() }).strict()
    .refine(row => row.minShotFrames <= row.maxShotFrames).optional(),
  titles: z.array(text).max(50), output: z.object({ container: z.enum(['mov', 'mp4']), renderRequired: z.boolean(), creativeReviewRequired:z.boolean().optional() }).strict(),
  weights: z.array(z.object({ criterion: videoIdSchema, weight: z.number().min(0).max(100) }).strict()).min(1).max(30),
  maxRevisions: z.number().int().min(0).max(10), mode: z.literal('prepare-only'),
}).strict().superRefine((row, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (new Set(row.assets.map(asset => asset.id)).size !== row.assets.length) fail('Duplicate work asset');
  const poolIds = row.assets.flatMap(asset => asset.resolveMediaId ? [asset.resolveMediaId] : []);
  if (new Set(poolIds).size !== poolIds.length) fail('Ambiguous media-pool identity');
  if (!row.assets.some(asset => asset.role === 'source') || !row.assets.some(asset => asset.role === 'reference')) fail('Source and reference required');
  if (row.assets.filter(asset => asset.role === 'reference').length > 20) fail('Reference inventory bound');
  if (row.assets.some(asset => asset.role === 'music' && asset.kind !== 'audio' || asset.role === 'source' && asset.kind === 'image' || asset.role === 'reference' && asset.kind === 'audio')) fail('Unsupported asset role/kind');
  for (const ids of [row.content.requiredAssetIds, row.content.forbiddenAssetIds]) {
    if (new Set(ids).size !== ids.length || ids.some(id => !row.assets.some(asset => asset.id === id && asset.role !== 'reference'))) fail('Content identity mismatch');
  }
  if (row.content.requiredAssetIds.some(id => row.content.forbiddenAssetIds.includes(id))) fail('Contradictory content');
  if (new Set(row.weights.map(weight => weight.criterion)).size !== row.weights.length || !row.weights.some(weight => weight.weight > 0)) fail('Invalid comparison weights');
  if (new TextEncoder().encode(JSON.stringify(row)).length > VIDEO_DOCUMENT_MAX_BYTES) fail('Request byte bound');
});
export const adapterCutCapabilitiesSchema = z.object({ tools: z.array(videoIdSchema).max(10),
  sourceEnd: z.enum(['inclusive', 'exclusive', 'unknown']), acceptance: z.enum(['fixture', 'unverified']) }).strict();
export const preparedRequestSchema = z.object({ planId: videoIdSchema, timelineId: videoIdSchema,
  beforeEvidenceIds: refs, operationId: z.string().uuid() }).strict();
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
/** An explicit source constraint decision, separate from immutable request and measured media. */
export const sourceUsabilityBindingSchema = z.object({
  jobId: videoIdSchema, assetId: videoIdSchema, resolveMediaId: videoIdSchema,
  path: z.string().min(1).max(4096), sha256: fingerprint, frameCount: frame.positive(), evidenceHash: fingerprint,
}).strict();
export const sourceUsabilityInputSchema = z.object({
  binding: sourceUsabilityBindingSchema, expectedRevision: frame,
  ranges: z.array(frameRangeSchema).min(1).max(100),
}).strict();
export const sourceUsabilityDecisionSchema = z.object({
  binding: sourceUsabilityBindingSchema, ranges: z.array(frameRangeSchema).min(1).max(100),
  sessionId: videoIdSchema, localProjectId: videoIdSchema.nullable(), resolveProjectId: videoIdSchema,
  provenance: z.literal('native-operator'), operatorId: videoIdSchema,
  decidedAt: z.number().int().nonnegative(), revision: frame.positive(),
}).strict();
export const plannerDescriptorSchema = z.object({ id: videoIdSchema, version: videoIdSchema,
  kind: z.enum(['fixture', 'external', 'operator']), configuration: z.record(videoIdSchema, z.string().max(2000))
    .refine(row => Object.keys(row).length <= 30) }).strict();
export const capabilityAdmissionSchema = z.object({
  jobId: videoIdSchema, sessionId: videoIdSchema, localProjectId: videoIdSchema.nullable(),
  resolveProjectId: videoIdSchema, sourceEnd: z.literal('inclusive'), guardVersion: z.literal(2),
  adapterVersion: z.string().min(1).max(128), adapterEpoch: z.string().min(1).max(128),
  capabilityFingerprint: fingerprint, admittedAt: z.number().int().nonnegative(),
  revision: frame.positive(), provenance: z.literal('trusted-adapter'),
}).strict();
export type CapabilityAdmission = z.infer<typeof capabilityAdmissionSchema>;
export const capabilityAdmissionReceiptSchema = z.object({
  id: z.string().uuid(), kind: z.literal('operator-explicit'),
  jobId: videoIdSchema, sessionId: videoIdSchema, conversationId: z.string().min(1).max(128).optional(),
  localProjectId: videoIdSchema.nullable(), resolveProjectId: videoIdSchema,
  capabilityFingerprint: fingerprint, admissionRevision: frame.positive(),
  adapterEpoch: z.string().min(1).max(128), sourceEnd: z.literal('inclusive'),
  guardVersion: z.literal(2), provenance: z.literal('operator-ipc'),
  confirmedAt: z.number().int().nonnegative(), confirmationFingerprint: fingerprint,
  // Optional only for unchanged forensic retention. Current authority requires bound UCV metadata;
  // historical windows-credentials and unauthenticated receipts cannot authorize new work.
  authentication: z.object({ method: z.enum(['windows-credentials', 'windows-user-consent-verifier']), challengeHash: fingerprint,
    verifiedAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative() }).strict()
    .refine(value => value.expiresAt > value.verifiedAt && value.expiresAt - value.verifiedAt <= 60_000).optional(),
}).strict();
export type CapabilityAdmissionReceipt = z.infer<typeof capabilityAdmissionReceiptSchema>;
export const preparedArtifactSchema = z.object({ request: preparedRequestSchema, capabilities: adapterCutCapabilitiesSchema,
  intentHash: fingerprint, preparedHash: fingerprint }).strict();
export const legacyPreparedRecoveryInputSchema = z.object({ expectedRevision: frame,
  preparedHash: fingerprint, operationId: z.string().uuid() }).strict();
/** Audit custody only. The invalidated artifact never becomes active preparation again. */
export const legacyPreparedRecoverySchema = z.object({
  id: z.string().uuid(), kind: z.literal('legacy-capability-confirmation'),
  jobId: videoIdSchema, sessionId: videoIdSchema, conversationId: videoIdSchema,
  localProjectId: videoIdSchema.nullable(), resolveProjectId: videoIdSchema,
  priorRevision: frame, revision: frame, recoveredAt: z.number().int().nonnegative(),
  capabilityAdmission: capabilityAdmissionSchema, invalidatedPrepared: preparedArtifactSchema,
  evidenceIds: z.array(videoIdSchema).max(1000),
  verifiedTarget: videoEvidenceSchema,
  custody: z.object({ authority: z.literal('absent'), checkpoints: z.literal(0), execution: z.literal('absent') }).strict(),
}).strict();
export type LegacyPreparedRecovery = z.infer<typeof legacyPreparedRecoverySchema>;
export type LegacyPreparedRecoveryInput = z.infer<typeof legacyPreparedRecoveryInputSchema>;
export const videoWorkflowSchema = z.object({
  request: workRequestSchema, requestHash: fingerprint, revision: frame,
  phase: z.enum(['requested', 'ingesting', 'evidence-ready', 'planning', 'candidates-ready', 'selected', 'prepared', 'blocked']),
  blockedAt: z.enum(['ingesting', 'planning', 'preparing']).optional(), blockers: z.array(text).max(100),
  planner: plannerDescriptorSchema.optional(),
  planningInputHash: fingerprint.optional(),
  sourceUsability: z.array(sourceUsabilityDecisionSchema).max(100).optional(),
  capabilities: adapterCutCapabilitiesSchema,
  capabilityAdmission: capabilityAdmissionSchema.optional(),
  capabilityConfirmation: capabilityAdmissionReceiptSchema.optional(),
  comparison: z.array(z.object({ candidateId: videoIdSchema, planId: videoIdSchema, score: confidence.nullable(),
    blockers: z.array(text).max(100) }).strict()).max(20),
  selection: z.object({ candidateId: videoIdSchema, operatorId: videoIdSchema, kind: z.literal('operator') }).strict().optional(),
  prepared: preparedArtifactSchema.optional(),
  legacyPreparedRecovery: legacyPreparedRecoverySchema.optional(),
}).strict();
export const videoEditingDocumentSchema = z.object({
  // Only creation under the native admission contract earns this immutable marker.
  // Absent historical markers are retained unchanged and never grant native execution.
  nativeExecutionEligible: z.literal(true).optional(),
  operatorAuthorizations: z.array(operatorAuthorizationSchema).max(20).optional(),
  version: z.literal(1), id: videoIdSchema, sessionId: videoIdSchema, localProjectId: videoIdSchema.nullable(),
  resolveProjectId: videoIdSchema, objective: z.string().min(1).max(96000), maxRevisions: z.number().int().min(0).max(10),
  evidence: z.array(videoEvidenceSchema).max(1000), references: z.array(referenceProfileSchema).max(20),
  media: z.array(mediaAssetSchema).max(100), candidates: z.array(editCandidateSchema).max(20),
  checkpoints: z.array(executionCheckpointSchema).max(100), reviews: z.array(outputReviewSchema).max(100),
  revisions: z.array(revisionPlanSchema).max(100), workflow: videoWorkflowSchema.optional(),
}).strict();

/** Fixed native execute selectors. Main resolves all operations and execution policy. */
export const nativeVideoExecutionInputSchema = z.object({ jobId: videoIdSchema, expectedPreparedHash: fingerprint,
  authorizationId: z.string().uuid(), reviewedManifestHash: fingerprint }).strict();

export type FrameRate = z.infer<typeof frameRateSchema>;
export type VideoEvidence = z.infer<typeof videoEvidenceSchema>;
export type ReferenceProfile = z.infer<typeof referenceProfileSchema>;
export type MediaAsset = z.infer<typeof mediaAssetSchema>;
export type EditClip = z.infer<typeof editClipSchema>;
export type EditPlan = z.infer<typeof editPlanSchema>;
export type EditCandidate = z.infer<typeof editCandidateSchema>;
export type ExecutionCheckpoint = z.infer<typeof executionCheckpointSchema>;
export type OutputReview = z.infer<typeof outputReviewSchema>;
export type RevisionPlan = z.infer<typeof revisionPlanSchema>;
export type VideoEditingDocument = z.infer<typeof videoEditingDocumentSchema>;
export type WorkRequest = z.infer<typeof workRequestSchema>;
export type VideoWorkflow = z.infer<typeof videoWorkflowSchema>;
export type SourceUsabilityInput = z.infer<typeof sourceUsabilityInputSchema>;
export type SourceUsabilityDecision = z.infer<typeof sourceUsabilityDecisionSchema>;
