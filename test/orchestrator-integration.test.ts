import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import {
  restoreOrchestratorRuns,
  resetOrchestratorForTests
} from '../src/main/orchestrator/conductor.js';
import type { FileEffect } from '../src/main/orchestrator/types.js';
import {
  stagesToStepInputs,
  createOrchestratorDriver,
  type OrchestratorDriver
} from '../src/main/orchestrator/driver.js';
import {
  resetAgentsForTests,
  onWorkerReportCommitted,
  type CommittedWorkerReport
} from '../src/main/agents.js';
import { initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';

function mockReport(workerId: string, messageId: string, result: string): CommittedWorkerReport {
  return {
    runId: 'swarm-run-1',
    workerId,
    messageId,
    result,
    reportMessage: {
      id: messageId,
      from: workerId,
      to: 'prime',
      text: result,
      time: Date.now(),
      offeredAt: null,
      offers: 0,
      offeredOnFinish: false,
      offeredViaRevival: false,
      ackedAt: null
    },
    agentInfo: {
      id: workerId,
      role: 'worker',
      label: workerId,
      task: 'Task',
      state: 'sleeping',
      createdAt: Date.now(),
      activatedAt: Date.now(),
      finishedAt: null,
      result,
      pending: 0,
      awaitingAck: 0,
      delivered: 1,
      conversationId: null,
      detachedAt: null,
      lastSeenAt: Date.now(),
      sleptAt: Date.now(),
      revivable: true,
      contextTokens: 1000,
      reasoningEffort: null,
      model: null
    }
  };
}

describe('Orchestrator Phase 2 Integration Slice', () => {
  let dir: string;
  let driver: OrchestratorDriver;

  beforeEach(async () => {
    dir = await makeTempDir('orch-p2-test-');
    initDurableStore(dir);
    initSessionStore(dir);
    resetOrchestratorForTests();
    resetAgentsForTests();
    driver = createOrchestratorDriver();
  });

  afterEach(async () => {
    driver?.dispose();
    resetOrchestratorForTests();
    resetAgentsForTests();
    resetSessionStoreForTests();
    resetDurableForTests();
    await removeTempDir(dir);
  });

  // 1. Stage mapping
  it('1. maps Goal/Loop plan stages to StepInput[] preserving deterministic order without hallucinated criteria', () => {
    const stages = [
      'Implement data model and types',
      'Verify unit tests and boundary conditions',
      'Run end-to-end integration and sanity checks'
    ];
    const steps = stagesToStepInputs(stages);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({
      id: 'step-0',
      title: 'Stage 1',
      instructions: 'Implement data model and types',
      acceptanceCriteria: [] // No hallucinated criteria
    });
    expect(steps[1]).toEqual({
      id: 'step-1',
      title: 'Stage 2',
      instructions: 'Verify unit tests and boundary conditions',
      acceptanceCriteria: []
    });
    expect(steps[2]).toEqual({
      id: 'step-2',
      title: 'Stage 3',
      instructions: 'Run end-to-end integration and sanity checks',
      acceptanceCriteria: []
    });
  });

  // 2. Sequential worker assignment
  it('2. assigns exactly one worker to RUNNING/PENDING step and forbids parallel worker assignment', async () => {
    const steps = stagesToStepInputs(['First task', 'Second task']);
    const run = await driver.createRun({
      id: 'run-seq-1',
      ownerConversationId: 'prime-conv-1',
      projectId: 'proj-1',
      objective: 'Sequential test',
      steps
    });
    expect(run.status).toBe('RUNNING');
    expect(run.steps[0]?.status).toBe('PENDING');

    const updated = await driver.assignCurrentStepWorker('run-seq-1', 'worker-1');
    expect(updated.status).toBe('WAITING_WORKER');
    expect(updated.steps[0]?.status).toBe('ACTIVE');
    expect(updated.steps[0]?.assignedWorkerId).toBe('worker-1');
    expect(updated.steps[0]?.generation).toBe(1);

    // Attempting to assign a second worker for the same active step must be rejected
    await expect(driver.assignCurrentStepWorker('run-seq-1', 'worker-2')).rejects.toThrow(/ACTIVE_ASSIGNMENT/);
    const unchanged = driver.getRun('run-seq-1');
    expect(unchanged?.steps[0]?.assignedWorkerId).toBe('worker-1');
  });

  // 3. Correct worker result routing
  it('3. routes committed worker result from assigned worker into WAITING_WORKER -> VERIFYING', async () => {
    const steps = stagesToStepInputs(['Task 1']);
    await driver.createRun({
      id: 'run-route-1',
      ownerConversationId: 'prime-conv-1',
      projectId: 'proj-1',
      objective: 'Route test',
      steps
    });
    await driver.assignCurrentStepWorker('run-route-1', 'worker-1');

    const committedReport = mockReport('worker-1', 'msg-rep-1', 'Finished implementation with all requirements met');
    const outcome = await driver.handleCommittedWorkerReport('run-route-1', committedReport);
    expect(outcome.handled).toBe(true);

    const run = driver.getRun('run-route-1');
    expect(run?.status).toBe('VERIFYING');
    expect(run?.steps[0]?.status).toBe('VERIFYING');
    expect(run?.steps[0]?.lastWorkerResultId).toBe('msg-rep-1');
    expect(run?.steps[0]?.workerResult?.summary).toBe('Finished implementation with all requirements met');
  });

  // 4. Wrong-worker rejection
  it('4. rejects committed report from worker != assignedWorkerId and leaves conductor state unchanged', async () => {
    const steps = stagesToStepInputs(['Task 1']);
    await driver.createRun({
      id: 'run-wrong-1',
      ownerConversationId: 'prime-conv-1',
      projectId: 'proj-1',
      objective: 'Wrong worker test',
      steps
    });
    await driver.assignCurrentStepWorker('run-wrong-1', 'worker-1');

    const wrongWorkerReport = mockReport('worker-99', 'msg-wrong-1', 'Intruder report');
    const outcome = await driver.handleCommittedWorkerReport('run-wrong-1', wrongWorkerReport);
    expect(outcome.handled).toBe(false);
    expect(outcome.reason).toBe('WRONG_WORKER');

    const run = driver.getRun('run-wrong-1');
    expect(run?.status).toBe('WAITING_WORKER');
    expect(run?.steps[0]?.status).toBe('ACTIVE');
    expect(run?.steps[0]?.lastWorkerResultId).toBeUndefined();
  });

  // 5. Duplicate delivery idempotency
  it('5. handles duplicate delivery of the same committed AgentMessage idempotently', async () => {
    const steps = stagesToStepInputs(['Task 1']);
    await driver.createRun({
      id: 'run-dup-1',
      ownerConversationId: 'prime-conv-1',
      projectId: 'proj-1',
      objective: 'Dup test',
      steps
    });
    await driver.assignCurrentStepWorker('run-dup-1', 'worker-1');

    const report = mockReport('worker-1', 'msg-rep-dup', 'Done once');
    const first = await driver.handleCommittedWorkerReport('run-dup-1', report);
    expect(first.handled).toBe(true);
    expect(first.alreadyAccepted).toBe(false);

    // Second delivery of same message
    const second = await driver.handleCommittedWorkerReport('run-dup-1', report);
    expect(second.handled).toBe(true);
    expect(second.alreadyAccepted).toBe(true);

    const run = driver.getRun('run-dup-1');
    expect(run?.status).toBe('VERIFYING');
    expect(run?.steps[0]?.generation).toBe(1);
    expect(run?.steps[0]?.lastWorkerResultId).toBe('msg-rep-dup');
  });

  // 6. Stale generation result
  it('6. rejects delayed worker result from earlier generation without altering conductor state', async () => {
    const steps = stagesToStepInputs(['Task 1']);
    await driver.createRun({
      id: 'run-stale-1',
      ownerConversationId: 'prime-conv-1',
      projectId: 'proj-1',
      objective: 'Stale test',
      steps
    });
    await driver.assignCurrentStepWorker('run-stale-1', 'worker-1');

    const staleReport = mockReport('worker-1', 'msg-old-gen', 'Late report from gen 0');
    const outcome = await driver.handleCommittedWorkerReport('run-stale-1', staleReport, { forceGeneration: 0 });
    expect(outcome.handled).toBe(false);
    expect(outcome.reason).toMatch(/STALE_GENERATION/);

    const run = driver.getRun('run-stale-1');
    expect(run?.status).toBe('WAITING_WORKER');
    expect(run?.steps[0]?.lastWorkerResultId).toBeUndefined();
  });

  // 7. Independent verifier dispatch
  it('7. dispatches distinct verifier worker/session and forbids worker self-verification', async () => {
    const steps = stagesToStepInputs(['Task 1']);
    await driver.createRun({
      id: 'run-verif-dispatch',
      ownerConversationId: 'prime-conv-1',
      projectId: 'proj-1',
      objective: 'Verifier dispatch test',
      steps
    });
    await driver.assignCurrentStepWorker('run-verif-dispatch', 'worker-1');

    const report = mockReport('worker-1', 'msg-verif-1', 'Done task');
    await driver.handleCommittedWorkerReport('run-verif-dispatch', report);

    // Attempting to verify using the mutation worker itself must be rejected!
    await expect(driver.dispatchVerifier('run-verif-dispatch', 'worker-1')).rejects.toThrow(/SELF_VERIFICATION_FORBIDDEN/);

    // Dispatching with distinct verifier succeeds
    const verifierTask = await driver.dispatchVerifier('run-verif-dispatch', 'verifier-1');
    expect(verifierTask.verifierId).toBe('verifier-1');
    expect(verifierTask.instructions).toBe('Task 1');
    expect(verifierTask.workerResultSummary).toBe('Done task');
  });

  // 8. Verifier PASS
  it('8. advances conductor when verifier reports explicit PASS', async () => {
    const steps = stagesToStepInputs(['Step 1', 'Step 2']);
    await driver.createRun({
      id: 'run-pass-1',
      ownerConversationId: 'prime-conv-1',
      projectId: 'proj-1',
      objective: 'Pass test',
      steps
    });
    await driver.assignCurrentStepWorker('run-pass-1', 'worker-1');
    await driver.handleCommittedWorkerReport('run-pass-1', mockReport('worker-1', 'msg-p1', 'Step 1 complete'));
    await driver.dispatchVerifier('run-pass-1', 'verifier-1');

    const result = await driver.handleVerifierReport('run-pass-1', 'verifier-1', 'VERDICT: PASS - all acceptance criteria verified');
    expect(result.status).toBe('RUNNING');
    expect(result.currentStepIndex).toBe(1);
    expect(result.steps[0]?.status).toBe('COMPLETED');
    expect(result.steps[0]?.verificationResult?.verdict).toBe('PASS');
    expect(result.steps[1]?.status).toBe('PENDING');
  });

  // 9. Verifier DEFECT
  it('9. blocks conductor and preserves defect detail when verifier reports explicit DEFECT', async () => {
    const steps = stagesToStepInputs(['Step 1']);
    await driver.createRun({
      id: 'run-defect-1',
      ownerConversationId: 'prime-conv-1',
      projectId: 'proj-1',
      objective: 'Defect test',
      steps
    });
    await driver.assignCurrentStepWorker('run-defect-1', 'worker-1');
    await driver.handleCommittedWorkerReport('run-defect-1', mockReport('worker-1', 'msg-d1', 'Step 1 complete'));
    await driver.dispatchVerifier('run-defect-1', 'verifier-1');

    const result = await driver.handleVerifierReport('run-defect-1', 'verifier-1', 'VERDICT: DEFECT - missing edge case handling');
    expect(result.status).toBe('BLOCKED');
    expect(result.steps[0]?.status).toBe('DEFECT');
    expect(result.blockerReason).toBe('missing edge case handling');
    expect(result.steps[0]?.verificationResult?.verdict).toBe('DEFECT');
  });

  // 10. Malformed verifier output fails closed
  it('10. fails closed as DEFECT when verifier output is ambiguous or missing explicit VERDICT marker', async () => {
    const steps = stagesToStepInputs(['Step 1']);
    await driver.createRun({
      id: 'run-malformed-1',
      ownerConversationId: 'prime-conv-1',
      projectId: 'proj-1',
      objective: 'Malformed test',
      steps
    });
    await driver.assignCurrentStepWorker('run-malformed-1', 'worker-1');
    await driver.handleCommittedWorkerReport('run-malformed-1', mockReport('worker-1', 'msg-m1', 'Step 1 complete'));
    await driver.dispatchVerifier('run-malformed-1', 'verifier-1');

    // Casual response without explicit VERDICT marker
    const result = await driver.handleVerifierReport('run-malformed-1', 'verifier-1', 'I reviewed the code and everything looks wonderful!');
    expect(result.status).toBe('BLOCKED'); // Must fail closed, NEVER pass!
    expect(result.steps[0]?.status).toBe('DEFECT');
    expect(result.blockerReason).toContain('Malformed verifier output');
  });

  // 11. Repair generation
  it('11. prepares repair from defect, increments generation, and invalidates previous reports', async () => {
    const steps = stagesToStepInputs(['Step 1']);
    await driver.createRun({
      id: 'run-repair-1',
      ownerConversationId: 'prime-conv-1',
      projectId: 'proj-1',
      objective: 'Repair test',
      steps
    });
    await driver.assignCurrentStepWorker('run-repair-1', 'worker-1');
    await driver.handleCommittedWorkerReport('run-repair-1', mockReport('worker-1', 'msg-r1', 'Step 1 complete'));
    await driver.dispatchVerifier('run-repair-1', 'verifier-1');
    await driver.handleVerifierReport('run-repair-1', 'verifier-1', 'VERDICT: DEFECT - broken tests');

    const repaired = await driver.prepareRepair('run-repair-1', 'worker-repair-1');
    expect(repaired.status).toBe('WAITING_WORKER');
    expect(repaired.steps[0]?.status).toBe('ACTIVE');
    expect(repaired.steps[0]?.generation).toBe(2);
    expect(repaired.steps[0]?.attemptCount).toBe(2);
    expect(repaired.steps[0]?.assignedWorkerId).toBe('worker-repair-1');
    expect(repaired.steps[0]?.lastWorkerResultId).toBeUndefined();

    // A stale result carrying generation 1 must now be rejected
    const staleResult = await driver.handleCommittedWorkerReport(
      'run-repair-1',
      mockReport('worker-1', 'msg-r1-late', 'Late report from first attempt'),
      { forceGeneration: 1 }
    );
    expect(staleResult.handled).toBe(false);
  });

  // 12. Restart — WAITING_WORKER
  it('12. handles restart during WAITING_WORKER without duplicate worker spawn or replayed mutation', async () => {
    const steps = stagesToStepInputs(['Step 1']);
    await driver.createRun({
      id: 'run-restart-ww',
      ownerConversationId: 'prime-conv-1',
      projectId: 'proj-1',
      objective: 'Restart WW test',
      steps
    });
    await driver.assignCurrentStepWorker('run-restart-ww', 'worker-1');

    // Simulate process restart
    resetOrchestratorForTests();
    await restoreOrchestratorRuns();
    const restored = driver.getRun('run-restart-ww');
    expect(restored?.status).toBe('WAITING_WORKER');
    expect(restored?.steps[0]?.assignedWorkerId).toBe('worker-1');
    expect(restored?.steps[0]?.generation).toBe(1);

    // Reconcile: worker-1 is still the authoritative assigned worker, do NOT spawn duplicate
    const activeWorkers = new Set(['worker-1']);
    const actions = await driver.reconcileOnStartup(activeWorkers);
    expect(actions.spawnedWorkers).toHaveLength(0); // Zero duplicate workers spawned!
  });

  // 13. Restart — VERIFYING
  it('13. handles restart during VERIFYING without rerunning mutation worker', async () => {
    const steps = stagesToStepInputs(['Step 1']);
    await driver.createRun({
      id: 'run-restart-verif',
      ownerConversationId: 'prime-conv-1',
      projectId: 'proj-1',
      objective: 'Restart Verif test',
      steps
    });
    await driver.assignCurrentStepWorker('run-restart-verif', 'worker-1');
    await driver.handleCommittedWorkerReport('run-restart-verif', mockReport('worker-1', 'msg-rv-1', 'Finished work'));

    // Worker result is durably accepted: status is VERIFYING
    expect(driver.getRun('run-restart-verif')?.status).toBe('VERIFYING');

    // Process restart occurs
    resetOrchestratorForTests();
    await restoreOrchestratorRuns();

    const restored = driver.getRun('run-restart-verif');
    expect(restored?.status).toBe('VERIFYING');
    expect(restored?.steps[0]?.lastWorkerResultId).toBe('msg-rv-1');

    // Reconcile must NEVER rerun mutation worker!
    const actions = await driver.reconcileOnStartup(new Set());
    expect(actions.rerunMutationWorkers).toHaveLength(0);
  });

  // 14. Cancellation
  it('14. cancels run, prevents subsequent advancement, and rejects late reports', async () => {
    const steps = stagesToStepInputs(['Step 1']);
    await driver.createRun({
      id: 'run-cancel-1',
      ownerConversationId: 'prime-conv-1',
      projectId: 'proj-1',
      objective: 'Cancel test',
      steps
    });
    await driver.assignCurrentStepWorker('run-cancel-1', 'worker-1');

    const canceled = await driver.cancelActiveRun('run-cancel-1');
    expect(canceled.status).toBe('CANCELED');

    // Late worker report on canceled run must be rejected
    const lateReport = mockReport('worker-1', 'msg-late', 'Late answer');
    const outcome = await driver.handleCommittedWorkerReport('run-cancel-1', lateReport);
    expect(outcome.handled).toBe(false);
    expect(outcome.reason).toMatch(/RUN_TERMINAL/);

    // Late verifier report on canceled run must be rejected
    await expect(driver.handleVerifierReport('run-cancel-1', 'verifier-1', 'VERDICT: PASS')).rejects.toThrow(/RUN_TERMINAL/);
  });

  // 15. File-effect durability (Conductor-owned transition)
  it('15. records file effect through conductor-owned transition and preserves it across restart without direct mutation', async () => {
    const steps = stagesToStepInputs(['Step 1']);
    await driver.createRun({
      id: 'run-file-eff',
      ownerConversationId: 'prime-conv-1',
      projectId: 'proj-1',
      objective: 'File effect test',
      steps
    });
    await driver.assignCurrentStepWorker('run-file-eff', 'worker-1');

    const effect: FileEffect = {
      path: 'src/main/example.ts',
      beforeHash: 'abc001',
      afterHash: 'def002',
      delta: { added: 10, removed: 2 },
      stepId: 'step-0'
    };

    const updated = await driver.recordFileEffect('run-file-eff', 'step-0', 1, effect);
    expect(updated.steps[0]?.fileEffects).toHaveLength(1);
    expect(updated.steps[0]?.fileEffects[0]).toEqual(effect);

    // Restart and verify durable persistence
    resetOrchestratorForTests();
    await restoreOrchestratorRuns();

    const restored = driver.getRun('run-file-eff');
    expect(restored?.steps[0]?.fileEffects).toHaveLength(1);
    expect(restored?.steps[0]?.fileEffects[0]).toEqual(effect);
  });

  describe('Adversarial Scenarios', () => {
    // A1: verifier report delivered twice
    it('A1. rejects duplicate verifier report delivery on already advanced step', async () => {
      const steps = stagesToStepInputs(['Step 1']);
      await driver.createRun({
        id: 'run-adv-vdup',
        ownerConversationId: 'c1',
        projectId: 'p1',
        objective: 'Adv VDup',
        steps
      });
      await driver.assignCurrentStepWorker('run-adv-vdup', 'worker-1');
      await driver.handleCommittedWorkerReport('run-adv-vdup', mockReport('worker-1', 'm1', 'done'));
      await driver.dispatchVerifier('run-adv-vdup', 'verifier-1');
      await driver.handleVerifierReport('run-adv-vdup', 'verifier-1', 'VERDICT: PASS');

      // Attempting to deliver second verifier report must fail because run is completed / not verifying
      await expect(driver.handleVerifierReport('run-adv-vdup', 'verifier-1', 'VERDICT: PASS')).rejects.toThrow(/RUN_TERMINAL/);
    });

    // A2: old verifier returns after prepareRepair
    it('A2. rejects old verifier report returning after prepareRepair has advanced generation', async () => {
      const steps = stagesToStepInputs(['Step 1']);
      await driver.createRun({
        id: 'run-adv-oldv',
        ownerConversationId: 'c1',
        projectId: 'p1',
        objective: 'Adv OldV',
        steps
      });
      await driver.assignCurrentStepWorker('run-adv-oldv', 'worker-1');
      await driver.handleCommittedWorkerReport('run-adv-oldv', mockReport('worker-1', 'm1', 'done'));
      await driver.dispatchVerifier('run-adv-oldv', 'verifier-1');
      await driver.handleVerifierReport('run-adv-oldv', 'verifier-1', 'VERDICT: DEFECT - broken');

      // Prepare repair for next generation
      await driver.prepareRepair('run-adv-oldv', 'worker-repair-1');

      // Late verifier report from previous attempt must fail
      await expect(driver.handleVerifierReport('run-adv-oldv', 'verifier-1', 'VERDICT: PASS')).rejects.toThrow(/NOT_VERIFYING/);
    });

    // A3: worker durable commit failure never triggers worker report listener
    it('A3. worker durable commit failure prevents onWorkerReportCommitted from firing', async () => {
      const { stageFinishAgent, onSwarmPersistNow, persistCriticalSwarmNow, spawn, bindConversation } = await import('../src/main/agents.js');
      const caller = { conversationId: 'prime-c1' };
      spawn({ caller, workers: [{ task: 'work' }] });
      bindConversation('worker-1', 'worker-chat-1');

      let listenerFired = false;
      const unhook = onWorkerReportCommitted(() => {
        listenerFired = true;
      });

      // Simulate durable commit failure
      onSwarmPersistNow(async () => {
        throw new Error('DISK_IO_FAILURE');
      });

      const staged = stageFinishAgent({ conversationId: 'worker-chat-1' }, 'attempted report');
      await expect(persistCriticalSwarmNow()).rejects.toThrow(/DISK_IO_FAILURE/);
      staged.rollback();

      // Listener MUST NOT have fired on rolled-back/failed commit!
      expect(listenerFired).toBe(false);

      unhook();
    });

    // A4: Goal/Loop canceled while worker is finishing
    it('A4. cancellation racing with worker finish rejects the late result safely', async () => {
      const steps = stagesToStepInputs(['Step 1']);
      await driver.createRun({
        id: 'run-adv-cancel-race',
        ownerConversationId: 'c1',
        projectId: 'p1',
        objective: 'Cancel race',
        steps
      });
      await driver.assignCurrentStepWorker('run-adv-cancel-race', 'worker-1');

      // User triggers cancel before result arrives
      await driver.cancelActiveRun('run-adv-cancel-race');

      // In-flight worker report arrives
      const lateReport = mockReport('worker-1', 'm-race', 'Finished just now');
      const outcome = await driver.handleCommittedWorkerReport('run-adv-cancel-race', lateReport);
      expect(outcome.handled).toBe(false);
      expect(outcome.reason).toMatch(/RUN_TERMINAL/);

      const run = driver.getRun('run-adv-cancel-race');
      expect(run?.status).toBe('CANCELED');
    });

    // A5: legacy non-Orchestrator Goal and Loop execution remains untouched
    it('A5. legacy Goal and Loop switches and behaviors function completely independently', async () => {
      const { goalSwitchFor, setGoalSwitchNow } = await import('../src/main/goal.js');
      const testChat = 'legacy-chat-' + Date.now();
      expect(goalSwitchFor(testChat).enabled).toBe(false);

      // Toggling goal on legacy chat functions normally
      const toggled = await setGoalSwitchNow(testChat, 'goal', true);
      expect(toggled.enabled).toBe(true);
      expect(toggled.mode).toBe('goal');
      expect(goalSwitchFor(testChat).enabled).toBe(true);

      // Turning it off works normally
      const off = await setGoalSwitchNow(testChat, 'goal', false);
      expect(off.enabled).toBe(false);
    });
  });

  describe('HEAD Review Tests A-G: Goal & Loop Independence and Agents Isolation', () => {
    // TEST A — LEGACY GOAL WITH NO ORCHESTRATOR
    it('TEST A: legacy Goal executes normally with no OrchestratorRun or verifier spawned', async () => {
      const { setGoalSwitchNow, goalSwitchFor, acceptGoalReplyNow, goalPendingReplyFor } = await import('../src/main/goal.js');
      const { getRun } = await import('../src/main/orchestrator/conductor.js');
      const convId = 'test-a-goal-conv-' + Date.now();
      const sessionId = 'session-a-' + Date.now();
      const replyId = 'reply-a-' + Date.now();
      const turnId = 'turn-a-' + Date.now();

      await setGoalSwitchNow(convId, 'goal', true);
      expect(goalSwitchFor(convId).enabled).toBe(true);
      expect(goalSwitchFor(convId).mode).toBe('goal');
      expect(getRun(convId)).toBeUndefined();

      await acceptGoalReplyNow({
        conversationId: convId,
        sessionId,
        replyId,
        turnId,
        eventSeq: 1,
        blocked: false
      });

      // Invariants: No orchestrator run created, no verifier, legacy Goal obligation behaves identically
      expect(getRun(convId)).toBeUndefined();
      expect(getRun(sessionId)).toBeUndefined();
      const pending = goalPendingReplyFor(convId);
      expect(pending).not.toBeNull();
      expect(pending?.replyId).toBe(replyId);
    });

    // TEST B — LEGACY LOOP WITH NO ORCHESTRATOR
    it('TEST B: legacy Loop executes normally with no OrchestratorRun or verifier spawned', async () => {
      const { setGoalSwitchNow, goalSwitchFor, loopAfterTurnFor } = await import('../src/main/goal.js');
      const { getRun } = await import('../src/main/orchestrator/conductor.js');
      const convId = 'test-b-loop-conv-' + Date.now();

      await setGoalSwitchNow(convId, 'loop', true, true);
      expect(goalSwitchFor(convId).enabled).toBe(true);
      expect(goalSwitchFor(convId).mode).toBe('loop');
      expect(loopAfterTurnFor(convId)).toBe(true);

      // Invariants: No orchestrator run created, no verifier
      expect(getRun(convId)).toBeUndefined();
    });

    // TEST C — ORDINARY AGENT WITHOUT ORCHESTRATOR
    it('TEST C: ordinary Agents worker task delivers report to Prime, untouched by Orchestrator', async () => {
      const { spawn, bindConversation, stageFinishAgent, persistCriticalSwarmNow, offerMessagesForConversation } = await import('../src/main/agents.js');
      const { getRun } = await import('../src/main/orchestrator/conductor.js');
      const primeConv = 'test-c-prime-' + Date.now();
      const workerConv = 'test-c-worker-' + Date.now();

      spawn({ caller: { conversationId: primeConv }, workers: [{ task: 'regular agent work' }] });
      bindConversation('worker-1', workerConv);

      const staged = stageFinishAgent({ conversationId: workerConv }, 'regular worker finished successfully');
      await persistCriticalSwarmNow();
      staged.commit();

      // Normal report delivered to prime
      const msgs = offerMessagesForConversation(primeConv)?.messages ?? [];
      expect(msgs.some(m => m.text.includes('regular worker finished successfully'))).toBe(true);

      // Orchestrator did not claim it, created no run, made no state change
      expect(getRun('worker-1')).toBeUndefined();
      expect(getRun(workerConv)).toBeUndefined();
      expect(getRun(primeConv)).toBeUndefined();
    });

    // TEST D — ORCHESTRATOR EXPLICIT ACTIVATION
    it('TEST D: explicit Orchestrator run correlates driver, worker result, and verifier strictly to itself', async () => {
      const orchConv = 'test-d-orch-' + Date.now();
      const legacyConv = 'test-d-legacy-' + Date.now();
      const { setGoalSwitchNow, goalSwitchFor } = await import('../src/main/goal.js');
      await setGoalSwitchNow(legacyConv, 'goal', true);

      const run = await driver.createRun({
        id: 'run-d-explicit',
        ownerConversationId: orchConv,
        projectId: 'proj-d',
        objective: 'Explicit activation test',
        steps: stagesToStepInputs(['Step 1'])
      });
      expect(run.status).toBe('RUNNING');

      await driver.assignCurrentStepWorker('run-d-explicit', 'worker-d1');
      expect(driver.getRun('run-d-explicit')?.status).toBe('WAITING_WORKER');

      const outcome = await driver.handleCommittedWorkerReport('run-d-explicit', mockReport('worker-d1', 'msg-d1', 'Result 1'));
      expect(outcome.handled).toBe(true);
      expect(driver.getRun('run-d-explicit')?.status).toBe('VERIFYING');

      const verifierTask = await driver.dispatchVerifier('run-d-explicit', 'verifier-d1');
      expect(verifierTask.verifierId).toBe('verifier-d1');

      const verified = await driver.handleVerifierReport('run-d-explicit', 'verifier-d1', 'VERDICT: PASS');
      expect(verified.status).toBe('COMPLETED');

      // Unrelated legacy Goal conversation remains completely untouched
      expect(goalSwitchFor(legacyConv).enabled).toBe(true);
      expect(driver.getRun(legacyConv)).toBeUndefined();
    });

    // TEST E — MULTIPLE CONVERSATIONS ISOLATION
    it('TEST E: cross-conversation worker reports do not cross-route or affect other runs', async () => {
      const { setGoalSwitchNow, goalSwitchFor } = await import('../src/main/goal.js');
      const convA = 'conv-a-orch-' + Date.now();
      const convB = 'conv-b-goal-' + Date.now();
      await setGoalSwitchNow(convB, 'goal', true);

      await driver.createRun({
        id: 'run-a-multi',
        ownerConversationId: convA,
        projectId: 'proj-a',
        objective: 'Run A',
        steps: stagesToStepInputs(['Task A'])
      });
      await driver.assignCurrentStepWorker('run-a-multi', 'worker-a');

      // Worker B from conversation B attempts to report to run A -> rejected
      const reportB = mockReport('worker-b', 'msg-b', 'Work for B');
      const outcomeB = await driver.handleCommittedWorkerReport('run-a-multi', reportB);
      expect(outcomeB.handled).toBe(false);
      expect(outcomeB.reason).toBe('WRONG_WORKER');
      expect(driver.getRun('run-a-multi')?.status).toBe('WAITING_WORKER');

      // Worker A from conversation A -> accepted
      const reportA = mockReport('worker-a', 'msg-a', 'Work for A');
      const outcomeA = await driver.handleCommittedWorkerReport('run-a-multi', reportA);
      expect(outcomeA.handled).toBe(true);
      expect(driver.getRun('run-a-multi')?.status).toBe('VERIFYING');

      // Conversation B goal switch remains untouched
      expect(goalSwitchFor(convB).enabled).toBe(true);
    });

    // TEST F — LISTENER FAILURE ISOLATION
    it('TEST F: listener throwing an error does not destabilize Agents completion or lose reports', async () => {
      const { spawn, bindConversation, stageFinishAgent, persistCriticalSwarmNow, offerMessagesForConversation } = await import('../src/main/agents.js');
      const primeConv = 'test-f-prime-' + Date.now();
      const workerConv = 'test-f-worker-' + Date.now();

      spawn({ caller: { conversationId: primeConv }, workers: [{ task: 'fault tolerance task' }] });
      bindConversation('worker-1', workerConv);

      // Register an explosive listener
      const unhook = onWorkerReportCommitted(() => {
        throw new Error('EXPLOSIVE_ORCHESTRATOR_LISTENER');
      });

      try {
        const staged = stageFinishAgent({ conversationId: workerConv }, 'durable result despite listener explosion');
        await persistCriticalSwarmNow();
        expect(() => staged.commit()).not.toThrow();

        // Prime report must be preserved
        const msgs = offerMessagesForConversation(primeConv)?.messages ?? [];
        expect(msgs.some(m => m.text.includes('durable result despite listener explosion'))).toBe(true);
      } finally {
        unhook();
      }
    });

    // TEST G — ORCHESTRATOR RESTORE FAILURE ISOLATION
    it('TEST G: corrupted Orchestrator durable state isolates failure without corrupting Goal/Loop state', async () => {
      const { writeDurableNow } = await import('../src/main/durable.js');
      const { setGoalSwitchNow, goalSwitchFor } = await import('../src/main/goal.js');
      const convG = 'test-g-goal-' + Date.now();
      await setGoalSwitchNow(convG, 'goal', true);

      // Write corrupted/malformed orchestrator runs snapshot
      await writeDurableNow('orchestrator-runs', { version: 1, runs: [null, { bad: true }] });

      // Restore orchestrator runs isolates the corrupt file and logs warning
      resetOrchestratorForTests();
      await expect(restoreOrchestratorRuns()).resolves.toBeUndefined();

      // Runs is cleanly empty (failure isolated)
      expect(driver.getRun('any-id')).toBeUndefined();

      // Goal state remains completely intact and uncorrupted
      expect(goalSwitchFor(convG).enabled).toBe(true);
    });
  });
});
