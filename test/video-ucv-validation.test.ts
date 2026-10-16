import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildSync } from 'esbuild';
import { runUcvValidation } from '../src/main/video-editing/ucv-validation.js';
import { createCapabilityOperatorProofStore, authenticateCapabilityOperator, consumeCapabilityOperatorProof,
  type CapabilityOperatorContext } from '../src/main/video-editing/capability-operator-proof.js';
import { ucvValidationContextSchema } from '../src/shared/ucv-validation.js';
import { videoIdSchema } from '../src/shared/video-editing.js';
import { faultGate } from './helpers.js';

const production: CapabilityOperatorContext = { jobId: 's75-absent-scope-live-acceptance-20261010', sessionId: 'production-session',
  conversationId: 'production-chat', localProjectId: null, resolveProjectId: 'production-project',
  capabilityFingerprint: 'a'.repeat(64), admissionRevision: 20, workflowRevision: 20, adapterEpoch: 'production:1',
  adapterVersion: 'production:1', sourceEnd: 'inclusive', guardVersion: 2, sessionBinding: 'b'.repeat(64) };
const ports = () => ({ confirm: vi.fn(async (_detail: string) => true),
  authenticate: vi.fn(async (_detail: string, assertCurrent: () => void) => { assertCurrent(); return 'windows-user-consent-verifier' as const; }),
  assertOwner: vi.fn(), now: () => 100 });

it('terminates after real proof consumption/replay with metadata only, no durable job or receipt', async () => {
  const p = ports(), result = await runUcvValidation(p);
  expect(result).toEqual({ status: 'validated', contextId: expect.any(String), ucvResult: 'Verified',
    proofCreated: true, bindingValid: true, ttlValid: true, firstConsumption: 'success', replay: 'rejected',
    receiptCreated: false, disposed: true });
  expect(p.authenticate).toHaveBeenCalledOnce(); expect(p.confirm).toHaveBeenCalledOnce();
  expect(p.confirm.mock.calls[0]![0]).not.toContain(production.jobId);
  expect(JSON.stringify(result)).not.toMatch(/challengeHash|verifiedAt|expiresAt|proofSecret|password|biometric|hwnd/i);
});
it('proof namespaces cannot consume each other, including the protected production binding', async () => {
  const isolated = createCapabilityOperatorProofStore<CapabilityOperatorContext>();
  const proof = await isolated.authenticate(production, 'Isolated', async () => 'windows-user-consent-verifier', () => {}, () => 100);
  expect(() => consumeCapabilityOperatorProof(proof, production, 100)).toThrow(/required/);
  expect(isolated.consume(proof, production, 100).method).toBe('windows-user-consent-verifier');
  expect(() => isolated.consume(proof, production, 100)).toThrow(/required/);
  const real = await authenticateCapabilityOperator(production, 'Normal', async () => 'windows-user-consent-verifier', () => {}, () => 100);
  expect(() => isolated.consume(real, production, 100)).toThrow(/required/);
  expect(consumeCapabilityOperatorProof(real, production, 100).method).toBe('windows-user-consent-verifier');
  isolated.dispose();
});
it('disposal revokes a pending authenticator and issued proofs deterministically', async () => {
  const isolated = createCapabilityOperatorProofStore<CapabilityOperatorContext>(), gate = faultGate();
  const issued = await isolated.authenticate(production, 'Issued', async () => 'windows-user-consent-verifier', () => {}, () => 100);
  const pending = isolated.authenticate(production, 'Pending', async () => { await gate.hold(); return 'windows-user-consent-verifier'; }, () => {}, () => 100);
  await gate.entered; isolated.dispose(); gate.release();
  await expect(pending).rejects.toThrow(/disposed/);
  expect(() => isolated.consume(issued, production, 100)).toThrow(/disposed/);
});
it('cancel before UCV and non-Verified outcomes issue no proof and never retry', async () => {
  const p = ports(); p.confirm.mockResolvedValue(false);
  expect(await runUcvValidation(p)).toMatchObject({ status: 'cancelled', proofCreated: false, disposed: true });
  expect(p.authenticate).not.toHaveBeenCalled();
  const q = { ...ports(), authenticate: vi.fn(async () => null) };
  expect(await runUcvValidation(q)).toMatchObject({ status: 'not-verified', proofCreated: false, disposed: true });
  expect(q.authenticate).toHaveBeenCalledOnce();
});
it.each([60_100, 99])('expired/reversed validation context at %s rejects before UCV', async end => {
  let clock = 100; const p = ports(); p.confirm.mockImplementation(async () => { clock = end; return true; });
  await expect(runUcvValidation({ ...p, now: () => clock })).rejects.toThrow(/expired/);
  expect(p.authenticate).not.toHaveBeenCalled();
});
it('late owner loss or expiration cannot turn a successful OS response into validation success', async () => {
  for (const kind of ['owner', 'expiry']) {
    let valid = true, clock = 100; const p = ports();
    p.authenticate.mockImplementation(async () => { if (kind === 'owner') valid = false; else clock = 60_100; return 'windows-user-consent-verifier'; });
    await expect(runUcvValidation({ ...p, now: () => clock, assertOwner: () => { if (!valid) throw new Error('owner lost'); } })).rejects.toThrow();
    expect(p.authenticate).toHaveBeenCalledOnce();
  }
});
it('dedicated context schema cannot collide with a durable job and rejects malformed/production identities', () => {
  const context = { purpose: 'ucv-validation', contextId: '11111111-1111-4111-8111-111111111111',
    jobId: null, sessionId: '22222222-2222-4222-8222-222222222222', conversationId: null, localProjectId: null, resolveProjectId: null,
    capabilityFingerprint: 'a'.repeat(64), admissionRevision: 1, workflowRevision: 1, adapterEpoch: 'ucv-validation:1',
    adapterVersion: 'ucv-validation:1', sourceEnd: 'inclusive', guardVersion: 2, sessionBinding: 'b'.repeat(64), createdAt: 100, expiresAt: 60100 };
  expect(ucvValidationContextSchema.parse(context).jobId).toBeNull(); expect(videoIdSchema.safeParse(context.jobId).success).toBe(false);
  for (const patch of [{ jobId: production.jobId }, { purpose: 'production' }, { contextId: 'bad' }, { expiresAt: 60101 },
    { sessionId: production.sessionId }, { resolveProjectId: production.resolveProjectId }, { receipt: {} }])
    expect(ucvValidationContextSchema.safeParse({ ...context, ...patch }).success).toBe(false);
});
it('transitive validation code has no receipt/store/S7/Resolve/secret logging or persistence dependency', () => {
  const built = buildSync({ entryPoints: ['src/main/video-editing/ucv-validation.ts'], bundle: true, platform: 'node',
    format: 'esm', write: false, metafile: true, packages: 'external' });
  const inputs = Object.keys(built.metafile!.inputs);
  expect(inputs).toContain('src/main/video-editing/capability-operator-proof.ts');
  expect(inputs.filter(p => /service|store|source-end-admission|authority|runtime-inspection|execution|logger|durable/.test(p))).toEqual([]);
  const source = readFileSync('src/main/video-editing/ucv-validation.ts', 'utf8');
  expect(source).not.toMatch(/console\.|logInfo|logWarn|writeFile|writeDurable|confirmCapabilityAdmission|consumeCapabilityOperatorProof/);
});
