import type { OrchestratorRun } from '../main/orchestrator/types.js';

export interface OrchestratorPresentation {
  chipLabel: string;
  statusText: string | null;
  state: 'ready' | 'worker' | 'verifying' | 'blocked' | 'completed' | 'canceled';
}

export function orchestratorPresentation(
  enabled: boolean,
  run: OrchestratorRun | null
): OrchestratorPresentation {
  if (!run) {
    return {
      chipLabel: enabled ? 'ORCH · Active' : 'ORCH',
      statusText: null,
      state: 'ready'
    };
  }

  const total = run.steps.length;
  const stepNumber = Math.min(run.currentStepIndex + 1, Math.max(1, total));
  const progress = `${stepNumber}/${total}`;
  const step = run.steps[run.currentStepIndex];

  switch (run.status) {
    case 'WAITING_WORKER':
      return {
        chipLabel: `ORCH · ${progress} · Worker`,
        statusText: `ORCH · Step ${progress} · Worker${step?.assignedWorkerId ? ` · ${step.assignedWorkerId}` : ''}`,
        state: 'worker'
      };
    case 'VERIFYING':
      return {
        chipLabel: `ORCH · ${progress} · Verifying`,
        statusText: `ORCH · Step ${progress} · Verifying`,
        state: 'verifying'
      };
    case 'BLOCKED':
      return {
        chipLabel: 'ORCH · Blocked',
        statusText: `ORCH · Step ${progress} · Blocked${run.blockerReason ? ` — ${run.blockerReason}` : ''}`,
        state: 'blocked'
      };
    case 'COMPLETED':
      return {
        chipLabel: 'ORCH · Completed',
        statusText: 'ORCH · Completed',
        state: 'completed'
      };
    case 'CANCELED':
      return {
        chipLabel: 'ORCH · Canceled',
        statusText: 'ORCH · Canceled',
        state: 'canceled'
      };
    case 'RUNNING':
    default:
      return {
        chipLabel: `ORCH · ${progress} · Ready`,
        statusText: `ORCH · Step ${progress} · Ready`,
        state: 'ready'
      };
  }
}
