import { createCapabilityOperatorProofStore } from './capability-operator-proof.js';

// Main-only, exact invocation scope. This proof admits a principal; durable operator authority
// still owns permission to execute. Separate custody prevents capability proofs being reused here.
interface NativeExecutionScope {
  jobId: string; sessionId: string; localProjectId: string | null; resolveProjectId: string;
  preparedHash: string; authorizationId: string; manifestHash: string;
  workflowRevision: number; sessionBinding: string; adapterEpoch: string;
}
const principals = createCapabilityOperatorProofStore<NativeExecutionScope>();
export const authenticateNativeExecution = principals.authenticate;
export const consumeNativeExecutionPrincipal = principals.consume;
export type NativeExecutionReview = (detail: string, scope: NativeExecutionScope, assertCurrent: () => Promise<void>) => Promise<unknown>;
