import {
  createRun,
  getRun,
  listOrchestratorRuns,
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
  persistCriticalSwarmNow,
  stageSpawn,
  requestWorkerBootstraps,
  swarmState,
  type CommittedWorkerReport
} from '../agents.js';
import { getChatModels } from '../chat-models.js';
import { getConfig } from '../config.js';
import { logWarn } from '../logger.js';
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

export function buildVerifierTask(step: StepRecord): string {
  const criteria = step.acceptanceCriteria.length
    ? step.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`).join('\n')
    : 'No explicit acceptance criteria were provided; verify the step instructions and reported result.';
  return [
    `Verify step: ${step.title}`,
    '',
    'Step instructions:',
    step.instructions,
    '',
    'Worker result:',
    step.workerResult?.summary ?? '(no worker summary recorded)',
    '',
    'Acceptance criteria:',
    criteria,
    '',
    'Do not modify files or state. Inspect and verify only.',
    'End with exactly one explicit verdict line:',
    'VERDICT: PASS',
    'or',
    'VERDICT: DEFECT'
  ].join('\n');
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
  startRun(
    input: CreateRunInput,
    options?: { primeModel?: string; spawnAgent?: boolean }
  ): Promise<OrchestratorRun>;
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
  advanceCommittedReport(report: CommittedWorkerReport): Promise<{ handled: boolean; reason?: string }>;
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
  const primeModels = new Map<string, string | undefined>();
  let unregisterReportListener: (() => void) | null = null;

  // A real ORCH run advances only from the Agents system's committed report boundary.
  unregisterReportListener = onWorkerReportCommitted((report: CommittedWorkerReport) => {
    void advanceCommittedReportImpl(report).catch((error) => {
      logWarn(`orchestrator: committed report routing failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });

  function currentStep(run: OrchestratorRun): StepRecord {
    const step = run.steps[run.currentStepIndex];
    if (!step) throw new Error('NO_CURRENT_STEP');
    return step;
  }

  async function persistCommitAndPublishSpawn(staged: ReturnType<typeof stageSpawn>): Promise<void> {
    try {
      if (!(await persistCriticalSwarmNow())) {
        throw new Error('ORCHESTRATOR_DURABILITY_UNAVAILABLE');
      }
    } catch (error) {
      staged.rollback();
      throw error;
    }
    staged.commit();
    requestWorkerBootstraps(staged.created.map((agent) => agent.id), staged.runId);
  }

  async function createRunImpl(input: CreateRunInput): Promise<OrchestratorRun> {
    return createRun(input);
  }

  async function startRunImpl(
    input: CreateRunInput,
    options?: { primeModel?: string; spawnAgent?: boolean }
  ): Promise<OrchestratorRun> {
    primeModels.set(input.id, options?.primeModel);
    await createRun(input);
    return assignCurrentStepWorkerImpl(input.id, undefined, {
      primeModel: options?.primeModel,
      spawnAgent: options?.spawnAgent ?? true
    });
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
    let assignedId = workerId ?? `worker-${step.index + 1}`;

    const modelResolution = resolveModelPolicy('worker', options?.primeModel);

    if (options?.spawnAgent && getConfig().multiAgent.enabled) {
      const staged = stageSpawn({
        workers: [{
          label: assignedId,
          task: step.instructions,
          model: modelResolution.model
        }],
        caller: { conversationId: run.ownerConversationId },
        origin: 'ORCHESTRATOR',
        orchestratorRunId: runId,
        orchestratorStepId: step.id,
        executionRole: 'worker'
      });
      await persistCommitAndPublishSpawn(staged);
      assignedId = staged.created[0]?.id ?? assignedId;
    }

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

    const modelResolution = resolveModelPolicy('verifier', options?.primeModel);
    let actualVerifierId = verifierId;

    if (options?.spawnAgent && getConfig().multiAgent.enabled) {
      const staged = stageSpawn({
        workers: [{
          label: verifierId,
          task: buildVerifierTask(step),
          model: modelResolution.model
        }],
        caller: { conversationId: run.ownerConversationId },
        origin: 'ORCHESTRATOR',
        orchestratorRunId: runId,
        orchestratorStepId: step.id,
        executionRole: 'verifier'
      });
      await persistCommitAndPublishSpawn(staged);
      actualVerifierId = staged.created[0]?.id ?? verifierId;
    }

    const spec: VerifierTaskSpec = {
      runId,
      stepId: step.id,
      verifierId: actualVerifierId,
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
    activeVerifiers.set(runId, actualVerifierId);
    verifierSpecs.set(`${runId}:${actualVerifierId}`, spec);

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

  async function advanceCommittedReportImpl(
    report: CommittedWorkerReport
  ): Promise<{ handled: boolean; reason?: string }> {
    if (report.agentInfo.origin !== 'ORCHESTRATOR' || !report.agentInfo.orchestratorRunId) {
      return { handled: false, reason: 'NOT_ORCHESTRATOR' };
    }
    const runId = report.agentInfo.orchestratorRunId;
    const run = getRun(runId);
    if (!run) return { handled: false, reason: 'RUN_NOT_FOUND' };
    const step = currentStep(run);
    if (report.agentInfo.orchestratorStepId !== step.id) {
      return { handled: false, reason: 'WRONG_STEP' };
    }
    const primeModel = primeModels.get(runId);

    if (report.agentInfo.executionRole === 'worker' || report.agentInfo.executionRole === 'repair_worker') {
      const accepted = await handleCommittedWorkerReportImpl(runId, report);
      if (!accepted.handled) return { handled: false, reason: accepted.reason };
      if (accepted.alreadyAccepted) return { handled: true };
      const verifying = getRun(runId);
      if (!verifying || verifying.status !== 'VERIFYING') return { handled: false, reason: 'NOT_VERIFYING' };
      const current = currentStep(verifying);
      await dispatchVerifierImpl(runId, `verifier-${current.index + 1}-g${current.generation}`, {
        primeModel,
        spawnAgent: true
      });
      return { handled: true };
    }

    if (report.agentInfo.executionRole === 'verifier') {
      const activeVerifier = activeVerifiers.get(runId);
      if (activeVerifier && activeVerifier !== report.workerId) {
        return { handled: false, reason: 'WRONG_VERIFIER' };
      }
      const updated = await handleVerifierReportImpl(runId, report.workerId, report.result);
      if (updated.status === 'RUNNING') {
        const next = currentStep(updated);
        await assignCurrentStepWorkerImpl(runId, `worker-${next.index + 1}-g${next.generation}`, {
          primeModel,
          spawnAgent: true
        });
      }
      return { handled: true };
    }

    return { handled: false, reason: 'UNKNOWN_EXECUTION_ROLE' };
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
      await persistCommitAndPublishSpawn(staged);
    }

    assignedWorkerSpecs.set(`${runId}:${repairId}`, repairSpec);
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
    const spawnedWorkers: string[] = [];
    const rerunMutationWorkers: string[] = [];
    const agents = swarmState().agents;

    for (const run of listOrchestratorRuns()) {
      if (run.status === 'COMPLETED' || run.status === 'CANCELED' || run.status === 'BLOCKED') continue;
      const step = currentStep(run);

      if (run.status === 'WAITING_WORKER') {
        const assignedId = step.assignedWorkerId;
        const matchingWorker = agents.find(agent =>
          agent.origin === 'ORCHESTRATOR'
          && agent.orchestratorRunId === run.id
          && agent.orchestratorStepId === step.id
          && (agent.executionRole === 'worker' || agent.executionRole === 'repair_worker')
        );
        // A durable WAITING_WORKER assignment is mutation authority. If its real worker is
        // missing, the state is ambiguous: never manufacture a second mutation worker.
        if (!matchingWorker && assignedId && !activeWorkerIds.has(assignedId)) {
          logWarn(`orchestrator: restored ${run.id} is waiting for ${assignedId}, but no matching durable Agents worker exists; mutation replay withheld`);
        }
        continue;
      }

      if (run.status !== 'VERIFYING') continue;

      const existingVerifier = agents.find(agent =>
        agent.origin === 'ORCHESTRATOR'
        && agent.orchestratorRunId === run.id
        && agent.orchestratorStepId === step.id
        && agent.executionRole === 'verifier'
      );
      if (existingVerifier) {
        activeVerifiers.set(run.id, existingVerifier.id);
        continue;
      }

      // VERIFYING means the worker result crossed the conductor durability barrier already.
      // Dispatching the missing read-only verifier cannot replay mutation work.
      if (!getConfig().multiAgent.enabled) continue;
      try {
        const verifier = await dispatchVerifierImpl(
          run.id,
          `verifier-${step.index + 1}-g${step.generation}`,
          { primeModel: primeModels.get(run.id), spawnAgent: true }
        );
        spawnedWorkers.push(verifier.verifierId);
      } catch (error) {
        // Recovery is allowed to abstain, never to weaken the durability barrier. The run
        // remains VERIFYING and can be reconciled again once persistence/runtime is available.
        logWarn(`orchestrator: verifier recovery for ${run.id} deferred: ${error instanceof Error ? error.message : String(error)}`);
      }
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
    primeModels.clear();
  }

  return {
    startRun: startRunImpl,
    createRun: createRunImpl,
    getRun: getRunImpl,
    assignCurrentStepWorker: assignCurrentStepWorkerImpl,
    getAssignedWorkerSpec: getAssignedWorkerSpecImpl,
    handleCommittedWorkerReport: handleCommittedWorkerReportImpl,
    dispatchVerifier: dispatchVerifierImpl,
    handleVerifierReport: handleVerifierReportImpl,
    advanceCommittedReport: advanceCommittedReportImpl,
    prepareRepair: prepareRepairImpl,
    cancelActiveRun: cancelActiveRunImpl,
    recordFileEffect: recordFileEffectImpl,
    reconcileOnStartup: reconcileOnStartupImpl,
    dispose: disposeImpl
  };
}

let runtimeDriver: OrchestratorDriver | null = null;

export function getOrchestratorRuntimeDriver(): OrchestratorDriver {
  runtimeDriver ??= createOrchestratorDriver();
  return runtimeDriver;
}

export function resetOrchestratorRuntimeDriverForTests(): void {
  runtimeDriver?.dispose();
  runtimeDriver = null;
}
