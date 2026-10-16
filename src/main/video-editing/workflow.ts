import { randomUUID } from 'node:crypto';
import { workRequestSchema, adapterCutCapabilitiesSchema, plannerDescriptorSchema, type VideoEditingDocument, type VideoEvidence, type VideoWorkflow, sourceUsabilityInputSchema } from '../../shared/video-editing.js';
import { VideoEditingStore } from './store.js';
import { validateDocument } from './validation.js';
import { canonicalJson } from './identity.js';
import { prepareExecution } from './execution.js';
import { requestFingerprint, fingerprint, admitDesigns, compareWorkCandidates, type CandidatePlanner } from './workflow-planning.js';
import type { AssetIngestor } from './workflow-ingestion.js';
import { workflowPreview, preparedWorkflow, serializeWorkflowPreview } from './workflow-preview.js';
import { effectiveWorkflowCapabilities, capabilityAdmissionBlockers } from './source-end-admission.js';
import type { CapabilityAdmissionReceipt } from '../../shared/video-editing.js';

const queues = new WeakMap<VideoEditingStore, Map<string, Promise<unknown>>>();
/** Preparation workflow only: ports acquire evidence/designs, never Resolve mutations. */
export class VideoWorkflowCoordinator {
  constructor(private readonly store: VideoEditingStore, private readonly ports: { ingestor: AssetIngestor; planner?: CandidatePlanner;
    capabilities: VideoWorkflow['capabilities']; assertOwner?:()=>Promise<void>; epoch?: () => string }) {}
  private serial<T>(id: string, work: () => Promise<T>) {
    let queue = queues.get(this.store); if (!queue) { queue = new Map(); queues.set(this.store, queue); }
    const result = (queue.get(id) ?? Promise.resolve()).catch(() => undefined).then(work);
    queue.set(id, result);
    const retire = () => { if (queue!.get(id) === result) queue!.delete(id); }; void result.then(retire, retire);
    return result;
  }
  private get(id: string) { const job = this.store.get(id); if (!job?.workflow) throw new Error('Existing workflow required'); return job; }
  private async advance(job: VideoEditingDocument, patch: Partial<VideoWorkflow>, artifacts: Partial<VideoEditingDocument> = {}) {
    await this.ports.assertOwner?.();
    return this.store.advanceWorkflow({ ...job, ...artifacts,
      workflow: { ...job.workflow!, ...patch, revision: job.workflow!.revision + 1 } }, job.workflow!.revision);
  }
  private block(job: VideoEditingDocument, at: NonNullable<VideoWorkflow['blockedAt']>, reason: string) {
    return this.advance(job, { phase: 'blocked', blockedAt: at, blockers: [reason.slice(0, 2000)] });
  }
  async request(raw: unknown) {
    const request = workRequestSchema.parse(raw), capabilities = adapterCutCapabilitiesSchema.parse(this.ports.capabilities);
    return this.serial(request.id, async () => {
      const old = this.store.get(request.id);
      if (old) {
        if (old.workflow?.requestHash !== requestFingerprint(request)) throw new Error('Work request immutable conflict');
        return old;
      }
      await this.ports.assertOwner?.();
      return this.store.put({ version: 1, nativeExecutionEligible: true, id: request.id, sessionId: request.sessionId, localProjectId: request.localProjectId,
        resolveProjectId: request.resolveProjectId, objective: request.objective, maxRevisions: request.maxRevisions,
        evidence: [], references: [], media: [], candidates: [], checkpoints: [], reviews: [], revisions: [],
        workflow: { request, requestHash: requestFingerprint(request), revision: 0, phase: 'requested', blockers: [], comparison: [], capabilities } });
    });
  }
  async ingest(id: string) {
    return this.serial(id, async () => {
      let job = this.get(id), phase = job.workflow!.phase;
      if (!['requested', 'ingesting'].includes(phase) && !(phase === 'blocked' && job.workflow!.blockedAt === 'ingesting')) return job;
      if (phase !== 'ingesting') job = await this.advance(job, { phase: 'ingesting', blockers: [], blockedAt: undefined });
      try {
        const batch = await this.ports.ingestor.ingest(structuredClone(job.workflow!.request));
        const draft = validateDocument({ ...job, ...batch, workflow: { ...job.workflow!, phase: 'evidence-ready' } });
        return await this.advance(job, { phase: 'evidence-ready' }, { evidence: draft.evidence, media: draft.media, references: draft.references });
      } catch (error) { return this.block(job, 'ingesting', `INGESTION_FAILED:${error instanceof Error ? error.message : 'unavailable'}`); }
    });
  }
  async plan(id: string) {
    return this.serial(id, async () => {
      let job = this.get(id);
      if (['candidates-ready', 'selected', 'prepared'].includes(job.workflow!.phase)) return job;
      if (!['evidence-ready', 'planning'].includes(job.workflow!.phase) && !(job.workflow!.phase === 'blocked' && job.workflow!.blockedAt === 'planning')) throw new Error('Planning requires evidence');
      const planner = this.ports.planner;
      if (!planner) {
        if (job.workflow!.phase === 'blocked') return job;
        return this.block(job, 'planning', 'PLANNER_UNAVAILABLE');
      }
      const descriptor = plannerDescriptorSchema.parse(planner.descriptor);
      if (descriptor.kind === 'fixture' && (process.env.NODE_ENV !== 'test' || process.env.VITEST !== 'true')) throw new Error('Fixture planner requires tests');
      const input = { request: job.workflow!.request, requestHash: job.workflow!.requestHash,
        evidence: job.evidence, media: job.media, references: job.references, capabilities: job.workflow!.capabilities };
      if (job.workflow!.planner && (canonicalJson(job.workflow!.planner) !== canonicalJson(descriptor) || job.workflow!.planningInputHash !== fingerprint(input))) throw new Error('Planner incarnation/input changed');
      if (job.workflow!.phase !== 'planning') job = await this.advance(job, { phase: 'planning', planner: descriptor,
        planningInputHash: fingerprint(input), blockers: [], blockedAt: undefined });
      try {
        const designs = await planner.plan(structuredClone(input));
        if (canonicalJson(plannerDescriptorSchema.parse(planner.descriptor)) !== canonicalJson(descriptor)) throw new Error('PLANNER_INCARNATION_CHANGED');
        const candidates = admitDesigns(input, descriptor, designs);
        const draft = validateDocument({ ...job, candidates });
        return await this.advance(job, { phase: 'candidates-ready', comparison: compareWorkCandidates(draft, job.workflow!.capabilities) }, { candidates });
      } catch (error) { return this.block(job, 'planning', `PLANNING_FAILED:${error instanceof Error ? error.message : 'unavailable'}`); }
    });
  }
  async select(id: string, candidateId: string, operatorId: string) {
    return this.serial(id, async () => {
      const job = this.get(id);
      validateDocument(job);
      if (canonicalJson(compareWorkCandidates(job, job.workflow!.capabilities)) !== canonicalJson(job.workflow!.comparison)) throw new Error('Candidate comparison stale');
      if (job.workflow!.selection) {
        if (job.workflow!.selection.candidateId !== candidateId || job.workflow!.selection.operatorId !== operatorId) throw new Error('Selection immutable');
        return job;
      }
      if (job.workflow!.phase !== 'candidates-ready') throw new Error('Selection requires candidate set');
      if (!job.workflow!.comparison.some(row => row.candidateId === candidateId && row.score !== null && !row.blockers.length)) throw new Error('Selected candidate infeasible');
      return this.advance(job, { phase: 'selected', selection: { candidateId, operatorId, kind: 'operator' } });
    });
  }
  async prepare(id: string, rawTarget: VideoEvidence) {
    const target = structuredClone(rawTarget);
    return this.serial(id, async () => {
      let job = this.get(id);
      if (job.workflow!.phase === 'prepared') return { document: job, prepared: preparedWorkflow(job), preview: this.preview(id) };
      if (job.workflow!.phase !== 'selected' && !(job.workflow!.phase === 'blocked' && job.workflow!.blockedAt === 'preparing'))
        throw new Error('Preparation requires operator selection');
      const plan = job.candidates.find(row => row.id === job.workflow!.selection!.candidateId)!.plan;
      const draft = validateDocument({ ...job, evidence: [...job.evidence, target] });
      const trustedContext = {
        epoch: this.ports.epoch?.(),
        adapterSourceEnd: target.adapterDispatch?.sourceEnd,
        guardVersion: target.adapterDispatch?.guardVersion,
      };
      const capabilities = effectiveWorkflowCapabilities(draft, trustedContext);
      const admissionBlockers = capabilityAdmissionBlockers(draft, trustedContext);
      const prepared = prepareExecution(draft, { planId: plan.id, timelineId: target.subjectId,
        beforeEvidenceIds: [target.id], operationId: randomUUID() }, capabilities);
      const rawBlockers = [
        ...admissionBlockers,
        ...(draft.workflow?.capabilityAdmission
          ? prepared.blockers.filter(b => b !== 'SOURCE_END_CONVENTION_UNVERIFIED')
          : prepared.blockers),
        ...(this.store.consumedTarget(job.resolveProjectId, target.subjectId).length ? ['TARGET_ALREADY_CONSUMED'] : []),
      ];
      const blockers = [...new Set(rawBlockers)];
      if (blockers.length) {
        job = await this.advance(job, { phase: 'blocked', blockedAt: 'preparing', blockers });
        return { document: job, prepared, preview: workflowPreview({ ...draft, workflow: job.workflow }, prepared) };
      }
      job = await this.advance(job, { phase: 'prepared', blockedAt: undefined, blockers: [], prepared: { request: prepared.request, capabilities: prepared.capabilities,
        intentHash: prepared.intentHash, preparedHash: prepared.preparedHash } }, { evidence: draft.evidence });
      return { document: job, prepared, preview: this.preview(id) };
    });
  }
  async setUsableRanges(id: string, raw: unknown) {
    const input = sourceUsabilityInputSchema.parse(raw);
    return this.serial(id, () => this.store.setSourceUsability(id, input, this.ports.assertOwner));
  }
  async readmitCapabilities(id: string, adapterInfo: { sourceEnd: string; guardVersion: number; adapterVersion: string; epoch: string }) {
    return this.serial(id, () => this.store.setCapabilityAdmission(id, adapterInfo, this.ports.assertOwner));
  }
  async confirmCapabilityAdmission(id: string, receipt: CapabilityAdmissionReceipt) {
    const expectedRevision = this.get(id).workflow!.revision;
    return this.serial(id, () => this.store.confirmCapabilityAdmission(id, receipt, expectedRevision, this.ports.assertOwner));
  }
  preview(id: string) {
    const job = this.get(id), preview = workflowPreview(job, preparedWorkflow(job));
    serializeWorkflowPreview(preview); return preview;
  }
}
