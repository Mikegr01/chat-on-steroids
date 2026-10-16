import { expect, it, vi } from 'vitest';
import { authenticateCapabilityOperator, consumeCapabilityOperatorProof, type CapabilityOperatorContext } from '../src/main/video-editing/capability-operator-proof.js';
const context: CapabilityOperatorContext = { jobId: 'synthetic-job', sessionId: 'synthetic-session', conversationId: 'synthetic-chat',
  localProjectId: null, resolveProjectId: 'synthetic-resolve', capabilityFingerprint: 'a'.repeat(64), admissionRevision: 7,
  workflowRevision: 7, adapterEpoch: 'synthetic:1', adapterVersion: 'synthetic-1', sourceEnd: 'inclusive', guardVersion: 2, sessionBinding: 'b'.repeat(64) };

it('proof is an opaque one-use main object, never a serialized renderer token', async () => {
  const owner = vi.fn(), prompt = vi.fn(async (_message: string) => 'windows-user-consent-verifier' as const);
  const proof = await authenticateCapabilityOperator(context, 'Exact synthetic admission', prompt, owner, () => 100);
  expect(Object.keys(proof!)).toEqual([]);
  expect(prompt.mock.calls[0]![0]).toContain('Exact synthetic admission');
  expect(() => consumeCapabilityOperatorProof(JSON.parse(JSON.stringify(proof)), context, 100)).toThrow(/required/);
  const auth = consumeCapabilityOperatorProof(proof, context, 100);
  expect(auth).toMatchObject({ method: 'windows-user-consent-verifier', verifiedAt: 100, expiresAt: 60100 });
  expect(() => consumeCapabilityOperatorProof(proof, context, 100)).toThrow(/required/);
  expect(owner).toHaveBeenCalledTimes(3);
});
it.each(Object.keys(context))('binding mismatch in %s burns the proof', async key => {
  const proof = await authenticateCapabilityOperator(context, 'Synthetic', async () => 'windows-user-consent-verifier', () => {}, () => 100);
  expect(() => consumeCapabilityOperatorProof(proof, { ...context, [key]: 'different' }, 100)).toThrow(/binding/);
  expect(() => consumeCapabilityOperatorProof(proof, context, 100)).toThrow(/required/);
});
it.each([false, true, 0, {}, undefined, 'windows-credentials', 'Verified'])('numeric/UI/native result %j cannot issue authentication proof', async result => {
  await expect(authenticateCapabilityOperator(context, 'Synthetic', async () => result as never, () => {}, () => 100)).rejects.toThrow(/missing/);
});
it('independent random challenges do not repeat for the same context', async () => {
  const first = await authenticateCapabilityOperator(context, 'Synthetic', async () => 'windows-user-consent-verifier', () => {}, () => 100);
  const second = await authenticateCapabilityOperator(context, 'Synthetic', async () => 'windows-user-consent-verifier', () => {}, () => 100);
  expect(consumeCapabilityOperatorProof(first, context, 100).challengeHash).not.toBe(consumeCapabilityOperatorProof(second, context, 100).challengeHash);
});
it('concurrent submissions of the same proof have exactly one successful consumption', async () => {
  const proof = await authenticateCapabilityOperator(context, 'Synthetic', async () => 'windows-user-consent-verifier', () => {}, () => 100);
  const results = await Promise.allSettled([0, 1].map(() => Promise.resolve().then(() => consumeCapabilityOperatorProof(proof, context, 100))));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
});
it('authentication timeout and clock reversal fail without issuing a proof', async () => {
  let clock = 100;
  for (const end of [60100, 99]) {
    clock = 100;
    await expect(authenticateCapabilityOperator(context, 'Synthetic', async () => { clock = end; return 'windows-user-consent-verifier'; },
      () => {}, () => clock)).rejects.toThrow(/expired/);
  }
});
it.each([60100, 99])('expiry or clock reversal at consumption (%s) burns a previously issued proof', async time => {
  const proof = await authenticateCapabilityOperator(context, 'Synthetic', async () => 'windows-user-consent-verifier', () => {}, () => 100);
  expect(() => consumeCapabilityOperatorProof(proof, context, time)).toThrow(/stale/);
  expect(() => consumeCapabilityOperatorProof(proof, context, 100)).toThrow(/required/);
});
it('renderer invalidation after OS authentication and before consumption fails closed', async () => {
  let valid = true;
  const owner = () => { if (!valid) throw new Error('Renderer retired'); };
  const proof = await authenticateCapabilityOperator(context, 'Synthetic', async () => 'windows-user-consent-verifier', owner, () => 100);
  valid = false;
  expect(() => consumeCapabilityOperatorProof(proof, context, 100)).toThrow(/retired/);
  valid = true;
  expect(() => consumeCapabilityOperatorProof(proof, context, 100)).toThrow(/required/);
  await expect(authenticateCapabilityOperator(context, 'Synthetic', async () => { valid = false; return 'windows-user-consent-verifier'; }, owner))
    .rejects.toThrow(/retired/);
});
