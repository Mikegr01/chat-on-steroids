import { z } from 'zod';
import type { AppApi } from '../preload/index.js';
import { $ } from './dom.js';

// Parse only this UI's bounded projection. Main retains the complete ledger and all authority.
const id = z.string().min(1).max(128).refine(value => value.trim() === value);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const inspection = z.object({ job: z.object({
  id,
  checkpoints: z.array(z.object({ state: z.enum(['claimed', 'verified', 'ambiguous']) })).max(100),
  operatorAuthorizations: z.array(z.object({ expiresAt: z.number().int().nonnegative(),
    consumedAt: z.number().int().nonnegative().optional() })).max(20).optional(),
  candidates: z.array(z.object({ id, plan: z.object({ id }) })).max(20).optional(),
  workflow: z.object({
    revision: z.number().int().nonnegative().max(1_000_000_000),
    phase: z.enum(['requested', 'ingesting', 'evidence-ready', 'planning', 'candidates-ready', 'selected', 'prepared', 'blocked']),
    blockedAt: z.enum(['ingesting', 'planning', 'preparing']).optional(),
    selection: z.object({ candidateId: id }).optional(),
    capabilityAdmission: z.object({ capabilityFingerprint: hash, adapterEpoch: id }).optional(),
    capabilityConfirmation: z.object({}).optional(),
    prepared: z.object({ preparedHash: hash, request: z.object({ timelineId: id, planId: id }) }).optional(),
  }).optional(),
}), capabilityAuthority: z.object({ confirmationValid: z.boolean(), sourceEnd: z.enum(['inclusive', 'exclusive', 'unknown']) }),
nativeExecution: z.discriminatedUnion('eligible', [z.object({ eligible: z.literal(false) }),
  z.object({ eligible: z.literal(true), expectedPreparedHash: hash, authorizationId: z.string().uuid(), reviewedManifestHash: hash })]).optional() });

/** Main supplies all reviewed selectors and owns native admission, confirmation and execution. */
export function initVideoOperatorControls(api: Pick<AppApi, 'inspectVideoJob' | 'confirmCapabilityAdmission' | 'authorizeVideoJob' | 'executeVideoJob'>) {
  const input = $<HTMLInputElement>('videoOperatorJobId');
  const inspect = $<HTMLButtonElement>('videoOperatorInspect');
  const capability = $<HTMLButtonElement>('videoOperatorCapabilityConfirm');
  const authorize = $<HTMLButtonElement>('videoOperatorAuthorize');
  const execute = $<HTMLButtonElement>('videoOperatorExecute');
  const summary = $('videoOperatorState'), status = $('videoOperatorStatus'), error = $('videoOperatorError');
  let inspected: z.infer<typeof inspection> | null = null, busy = false, generation = 0;
  function canConfirm() {
    const job = inspected?.job, workflow = job?.workflow;
    return !!workflow?.selection && !!workflow.capabilityAdmission && !inspected!.capabilityAuthority.confirmationValid && !workflow.prepared &&
      (workflow.phase === 'selected' || workflow.phase === 'blocked' && workflow.blockedAt === 'preparing') &&
      job!.checkpoints.length === 0 && !job!.operatorAuthorizations?.length;
  }
  function canAuthorize() {
    const job = inspected?.job;
    return job?.workflow?.phase === 'prepared' && !!job.workflow.prepared && job.checkpoints.length === 0 && inspected!.capabilityAuthority.sourceEnd === 'inclusive';
  }
  function paint() {
    const job = inspected?.job;
    inspect.disabled = busy || !id.safeParse(input.value).success;
    capability.disabled = busy || job?.id !== input.value || !canConfirm();
    authorize.disabled = busy || job?.id !== input.value || !canAuthorize();
    execute.hidden = job?.id !== input.value || inspected?.nativeExecution?.eligible !== true;
    execute.disabled = busy || execute.hidden;
    if (!job) { summary.textContent = 'Inspect a job to review its current state.'; return; }
    const workflow = job.workflow, admission = workflow?.capabilityAdmission, prepared = workflow?.prepared;
    const authorities = job.operatorAuthorizations ?? [];
    const available = authorities.filter(row => row.consumedAt === undefined && row.expiresAt > Date.now()).length;
    summary.textContent = [
      `Job: ${job.id}`, `Revision: ${workflow?.revision ?? '—'}`, `Phase: ${workflow?.phase ?? 'no workflow'}`,
      `Candidate: ${workflow?.selection?.candidateId ?? '—'}`,
      `Plan: ${prepared?.request.planId ?? job.candidates?.find(row => row.id === workflow?.selection?.candidateId)?.plan.id ?? '—'}`,
      `Capability admission: ${!admission ? 'absent' : inspected!.capabilityAuthority.confirmationValid ? 'present' : 'pending operator confirmation'}`,
      `Fingerprint: ${admission?.capabilityFingerprint ?? '—'}`, `Adapter epoch: ${admission?.adapterEpoch ?? '—'}`,
      `Capability confirmation: ${inspected!.capabilityAuthority.confirmationValid ? 'present (authenticated)' : workflow?.capabilityConfirmation ? 'historical receipt retained; fresh confirmation required' : 'absent'}`,
      `Prepared: ${prepared ? 'yes' : 'no'}`, `Prepared hash: ${prepared?.preparedHash ?? '—'}`,
      `Timeline: ${prepared?.request.timelineId ?? '—'}`, `Checkpoints: ${job.checkpoints.length}`,
      `Execution authorization: ${authorities.length ? `available: ${available}; total: ${authorities.length}` : 'none'}`,
    ].join('\n');
  }
  function showError(failure: unknown) {
    const message = failure instanceof Error ? failure.message : String(failure);
    error.textContent = error.hidden ? message : `${error.textContent}\n${message}`; error.hidden = false;
  }
  async function operate(action?: 'capability' | 'authorization' | 'execution') {
    if (busy || inspect.disabled || action === 'capability' && capability.disabled || action === 'authorization' && authorize.disabled || action === 'execution' && execute.disabled) return;
    const owner = { id: input.value, generation }, displayed = inspected?.job;
    const native = inspected?.nativeExecution;
    const current = () => generation === owner.generation && input.value === owner.id;
    busy = true; error.hidden = true;
    status.textContent = action ? 'Waiting for native review…' : 'Inspecting…'; paint();
    try {
      if (action) {
        try {
          let reply;
          if (action === 'execution') {
            if (!native?.eligible) return;
            reply = await api.executeVideoJob(displayed!.id, native.expectedPreparedHash, native.authorizationId, native.reviewedManifestHash);
          } else reply = action === 'capability'
            ? await api.confirmCapabilityAdmission(displayed!.id, displayed!.workflow!.capabilityAdmission!.capabilityFingerprint)
            : await api.authorizeVideoJob(displayed!.id, displayed!.workflow!.prepared!.preparedHash);
          if (!current()) return;
          if (!reply.ok) { showError(reply.error); status.textContent = 'Native review rejected. State refreshed below.'; }
          else if (action === 'execution') {
            const result = z.union([z.object({ cancelled: z.literal(true) }), z.object({ status: z.enum([
              'VERIFIED', 'DEVIATED', 'UNVERIFIED', 'AMBIGUOUS', 'FAILED_CONFIRMED', 'FAILED_BEFORE_MUTATION']) })]).parse(reply.data);
            status.textContent = 'cancelled' in result ? 'Native execution cancelled. State refreshed below.'
              : `Execution result: ${result.status}. State refreshed below.`;
          } else status.textContent = reply.data && typeof reply.data === 'object' && 'cancelled' in reply.data && reply.data.cancelled === true
            ? 'Native review cancelled. State refreshed below.' : 'Native review completed. State refreshed below.';
        } catch (failure) {
          if (!current()) return;
          showError(failure); status.textContent = 'Native review unavailable. State refreshed below.';
        }
      }
      if (!current()) return;
      inspected = null; paint();
      const reply = await api.inspectVideoJob(owner.id);
      if (!current()) return;
      if (!reply.ok) throw new Error(reply.error);
      const parsed = inspection.safeParse(reply.data);
      if (!parsed.success || parsed.data.job.id !== owner.id) throw new Error('Invalid job inspection. Review unavailable.');
      inspected = parsed.data;
      if (!action) status.textContent = 'Job inspected.';
    } catch (failure) {
      if (current()) { inspected = null; showError(failure); status.textContent = 'Inspection unavailable. Inspect again to review.'; }
    } finally { busy = false; paint(); }
  }
  input.addEventListener('input', () => {
    generation++; inspected = null; error.hidden = true; status.textContent = ''; paint();
  });
  inspect.addEventListener('click', () => void operate());
  capability.addEventListener('click', () => void operate('capability'));
  authorize.addEventListener('click', () => void operate('authorization'));
  execute.addEventListener('click', () => void operate('execution'));
  paint();
}
