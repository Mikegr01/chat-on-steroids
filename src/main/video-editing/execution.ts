import { z } from 'zod';
import { createHash } from 'node:crypto';
import { preparedRequestSchema, adapterCutCapabilitiesSchema, type VideoEditingDocument, type ExecutionCheckpoint } from '../../shared/video-editing.js';
import { canonicalJson, checkpointIntent } from './identity.js';
import { validateDocument, validatePlan, evidenceFor, checkpointEvidenceBlockers, sameRate } from './validation.js';
import { VideoEditingStore } from './store.js';
import { capabilityAdmissionBlockers } from './source-end-admission.js';

const requestSchema = preparedRequestSchema;
const capabilitySchema = adapterCutCapabilitiesSchema;
type Request = z.infer<typeof requestSchema>;
type Capabilities = z.infer<typeof capabilitySchema>;
export interface PreparedExecution {
  version: 1; jobId: string; request: Request; capabilities: Capabilities;
  state: 'ready' | 'blocked'; blockers: string[]; productionBlockers: string[];
  intentHash: string; preparedHash: string;
  operations: Array<{ operationId: string; name: 'resolve_assemble_rough_cut'; arguments: {
    timeline_unique_id: string; segments: Array<{ media_unique_id: string; start_frame: number; end_frame: number;
      record_frame: number; track_index: number; media_type: 'video' | 'audio' }> } }>;
  predicates: string[]; requiredAfterEvidence: string[]; versionBehavior: string;
}
function digest(value: unknown) { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }

/** Pure preview/compiler. Neither creates a timeline nor claims a mutation. */
export function prepareExecution(document: unknown, rawRequest: unknown, rawCapabilities: unknown): PreparedExecution {
  const job = validateDocument(document), request = requestSchema.parse(rawRequest), capabilities = capabilitySchema.parse(rawCapabilities);
  const plan = job.candidates.find(row => row.plan.id === request.planId)?.plan;
  if (!plan) throw new Error('Unknown selected edit plan');
  const intent = checkpointIntent(job, request.planId, request.timelineId, 'assemble', request.beforeEvidenceIds, request.operationId);
  const blockers = validatePlan(plan, job);
  for (const tool of ['resolve_inspect', 'resolve_assemble_rough_cut'])
    if (!capabilities.tools.includes(tool)) blockers.push(`ADAPTER_CAPABILITY_MISSING:${tool}`);
  if (capabilities.sourceEnd === 'unknown') blockers.push('SOURCE_END_CONVENTION_UNVERIFIED');
  const before = evidenceFor(job, request.beforeEvidenceIds, 'timeline', request.timelineId);
  const first = before[0]!.timelineState;
  for (const row of before) {
    const state = row.timelineState;
    if (!state?.complete || row.basis === 'inferred' || state.startFrame === undefined ||
      state.resolveProjectId !== job.resolveProjectId || !sameRate(state.fps, plan.timeline.fps)) blockers.push('TARGET_STATE_UNVERIFIED');
    if (!state?.ownership) blockers.push('TARGET_OWNERSHIP_UNVERIFIED');
    else if (state.ownership.sourceTimelineId !== null) blockers.push('TARGET_NOT_FRESH_VERSION');
    if (state?.items.length || state?.durationFrames) blockers.push('TARGET_NOT_EMPTY');
    if (first && canonicalJson(state) !== canonicalJson(first)) blockers.push('TARGET_OBSERVATION_CONFLICT');
  }
  for (const clip of plan.clips) {
    const asset = job.media.find(row => row.id === clip.mediaId)!;
    if (job.media.filter(row => row.resolveMediaId === asset.resolveMediaId).length !== 1) blockers.push(`AMBIGUOUS_MEDIA_ID:${asset.resolveMediaId}`);
  }
  const result = {
    version: 1 as const, jobId: job.id, request, capabilities, state: blockers.length ? 'blocked' as const : 'ready' as const,
    blockers: [...new Set(blockers)], productionBlockers: ['LIVE_EXECUTION_ACCEPTANCE_PENDING', 'FRAME_END_LIVE_ACCEPTANCE_PENDING'],
    intentHash: intent.intentHash,
    operations: blockers.length ? [] : [{ operationId: request.operationId, name: 'resolve_assemble_rough_cut' as const,
      arguments: { timeline_unique_id: request.timelineId, segments: plan.clips.map(clip => ({
        media_unique_id: job.media.find(asset => asset.id === clip.mediaId)!.resolveMediaId!,
        start_frame: clip.source.start, end_frame: clip.source.end - (capabilities.sourceEnd === 'inclusive' ? 1 : 0),
        record_frame: first!.startFrame! + clip.timeline.start, track_index: clip.track, media_type: clip.mediaType })) } }],
    predicates: ['CURRENT_SESSION_AND_PLUGIN_EPOCH', 'ADAPTER_OWNERSHIP', 'FRESH_EMPTY_VERSION', 'CURRENT_MEDIA_CONTENT', 'DURABLE_EXCLUSIVE_CLAIM'],
    requiredAfterEvidence: ['SAVED_ADAPTER_RECEIPT', 'COMPLETE_OWNED_TIMELINE', 'EXACT_SOURCE_TRACK_PLACEMENT_DURATION'],
    versionBehavior: 'Assemble once into a fresh adapter-owned empty version; preserve prior versions. No automatic rollback or replay.',
  };
  return { ...result, preparedHash: digest(result) };
}

/** Human-readable preparation, not an execution request. No storage, import, seek, save or render. */
export function preparedPreview(prepared: PreparedExecution): string {
  const { preparedHash, ...payload } = prepared;
  if (digest(payload) !== preparedHash) throw new Error('Prepared preview fingerprint mismatch');
  return [
    `Prepared edit: ${prepared.request.planId}`,
    `Job: ${prepared.jobId}; target timeline: ${prepared.request.timelineId}`,
    `Preparation: ${prepared.state}; source-end convention: ${prepared.capabilities.sourceEnd} (${prepared.capabilities.acceptance})`,
    `Intent fingerprint: ${prepared.intentHash}`,
    `Production gates: ${['S7_FINAL_LIVE_CANARY_DEFERRED', ...prepared.productionBlockers].join(', ')}`,
    `Preparation blockers: ${prepared.blockers.join(', ') || 'none'}`,
    `Before evidence: ${prepared.request.beforeEvidenceIds.join(', ')}`,
    `Required predicates: ${prepared.predicates.join(', ')}`,
    `Required afterward: ${prepared.requiredAfterEvidence.join(', ')}`,
    prepared.versionBehavior,
    'Ordered proposed operations (assembly operation ID belongs to local custody; adapter assembly has no ID parameter):',
    JSON.stringify(prepared.operations, null, 2),
  ].join('\n');
}

export interface ExecutionVerification { status: 'VERIFIED' | 'DEVIATED' | 'AMBIGUOUS' | 'UNVERIFIED'; blockers: string[] }
export function verifyExecution(job: VideoEditingDocument, checkpoint: ExecutionCheckpoint, afterIds: string[]): ExecutionVerification {
  if (checkpoint.state === 'ambiguous') return { status: 'AMBIGUOUS', blockers: ['CONSUMED_AMBIGUITY_PRESERVED'] };
  const rows = evidenceFor(job, afterIds, 'timeline', checkpoint.timelineId);
  const blockers = checkpointEvidenceBlockers(job, { ...checkpoint, afterEvidenceIds: afterIds });
  const before = evidenceFor(job, checkpoint.beforeEvidenceIds);
  for (const row of rows) {
    const state = row.timelineState, original = before[0]!.timelineState;
    if (!state?.ownership || !original?.ownership || canonicalJson(state.ownership) !== canonicalJson(original.ownership) ||
      state.startFrame !== original.startFrame) blockers.push('TARGET_OWNERSHIP_UNVERIFIED');
    if (row.observedAt <= Math.max(...before.map(value => value.observedAt))) blockers.push('AFTER_OBSERVATION_NOT_FRESH');
  }
  const unique = [...new Set(blockers)];
  return { status: !unique.length ? 'VERIFIED' : unique.every(row => row === 'TIMELINE_INTENT_MISMATCH') ? 'DEVIATED' : 'UNVERIFIED', blockers: unique };
}

export interface ExecutionBoundary {
  mode: 'production' | 'fixture';
  /** Exact session/project/plugin incarnation + current ownership/media preconditions; no permissive default. */
  guard: (prepared: PreparedExecution) => Promise<string>;
  call: (operation: PreparedExecution['operations'][number]) => Promise<unknown>;
  /** Read-only acquisition admits new evidence through the same store, then returns its IDs. */
  observe: (prepared: PreparedExecution) => Promise<string[]>;
}
export interface ExecutionProgress {
  state: 'blocked' | 'executing' | 'verifying' | 'completed' | 'ambiguous';
  blockers: string[]; checkpoint?: ExecutionCheckpoint; verification?: ExecutionVerification;
}
// Process-local promise coalescing only. This grants no replay and carries no durable authority.
const inFlight = new WeakMap<VideoEditingStore, Map<string, { intent: string; work: Promise<ExecutionProgress> }>>();
/** No scheduler or second ledger. Durable checkpoint state owns whether an operation was consumed. */
export class VideoExecutionCoordinator {
  constructor(private readonly store: VideoEditingStore, private readonly boundary: ExecutionBoundary) {}
  async execute(raw: PreparedExecution): Promise<ExecutionProgress> {
    // Absolute production firewall precedes callbacks, claims and all adapter dispatch.
    if (this.boundary.mode !== 'fixture' || process.env.NODE_ENV !== 'test' || process.env.VITEST !== 'true')
      return { state: 'blocked', blockers: ['S7_FINAL_LIVE_CANARY_DEFERRED'] };
    if (Buffer.byteLength(canonicalJson(raw)) > 1024 * 1024) throw new Error('Prepared execution bound');
    const captured = structuredClone(raw);
    const operationId = requestSchema.parse(captured.request).operationId;
    const intent = canonicalJson(captured);
    let flights = inFlight.get(this.store);
    if (!flights) { flights = new Map(); inFlight.set(this.store, flights); }
    const prior = flights.get(operationId);
    if (prior) {
      if (prior.intent !== intent) throw new Error('Prepared intent conflict');
      return structuredClone(await prior.work);
    }
    const work = Promise.resolve().then(() => this.run(captured));
    flights.set(operationId, { intent, work });
    const retire = () => { flights!.delete(operationId); };
    void work.then(retire, retire);
    return structuredClone(await work);
  }
  private async run(captured: PreparedExecution): Promise<ExecutionProgress> {
    const job = this.store.get(captured.jobId);
    if (!job) throw new Error('Existing durable video job required');
    const authorityBlockers = capabilityAdmissionBlockers(job);
    if (authorityBlockers.length) return { state: 'blocked', blockers: authorityBlockers };
    const prepared = prepareExecution(job, captured.request, captured.capabilities);
    if (canonicalJson(captured) !== canonicalJson(prepared)) throw new Error('Prepared intent changed');
    if (prepared.state !== 'ready') return { state: 'blocked', blockers: prepared.blockers };
    const epoch = await this.boundary.guard(structuredClone(prepared));
    if (!epoch) throw new Error('Current execution owner unavailable');
    const claim = await this.store.claim({ jobId: job.id, ...prepared.request, step: 'assemble' });
    let checkpoint = claim.checkpoint;
    if (checkpoint.state !== 'claimed') return { state: checkpoint.state === 'verified' ? 'completed' : 'ambiguous', blockers: [], checkpoint };
    if (claim.newlyClaimed) {
      try {
        if (await this.boundary.guard(structuredClone(prepared)) !== epoch) throw new Error('Execution epoch changed');
        const result = await this.boundary.call(structuredClone(prepared.operations[0]!));
        const receipt = z.object({ requested: z.literal(true), executed: z.boolean(), verified: z.literal(true), error: z.null() }).passthrough().safeParse(result);
        await this.store.recordReceipt(job.id, checkpoint.operationId,
          { status: receipt.success ? 'acknowledged' : 'uncertain', resultSha256: digest(result) });
        if (await this.boundary.guard(structuredClone(prepared)) !== epoch) throw new Error('Execution epoch changed');
      } catch {
        // A dispatch or failed receipt publication cannot grant another dispatch.
        const current = this.store.get(job.id)!.checkpoints.find(row => row.operationId === checkpoint.operationId)!;
        if (!current.receipt) await this.store.recordReceipt(job.id, checkpoint.operationId, { status: 'uncertain' });
      }
      checkpoint = this.store.get(job.id)!.checkpoints.find(row => row.operationId === checkpoint.operationId)!;
    }
    if (checkpoint.receipt?.status !== 'acknowledged') {
      checkpoint = await this.store.settle(job.id, checkpoint.operationId, 'ambiguous', []);
      return { state: 'ambiguous', blockers: ['ADAPTER_RECEIPT_UNCERTAIN'], checkpoint };
    }
    try {
      if (await this.boundary.guard(structuredClone(prepared)) !== epoch) throw new Error('Verification epoch changed');
      const ids = await this.boundary.observe(structuredClone(prepared));
      if (await this.boundary.guard(structuredClone(prepared)) !== epoch) throw new Error('Verification epoch changed');
      const current = this.store.get(job.id)!;
      const verification = verifyExecution(current, checkpoint, ids);
      checkpoint = await this.store.settle(job.id, checkpoint.operationId, verification.status === 'VERIFIED' ? 'verified' : 'ambiguous', ids);
      return { state: checkpoint.state === 'verified' ? 'completed' : 'ambiguous', blockers: verification.blockers, checkpoint, verification };
    } catch {
      checkpoint = await this.store.settle(job.id, checkpoint.operationId, 'ambiguous', []);
      return { state: 'ambiguous', blockers: ['AFTER_OBSERVATION_UNAVAILABLE'], checkpoint,
        verification: { status: 'UNVERIFIED', blockers: ['AFTER_OBSERVATION_UNAVAILABLE'] } };
    }
  }
}
