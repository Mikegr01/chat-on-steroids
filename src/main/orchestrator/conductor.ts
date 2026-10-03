import { readDurable, writeDurableNow } from '../durable.js';
import type { CreateRunInput, OrchestratorRun, StepRecord } from './types.js';

const STATE_NAME = 'orchestrator-runs';
interface StoredRuns { version: 1; runs: OrchestratorRun[] }

const runs = new Map<string, OrchestratorRun>();
let storeQueue: Promise<void> = Promise.resolve();

function copy<T>(value: T): T {
  return structuredClone(value);
}

function fail(code: string, detail?: string): never {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function terminal(run: OrchestratorRun): boolean {
  return run.status === 'COMPLETED' || run.status === 'CANCELED';
}

function currentStep(run: OrchestratorRun): StepRecord {
  const step = run.steps[run.currentStepIndex];
  if (!step) fail('NO_CURRENT_STEP');
  return step;
}

function assertStep(run: OrchestratorRun, stepId: string): StepRecord {
  const step = currentStep(run);
  if (step.id !== stepId) fail('WRONG_STEP', `expected ${step.id}`);
  return step;
}

function snapshot(replacement?: OrchestratorRun): StoredRuns {
  const values = [...runs.values()].map(copy);
  if (replacement) {
    const index = values.findIndex(row => row.id === replacement.id);
    if (index >= 0) values[index] = copy(replacement);
    else values.push(copy(replacement));
  }
  return { version: 1, runs: values };
}

async function persistSnapshot(replacement: OrchestratorRun): Promise<void> {
  try {
    await writeDurableNow(STATE_NAME, snapshot(replacement));
  } catch (error) {
    // writeDurableNow retains a failed generation for retry. The staged run has not
    // been published to the in-memory map, so supersede that retry with the
    // authoritative snapshot before returning the failed transition to the caller.
    await writeDurableNow(STATE_NAME, snapshot()).catch(() => undefined);
    throw error;
  }
}

async function serializeStore<T>(operation: () => Promise<T>): Promise<T> {
  const previous = storeQueue;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.then(() => gate, () => gate);
  storeQueue = queued;
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (storeQueue === queued) storeQueue = Promise.resolve();
  }
}

async function mutate(runId: string, change: (draft: OrchestratorRun) => void): Promise<OrchestratorRun> {
  return serializeStore(async () => {
    const existing = runs.get(runId);
    if (!existing) fail('RUN_NOT_FOUND');
    const draft = copy(existing);
    change(draft);
    draft.updatedAt = Date.now();
    await persistSnapshot(draft);
    runs.set(runId, draft);
    return copy(draft);
  });
}

export async function createRun(input: CreateRunInput): Promise<OrchestratorRun> {
  return serializeStore(async () => {
    if (runs.has(input.id)) fail('RUN_EXISTS');
    if (input.steps.length === 0) fail('NO_STEPS');
    const now = Date.now();
    const run: OrchestratorRun = {
      version: 1,
      id: input.id,
      ownerConversationId: input.ownerConversationId,
      projectId: input.projectId,
      objective: input.objective,
      status: 'RUNNING',
      currentStepIndex: 0,
      steps: input.steps.map((step, index) => ({
        ...copy(step), index, status: 'PENDING', generation: 0, attemptCount: 0, fileEffects: []
      })),
      startedAt: now,
      updatedAt: now,
      lastCheckpointAt: now,
      ...(input.projectIdentity ? { projectIdentity: copy(input.projectIdentity) } : {})
    };
    await persistSnapshot(run);
    runs.set(run.id, run);
    return copy(run);
  });
}

export async function restoreOrchestratorRuns(): Promise<void> {
  return serializeStore(async () => {
    const stored = await readDurable<StoredRuns>(STATE_NAME);
    runs.clear();
    if (!stored || stored.version !== 1 || !Array.isArray(stored.runs)) return;
    for (const run of stored.runs) runs.set(run.id, copy(run));
  });
}

export function getRun(runId: string): OrchestratorRun | undefined {
  const run = runs.get(runId);
  return run ? copy(run) : undefined;
}

export async function assignWorker(runId: string, stepId: string, workerId: string): Promise<OrchestratorRun> {
  return mutate(runId, run => {
    if (terminal(run)) fail('RUN_TERMINAL');
    const step = assertStep(run, stepId);
    if (run.status === 'WAITING_WORKER' || step.status === 'ACTIVE') fail('ACTIVE_ASSIGNMENT');
    if (run.status !== 'RUNNING' || step.status !== 'PENDING') fail('STEP_NOT_ASSIGNABLE');
    step.generation += 1;
    step.attemptCount += 1;
    step.assignedWorkerId = workerId;
    delete step.lastWorkerResultId;
    delete step.workerResult;
    delete step.verificationResult;
    step.status = 'ACTIVE';
    run.status = 'WAITING_WORKER';
  });
}

export interface WorkerResultInput {
  runId: string;
  stepId: string;
  generation: number;
  resultId: string;
  summary?: string;
}

export async function recordWorkerResult(input: WorkerResultInput): Promise<{ run: OrchestratorRun; alreadyAccepted: boolean }> {
  return serializeStore(async () => {
    const existing = runs.get(input.runId);
    if (!existing) fail('RUN_NOT_FOUND');
    if (terminal(existing)) fail('RUN_TERMINAL');
    const existingStep = assertStep(existing, input.stepId);
    if (input.generation !== existingStep.generation) fail('STALE_GENERATION');
    if (existingStep.lastWorkerResultId) {
      if (existingStep.lastWorkerResultId === input.resultId) return { run: copy(existing), alreadyAccepted: true };
      fail('GENERATION_SETTLED');
    }
    if (existing.status !== 'WAITING_WORKER' || existingStep.status !== 'ACTIVE') fail('NO_ACTIVE_ASSIGNMENT');
    const draft = copy(existing);
    const step = assertStep(draft, input.stepId);
    step.lastWorkerResultId = input.resultId;
    step.workerResult = { id: input.resultId, ...(input.summary === undefined ? {} : { summary: input.summary }) };
    step.status = 'VERIFYING';
    draft.status = 'VERIFYING';
    draft.updatedAt = Date.now();
    await persistSnapshot(draft);
    runs.set(input.runId, draft);
    return { run: copy(draft), alreadyAccepted: false };
  });
}

export interface VerificationInput {
  runId: string;
  stepId: string;
  verdict: 'PASS' | 'DEFECT';
  summary?: string;
}

export async function recordVerification(input: VerificationInput): Promise<OrchestratorRun> {
  return mutate(input.runId, run => {
    if (terminal(run)) fail('RUN_TERMINAL');
    const step = assertStep(run, input.stepId);
    if (run.status !== 'VERIFYING' || step.status !== 'VERIFYING' || !step.lastWorkerResultId) fail('NOT_VERIFYING');
    const verifiedAt = Date.now();
    step.verificationResult = {
      verdict: input.verdict,
      verifiedAt,
      ...(input.summary === undefined ? {} : { summary: input.summary })
    };
    run.lastCheckpointAt = verifiedAt;
    if (input.verdict === 'DEFECT') {
      step.status = 'DEFECT';
      run.status = 'BLOCKED';
      run.blockerReason = input.summary ?? 'Verifier reported a defect';
      return;
    }
    step.status = 'COMPLETED';
    delete step.assignedWorkerId;
    delete run.blockerReason;
    if (run.currentStepIndex === run.steps.length - 1) {
      run.status = 'COMPLETED';
    } else {
      run.currentStepIndex += 1;
      run.status = 'RUNNING';
    }
  });
}

export async function prepareRepair(runId: string, stepId: string, workerId: string): Promise<OrchestratorRun> {
  return mutate(runId, run => {
    if (terminal(run)) fail('RUN_TERMINAL');
    const step = assertStep(run, stepId);
    if (run.status !== 'BLOCKED' || step.status !== 'DEFECT') fail('NOT_DEFECT');
    step.generation += 1;
    step.attemptCount += 1;
    step.assignedWorkerId = workerId;
    delete step.lastWorkerResultId;
    delete step.workerResult;
    delete step.verificationResult;
    step.status = 'ACTIVE';
    run.status = 'WAITING_WORKER';
    delete run.blockerReason;
  });
}

export async function cancelRun(runId: string): Promise<OrchestratorRun> {
  return mutate(runId, run => {
    if (terminal(run)) fail('RUN_TERMINAL');
    run.status = 'CANCELED';
    run.lastCheckpointAt = Date.now();
  });
}

export function resetOrchestratorForTests(): void {
  runs.clear();
  storeQueue = Promise.resolve();
}
