import { createHash, randomBytes } from 'node:crypto';
import { canonicalJson } from './identity.js';

/** Main-owned state, never an IPC payload or renderer-issued gesture. */
export interface CapabilityOperatorContext {
  jobId: string;
  sessionId: string;
  conversationId: string | null;
  localProjectId: string | null;
  resolveProjectId: string;
  capabilityFingerprint: string;
  admissionRevision: number;
  workflowRevision: number;
  adapterEpoch: string;
  adapterVersion: string;
  sourceEnd: 'inclusive';
  guardVersion: 2;
  sessionBinding: string;
}
export interface CapabilityAuthentication {
  method: 'windows-user-consent-verifier';
  challengeHash: string;
  verifiedAt: number;
  expiresAt: number;
}
export type CapabilityOperatorReview = (detail: string, context: CapabilityOperatorContext, assertCurrent: () => Promise<unknown>) => Promise<unknown>;
const lifetime = 60_000;

/** The same issuer/consumer implementation, with independent custody for a disposable validation.
 * No proof from that store can be consumed by production, even with an identical binding. */
export function createCapabilityOperatorProofStore<Context extends object = CapabilityOperatorContext>() {
  let disposed = false;
  let proofs = new WeakMap<object, {
    binding: string; authentication: CapabilityAuthentication; assertOwner: () => void;
  }>();
  const available = () => { if (disposed) throw new Error('Operator proof store disposed'); };

  /** Only privileged main code supplies the OS authenticator. A boolean or a serialized copy
   * cannot become a proof. No credential, nonce or proof is exposed through preload. */
  async function authenticate(
    context: Context, detail: string,
    authenticateOs: (message: string) => Promise<'windows-user-consent-verifier' | null>,
    assertOwner: () => void, now = Date.now
  ): Promise<object | null> {
    available();
    const binding = canonicalJson(context), startedAt = now(), expiresAt = startedAt + lifetime;
    const challengeHash = createHash('sha256').update(randomBytes(32)).update(binding).digest('hex');
    assertOwner();
    const method = await authenticateOs(`${detail}\n\nVerify with Windows to approve this exact admission.\nReview: ${challengeHash}`);
    available();
    assertOwner();
    if (method === null) return null;
    const verifiedAt = now();
    if (method !== 'windows-user-consent-verifier' || verifiedAt < startedAt || verifiedAt >= expiresAt)
      throw new Error('Independent operator authentication missing or expired');
    const proof = Object.freeze({});
    proofs.set(proof, { binding, authentication: { method, challengeHash, verifiedAt, expiresAt }, assertOwner });
    return proof;
  }

  /** Consume before the store transaction; even a rejected/mismatched attempt burns the proof. */
  function consume(proof: unknown, context: Context, now = Date.now()): CapabilityAuthentication {
    available();
    const entry = proof && typeof proof === 'object' ? proofs.get(proof) : undefined;
    if (proof && typeof proof === 'object') proofs.delete(proof);
    if (!entry) throw new Error('Independent operator authentication required; native Confirm is insufficient');
    entry.assertOwner();
    if (entry.binding !== canonicalJson(context) || now < entry.authentication.verifiedAt || now >= entry.authentication.expiresAt)
      throw new Error('Independent operator authentication stale or binding changed');
    return { ...entry.authentication };
  }
  return Object.freeze({ authenticate, consume, dispose: () => { disposed = true; proofs = new WeakMap(); } });
}

const production = createCapabilityOperatorProofStore();
export const authenticateCapabilityOperator = production.authenticate;
export const consumeCapabilityOperatorProof = production.consume;
