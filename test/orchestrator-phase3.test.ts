import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import {
  resetAgentsForTests,
  spawn,
  grantSpawnAuthorization,
  hasSpawnAuthorization,
  onSwarmPersistNow,
  onSpawnRequest,
  swarmState,
  type CommittedWorkerReport,
  type Caller
} from '../src/main/agents.js';
import { resetBridgeForTests } from '../src/main/bridge.js';
import {
  buildVerifierTask,
  createOrchestratorDriver,
  type OrchestratorDriver
} from '../src/main/orchestrator/driver.js';
import {
  getRun,
  resetOrchestratorForTests,
  restoreOrchestratorRuns
} from '../src/main/orchestrator/conductor.js';
import path from 'node:path';
import {
  defaultConfig,
  saveConfig,
  getConfig,
  initConfigPath
} from '../src/main/config.js';
import * as chatModels from '../src/main/chat-models.js';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  },
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined }
}));

function mockWorkerReport(
  workerId: string,
  messageId: string,
  result: string,
  orchestratorRunId?: string,
  orchestratorStepId?: string,
  executionRole?: 'worker' | 'verifier' | 'repair_worker'
): CommittedWorkerReport {
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
      task: 'Task brief',
      state: 'sleeping',
      createdAt: Date.now(),
      activatedAt: Date.now(),
      finishedAt: null,
      result,
      pending: 0,
      awaitingAck: 0,
      delivered: 1,
      conversationId: `conv-${workerId}`,
      detachedAt: null,
      lastSeenAt: Date.now(),
      sleptAt: Date.now(),
      revivable: true,
      contextTokens: 1000,
      reasoningEffort: null,
      model: null,
      origin: orchestratorRunId ? 'ORCHESTRATOR' : 'NORMAL_AUTO',
      orchestratorRunId,
      orchestratorStepId,
      executionRole
    }
  };
}

describe('ORCHESTRATOR_V2_PHASE3: Required Scenarios', () => {
  let dir: string;
  let driver: OrchestratorDriver;

  beforeEach(async () => {
    dir = await makeTempDir('orch-p3-test-');
    initConfigPath(path.join(dir, 'config.json'));
    initDurableStore(dir);
    initSessionStore(dir);
    resetOrchestratorForTests();
    resetAgentsForTests();
    resetBridgeForTests();
    driver = createOrchestratorDriver();

    // Setup base config with multiAgent enabled but workerPolicy=off
    const base = defaultConfig();
    await saveConfig({
      ...base,
      multiAgent: {
        ...base.multiAgent,
        enabled: true,
        maxWorkers: 4,
        workerPolicy: 'off',
        workerModelPolicy: 'auto',
        verifierModelPolicy: 'auto'
      }
    });

    // Provide observed chat models in catalog
    vi.spyOn(chatModels, 'getChatModels').mockReturnValue({
      state: 'ready',
      requestedAt: null,
      observedAt: Date.now(),
      models: [
        { id: 'gpt-5.6', label: 'GPT-5.6', efforts: ['none', 'low', 'medium', 'high'] },
        { id: 'gpt-5.5-preview', label: 'GPT-5.5 Preview', efforts: ['medium', 'high'] },
        { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['high'] }
      ]
    });
  });

  afterEach(async () => {
    driver?.dispose();
    resetOrchestratorForTests();
    resetAgentsForTests();
    resetBridgeForTests();
    resetSessionStoreForTests();
    resetDurableForTests();
    vi.restoreAllMocks();
    await removeTempDir(dir);
  });

  // 1. NORMAL OFF
  // workerPolicy=OFF
  // ordinary Prime calls agents spawn -> rejected, zero workers, zero bootstrap requests
  it('1. NORMAL OFF: ordinary Prime calls agents spawn is rejected with zero workers', async () => {
    const caller: Caller = { conversationId: 'prime-chat-1' };
    expect(() =>
      spawn({
        workers: [{ task: 'Independent task' }],
        caller
      })
    ).toThrow(/WORKER_SPAWN_DISABLED/);
  });

  // 2. NORMAL AUTO
  // workerPolicy=AUTO
  // ordinary Prime calls agents spawn -> existing spawn behavior succeeds
  it('2. NORMAL AUTO: ordinary Prime calls agents spawn succeeds when policy is AUTO', async () => {
    const base = getConfig();
    await saveConfig({
      ...base,
      multiAgent: {
        ...base.multiAgent,
        workerPolicy: 'auto'
      }
    });

    const caller: Caller = { conversationId: 'prime-chat-2' };
    const result = spawn({
      workers: [{ task: 'Independent task' }],
      caller
    });

    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.id).toBe('worker-1');
    expect(result.created[0]?.origin).toBe('NORMAL_AUTO');
  });

  // 3. ASK
  // workerPolicy=ASK
  // no grant -> SPAWN_AUTHORIZATION_REQUIRED, no worker
  // after valid grant -> spawn succeeds
  it('3. ASK: requires explicit authorization grant before spawn succeeds', async () => {
    const base = getConfig();
    await saveConfig({
      ...base,
      multiAgent: {
        ...base.multiAgent,
        workerPolicy: 'ask'
      }
    });

    const caller: Caller = { conversationId: 'prime-chat-ask' };

    // Without grant -> fails with SPAWN_AUTHORIZATION_REQUIRED
    expect(() =>
      spawn({
        workers: [{ task: 'Task needing approval' }],
        caller
      })
    ).toThrow(/SPAWN_AUTHORIZATION_REQUIRED/);

    // After valid grant -> succeeds
    grantSpawnAuthorization('prime-chat-ask');
    const result = spawn({
      workers: [{ task: 'Task needing approval' }],
      caller
    });
    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.origin).toBe('NORMAL_AUTHORIZED');
  });

  // 4. ORCH WITH NORMAL OFF
  // workerPolicy=OFF
  // ORCH explicitly started
  // Expected: Orchestrator worker spawn succeeds, unrelated normal Prime spawn remains blocked
  it('4. ORCH WITH NORMAL OFF: Orchestrator worker spawn succeeds while normal Prime spawn remains blocked', async () => {
    // Normal chat spawn must still fail
    expect(() =>
      spawn({
        workers: [{ task: 'Normal chat work' }],
        caller: { conversationId: 'prime-normal' }
      })
    ).toThrow(/WORKER_SPAWN_DISABLED/);

    // Orchestrator run creation & step assignment
    const run = await driver.createRun({
      id: 'run-orch-bypass-1',
      ownerConversationId: 'prime-orch',
      projectId: 'proj-1',
      objective: 'Orchestrated goal',
      steps: [{ id: 's1', title: 'Step 1', instructions: 'Implement step 1', acceptanceCriteria: ['passes'] }]
    });

    // Orchestrator worker spawn succeeds despite workerPolicy=OFF
    const updated = await driver.assignCurrentStepWorker(run.id, 'worker-1');
    expect(updated.status).toBe('WAITING_WORKER');
    expect(updated.steps[0]?.status).toBe('ACTIVE');
    expect(updated.steps[0]?.assignedWorkerId).toBe('worker-1');

    // Verify unrelated normal chat remains blocked
    expect(() =>
      spawn({
        workers: [{ task: 'Another normal chat work' }],
        caller: { conversationId: 'prime-other' }
      })
    ).toThrow(/WORKER_SPAWN_DISABLED/);
  });

  // 5. SEQUENTIAL ORCH
  // worker running -> no verifier concurrently
  // worker committed -> verifier dispatched
  // verifier PASS -> next worker
  it('5. SEQUENTIAL ORCH: strictly sequential worker and verifier execution', async () => {
    const run = await driver.createRun({
      id: 'run-seq-test',
      ownerConversationId: 'prime-orch-seq',
      projectId: 'proj-1',
      objective: 'Sequential work',
      steps: [
        { id: 's1', title: 'Step 1', instructions: 'Do step 1', acceptanceCriteria: ['c1'] },
        { id: 's2', title: 'Step 2', instructions: 'Do step 2', acceptanceCriteria: ['c2'] }
      ]
    });

    // 1. Worker assigned & running
    await driver.assignCurrentStepWorker(run.id, 'worker-1');
    expect(driver.getRun(run.id)?.status).toBe('WAITING_WORKER');

    // Attempting to dispatch verifier while worker is still running must fail
    await expect(driver.dispatchVerifier(run.id, 'verifier-1')).rejects.toThrow(/NOT_VERIFYING/);

    // 2. Worker committed -> moves to VERIFYING
    const workerReport = mockWorkerReport('worker-1', 'm1', 'Finished step 1', run.id, 's1', 'worker');
    const handled = await driver.handleCommittedWorkerReport(run.id, workerReport);
    expect(handled.handled).toBe(true);
    expect(driver.getRun(run.id)?.status).toBe('VERIFYING');

    // 3. Verifier dispatched
    const verifierTask = await driver.dispatchVerifier(run.id, 'verifier-1');
    expect(verifierTask.verifierId).toBe('verifier-1');

    // Cannot run worker while verifier is verifying
    await expect(driver.assignCurrentStepWorker(run.id, 'worker-2')).rejects.toThrow();

    // 4. Verifier reports PASS -> advances to step 2
    const afterPass = await driver.handleVerifierReport(run.id, 'verifier-1', 'VERDICT: PASS - Verified step 1 correctly');
    expect(afterPass.status).toBe('RUNNING');
    expect(afterPass.currentStepIndex).toBe(1);
    expect(afterPass.steps[0]?.status).toBe('COMPLETED');
    expect(afterPass.steps[1]?.status).toBe('PENDING');

    // 5. Next worker assigned
    const nextWorker = await driver.assignCurrentStepWorker(run.id, 'worker-2');
    expect(nextWorker.status).toBe('WAITING_WORKER');
    expect(nextWorker.steps[1]?.status).toBe('ACTIVE');
    expect(nextWorker.steps[1]?.assignedWorkerId).toBe('worker-2');
  });

  // 6. ORCH DEFECT
  // verifier DEFECT -> run BLOCKED -> no next worker
  it('6. ORCH DEFECT: verifier reporting DEFECT transitions run to BLOCKED with no next worker', async () => {
    const run = await driver.createRun({
      id: 'run-defect-test',
      ownerConversationId: 'prime-orch-defect',
      projectId: 'proj-1',
      objective: 'Defect test',
      steps: [
        { id: 's1', title: 'Step 1', instructions: 'Do step 1', acceptanceCriteria: ['c1'] },
        { id: 's2', title: 'Step 2', instructions: 'Do step 2', acceptanceCriteria: ['c2'] }
      ]
    });

    await driver.assignCurrentStepWorker(run.id, 'worker-1');
    await driver.handleCommittedWorkerReport(run.id, mockWorkerReport('worker-1', 'm1', 'Done', run.id, 's1', 'worker'));
    await driver.dispatchVerifier(run.id, 'verifier-1');

    // Verifier reports DEFECT
    const blocked = await driver.handleVerifierReport(run.id, 'verifier-1', 'VERDICT: DEFECT - Acceptance criteria not met');
    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.steps[0]?.status).toBe('DEFECT');
    expect(blocked.blockerReason).toContain('Acceptance criteria not met');
    expect(blocked.currentStepIndex).toBe(0);

    // Attempting to assign next worker while BLOCKED must be rejected
    await expect(driver.assignCurrentStepWorker(run.id, 'worker-2')).rejects.toThrow(/STEP_NOT_ASSIGNABLE/);
  });

  // 7. MODEL INHERIT
  // worker policy model=INHERIT
  // Expected: worker effective model follows Prime inheritance path
  it('7. MODEL INHERIT: worker model policy INHERIT_PRIME inherits prime model', async () => {
    const base = getConfig();
    await saveConfig({
      ...base,
      multiAgent: {
        ...base.multiAgent,
        workerModelPolicy: 'inherit_prime'
      }
    });

    const run = await driver.createRun({
      id: 'run-model-inherit',
      ownerConversationId: 'prime-model-chat',
      projectId: 'proj-1',
      objective: 'Inherit model test',
      steps: [{ id: 's1', title: 'Step 1', instructions: 'Do it', acceptanceCriteria: [] }]
    });

    const assigned = await driver.assignCurrentStepWorker(run.id, 'worker-1', {
      primeModel: 'gpt-5.6'
    });
    expect(assigned.steps[0]?.assignedWorkerId).toBe('worker-1');
    // Driver / agents records resolved model
    const taskSpec = driver.getAssignedWorkerSpec?.(run.id, 'worker-1');
    expect(taskSpec?.model).toBe('gpt-5.6');
  });

  // 8. MODEL SPECIFIC
  // specific observed model selected
  // Expected: exact model ID sent to Agents worker
  it('8. MODEL SPECIFIC: exact model ID sent to worker when SPECIFIC_MODEL configured', async () => {
    const base = getConfig();
    await saveConfig({
      ...base,
      multiAgent: {
        ...base.multiAgent,
        workerModelPolicy: 'specific_model',
        workerSpecificModel: 'gpt-5.5-preview'
      }
    });

    const run = await driver.createRun({
      id: 'run-model-specific',
      ownerConversationId: 'prime-model-chat-2',
      projectId: 'proj-1',
      objective: 'Specific model test',
      steps: [{ id: 's1', title: 'Step 1', instructions: 'Do it', acceptanceCriteria: [] }]
    });

    await driver.assignCurrentStepWorker(run.id, 'worker-1');
    const taskSpec = driver.getAssignedWorkerSpec?.(run.id, 'worker-1');
    expect(taskSpec?.model).toBe('gpt-5.5-preview');
  });

  // 9. MISSING MODEL
  // persisted specific model absent from live catalog
  // Expected: fallback to Inherit Prime, warning/diagnostic emitted, no invalid spawn
  it('9. MISSING MODEL: falls back to Inherit Prime with diagnostic when specific model disappears', async () => {
    const base = getConfig();
    await saveConfig({
      ...base,
      multiAgent: {
        ...base.multiAgent,
        workerModelPolicy: 'specific_model',
        workerSpecificModel: 'disappeared-gpt-model'
      }
    });

    const run = await driver.createRun({
      id: 'run-model-missing',
      ownerConversationId: 'prime-model-chat-3',
      projectId: 'proj-1',
      objective: 'Missing model test',
      steps: [{ id: 's1', title: 'Step 1', instructions: 'Do it', acceptanceCriteria: [] }]
    });

    const res = await driver.assignCurrentStepWorker(run.id, 'worker-1', {
      primeModel: 'gpt-5.6'
    });
    expect(res.steps[0]?.assignedWorkerId).toBe('worker-1');
    const taskSpec = driver.getAssignedWorkerSpec?.(run.id, 'worker-1');
    // Fallback to prime model gpt-5.6
    expect(taskSpec?.model).toBe('gpt-5.6');
    expect(taskSpec?.fallbackReason).toContain('disappeared-gpt-model');
  });

  // 10. VERIFIER MODEL
  // worker Specific A, verifier Specific B
  // Expected: implementation worker receives A, verifier receives B
  it('10. VERIFIER MODEL: worker and verifier independently receive their configured models', async () => {
    const base = getConfig();
    await saveConfig({
      ...base,
      multiAgent: {
        ...base.multiAgent,
        workerModelPolicy: 'specific_model',
        workerSpecificModel: 'gpt-5.5-preview',
        verifierModelPolicy: 'specific_model',
        verifierSpecificModel: 'gpt-5.6-sol'
      }
    });

    const run = await driver.createRun({
      id: 'run-independent-models',
      ownerConversationId: 'prime-ind-chat',
      projectId: 'proj-1',
      objective: 'Independent models',
      steps: [{ id: 's1', title: 'Step 1', instructions: 'Do it', acceptanceCriteria: [] }]
    });

    await driver.assignCurrentStepWorker(run.id, 'worker-1');
    const workerSpec = driver.getAssignedWorkerSpec?.(run.id, 'worker-1');
    expect(workerSpec?.model).toBe('gpt-5.5-preview');

    await driver.handleCommittedWorkerReport(run.id, mockWorkerReport('worker-1', 'm1', 'Done', run.id, 's1', 'worker'));
    const verifierSpec = await driver.dispatchVerifier(run.id, 'verifier-1');
    expect(verifierSpec.model).toBe('gpt-5.6-sol');
  });

  it('10b. VERIFIER PROMPT: carries worker evidence, criteria, and an explicit terminal verdict contract', () => {
    const prompt = buildVerifierTask({
      id: 's1', index: 0, title: 'Step 1', instructions: 'Inspect the implementation',
      acceptanceCriteria: ['Tests pass', 'No source mutation by verifier'], status: 'VERIFYING',
      generation: 1, attemptCount: 1, fileEffects: [],
      workerResult: { id: 'm1', summary: 'Implemented the change' }
    });
    expect(prompt).toContain('Implemented the change');
    expect(prompt).toContain('Tests pass');
    expect(prompt).toContain('VERDICT: PASS');
    expect(prompt).toContain('VERDICT: DEFECT');
    expect(prompt).toContain('Do not modify');
  });

  // 11. PROVENANCE
  // normal AUTO spawn -> NORMAL_AUTO
  // Orchestrator worker -> ORCHESTRATOR + worker
  // Orchestrator verifier -> ORCHESTRATOR + verifier
  it('11. PROVENANCE: records factual runtime origin and role metadata', async () => {
    // Normal auto
    const base = getConfig();
    await saveConfig({
      ...base,
      multiAgent: { ...base.multiAgent, workerPolicy: 'auto' }
    });
    const normal = spawn({
      workers: [{ task: 'Normal work' }],
      caller: { conversationId: 'prime-prov-chat' }
    });
    expect(normal.created[0]?.origin).toBe('NORMAL_AUTO');

    // Orchestrator worker
    const run = await driver.createRun({
      id: 'run-prov-test',
      ownerConversationId: 'prime-orch-prov',
      projectId: 'proj-1',
      objective: 'Provenance test',
      steps: [{ id: 's1', title: 'Step 1', instructions: 'Step 1', acceptanceCriteria: [] }]
    });
    await driver.assignCurrentStepWorker(run.id, 'worker-1');
    const workerSpec = driver.getAssignedWorkerSpec?.(run.id, 'worker-1');
    expect(workerSpec?.origin).toBe('ORCHESTRATOR');
    expect(workerSpec?.executionRole).toBe('worker');
    expect(workerSpec?.orchestratorRunId).toBe(run.id);

    // Orchestrator verifier
    await driver.handleCommittedWorkerReport(run.id, mockWorkerReport('worker-1', 'm1', 'Done', run.id, 's1', 'worker'));
    const verifierSpec = await driver.dispatchVerifier(run.id, 'verifier-1');
    expect(verifierSpec.origin).toBe('ORCHESTRATOR');
    expect(verifierSpec.executionRole).toBe('verifier');
    expect(verifierSpec.orchestratorRunId).toBe(run.id);
  });

  // 12. RESTORE
  // restart during WAITING_WORKER and VERIFYING
  // Expected: provenance survives, model survives, no duplicate worker, no duplicate verifier
  it('12. RESTORE: reconciles WAITING_WORKER and VERIFYING across restore without duplicate workers', async () => {
    const run = await driver.createRun({
      id: 'run-restore-test',
      ownerConversationId: 'prime-restore-chat',
      projectId: 'proj-1',
      objective: 'Restore test',
      steps: [{ id: 's1', title: 'Step 1', instructions: 'Step 1', acceptanceCriteria: [] }]
    });
    await driver.assignCurrentStepWorker(run.id, 'worker-1');

    // Reconcile on startup with worker-1 already active in swarm
    const recon1 = await driver.reconcileOnStartup(new Set(['worker-1']));
    expect(recon1.spawnedWorkers).toHaveLength(0); // No duplicate worker spawned!

    // Transition to VERIFYING and dispatch verifier-1
    await driver.handleCommittedWorkerReport(run.id, mockWorkerReport('worker-1', 'm1', 'Done', run.id, 's1', 'worker'));
    await driver.dispatchVerifier(run.id, 'verifier-1');

    // Reconcile on startup with verifier-1 already active
    const recon2 = await driver.reconcileOnStartup(new Set(['verifier-1']));
    expect(recon2.spawnedWorkers).toHaveLength(0); // No duplicate verifier spawned!

    // Conductor restore
    resetOrchestratorForTests();
    await restoreOrchestratorRuns();
    const restored = getRun(run.id);
    expect(restored?.status).toBe('VERIFYING');
    expect(restored?.steps[0]?.status).toBe('VERIFYING');
  });

  it('12b. RESTORE: a durable VERIFYING step without a verifier dispatches exactly one verifier and never replays mutation work', async () => {
    const requestedBootstraps: unknown[] = [];
    const unsubscribe = onSpawnRequest((workers) => {
      requestedBootstraps.push(...workers);
    });
    onSwarmPersistNow(async () => undefined);
    try {
      const run = await driver.createRun({
        id: 'run-restore-missing-verifier',
        ownerConversationId: 'prime-restore-missing-verifier',
        projectId: 'proj-1',
        objective: 'Restore verifier safely',
        steps: [{ id: 's1', title: 'Step 1', instructions: 'Step 1', acceptanceCriteria: [] }]
      });
      await driver.assignCurrentStepWorker(run.id, 'worker-1', { spawnAgent: true, primeModel: 'gpt-5.6' });
      await driver.handleCommittedWorkerReport(
        run.id,
        mockWorkerReport('worker-1', 'm1', 'Done', run.id, 's1', 'worker')
      );
      expect(driver.getRun(run.id)?.status).toBe('VERIFYING');
      expect(swarmState().agents.some(agent => agent.executionRole === 'verifier')).toBe(false);

      driver.dispose();
      resetOrchestratorForTests();
      await restoreOrchestratorRuns();
      driver = createOrchestratorDriver();

      const activeIds = new Set(
        swarmState().agents
          .filter(agent => ['invited', 'active', 'detached', 'waking'].includes(agent.state))
          .map(agent => agent.id)
      );
      const first = await driver.reconcileOnStartup(activeIds);
      expect(first.rerunMutationWorkers).toEqual([]);
      expect(first.spawnedWorkers).toHaveLength(1);
      const verifier = swarmState().agents.find(agent =>
        agent.executionRole === 'verifier' && agent.orchestratorRunId === run.id
      );
      expect(verifier).toBeDefined();

      const bootstrapCount = requestedBootstraps.length;
      const second = await driver.reconcileOnStartup(new Set([...activeIds, verifier!.id]));
      expect(second.spawnedWorkers).toEqual([]);
      expect(second.rerunMutationWorkers).toEqual([]);
      expect(requestedBootstraps).toHaveLength(bootstrapCount);
    } finally {
      onSwarmPersistNow(null);
      unsubscribe();
    }
  });

  // 13. GOAL WITHOUT ORCH
  // Goal ON, ORCH OFF -> legacy Goal behavior, zero Orchestrator workers
  it('13. GOAL WITHOUT ORCH: Goal behaves as legacy when ORCH is OFF with zero Orchestrator workers', async () => {
    const base = getConfig();
    await saveConfig({
      ...base,
      goal: { ...base.goal, enabled: true, mode: 'goal' },
      multiAgent: { ...base.multiAgent, workerPolicy: 'off' }
    });

    expect(getConfig().goal.enabled).toBe(true);
    expect(getConfig().multiAgent.workerPolicy).toBe('off');

    // Normal chat calls spawn -> rejected, zero orchestrator workers
    expect(() =>
      spawn({
        workers: [{ task: 'Goal sub-agent' }],
        caller: { conversationId: 'goal-chat' }
      })
    ).toThrow(/WORKER_SPAWN_DISABLED/);
  });

  // 14. LOOP WITHOUT ORCH
  // Loop ON, ORCH OFF -> legacy Loop behavior, zero Orchestrator workers
  it('14. LOOP WITHOUT ORCH: Loop behaves as legacy when ORCH is OFF with zero Orchestrator workers', async () => {
    const base = getConfig();
    await saveConfig({
      ...base,
      goal: { ...base.goal, enabled: true, mode: 'loop' },
      multiAgent: { ...base.multiAgent, workerPolicy: 'off' }
    });

    expect(getConfig().goal.enabled).toBe(true);
    expect(getConfig().goal.mode).toBe('loop');
    expect(getConfig().multiAgent.workerPolicy).toBe('off');

    expect(() =>
      spawn({
        workers: [{ task: 'Loop sub-agent' }],
        caller: { conversationId: 'loop-chat' }
      })
    ).toThrow(/WORKER_SPAWN_DISABLED/);
  });

  // 15. NORMAL CHAT FALSE-SPAWN PROTECTION
  // large complex prompt with workerPolicy=OFF
  // Even if Prime invokes spawn: runtime denies creation
  it('15. NORMAL CHAT FALSE-SPAWN PROTECTION: complex prompt cannot trigger autonomous worker creation when workerPolicy=OFF', async () => {
    const base = getConfig();
    expect(base.multiAgent.workerPolicy).toBe('off');

    const complexContext = 'You are working on a massive refactor. Please divide tasks and create multiple sub-agents to help.';
    expect(() =>
      spawn({
        context: complexContext,
        workers: [
          { label: 'Refactor Worker', task: 'Refactor module A' },
          { label: 'Test Worker', task: 'Add unit tests' }
        ],
        caller: { conversationId: 'complex-prompt-chat' }
      })
    ).toThrow(/WORKER_SPAWN_DISABLED/);
  });

  // 16. REAL AGENTS WIRING (End-to-End stageSpawn)
  it('16. REAL AGENTS WIRING: creates actual AgentInfo records and emits bootstrap commands with distinct roles', async () => {
    const requestedBootstraps: any[] = [];
    const unsubscribe = onSpawnRequest((workers) => {
      requestedBootstraps.push(...workers);
    });
    onSwarmPersistNow(async () => undefined);

    try {
      const run = await driver.createRun({
        id: 'run-real-agents-1',
        ownerConversationId: 'conv-real',
        projectId: 'proj-1',
        objective: 'Verify real Agents are created end-to-end',
        steps: [{ id: 'step-real-1', title: 'Step 1', instructions: 'Implement feature', acceptanceCriteria: ['Works'] }]
      });

      // 1. Assign worker with spawnAgent: true
      await driver.assignCurrentStepWorker(run.id, 'worker-1', { spawnAgent: true, primeModel: 'gpt-5.6' });
      const swarm1 = swarmState();
      const workerAgent = swarm1.agents.find(a => a.id === 'worker-1');
      expect(workerAgent).toBeDefined();
      expect(workerAgent?.origin).toBe('ORCHESTRATOR');
      expect(workerAgent?.orchestratorRunId).toBe(run.id);
      expect(workerAgent?.orchestratorStepId).toBe('step-real-1');
      expect(workerAgent?.executionRole).toBe('worker');
      expect(requestedBootstraps.length).toBeGreaterThanOrEqual(1);

      // 2. Commit worker result
      await driver.handleCommittedWorkerReport(
        run.id,
        mockWorkerReport('worker-1', 'msg-1', 'Worker completed implementation', run.id, 'step-real-1', 'worker')
      );

      // 3. Dispatch verifier with spawnAgent: true
      await driver.dispatchVerifier(run.id, 'verifier-1', { spawnAgent: true, primeModel: 'gpt-5.6' });
      const swarm2 = swarmState();
      const verifierAgent = swarm2.agents.find(a => a.executionRole === 'verifier');
      expect(verifierAgent).toBeDefined();
      expect(verifierAgent?.label).toBe('verifier-1');
      expect(verifierAgent?.origin).toBe('ORCHESTRATOR');
      expect(verifierAgent?.orchestratorRunId).toBe(run.id);
      expect(verifierAgent?.orchestratorStepId).toBe('step-real-1');
      expect(verifierAgent?.executionRole).toBe('verifier');
      expect(verifierAgent?.id).not.toBe(workerAgent?.id);

      // 4. Verifier reports DEFECT
      await driver.handleVerifierReport(run.id, 'verifier-1', JSON.stringify({
        verdict: 'DEFECT',
        summary: 'Acceptance criteria not met'
      }));

      // 5. Prepare repair worker with spawnAgent: true
      await driver.prepareRepair(run.id, 'worker-repair-1', { spawnAgent: true, primeModel: 'gpt-5.6' });
      const swarm3 = swarmState();
      const repairAgent = swarm3.agents.find(a => a.executionRole === 'repair_worker');
      expect(repairAgent).toBeDefined();
      expect(repairAgent?.label).toBe('worker-repair-1');
      expect(repairAgent?.origin).toBe('ORCHESTRATOR');
      expect(repairAgent?.executionRole).toBe('repair_worker');
      const updatedRun = driver.getRun(run.id);
      expect(updatedRun?.steps[0]?.generation).toBe(2);
    } finally {
      onSwarmPersistNow(null);
      unsubscribe();
    }
  });

  it('16b. REAL AGENTS DURABILITY: crosses the immediate swarm persistence barrier before bootstrap publication', async () => {
    let durableWrites = 0;
    onSwarmPersistNow(async () => { durableWrites += 1; });
    const run = await driver.createRun({
      id: 'run-real-agents-durable',
      ownerConversationId: 'conv-real-durable',
      projectId: 'proj-1',
      objective: 'Durable real-agent spawn',
      steps: [{ id: 'step-real-1', title: 'Step 1', instructions: 'Inspect safely', acceptanceCriteria: [] }]
    });
    try {
      await driver.assignCurrentStepWorker(run.id, 'worker-1', { spawnAgent: true, primeModel: 'gpt-5.6' });
      expect(durableWrites).toBeGreaterThan(0);
    } finally {
      onSwarmPersistNow(null);
    }
  });

  it('16c. REAL AGENTS DURABILITY: rolls back a staged worker when immediate persistence throws', async () => {
    const requestedBootstraps: unknown[] = [];
    const unsubscribe = onSpawnRequest((workers) => {
      requestedBootstraps.push(...workers);
    });
    onSwarmPersistNow(async () => {
      throw new Error('durable worker write failed');
    });
    const run = await driver.createRun({
      id: 'run-real-agents-worker-failure',
      ownerConversationId: 'conv-real-worker-failure',
      projectId: 'proj-1',
      objective: 'Reject phantom worker',
      steps: [{ id: 'step-real-1', title: 'Step 1', instructions: 'Inspect safely', acceptanceCriteria: [] }]
    });
    try {
      await expect(
        driver.assignCurrentStepWorker(run.id, 'worker-1', { spawnAgent: true, primeModel: 'gpt-5.6' })
      ).rejects.toThrow(/durable worker write failed/);
      expect(swarmState().agents.some(agent => agent.origin === 'ORCHESTRATOR')).toBe(false);
      expect(requestedBootstraps).toHaveLength(0);
      expect(driver.getRun(run.id)?.status).toBe('RUNNING');
    } finally {
      onSwarmPersistNow(null);
      unsubscribe();
    }
  });

  it('16d. REAL AGENTS DURABILITY: rolls back a staged verifier when immediate persistence throws', async () => {
    const requestedBootstraps: unknown[] = [];
    const unsubscribe = onSpawnRequest((workers) => {
      requestedBootstraps.push(...workers);
    });
    const run = await driver.createRun({
      id: 'run-real-agents-verifier-failure',
      ownerConversationId: 'conv-real-verifier-failure',
      projectId: 'proj-1',
      objective: 'Reject phantom verifier',
      steps: [{ id: 'step-real-1', title: 'Step 1', instructions: 'Inspect safely', acceptanceCriteria: [] }]
    });
    await driver.assignCurrentStepWorker(run.id, 'worker-1');
    await driver.handleCommittedWorkerReport(
      run.id,
      mockWorkerReport('worker-1', 'msg-1', 'Worker completed', run.id, 'step-real-1', 'worker')
    );
    onSwarmPersistNow(async () => {
      throw new Error('durable verifier write failed');
    });
    try {
      await expect(
        driver.dispatchVerifier(run.id, 'verifier-1', { spawnAgent: true, primeModel: 'gpt-5.6' })
      ).rejects.toThrow(/durable verifier write failed/);
      expect(swarmState().agents.some(agent => agent.executionRole === 'verifier')).toBe(false);
      expect(requestedBootstraps).toHaveLength(0);
      expect(driver.getRun(run.id)?.status).toBe('VERIFYING');
    } finally {
      onSwarmPersistNow(null);
      unsubscribe();
    }
  });

  it('16e. REAL AGENTS DURABILITY: repair workers cross the same persistence barrier before publication', async () => {
    const requestedBootstraps: unknown[] = [];
    const unsubscribe = onSpawnRequest((workers) => {
      requestedBootstraps.push(...workers);
    });
    const run = await driver.createRun({
      id: 'run-real-agents-repair-failure',
      ownerConversationId: 'conv-real-repair-failure',
      projectId: 'proj-1',
      objective: 'Reject phantom repair worker',
      steps: [{ id: 'step-real-1', title: 'Step 1', instructions: 'Inspect safely', acceptanceCriteria: [] }]
    });
    await driver.assignCurrentStepWorker(run.id, 'worker-1');
    await driver.handleCommittedWorkerReport(
      run.id,
      mockWorkerReport('worker-1', 'msg-1', 'Worker completed', run.id, 'step-real-1', 'worker')
    );
    await driver.dispatchVerifier(run.id, 'verifier-1');
    await driver.handleVerifierReport(run.id, 'verifier-1', 'VERDICT: DEFECT - repair required');
    onSwarmPersistNow(async () => {
      throw new Error('durable repair write failed');
    });
    try {
      await expect(
        driver.prepareRepair(run.id, 'worker-repair-1', { spawnAgent: true, primeModel: 'gpt-5.6' })
      ).rejects.toThrow(/durable repair write failed/);
      expect(swarmState().agents.some(agent => agent.executionRole === 'repair_worker')).toBe(false);
      expect(requestedBootstraps).toHaveLength(0);
      expect(driver.getRun(run.id)?.status).toBe('BLOCKED');
      expect(driver.getAssignedWorkerSpec(run.id, 'worker-repair-1')).toBeUndefined();
    } finally {
      onSwarmPersistNow(null);
      unsubscribe();
    }
  });

  // 17. ASK AUTHORIZATION: TTL and Single-Use
  it('17. ASK AUTHORIZATION: enforces single-use consumption and 5-minute TTL expiration', async () => {
    const base = getConfig();
    await saveConfig({
      ...base,
      multiAgent: { ...base.multiAgent, workerPolicy: 'ask' }
    });

    const convId = 'ask-auth-chat';
    const caller: Caller = { conversationId: convId };

    // Initially unapproved -> rejected
    expect(() =>
      spawn({
        workers: [{ task: 'Unapproved task' }],
        caller
      })
    ).toThrow(/SPAWN_AUTHORIZATION_REQUIRED/);

    // Grant authorization
    grantSpawnAuthorization(convId);
    expect(hasSpawnAuthorization(convId)).toBe(true);

    // Spawn succeeds and consumes authorization
    const outcome = spawn({
      workers: [{ task: 'Approved task' }],
      caller
    });
    expect(outcome.created.length).toBe(1);
    expect(hasSpawnAuthorization(convId)).toBe(false);

    // Immediate second spawn without re-authorization is rejected (single-use enforced)
    expect(() =>
      spawn({
        workers: [{ task: 'Second unauthorized task' }],
        caller
      })
    ).toThrow(/SPAWN_AUTHORIZATION_REQUIRED/);

    // Test TTL expiration (5 minutes = 300,000 ms)
    const ttlConvId = 'ttl-auth-chat';
    const ttlCaller: Caller = { conversationId: ttlConvId };
    grantSpawnAuthorization(ttlConvId);
    expect(hasSpawnAuthorization(ttlConvId)).toBe(true);

    // Advance time by 5 minutes + 1 second
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + (5 * 60 * 1000 + 1000);
      expect(hasSpawnAuthorization(ttlConvId)).toBe(false);
      expect(() =>
        spawn({
          workers: [{ task: 'Expired auth task' }],
          caller: ttlCaller
        })
      ).toThrow(/SPAWN_AUTHORIZATION_REQUIRED/);
    } finally {
      Date.now = realNow;
    }
  });
});
