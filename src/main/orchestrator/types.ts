export type OrchestratorStatus =
  | 'RUNNING'
  | 'WAITING_WORKER'
  | 'VERIFYING'
  | 'BLOCKED'
  | 'COMPLETED'
  | 'CANCELED';

export type StepStatus = 'PENDING' | 'ACTIVE' | 'VERIFYING' | 'DEFECT' | 'COMPLETED' | 'BLOCKED';

export interface ProjectIdentitySnapshot {
  branch?: string;
  head?: string;
}

export interface FileEffect {
  path: string;
  beforeHash: string;
  afterHash: string;
  delta: { added: number; removed: number; approximate?: boolean };
  stepId: string;
}

export interface WorkerResultRecord {
  id: string;
  summary?: string;
}

export interface VerificationResult {
  verdict: 'PASS' | 'DEFECT';
  summary?: string;
  verifiedAt: number;
}

export interface StepRecord {
  id: string;
  index: number;
  title: string;
  instructions: string;
  acceptanceCriteria: string[];
  status: StepStatus;
  generation: number;
  attemptCount: number;
  assignedWorkerId?: string;
  lastWorkerResultId?: string;
  workerResult?: WorkerResultRecord;
  fileEffects: FileEffect[];
  verificationResult?: VerificationResult;
}

export interface OrchestratorRun {
  version: 1;
  id: string;
  ownerConversationId: string;
  projectId: string;
  objective: string;
  status: OrchestratorStatus;
  currentStepIndex: number;
  steps: StepRecord[];
  startedAt: number;
  updatedAt: number;
  lastCheckpointAt: number;
  blockerReason?: string;
  projectIdentity?: ProjectIdentitySnapshot;
}

export interface StepInput {
  id: string;
  title: string;
  instructions: string;
  acceptanceCriteria: string[];
}

export interface CreateRunInput {
  id: string;
  ownerConversationId: string;
  projectId: string;
  objective: string;
  steps: StepInput[];
  projectIdentity?: ProjectIdentitySnapshot;
}
