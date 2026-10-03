import { describe, expect, it } from 'vitest';
import type { OrchestratorRun } from '../src/main/orchestrator/types.js';
import { orchestratorPresentation } from '../src/renderer/orchestrator-ui.js';

function run(status: OrchestratorRun['status'], currentStepIndex = 1): OrchestratorRun {
  return {
    version: 1,
    id: 'orch-ui-run',
    ownerConversationId: 'conv-ui',
    projectId: 'proj-ui',
    objective: 'UI state',
    status,
    currentStepIndex,
    steps: [
      {
        id: 'step-0',
        index: 0,
        title: 'Step 1',
        instructions: 'One',
        acceptanceCriteria: [],
        status: 'COMPLETED',
        generation: 1,
        attemptCount: 1,
        fileEffects: []
      },
      {
        id: 'step-1',
        index: 1,
        title: 'Step 2',
        instructions: 'Two',
        acceptanceCriteria: [],
        status: status === 'WAITING_WORKER' ? 'ACTIVE' : status === 'VERIFYING' ? 'VERIFYING' : status === 'BLOCKED' ? 'DEFECT' : 'PENDING',
        generation: 1,
        attemptCount: 1,
        assignedWorkerId: 'worker-2',
        fileEffects: []
      }
    ],
    startedAt: 1,
    updatedAt: 2,
    lastCheckpointAt: 2,
    ...(status === 'BLOCKED' ? { blockerReason: 'Acceptance criterion failed' } : {})
  };
}

describe('Orchestrator composer presentation', () => {
  it('keeps enabled-but-idle ORCH compact without reserving a status row', () => {
    expect(orchestratorPresentation(true, null)).toEqual({
      chipLabel: 'ORCH · Active',
      statusText: null,
      state: 'ready'
    });
  });

  it('derives worker and verifier progress from the durable run state', () => {
    expect(orchestratorPresentation(true, run('WAITING_WORKER'))).toMatchObject({
      chipLabel: 'ORCH · 2/2 · Worker',
      statusText: 'ORCH · Step 2/2 · Worker · worker-2',
      state: 'worker'
    });
    expect(orchestratorPresentation(true, run('VERIFYING'))).toMatchObject({
      chipLabel: 'ORCH · 2/2 · Verifying',
      statusText: 'ORCH · Step 2/2 · Verifying',
      state: 'verifying'
    });
  });

  it('distinguishes blocked, completed, and canceled without failure wording', () => {
    expect(orchestratorPresentation(true, run('BLOCKED'))).toMatchObject({
      chipLabel: 'ORCH · Blocked',
      statusText: 'ORCH · Step 2/2 · Blocked — Acceptance criterion failed',
      state: 'blocked'
    });
    expect(orchestratorPresentation(true, run('COMPLETED'))).toMatchObject({
      chipLabel: 'ORCH · Completed',
      statusText: 'ORCH · Completed',
      state: 'completed'
    });
    const canceled = orchestratorPresentation(true, run('CANCELED'));
    expect(canceled).toMatchObject({
      chipLabel: 'ORCH · Canceled',
      statusText: 'ORCH · Canceled',
      state: 'canceled'
    });
    expect(canceled.statusText).not.toMatch(/fail/i);
  });

  it('handles disabled state and multi-step progress accurately', () => {
    expect(orchestratorPresentation(false, null)).toEqual({
      chipLabel: 'ORCH',
      statusText: null,
      state: 'ready'
    });

    const fourStepRun: OrchestratorRun = {
      ...run('WAITING_WORKER', 0),
      steps: [
        { id: 's1', index: 0, title: 'S1', instructions: 'I1', acceptanceCriteria: [], status: 'ACTIVE', generation: 1, attemptCount: 1, fileEffects: [] },
        { id: 's2', index: 1, title: 'S2', instructions: 'I2', acceptanceCriteria: [], status: 'PENDING', generation: 0, attemptCount: 0, fileEffects: [] },
        { id: 's3', index: 2, title: 'S3', instructions: 'I3', acceptanceCriteria: [], status: 'PENDING', generation: 0, attemptCount: 0, fileEffects: [] },
        { id: 's4', index: 3, title: 'S4', instructions: 'I4', acceptanceCriteria: [], status: 'PENDING', generation: 0, attemptCount: 0, fileEffects: [] }
      ]
    };

    expect(orchestratorPresentation(true, fourStepRun)).toMatchObject({
      chipLabel: 'ORCH · 1/4 · Worker',
      statusText: 'ORCH · Step 1/4 · Worker',
      state: 'worker'
    });
  });
});
