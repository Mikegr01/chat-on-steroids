import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import {
  assignWorker,
  cancelRun,
  createRun,
  getRun,
  latestRunForOwnerConversation,
  onOrchestratorRunChange,
  prepareRepair,
  recordVerification,
  recordWorkerResult,
  resetOrchestratorForTests,
  restoreOrchestratorRuns
} from '../src/main/orchestrator/conductor.js';

let dir: string;
const steps = [
  { id: 's1', title: 'First', instructions: 'Do first', acceptanceCriteria: ['first passes'] },
  { id: 's2', title: 'Second', instructions: 'Do second', acceptanceCriteria: ['second passes'] }
];

beforeEach(async () => {
  dir = await makeTempDir('clf-orchestrator-');
  initDurableStore(dir);
  resetOrchestratorForTests();
});

afterEach(async () => {
  resetOrchestratorForTests();
  resetDurableForTests();
  await removeTempDir(dir);
});

async function run() {
  return createRun({ id: 'run-1', ownerConversationId: 'c1', projectId: 'p1', objective: 'Finish it', steps });
}

describe('orchestrator conductor', () => {
  it('publishes only durable run transitions and resolves the latest run for an owner conversation', async () => {
    const observed: string[] = [];
    const unsubscribe = onOrchestratorRunChange((value) => observed.push(value.status));
    try {
      const first = await run();
      await createRun({
        id: 'run-2',
        ownerConversationId: 'c1',
        projectId: 'p1',
        objective: 'Second run',
        steps
      });
      expect(first.status).toBe('RUNNING');
      expect(observed).toEqual(['RUNNING', 'RUNNING']);
      expect(latestRunForOwnerConversation('c1')?.id).toBe('run-2');

      await assignWorker('run-2', 's1', 'worker-2');
      expect(observed.at(-1)).toBe('WAITING_WORKER');
      expect(latestRunForOwnerConversation('c1')?.status).toBe('WAITING_WORKER');
    } finally {
      unsubscribe();
    }
  });

  it('persists creation and restores the exact current run without replaying work', async () => {
    const created = await run();
    expect(created.currentStepIndex).toBe(0);
    expect(created.steps[0]?.status).toBe('PENDING');
    resetOrchestratorForTests();
    await restoreOrchestratorRuns();
    expect(getRun('run-1')).toEqual(created);

    await assignWorker('run-1', 's1', 'worker-1');
    const waiting = getRun('run-1');
    resetOrchestratorForTests();
    await restoreOrchestratorRuns();
    expect(getRun('run-1')).toEqual(waiting);
    expect(getRun('run-1')?.status).toBe('WAITING_WORKER');

    await recordWorkerResult({ runId: 'run-1', stepId: 's1', generation: 1, resultId: 'r1', summary: 'done' });
    const verifying = getRun('run-1');
    resetOrchestratorForTests();
    await restoreOrchestratorRuns();
    expect(getRun('run-1')).toEqual(verifying);
    expect(getRun('run-1')?.status).toBe('VERIFYING');
  });

  it('serializes one assignment and gives it a fresh generation', async () => {
    await run();
    const assigned = await assignWorker('run-1', 's1', 'worker-1');
    expect(assigned.steps[0]).toMatchObject({ status: 'ACTIVE', generation: 1, attemptCount: 1, assignedWorkerId: 'worker-1' });
    await expect(assignWorker('run-1', 's1', 'worker-2')).rejects.toThrow(/ACTIVE_ASSIGNMENT/);
    await expect(assignWorker('run-1', 's2', 'worker-2')).rejects.toThrow(/WRONG_STEP/);
  });

  it('rejects wrong ownership and only moves an accepted worker result to VERIFYING', async () => {
    await run();
    await assignWorker('run-1', 's1', 'worker-1');
    await expect(recordWorkerResult({ runId: 'run-1', stepId: 's1', generation: 0, resultId: 'bad' })).rejects.toThrow(/STALE_GENERATION/);
    await expect(recordWorkerResult({ runId: 'run-1', stepId: 's2', generation: 1, resultId: 'bad2' })).rejects.toThrow(/WRONG_STEP/);
    const accepted = await recordWorkerResult({ runId: 'run-1', stepId: 's1', generation: 1, resultId: 'r1', summary: 'worker says done' });
    expect(accepted.alreadyAccepted).toBe(false);
    expect(accepted.run.steps[0]?.status).toBe('VERIFYING');
    expect(accepted.run.steps[0]?.status).not.toBe('COMPLETED');
    expect(accepted.run.currentStepIndex).toBe(0);
    const duplicate = await recordWorkerResult({ runId: 'run-1', stepId: 's1', generation: 1, resultId: 'r1', summary: 'worker says done' });
    expect(duplicate.alreadyAccepted).toBe(true);
    expect(duplicate.run.currentStepIndex).toBe(0);
    await expect(recordWorkerResult({ runId: 'run-1', stepId: 's1', generation: 1, resultId: 'r2' })).rejects.toThrow(/GENERATION_SETTLED/);
  });

  it('allows only verification PASS to complete and advance exactly one step', async () => {
    await run();
    await assignWorker('run-1', 's1', 'worker-1');
    await expect(recordVerification({ runId: 'run-1', stepId: 's1', verdict: 'PASS' })).rejects.toThrow(/NOT_VERIFYING/);
    await recordWorkerResult({ runId: 'run-1', stepId: 's1', generation: 1, resultId: 'r1' });
    const passed = await recordVerification({ runId: 'run-1', stepId: 's1', verdict: 'PASS', summary: 'verified' });
    expect(passed.steps[0]?.status).toBe('COMPLETED');
    expect(passed.currentStepIndex).toBe(1);
    expect(passed.steps[1]?.status).toBe('PENDING');
    expect(passed.status).toBe('RUNNING');
  });

  it('retains an exact defect, does not advance, and repair creates a fresh generation', async () => {
    await run();
    await assignWorker('run-1', 's1', 'worker-1');
    await recordWorkerResult({ runId: 'run-1', stepId: 's1', generation: 1, resultId: 'r1' });
    const defect = await recordVerification({ runId: 'run-1', stepId: 's1', verdict: 'DEFECT', summary: 'missing proof' });
    expect(defect.currentStepIndex).toBe(0);
    expect(defect.steps[0]?.status).toBe('DEFECT');
    expect(defect.blockerReason).toBe('missing proof');
    const repaired = await prepareRepair('run-1', 's1', 'worker-2');
    expect(repaired.steps[0]).toMatchObject({ status: 'ACTIVE', generation: 2, attemptCount: 2, assignedWorkerId: 'worker-2' });
    await expect(recordWorkerResult({ runId: 'run-1', stepId: 's1', generation: 1, resultId: 'late' })).rejects.toThrow(/STALE_GENERATION/);
  });

  it('makes cancellation and completion terminal', async () => {
    await run();
    await assignWorker('run-1', 's1', 'worker-1');
    await cancelRun('run-1');
    expect(getRun('run-1')?.status).toBe('CANCELED');
    await expect(recordWorkerResult({ runId: 'run-1', stepId: 's1', generation: 1, resultId: 'late' })).rejects.toThrow(/RUN_TERMINAL/);

    await createRun({ id: 'run-2', ownerConversationId: 'c1', projectId: 'p1', objective: 'One', steps: [steps[0]!] });
    await assignWorker('run-2', 's1', 'worker-1');
    await recordWorkerResult({ runId: 'run-2', stepId: 's1', generation: 1, resultId: 'r1' });
    const completed = await recordVerification({ runId: 'run-2', stepId: 's1', verdict: 'PASS' });
    expect(completed.status).toBe('COMPLETED');
    await expect(assignWorker('run-2', 's1', 'worker-2')).rejects.toThrow(/RUN_TERMINAL/);
    resetOrchestratorForTests();
    await restoreOrchestratorRuns();
    expect(getRun('run-2')?.status).toBe('COMPLETED');
  });

  it('concurrent_creates_for_different_runs_both_survive_restart', async () => {
    await Promise.all([
      createRun({ id: 'run-a', ownerConversationId: 'c1', projectId: 'p1', objective: 'A', steps }),
      createRun({ id: 'run-b', ownerConversationId: 'c2', projectId: 'p2', objective: 'B', steps })
    ]);
    expect(getRun('run-a')).toBeDefined();
    expect(getRun('run-b')).toBeDefined();

    resetOrchestratorForTests();
    await restoreOrchestratorRuns();

    expect(getRun('run-a')).toBeDefined();
    expect(getRun('run-b')).toBeDefined();
    expect(getRun('run-a')?.id).toBe('run-a');
    expect(getRun('run-b')?.id).toBe('run-b');
  });

  it('concurrent_cross_run_assignments_both_survive_restart', async () => {
    await createRun({ id: 'run-a', ownerConversationId: 'c1', projectId: 'p1', objective: 'A', steps });
    await createRun({ id: 'run-b', ownerConversationId: 'c2', projectId: 'p2', objective: 'B', steps });

    await Promise.all([
      assignWorker('run-a', 's1', 'worker-a'),
      assignWorker('run-b', 's1', 'worker-b')
    ]);

    expect(getRun('run-a')?.status).toBe('WAITING_WORKER');
    expect(getRun('run-b')?.status).toBe('WAITING_WORKER');

    resetOrchestratorForTests();
    await restoreOrchestratorRuns();

    expect(getRun('run-a')?.status).toBe('WAITING_WORKER');
    expect(getRun('run-b')?.status).toBe('WAITING_WORKER');
    expect(getRun('run-a')?.steps[0]?.assignedWorkerId).toBe('worker-a');
    expect(getRun('run-b')?.steps[0]?.assignedWorkerId).toBe('worker-b');
    expect(getRun('run-a')?.steps[0]?.generation).toBe(1);
    expect(getRun('run-b')?.steps[0]?.generation).toBe(1);
  });

  it('concurrent_cross_run_worker_results_both_survive_restart', async () => {
    await createRun({ id: 'run-a', ownerConversationId: 'c1', projectId: 'p1', objective: 'A', steps });
    await createRun({ id: 'run-b', ownerConversationId: 'c2', projectId: 'p2', objective: 'B', steps });
    await assignWorker('run-a', 's1', 'worker-a');
    await assignWorker('run-b', 's1', 'worker-b');

    await Promise.all([
      recordWorkerResult({ runId: 'run-a', stepId: 's1', generation: 1, resultId: 'res-a', summary: 'done a' }),
      recordWorkerResult({ runId: 'run-b', stepId: 's1', generation: 1, resultId: 'res-b', summary: 'done b' })
    ]);

    expect(getRun('run-a')?.status).toBe('VERIFYING');
    expect(getRun('run-b')?.status).toBe('VERIFYING');

    resetOrchestratorForTests();
    await restoreOrchestratorRuns();

    expect(getRun('run-a')?.status).toBe('VERIFYING');
    expect(getRun('run-b')?.status).toBe('VERIFYING');
    expect(getRun('run-a')?.steps[0]?.lastWorkerResultId).toBe('res-a');
    expect(getRun('run-b')?.steps[0]?.lastWorkerResultId).toBe('res-b');
  });

  it('shared_store_queue_survives_failed_commit', async () => {
    const { promises: nodeFs } = await import('node:fs');
    const realRename = nodeFs.rename.bind(nodeFs);
    let failNextRename = true;
    const { vi } = await import('vitest');
    const renameSpy = vi.spyOn(nodeFs, 'rename').mockImplementation(async (...args) => {
      if (failNextRename && String(args[1]).includes('orchestrator-runs')) {
        failNextRename = false;
        throw new Error('disk failure simulation');
      }
      return realRename(...args);
    });

    try {
      await expect(
        createRun({ id: 'run-fail', ownerConversationId: 'c1', projectId: 'p1', objective: 'Fail', steps })
      ).rejects.toThrow('disk failure simulation');

      expect(getRun('run-fail')).toBeUndefined();

      const recovered = await createRun({ id: 'run-ok', ownerConversationId: 'c1', projectId: 'p1', objective: 'OK', steps });
      expect(recovered.id).toBe('run-ok');
      expect(getRun('run-ok')).toBeDefined();

      resetOrchestratorForTests();
      await restoreOrchestratorRuns();
      expect(getRun('run-fail')).toBeUndefined();
      expect(getRun('run-ok')).toBeDefined();
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('rejected durable commit cannot resurrect from the retry queue', async () => {
    const { promises: nodeFs } = await import('node:fs');
    const realRename = nodeFs.rename.bind(nodeFs);
    let failNextRename = true;
    const { vi } = await import('vitest');
    const renameSpy = vi.spyOn(nodeFs, 'rename').mockImplementation(async (...args) => {
      if (failNextRename && String(args[1]).includes('orchestrator-runs')) {
        failNextRename = false;
        throw new Error('disk failure simulation');
      }
      return realRename(...args);
    });

    try {
      await expect(
        createRun({ id: 'run-rejected', ownerConversationId: 'c1', projectId: 'p1', objective: 'Rejected', steps })
      ).rejects.toThrow('disk failure simulation');
      expect(getRun('run-rejected')).toBeUndefined();

      await flushDurable();
      resetOrchestratorForTests();
      await restoreOrchestratorRuns();

      expect(getRun('run-rejected')).toBeUndefined();
    } finally {
      renameSpy.mockRestore();
    }
  });
});
