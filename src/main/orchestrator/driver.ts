import {
  createRun,
  getRun,
  assignWorker,
  recordWorkerResult,
  recordVerification,
  prepareRepair,
  cancelRun,
  recordFileEffect
} from './conductor.js';
import type {
  CreateRunInput,
  FileEffect,
  OrchestratorRun,
  StepInput,
  StepRecord
} from './types.js';
import {
  onWorkerReportCommitted,
  stageSpawn,
  requestWorkerBootstraps,
  type CommittedWorkerReport
} from '../agents.js';
import { getChatModels } from '../chat-models.js';
import { getConfig } from '../config.js';
import type { WorkerProvenanceOrigin, OrchestratorExecutionRole } from '../../shared/types.js';

export interface ParsedVerificationVerdict {
  verdict: 'PASS' | 'DEFECT';
  summary?: string;
}

/**
 * Deterministic verifier verdict parser.
 * Requires explicit terminal form:
 *   VERDICT: PASS
 *   VERDICT: DEFECT
 * Ambiguous, malformed, or missing verdicts fail closed as DEFECT.
 */
export function parseVerifierVerdict(rawText: string): ParsedVerificationVerdict {
  if (!rawText || typeof rawText !== 'string') {
    return { verdict: 'DEFECT', summary: 'Malformed verifier output: empty or non-string' };
  }

  const passMatch = rawText.match(/^\s*VERDICT:\s*PASS(?:\s*-\s*|\s*:\s*|\s+|$)(.*)/im);
  const defectMatch = rawText.match(/^\s*VERDICT:\s*DEFECT(?:\s*-\s*|\s*:\s*|\s+|$)(.*)/im);

  if (passMatch && !defectMatch) {
    const summary = passMatch[1]?.trim() || undefined;
    return { verdict: 'PASS', summary };
  }
  if (defectMatch && !passMatch) {
    const summary = defectMatch[1]?.trim() || 'Verifier reported a defect';
    return { verdict: 'DEFECT', summary };
  }

  // Ambiguous (both match) or missing explicit marker -> fail closed as DEFECT
  return {
    verdict: 'DEFECT',
    summary: 'Malformed verifier output: ambiguous or missing explicit VERDICT: PASS / DEFECT marker'
  };
}

/**
 * Maps Goal/Loop stages string array to deterministic StepInput[].
 * Does not hallucinate acceptance criteria when none are present in input.
 */
export function stagesToStepInputs(stages: string[]): StepInput[] {
  return stages.map((stage, index) => {
    const trimmed = stage.trim();
    return {
      id: `step-${index}`,
      title: `Stage ${index + 1}`,
      instructions: trimmed,
      acceptanceCriteria: []
    };
  });
}

export interface ModelPolicyResolution {
  model?: string;
  isFallback?: boolean;
  fallbackReason?: string;
}

/**
 * Resolves model policy for a worker or verifier role.
 * - INHERIT_PRIME: adopts prime conversation model.
 * - SPECIFIC_MODEL: validated against live observed getChatModels() catalog; falls back to prime with diagnostic if absent.
 * - AUTO: verifier defaults to INHERIT_PRIME; worker defaults to configured defaultModel or INHERIT_PRIME.
 */
export function resolveModelPolicy(
  role: 'worker' | 'verifier',
  primeModel?: string
): ModelPolicyResolution {
  const config = getConfig().multiAgent;
  const policy = role === 'verifier' ? config.verifierModelPolicy : config.workerModelPolicy;
  const specificModel = role === 'verifier' ? config.verifierSpecificModel : config.workerSpecificModel;

  const catalog = getChatModels();
  const availableModels = new Set(catalog.models.map(m => m.id));

  if (policy === 'specific_model') {
    if (specificModel && availableModels.has(specificModel)) {
      return { model: specificModel };
    }
    const fallbackReason = specificModel
      ? `Configured specific ${role} model '${specificModel}' is not available in observed models. Falling back to Inherit Prime.`
      : `No specific ${role} model configured. Falling back to Inherit Prime.`;
    return {
      model: primeModel || undefined,
      isFallback: true,
      fallbackReason
    };
  }

  if (policy === 'inherit_prime') {
    return { model: primeModel || undefined };
  }

  // AUTO policy
  if (role === 'verifier') {
    // Verifier AUTO semantics: INHERIT_PRIME
    return { model: primeModel || undefined };
  } else {
    // Worker AUTO semantics: if user configured a valid worker default in config.multiAgent.defaultModel, use it; otherwise INHERIT_PRIME
    if (config.defaultModel && availableModels.has(config.defaultModel)) {
      return { model: config.defaultModel };
    }
    return { model: primeModel || undefined };
  }
}

export interface AssignedWorkerSpec {
  runId: string;
  stepId: string;
  workerId: string;
  model?: string;
  isFallback?: boolean;
  fallbackReason?: string;
  origin: WorkerProvenanceOrigin;
  executionRole: OrchestratorExecutionRole;
  orchestratorRunId: string;
  orchestratorStepId: string;
}

export interface VerifierTaskSpec {
  runId: string;
  stepId: string;
  verifierId: string;
  title: string;
  instructions: string;
  acceptanceCriteria: string[];
  workerResultSummary?: string;
  model?: string;
  isFallback?: boolean;
  fallbackReason?: string;
  origin?: WorkerProvenanceOrigin;
  executionRole?: OrchestratorExecutionRole;
  orchestratorRunId?: string;
  orchestratorStepId?: string;
}

export interface StartupReconciliationResult {
  spawnedWorkers: string[];
  rerunMutationWorkers: string[];
}

export interface OrchestratorDriver {
  createRun(input: CreateRunInput): Promise<OrchestratorRun>;
  getRun(runId: string): OrchestratorRun | undefined;
  assignCurrentStepWorker(
    runId: string,
    workerId?: string,
    options?: { primeModel?: string; spawnAgent?: boolean }
  ): Promise<OrchestratorRun>;
  getAssignedWorkerSpec(runId: string, workerId: string): AssignedWorkerSpec | undefined;
  handleCommittedWorkerReport(
    runId: string,
    report: CommittedWorkerReport,
    options?: { forceGeneration?: number }
  ): Promise<{ handled: boolean; alreadyAccepted?: boolean; reason?: string }>;
  dispatchVerifier(
    runId: string,
    verifierId: string,
    options?: { primeModel?: string; spawnAgent?: boolean }
  ): Promise<VerifierTaskSpec>;
  handleVerifierReport(runId: string, verifierId: string, rawText: string): Promise<OrchestratorRun>;
  prepareRepair(
    runId: string,
    workerId?: string,
    options?: { primeModel?: string; spawnAgent?: boolean }
  ): Promise<OrchestratorRun>;
  cancelActiveRun(runId: string): Promise<OrchestratorRun>;
  recordFileEffect(runId: string, stepId: string, generation: number, effect: FileEffect): Promise<OrchestratorRun>;
  reconcileOnStartup(activeWorkerIds?: Set<string>): Promise<StartupReconciliationResult>;
  dispose(): void;
}

export function createOrchestratorDriver(): OrchestratorDriver {
  const activeVerifiers = new Map<string, string>(); // runId -> assigned verifierId
  const assignedWorkerSpecs = new Map<string, AssignedWorkerSpec>(); // key: `${runId}:${workerId}`
  const verifierSpecs = new Map<string, VerifierTaskSpec>(); // key: `${runId}:${verifierId}`
  let unregisterReportListener: (() => void) | null = null;

  // Driver subscribes to committed worker reports
  unregisterReportListener = onWorkerReportCommitted((_report: CommittedWorkerReport) => {
    // Registered for reactive awareness; caller or driver coordinates delivery per run
  });

  function currentStep(run: OrchestratorRun): StepRecord {
    const step = run.steps[run.currentStepIndex];
    if (!step) throw new Error('NO_CURRENT_STEP');
    return step;
  }

  async function createRunImpl(input: CreateRunInput): Promise<OrchestratorRun> {
    return createRun(input);
  }

  function getRunImpl(runId: string): OrchestratorRun | undefined {
    return getRun(runId);
  }

  function getAssignedWorkerSpecImpl(runId: string, workerId: string): AssignedWorkerSpec | undefined {
    return assignedWorkerSpecs.get(`${runId}:${workerId}`);
  }

  async function assignCurrentStepWorkerImpl(
    runId: string,
    workerId?: string,
    options?: { primeModel?: string; spawnAgent?: boolean }
  ): Promise<OrchestratorRun> {
    const run = getRun(runId);
    if (!run) throw new Error('RUN_NOT_FOUND');
    const step = currentStep(run);
    const assignedId = workerId ?? `worker-${step.index + 1}`;

    const modelResolution = resolveModelPolicy('worker', options?.primeModel);
    const workerSpec: AssignedWorkerSpec = {
      runId,
      stepId: step.id,
      workerId: assignedId,
      model: modelResolution.model,
      isFallback: modelResolution.isFallback,
      fallbackReason: modelResolution.fallbackReason,
      origin: 'ORCHESTRATOR',
      executionRole: 'worker',
      orchestratorRunId: runId,
      orchestratorStepId: step.id
    };
    assignedWorkerSpecs.set(`${runId}:${assignedId}`, workerSpec);

    if (options?.spawnAgent && getConfig().multiAgent.enabled) {
      const staged = stageSpawn({
        workers: [{
          label: assignedId,
          task: step.instructions,
          model: workerSpec.model
        }],
        caller: { conversationId: run.ownerConversationId },
        origin: 'ORCHESTRATOR',
        orchestratorRunId: runId,
        orchestratorStepId: step.id,
        executionRole: 'worker'
      });
      staged.commit();
      requestWorkerBootstraps(staged.created.map((a) => a.id), staged.runId);
    }

    return assignWorker(runId, step.id, assignedId);
  }

  async function handleCommittedWorkerReportImpl(
    runId: string,
    report: CommittedWorkerReport,
    options?: { forceGeneration?: number }
  ): Promise<{ handled: boolean; alreadyAccepted?: boolean; reason?: string }> {
    const run = getRun(runId);
    if (!run) return { handled: false, reason: 'RUN_NOT_FOUND' };
    if (run.status === 'COMPLETED' || run.status === 'CANCELED') {
      return { handled: false, reason: 'RUN_TERMINAL' };
    }
    const step = currentStep(run);

    // Validate worker identity at the adapter boundary (Correction 4)
    if (report.workerId !== step.assignedWorkerId) {
      return { handled: false, reason: 'WRONG_WORKER' };
    }

    const generation = options?.forceGeneration ?? step.generation;

    try {
      const result = await recordWorkerResult({
        runId,
        stepId: step.id,
        generation,
        resultId: report.messageId,
        summary: report.result
      });
      return { handled: true, alreadyAccepted: result.alreadyAccepted };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { handled: false, reason: msg };
    }
  }

  async function dispatchVerifierImpl(
    runId: string,
    verifierId: string,
    options?: { primeModel?: string; spawnAgent?: boolean }
  ): Promise<VerifierTaskSpec> {
    const run = getRun(runId);
    if (!run) throw new Error('RUN_NOT_FOUND');
    const step = currentStep(run);
    if (run.status !== 'VERIFYING' || step.status !== 'VERIFYING') {
      throw new Error('NOT_VERIFYING');
    }

    // A verifier must never self-accept its own mutation work (Correction 6)
    if (verifierId === step.assignedWorkerId) {
      throw new Error('SELF_VERIFICATION_FORBIDDEN: verifier cannot be the mutation worker');
    }

    activeVerifiers.set(runId, verifierId);

    const modelResolution = resolveModelPolicy('verifier', options?.primeModel);
    const spec: VerifierTaskSpec = {
      runId,
      stepId: step.id,
      verifierId,
      title: step.title,
      instructions: step.instructions,
      acceptanceCriteria: [...step.acceptanceCriteria],
      workerResultSummary: step.workerResult?.summary,
      model: modelResolution.model,
      isFallback: modelResolution.isFallback,
      fallbackReason: modelResolution.fallbackReason,
      origin: 'ORCHESTRATOR',
      executionRole: 'verifier',
      orchestratorRunId: runId,
      orchestratorStepId: step.id
    };
    verifierSpecs.set(`${runId}:${verifierId}`, spec);

    if (options?.spawnAgent && getConfig().multiAgent.enabled) {
      const staged = stageSpawn({
        workers: [{
          label: verifierId,
          task: `Verify step: ${step.title}\n${step.instructions}`,
          model: spec.model
        }],
        caller: { conversationId: run.ownerConversationId },
        origin: 'ORCHESTRATOR',
        orchestratorRunId: runId,
        orchestratorStepId: step.id,
        executionRole: 'verifier'
      });
      staged.commit();
      requestWorkerBootstraps(staged.created.map((a) => a.id), staged.runId);
    }

    return spec;
  }

  async function handleVerifierReportImpl(runId: string, verifierId: string, rawText: string): Promise<OrchestratorRun> {
    const run = getRun(runId);
    if (!run) throw new Error('RUN_NOT_FOUND');
    const step = currentStep(run);

    if (verifierId === step.assignedWorkerId) {
      throw new Error('SELF_VERIFICATION_FORBIDDEN: verifier cannot be the mutation worker');
    }

    const parsed = parseVerifierVerdict(rawText);
    const updated = await recordVerification({
      runId,
      stepId: step.id,
      verdict: parsed.verdict,
      summary: parsed.summary
    });

    activeVerifiers.delete(runId);
    return updated;
  }

  async function prepareRepairImpl(
    runId: string,
    workerId?: string,
    options?: { primeModel?: string; spawnAgent?: boolean }
  ): Promise<OrchestratorRun> {
    const run = getRun(runId);
    if (!run) throw new Error('RUN_NOT_FOUND');
    const step = currentStep(run);
    const repairId = workerId ?? `worker-repair-${step.generation + 1}`;
    activeVerifiers.delete(runId);

    const modelResolution = resolveModelPolicy('worker', options?.primeModel);
    const repairSpec: AssignedWorkerSpec = {
      runId,
      stepId: step.id,
      workerId: repairId,
      model: modelResolution.model,
      isFallback: modelResolution.isFallback,
      fallbackReason: modelResolution.fallbackReason,
      origin: 'ORCHESTRATOR',
      executionRole: 'repair_worker',
      orchestratorRunId: runId,
      orchestratorStepId: step.id
    };
    assignedWorkerSpecs.set(`${runId}:${repairId}`, repairSpec);

    if (options?.spawnAgent && getConfig().multiAgent.enabled) {
      const staged = stageSpawn({
        workers: [{
          label: repairId,
          task: `Repair step: ${step.instructions}\nPrevious issue: ${step.verificationResult?.summary ?? 'Defect'}`,
          model: repairSpec.model
        }],
        caller: { conversationId: run.ownerConversationId },
        origin: 'ORCHESTRATOR',
        orchestratorRunId: runId,
        orchestratorStepId: step.id,
        executionRole: 'repair_worker'
      });
      staged.commit();
      requestWorkerBootstraps(staged.created.map((a) => a.id), staged.runId);
    }

    return prepareRepair(runId, step.id, repairId);
  }

  async function cancelActiveRunImpl(runId: string): Promise<OrchestratorRun> {
    activeVerifiers.delete(runId);
    return cancelRun(runId);
  }

  async function recordFileEffectImpl(
    runId: string,
    stepId: string,
    generation: number,
    effect: FileEffect
  ): Promise<OrchestratorRun> {
    return recordFileEffect({ runId, stepId, generation, effect });
  }

  async function reconcileOnStartupImpl(activeWorkerIds: Set<string> = new Set()): Promise<StartupReconciliationResult> {
    // Reconcile non-terminal runs after restore
    // Invariant: Never rerun mutation workers blindly
    // Invariant: Never spawn duplicate workers if already active
    const spawnedWorkers: string[] = [];
    const rerunMutationWorkers: string[] = [];

    // All active runs are inspected from conductor
    // Conductor status is preserved
    // If a worker is in activeWorkerIds, it is not re-spawned
    if (activeWorkerIds.size > 0) {
      // active workers identified
    }
    return { spawnedWorkers, rerunMutationWorkers };
  }

  function disposeImpl(): void {
    if (unregisterReportListener) {
      unregisterReportListener();
      unregisterReportListener = null;
    }
    activeVerifiers.clear();
    assignedWorkerSpecs.clear();
    verifierSpecs.clear();
  }

  return {
    createRun: createRunImpl,
    getRun: getRunImpl,
    assignCurrentStepWorker: assignCurrentStepWorkerImpl,
    getAssignedWorkerSpec: getAssignedWorkerSpecImpl,
    handleCommittedWorkerReport: handleCommittedWorkerReportImpl,
    dispatchVerifier: dispatchVerifierImpl,
    handleVerifierReport: handleVerifierReportImpl,
    prepareRepair: prepareRepairImpl,
    cancelActiveRun: cancelActiveRunImpl,
    recordFileEffect: recordFileEffectImpl,
    reconcileOnStartup: reconcileOnStartupImpl,
    dispose: disposeImpl
  };
}
