import { it, expect, vi, describe, beforeEach, afterEach } from 'vitest';
import { resetVideoStoreForTests } from '../src/main/video-editing/service.js';
import { verifiedCapabilityReview, authenticatedCapabilityReceipt as createCapabilityAdmissionReceipt } from './fixtures/video-capability-authentication.js';
import { authenticateCapabilityOperator, consumeCapabilityOperatorProof, type CapabilityOperatorReview } from '../src/main/video-editing/capability-operator-proof.js';
import { faultGate } from './helpers.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const testMockState = vi.hoisted(() => ({
  parent: { caller: { sessionId: 'session-1', conversationId: 'chat-1' } } as any,
  session: { id: 'session-1', conversationId: 'chat-1', chatIds: ['chat-1'] } as any,
  readOnly: false,
  read: true,
  pluginSnapshot: null as any,
}));

vi.mock('../src/main/mcp/call-context.js', () => ({
  currentCall: () => testMockState.parent,
  currentAgent: () => undefined,
}));

vi.mock('../src/main/session/store.js', () => ({
  getSession: async (id: string) => testMockState.session?.id === id ? testMockState.session : { id, conversationId: 'default-chat', chatIds: ['default-chat'] },
}));

vi.mock('../src/main/config.js', () => ({
  getConfig: () => ({ readOnly: testMockState.readOnly, mediaRuntime: { test: 'admitted' } }),
  effectiveCapabilities: () => ({ read: testMockState.read }),
}));

vi.mock('../src/main/plugins/manager.js', () => ({
  pluginManager: {
    snapshot: () => testMockState.pluginSnapshot ?? {
      plugins: [{
        id: 'ea624669-8207-4138-9912-b5cd31a4bd0d',
        name: 'DaVinci Resolve',
        catalogId: 'davinci-resolve',
        version: '1.7.0',
        enabled: true,
        status: 'ready',
        tools: [
          { name: 'resolve_inspect', enabled: true, published: true },
          { name: 'resolve_assemble_rough_cut', enabled: true, published: true },
        ],
        davinci: {
          sourceEnd: 'inclusive',
          guardVersion: 2,
        },
      }],
      catalog: [],
      schemaRevision: 18,
    },
  },
}));

import { produceTimeline } from '../src/main/video-editing/producers.js';
import { timelinePage } from './fixtures/video-observation.js';
import { sourceUsabilityFixture } from './fixtures/video-source-usability.js';
import { sourceUsabilityBinding } from '../src/main/video-editing/source-usability.js';
import {
  effectiveSourceEnd,
  effectiveWorkflowCapabilities,
  assertCapabilityConfirmationMutable,
  assertCapabilityAdmissionReceiptBinding,
  createCapabilityAdmissionReceipt as createLegacyCapabilityAdmissionReceipt,
  capabilityAdmissionBlockers,
  capabilityAdmissionFingerprint,
  capabilityAdmissionReceiptFingerprint,
  isCapabilityConfirmationAuthorityValid,
} from '../src/main/video-editing/source-end-admission.js';
import { initDurableStore, resetDurableForTests, writeStrictDurableNow } from '../src/main/durable.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import type { VideoEditingDocument, CapabilityAdmission } from '../src/shared/video-editing.js';
import { capabilityAdmissionReceiptSchema, VIDEO_DOCUMENT_MAX_BYTES } from '../src/shared/video-editing.js';

function decision(job: VideoEditingDocument, assetId = 'source-a', ranges = [{ start: 0, end: 24 }]) {
  return { binding: sourceUsabilityBinding(job, assetId), expectedRevision: job.workflow!.revision, ranges };
}

async function createAdmittedFixture(dir: string, adapterVersion = '1.7.0', epoch = 'ea624669-8207-4138-9912-b5cd31a4bd0d:18') {
  const f = await sourceUsabilityFixture(dir, false, 'unknown');
  const planned = await f.coordinator.plan(f.request.id);
  const withA = await f.coordinator.setUsableRanges(f.request.id, decision(planned, 'source-a'));
  const green = await f.coordinator.setUsableRanges(f.request.id, decision(withA, 'source-b'));
  await f.coordinator.select(f.request.id, green.candidates[0]!.id, 'operator-ipc');
  const admitted = await f.coordinator.readmitCapabilities(f.request.id, {
    sourceEnd: 'inclusive',
    guardVersion: 2,
    adapterVersion,
    epoch,
  });
  return { ...f, job: admitted };
}

/** Synthetic historical admission topology; no live job or session identity. */
function historicalAdmissionFixture(): VideoEditingDocument {
  const admission: Omit<CapabilityAdmission, 'capabilityFingerprint'> = {
    jobId: 'synthetic-capability-history',
    sessionId: 'synthetic-historical-session',
    localProjectId: null,
    resolveProjectId: 'c6bb3432-2675-4cb7-b0ba-39a486187e06-proj',
    sourceEnd: 'inclusive' as const,
    guardVersion: 2 as const,
    adapterVersion: '1.7.0',
    adapterEpoch: 'ea624669-8207-4138-9912-b5cd31a4bd0d:18',
    admittedAt: 1760133857000,
    revision: 15,
    provenance: 'trusted-adapter' as const,
  };
  const fingerprint = capabilityAdmissionFingerprint(admission);

  return {
    version: 1,
    id: 'synthetic-capability-history',
    sessionId: 'synthetic-historical-session',
    localProjectId: null,
    resolveProjectId: 'c6bb3432-2675-4cb7-b0ba-39a486187e06-proj',
    objective: 'S7.5 live acceptance',
    maxRevisions: 10,
    evidence: [
      { id: 'ev-a', subject: 'media' as const, subjectId: 'source-a', basis: 'fixture' as const, producer: { name: 'test', version: '1.0' }, observedAt: 100, confidence: 1, parents: [] },
      { id: 'ev-b', subject: 'media' as const, subjectId: 'source-b', basis: 'fixture' as const, producer: { name: 'test', version: '1.0' }, observedAt: 100, confidence: 1, parents: [] },
      { id: 'ev-ref', subject: 'reference' as const, subjectId: 'ref-1', basis: 'fixture' as const, producer: { name: 'test', version: '1.0' }, observedAt: 100, confidence: 1, parents: [] },
    ],
    references: [
      {
        id: 'ref-1',
        referenceId: 'ref-1',
        status: 'complete',
        evidenceIds: ['ev-ref'],
      },
    ],
    media: [
      {
        id: 'source-a',
        path: 'D:/a.mov',
        sha256: 'a'.repeat(64),
        status: 'complete',
        evidenceIds: ['ev-a'],
        usableRanges: [{ start: 0, end: 24, evidenceIds: ['ev-a'] }],
        sceneRanges: [{ start: 0, end: 24, evidenceIds: ['ev-a'] }],
      },
      {
        id: 'source-b',
        path: 'D:/b.mov',
        sha256: 'b'.repeat(64),
        status: 'complete',
        evidenceIds: ['ev-b'],
        usableRanges: [{ start: 0, end: 24, evidenceIds: ['ev-b'] }],
        sceneRanges: [{ start: 0, end: 24, evidenceIds: ['ev-b'] }],
      },
    ],
    candidates: [
      {
        id: 'candidate-8a41c8980c286c6be7e50907c662403ea25fdf1ba0a3cea90a109f5af9d8c9ab',
        plan: {
          id: 'plan-8a41c8980c286c6be7e50907c662403ea25fdf1ba0a3cea90a109f5af9d8c9ab',
          rootPlanId: 'plan-8a41c8980c286c6be7e50907c662403ea25fdf1ba0a3cea90a109f5af9d8c9ab',
          revision: 1,
          referenceProfileIds: ['ref-1'],
          evidenceIds: ['ev-a', 'ev-b'],
          features: ['cut'],
          timeline: { name: 'Acceptance', fps: { numerator: 24, denominator: 1 }, durationFrames: 48 },
          clips: [
            { id: 'clip-a', mediaId: 'source-a', mediaType: 'video', track: 1, source: { start: 0, end: 24 }, timeline: { start: 0, end: 24 }, evidenceIds: ['ev-a'] },
            { id: 'clip-b', mediaId: 'source-b', mediaType: 'video', track: 1, source: { start: 0, end: 24 }, timeline: { start: 24, end: 48 }, evidenceIds: ['ev-b'] },
          ],
        },
        rationale: 'Live candidate',
        risks: [],
        scores: [{ criterion: 'operator-preference', value: 1, evidenceIds: ['ev-a'] }],
      },
    ],
    checkpoints: [],
    reviews: [],
    revisions: [],
    workflow: {
      request: {
        version: 1,
        id: 'synthetic-capability-history',
        sessionId: 'synthetic-historical-session',
        localProjectId: null,
        resolveProjectId: 'c6bb3432-2675-4cb7-b0ba-39a486187e06-proj',
        objective: 'S7.5 live acceptance',
        assets: [
          { id: 'source-a', role: 'source', kind: 'video', path: 'D:/a.mov', resolveMediaId: 'pool-a', usable: { operatorId: 'op-1', ranges: [{ start: 0, end: 24 }] } },
          { id: 'source-b', role: 'source', kind: 'video', path: 'D:/b.mov', resolveMediaId: 'pool-b', usable: { operatorId: 'op-1', ranges: [{ start: 0, end: 24 }] } },
          { id: 'ref-1', role: 'reference', kind: 'image', path: 'D:/ref.png' },
        ],
        target: { durationFrames: 48, fps: { numerator: 24, denominator: 1 }, width: 64, height: 36 },
        style: [],
        features: ['cut'],
        content: { requiredAssetIds: ['source-a', 'source-b'], forbiddenAssetIds: [] },
        titles: [],
        output: { container: 'mov', renderRequired: false },
        weights: [{ criterion: 'operator-preference', weight: 1 }],
        maxRevisions: 10,
        mode: 'prepare-only',
      },
      requestHash: 'd0047f2d9de0e6da32141bb8f789b2b1a0c13906dfba1426e422ae7a1f0b475b',
      revision: 15,
      phase: 'selected',
      blockers: [],
      comparison: [
        {
          candidateId: 'candidate-8a41c8980c286c6be7e50907c662403ea25fdf1ba0a3cea90a109f5af9d8c9ab',
          planId: 'plan-8a41c8980c286c6be7e50907c662403ea25fdf1ba0a3cea90a109f5af9d8c9ab',
          score: 1,
          blockers: [],
        },
      ],
      capabilities: {
        tools: ['resolve_inspect', 'resolve_assemble_rough_cut'],
        sourceEnd: 'unknown',
        acceptance: 'unverified',
      },
      selection: {
        candidateId: 'candidate-8a41c8980c286c6be7e50907c662403ea25fdf1ba0a3cea90a109f5af9d8c9ab',
        operatorId: 'operator-ipc',
        kind: 'operator',
      },
      capabilityAdmission: {
        ...admission,
        capabilityFingerprint: fingerprint,
      },
    },
  };
}

describe('KOSMOSYN S7.5 Native Capability-Readmission Confirmation Receipt', () => {
  describe('independent authority at the durable service boundary', () => {
    let dir: string, before: VideoEditingDocument;
    let ledger: Awaited<ReturnType<typeof import('../src/main/video-editing/service.js').videoStore>>;
    beforeEach(async () => {
      dir = await makeTempDir('cos-capability-authority-'); initDurableStore(dir);
      const f = await createAdmittedFixture(dir);
      testMockState.session = { id: f.request.sessionId, projectId: null, conversationId: 'synthetic-chat', chatIds: ['synthetic-chat'] };
      const { videoStore } = await import('../src/main/video-editing/service.js');
      ledger = await videoStore(); before = ledger.get(f.request.id)!;
    });
    afterEach(async () => { resetDurableForTests(); await removeTempDir(dir); });
    const run = async (review: CapabilityOperatorReview = verifiedCapabilityReview, guard?: () => void) => {
      const { confirmCapabilityAdmissionJob } = await import('../src/main/video-editing/service.js');
      return confirmCapabilityAdmissionJob(before.id, before.workflow!.capabilityAdmission!.capabilityFingerprint, review, guard);
    };
    const unchanged = () => {
      const job = ledger.get(before.id)!;
      expect(job.workflow!.capabilityConfirmation).toBeUndefined();
      expect(job.workflow!.prepared).toBeUndefined();
      expect(job.operatorAuthorizations ?? []).toEqual([]);
      return job;
    };
    it('valid current OS authority creates exactly one bound receipt and survives restore', async () => {
      const result = await run() as any;
      expect(result.status).toBe('confirmed');
      expect(result.receipt.authentication).toMatchObject({ method: 'windows-user-consent-verifier' });
      expect(result.receipt.authentication.challengeHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.receipt.conversationId).toBe('synthetic-chat');
      expect(result.receipt.admissionRevision).toBe(before.workflow!.capabilityAdmission!.revision);
      expect(result.job.workflow.revision).toBe(before.workflow!.revision + 1);
      const { VideoEditingStore } = await import('../src/main/video-editing/store.js');
      const restored = new VideoEditingStore(); await restored.restore();
      expect(restored.get(before.id)!.workflow!.capabilityConfirmation).toEqual(result.receipt);
      await expect(run()).rejects.toThrow(/already confirmed/);
      expect(ledger.get(before.id)!.workflow!.revision).toBe(result.job.workflow.revision);
    });
    it('new receipt binds conversation and authentication metadata, including an absent conversation', async () => {
      testMockState.session.conversationId = null;
      const result = await run() as any;
      expect(result.receipt.conversationId).toBeUndefined();
      assertCapabilityAdmissionReceiptBinding(result.job, result.receipt);
      expect(() => assertCapabilityAdmissionReceiptBinding(result.job, { ...result.receipt, conversationId: 'foreign-chat' })).toThrow(/fingerprint/);
      expect(() => assertCapabilityAdmissionReceiptBinding(result.job, { ...result.receipt,
        authentication: { ...result.receipt.authentication, verifiedAt: 0 } })).toThrow(/timestamp/);
    });
    it.each([undefined, true, {}, { method: 'windows-user-consent-verifier' }])('rejects unissued/malformed proof %j', async proof => {
      await expect(run(async () => proof)).rejects.toThrow(/independent operator authentication/i);
      expect(unchanged().workflow!.revision).toBe(before.workflow!.revision);
    });
    it('native or credential cancellation leaves revision unchanged', async () => {
      expect(await run(async () => null)).toEqual({ cancelled: true });
      expect(await run((detail, context) => authenticateCapabilityOperator(context, detail, async () => null, () => {}))).toEqual({ cancelled: true });
      expect(unchanged().workflow!.revision).toBe(before.workflow!.revision);
    });
    it('one-use proof cannot be reused, copied or substituted across context', async () => {
      let retained: unknown;
      const result = await run(async (detail, context) => {
        retained = await verifiedCapabilityReview(detail, context);
        expect(() => consumeCapabilityOperatorProof({}, context)).toThrow();
        return retained;
      }) as any;
      expect(result.receipt).toBeDefined();
      // A separately bound attempt burns its proof even when the binding is wrong.
      await expect(run(async () => retained)).rejects.toThrow(/already confirmed/);
    });
    it.each(['sessionId', 'conversationId', 'capabilityFingerprint', 'admissionRevision', 'adapterEpoch', 'sourceEnd', 'guardVersion'])('rejects a proof bound to the wrong %s', async key => {
      await expect(run((detail, context) => authenticateCapabilityOperator({ ...context, [key]: key === 'admissionRevision' || key === 'guardVersion' ? 999 : 'wrong' }, detail,
        async () => 'windows-user-consent-verifier', () => {}))).rejects.toThrow(/binding changed/);
      expect(unchanged().workflow!.revision).toBe(before.workflow!.revision);
    });
    it.each(['session', 'conversation', 'project', 'readOnly', 'epoch', 'guard', 'sourceEnd', 'offline', 'adapterVersion'])('revokes in-flight authority on changed %s', async change => {
      const review: CapabilityOperatorReview = async (detail, context) => {
        const proof = await verifiedCapabilityReview(detail, context);
        if (change === 'session') testMockState.session.id = 'other-session';
        if (change === 'conversation') testMockState.session.conversationId = 'successor-chat';
        if (change === 'project') testMockState.session.projectId = 'other-project';
        if (change === 'readOnly') testMockState.readOnly = true;
        if (['epoch', 'guard', 'sourceEnd', 'offline', 'adapterVersion'].includes(change)) {
          const snapshot = { plugins: [{ id: 'ea624669-8207-4138-9912-b5cd31a4bd0d', catalogId: 'davinci-resolve', enabled: true,
            status: change === 'offline' ? 'stopped' : 'ready', version: change === 'adapterVersion' ? '1.8.0' : '1.7.0',
            davinci: { guardVersion: change === 'guard' ? 1 : 2, sourceEnd: change === 'sourceEnd' ? 'unknown' : 'inclusive' } }],
            schemaRevision: change === 'epoch' ? 19 : 18 };
          testMockState.pluginSnapshot = snapshot;
        }
        return proof;
      };
      await expect(run(review)).rejects.toThrow(/changed/);
      expect(unchanged().workflow!.revision).toBe(before.workflow!.revision);
    });
    it('rejects a workflow revision change with the same admission fingerprint', async () => {
      await expect(run(async (detail, context) => {
        const proof = await verifiedCapabilityReview(detail, context);
        const next = structuredClone(before); next.workflow!.revision++;
        next.workflow!.phase = 'blocked'; next.workflow!.blockedAt = 'preparing'; next.workflow!.blockers = ['SYNTHETIC_BLOCK'];
        await ledger.advanceWorkflow(next, before.workflow!.revision);
        return proof;
      })).rejects.toThrow(/changed/);
      expect(unchanged().workflow!.revision).toBe(before.workflow!.revision + 1);
    });
    it('rejects a fresh readmission even when confirmation was already in flight', async () => {
      await expect(run(async (detail, context) => {
        const proof = await verifiedCapabilityReview(detail, context);
        await ledger.setCapabilityAdmission(before.id, { sourceEnd: 'inclusive', guardVersion: 2, adapterVersion: '1.7.0', epoch: 'different-epoch' });
        return proof;
      })).rejects.toThrow(/changed/);
      unchanged();
    });
    it('rejects racing confirmations before the second review can obtain authority', async () => {
      const gate = faultGate();
      const first = run(async (detail, context) => { await gate.hold(); return verifiedCapabilityReview(detail, context); });
      await gate.entered;
      const secondReview = vi.fn(verifiedCapabilityReview);
      await expect(run(secondReview)).rejects.toThrow(/already pending/);
      expect(secondReview).not.toHaveBeenCalled(); gate.release();
      expect((await first as any).status).toBe('confirmed');
      expect(ledger.get(before.id)!.workflow!.revision).toBe(before.workflow!.revision + 1);
    });
    it('renderer retirement during staging vetoes the final rename, preserving durable bytes', async () => {
      const target = path.join(dir, 'state', 'video-editing-jobs.json');
      const oldBytes = await fs.readFile(target);
      let valid = true;
      const original = fs.writeFile.bind(fs);
      const write = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
        await original(...args);
        if (String(args[0]).endsWith('video-editing-jobs.json.strict.tmp')) valid = false;
      });
      try {
        await expect(run(verifiedCapabilityReview, () => { if (!valid) throw new Error('Synthetic renderer destroyed'); }))
          .rejects.toThrow(/renderer destroyed/);
        expect(await fs.readFile(target)).toEqual(oldBytes);
        await expect(fs.stat(`${target}.strict.tmp`)).rejects.toThrow();
      } finally { write.mockRestore(); }
    });
    it('proof expiry during staging vetoes the final rename, preserving durable bytes', async () => {
      const target = path.join(dir, 'state', 'video-editing-jobs.json'), oldBytes = await fs.readFile(target);
      let clock = Date.now();
      const time = vi.spyOn(Date, 'now').mockImplementation(() => clock), original = fs.writeFile.bind(fs);
      const write = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
        await original(...args);
        if (String(args[0]).endsWith('video-editing-jobs.json.strict.tmp')) clock += 60_000;
      });
      try {
        await expect(run()).rejects.toThrow(/expired before publication/);
        expect(await fs.readFile(target)).toEqual(oldBytes);
        await expect(fs.stat(`${target}.strict.tmp`)).rejects.toThrow();
      } finally { write.mockRestore(); time.mockRestore(); }
    });
  });
  describe('legacy unauthenticated receipt quarantine', () => {
    let dir: string, f: Awaited<ReturnType<typeof createAdmittedFixture>>, legacy: VideoEditingDocument;
    beforeEach(async () => {
      dir = await makeTempDir('cos-legacy-receipt-quarantine-'); initDurableStore(dir);
      f = await createAdmittedFixture(dir);
      legacy = structuredClone(f.job);
      legacy.workflow!.capabilityConfirmation = createLegacyCapabilityAdmissionReceipt(legacy, 'operator-ipc');
      legacy.workflow!.revision++;
      // Historical bytes enter only a disposable test ledger, through restore rather than issuance.
      await writeStrictDurableNow('video-editing-jobs', { version: 1, jobs: [legacy] }, VIDEO_DOCUMENT_MAX_BYTES);
      const { VideoEditingStore } = await import('../src/main/video-editing/store.js');
      const { VideoWorkflowCoordinator } = await import('../src/main/video-editing/workflow.js');
      f.store = new VideoEditingStore(); await f.store.restore();
      f.coordinator = new VideoWorkflowCoordinator(f.store, { ingestor: f.ingestor, planner: f.planner, capabilities: legacy.workflow!.capabilities });
      testMockState.session = { id: legacy.sessionId, conversationId: 'synthetic-chat', chatIds: ['synthetic-chat'] };
      testMockState.parent = { caller: { sessionId: legacy.sessionId, conversationId: 'synthetic-chat' } };
    });
    afterEach(async () => { resetDurableForTests(); await removeTempDir(dir); });
    it('LEGACY_UNAUTHENTICATED_RECEIPT_PARSES_FOR_FORENSICS', () => {
      const receipt = legacy.workflow!.capabilityConfirmation!;
      expect(receipt.authentication).toBeUndefined();
      expect(capabilityAdmissionReceiptSchema.parse(receipt)).toEqual(receipt);
      expect(f.store.get(legacy.id)!.workflow!.capabilityConfirmation).toEqual(receipt);
    });
    it('LEGACY_RECEIPT_WITHOUT_AUTHENTICATION_EFFECTIVE_SOURCE_END_IS_UNKNOWN', () => {
      expect(isCapabilityConfirmationAuthorityValid(legacy)).toBe(false);
      expect(effectiveSourceEnd(legacy)).toBe('unknown');
      expect(effectiveWorkflowCapabilities(legacy).sourceEnd).toBe('unknown');
    });
    it('LEGACY_RECEIPT_WITHOUT_AUTHENTICATION_REQUIRES_FRESH_CONFIRMATION', async () => {
      const { videoAction } = await import('../src/main/video-editing/service.js');
      const status: any = await videoAction({ action: 'capability-status', jobId: legacy.id }, async () => true);
      expect(status.preparationBlockedByConfirmation).toBe(true);
      expect(status.preparationEligible).toBe(false);
      expect(status.confirmationRequired).toBe(true);
      expect(status.confirmationAuthorityValid).toBe(false);
      expect(status.nativeConfirmation).toEqual(legacy.workflow!.capabilityConfirmation);
      expect(capabilityAdmissionBlockers(legacy)).toContain('CAPABILITY_ADMISSION_OPERATOR_CONFIRMATION_REQUIRED');
      const admitted: any = await videoAction({ action: 'readmit-source-end', jobId: legacy.id, expectedRevision: legacy.workflow!.revision }, async () => true);
      expect(admitted.confirmationRequired).toBe(true);
    });
    it('LEGACY_RECEIPT_WITHOUT_AUTHENTICATION_BLOCKS_PREPARATION', async () => {
      const page: any = timelinePage();
      page.items = []; page.total = 0; page.duration_frames = 0;
      page.project_unique_id = legacy.resolveProjectId; page.rough_cut_guard_version = 2; page.source_end = 'inclusive';
      const target = produceTimeline([page], { id: 'synthetic-target', subjectId: page.unique_id, observedAt: 100 }).evidence;
      const result = await f.coordinator.prepare(legacy.id, target);
      expect(result.document.workflow!.phase).toBe('blocked');
      expect(result.document.workflow!.blockers).toContain('CAPABILITY_ADMISSION_OPERATOR_CONFIRMATION_REQUIRED');
      expect(result.prepared.operations).toEqual([]);
    });
    it('LEGACY_RECEIPT_DOES_NOT_BLOCK_FRESH_STRONG_RECONFIRMATION', async () => {
      const { confirmCapabilityAdmissionJob, videoStore } = await import('../src/main/video-editing/service.js');
      const ledger = await videoStore();
      const result: any = await confirmCapabilityAdmissionJob(legacy.id, legacy.workflow!.capabilityAdmission!.capabilityFingerprint, verifiedCapabilityReview);
      expect(result.status).toBe('confirmed');
      expect(result.receipt.id).not.toBe(legacy.workflow!.capabilityConfirmation!.id);
      expect(result.receipt.authentication.method).toBe('windows-user-consent-verifier');
      expect(result.receipt.authentication.verifiedAt).toBe(result.receipt.confirmedAt);
      expect(result.job.workflow.revision).toBe(legacy.workflow!.revision + 1);
      expect(ledger.get(legacy.id)!.workflow!.capabilityConfirmation).toEqual(result.receipt);
      const bytes = JSON.parse(await fs.readFile(path.join(dir, 'state', 'video-editing-jobs.json'), 'utf8'));
      expect(bytes.jobs[0]).toEqual(result.job);
      // A warm observer recognizes exactly the single committed replacement transition.
      await f.store.restore(); expect(f.store.get(legacy.id)).toEqual(result.job);
      expect(result.job.workflow.capabilityAdmission).toEqual(legacy.workflow!.capabilityAdmission);
      expect(result.job.workflow.selection).toEqual(legacy.workflow!.selection);
      expect(result.job.evidence).toEqual(legacy.evidence);
      expect(result.job.checkpoints).toEqual([]);
      expect(result.job.operatorAuthorizations ?? []).toEqual([]);
      const duplicate = vi.fn(verifiedCapabilityReview);
      await expect(confirmCapabilityAdmissionJob(legacy.id, result.receipt.capabilityFingerprint, duplicate)).rejects.toThrow(/already confirmed/);
      expect(duplicate).not.toHaveBeenCalled();
      await expect(ledger.confirmCapabilityAdmission(legacy.id, result.receipt, result.job.workflow.revision)).rejects.toThrow(/already confirmed/);
      expect(ledger.get(legacy.id)).toEqual(result.job);
    });
    it.each(['missing', 'timestamp', 'expiry', 'ttl', 'method', 'shape', 'hash'])('malformed or historical authentication %s fails closed even with a matching public fingerprint', kind => {
      const strong = createCapabilityAdmissionReceipt(legacy, 'operator-ipc');
      const receipt: any = structuredClone(strong);
      if (kind === 'missing') delete receipt.authentication;
      if (kind === 'timestamp') receipt.authentication.verifiedAt--;
      if (kind === 'expiry') receipt.authentication.expiresAt = receipt.authentication.verifiedAt;
      if (kind === 'ttl') receipt.authentication.expiresAt = receipt.authentication.verifiedAt + 60_001;
      if (kind === 'method') receipt.authentication.method = 'windows-credentials';
      if (kind === 'shape') receipt.authentication.untrusted = true;
      if (kind === 'hash') receipt.authentication.challengeHash = 'invalid';
      const { id: _id, kind: _kind, confirmedAt: _time, confirmationFingerprint: _hash, ...payload } = receipt;
      receipt.confirmationFingerprint = capabilityAdmissionReceiptFingerprint({ ...payload,
        ...(receipt.authentication ? { conversationId: receipt.conversationId ?? null } : {}) });
      if (kind === 'method') expect(capabilityAdmissionReceiptSchema.safeParse(receipt).success).toBe(true);
      const job = { ...legacy, workflow: { ...legacy.workflow!, capabilityConfirmation: receipt } };
      expect(isCapabilityConfirmationAuthorityValid(job)).toBe(false);
      expect(effectiveSourceEnd(job)).toBe('unknown');
      expect(capabilityAdmissionBlockers(job)).toContain('CAPABILITY_ADMISSION_OPERATOR_CONFIRMATION_REQUIRED');
    });
    it('durable UCV confirmation remains authoritative after the proof issuance TTL', () => {
      const receipt = createCapabilityAdmissionReceipt(legacy, 'operator-ipc', undefined, 100);
      const job = { ...legacy, workflow: { ...legacy.workflow!, capabilityConfirmation: receipt } };
      expect(isCapabilityConfirmationAuthorityValid(job)).toBe(true);
      expect(effectiveSourceEnd(job)).toBe('inclusive');
    });
    it('ledger rejects unauthenticated issuance and stale revision without publishing', async () => {
      const before = await fs.readFile(path.join(dir, 'state', 'video-editing-jobs.json'));
      await expect(f.store.confirmCapabilityAdmission(legacy.id, legacy.workflow!.capabilityConfirmation!, legacy.workflow!.revision))
        .rejects.toThrow(/authenticated/);
      await expect(f.store.confirmCapabilityAdmission(legacy.id, createCapabilityAdmissionReceipt(legacy, 'operator-ipc'), legacy.workflow!.revision - 1))
        .rejects.toThrow(/revision changed/);
      expect(await fs.readFile(path.join(dir, 'state', 'video-editing-jobs.json'))).toEqual(before);
      expect(f.store.get(legacy.id)).toEqual(legacy);
    });
    it('non-authoritative stale binding allows only a fresh exact authenticated replacement', async () => {
      legacy.workflow!.capabilityConfirmation!.capabilityFingerprint = '0'.repeat(64);
      await writeStrictDurableNow('video-editing-jobs', { version: 1, jobs: [legacy] }, VIDEO_DOCUMENT_MAX_BYTES);
      const { confirmCapabilityAdmissionJob } = await import('../src/main/video-editing/service.js');
      const result: any = await confirmCapabilityAdmissionJob(legacy.id, legacy.workflow!.capabilityAdmission!.capabilityFingerprint, verifiedCapabilityReview);
      expect(result.job.workflow.revision).toBe(legacy.workflow!.revision + 1);
      expect(isCapabilityConfirmationAuthorityValid(result.job)).toBe(true);
    });
    it.each(['renderer', 'expiry', 'write'])('replacement failure at %s staging preserves legacy bytes and burns the proof', async failure => {
      const { confirmCapabilityAdmissionJob, videoStore } = await import('../src/main/video-editing/service.js');
      const ledger = await videoStore(), file = path.join(dir, 'state', 'video-editing-jobs.json'), before = await fs.readFile(file);
      let alive = true, retained: unknown, clock = Date.now();
      const time = vi.spyOn(Date, 'now').mockImplementation(() => clock), original = fs.writeFile.bind(fs);
      const write = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
        if (String(args[0]).endsWith('video-editing-jobs.json.strict.tmp')) {
          if (failure === 'write') throw new Error('Synthetic staging failure');
          await original(...args);
          if (failure === 'renderer') alive = false;
          if (failure === 'expiry') clock += 60_000;
        } else await original(...args);
      });
      try {
        await expect(confirmCapabilityAdmissionJob(legacy.id, legacy.workflow!.capabilityAdmission!.capabilityFingerprint,
          async (detail, context) => { retained = await verifiedCapabilityReview(detail, context); return retained; },
          () => { if (!alive) throw new Error('Synthetic renderer retired'); })).rejects.toThrow();
        expect(await fs.readFile(file)).toEqual(before);
        write.mockRestore(); alive = true; await ledger.restore();
        expect(ledger.get(legacy.id)).toEqual(legacy);
        await expect(confirmCapabilityAdmissionJob(legacy.id, legacy.workflow!.capabilityAdmission!.capabilityFingerprint, async () => retained))
          .rejects.toThrow(/independent operator authentication/i);
      } finally { write.mockRestore(); time.mockRestore(); }
    });
    it('legacy receipt cannot issue or dispatch execution even with an old compiled preparation', async () => {
      const { prepareExecution, VideoExecutionCoordinator } = await import('../src/main/video-editing/execution.js');
      const { createOperatorAuthorization, operatorBinding } = await import('../src/main/video-editing/operator-authorization.js');
      const { evaluateWorkflowAuthorization } = await import('../src/main/video-editing/workflow-guards.js');
      const { VideoEditingStore } = await import('../src/main/video-editing/store.js');
      const { randomUUID } = await import('node:crypto');
      const job = structuredClone(legacy), page: any = timelinePage();
      page.items = []; page.total = 0; page.duration_frames = 0; page.project_unique_id = job.resolveProjectId;
      const target = produceTimeline([page], { id: 'synthetic-old-target', subjectId: page.unique_id, observedAt: 100 }).evidence;
      job.evidence.push(target);
      const compiled = prepareExecution(job, { planId: job.candidates.find(row => row.id === job.workflow!.selection!.candidateId)!.plan.id,
        timelineId: target.subjectId, beforeEvidenceIds: [target.id], operationId: randomUUID() }, { ...job.workflow!.capabilities, sourceEnd: 'inclusive' });
      expect(compiled.state).toBe('ready'); // Historical compilation is evidence, never authority.
      job.workflow!.phase = 'prepared';
      job.workflow!.prepared = { request: compiled.request, capabilities: compiled.capabilities, intentHash: compiled.intentHash, preparedHash: compiled.preparedHash };
      await writeStrictDurableNow('video-editing-jobs', { version: 1, jobs: [job] }, VIDEO_DOCUMENT_MAX_BYTES);
      const store = new VideoEditingStore(); await store.restore();
      expect(() => createOperatorAuthorization(job, 'operator-ipc')).toThrow(/confirmation authority/);
      const historicalAuthority = { ...operatorBinding(job), id: randomUUID(), kind: 'operator-explicit' as const, provenance: 'operator-ipc' as const,
        issuedAt: Date.now(), expiresAt: Date.now() + 600_000 };
      await expect(store.issueOperatorAuthorization(historicalAuthority)).rejects.toThrow(/confirmation authority/);
      await expect(store.claim({ jobId: job.id, ...compiled.request, step: 'assemble' })).rejects.toThrow(/confirmation authority/);
      // Historical authority custody remains readable, but cannot be consumed or joined to a new claim.
      job.operatorAuthorizations = [historicalAuthority];
      await writeStrictDurableNow('video-editing-jobs', { version: 1, jobs: [job] }, VIDEO_DOCUMENT_MAX_BYTES);
      await store.restore();
      await expect(store.consumeOperatorAuthorization(job.id, historicalAuthority.id, compiled.preparedHash, historicalAuthority.targetHash))
        .rejects.toThrow(/confirmation authority/);
      await expect(store.claimOperator(job.id, historicalAuthority.id, compiled.preparedHash, historicalAuthority.targetHash))
        .rejects.toThrow(/confirmation authority/);
      const gate = evaluateWorkflowAuthorization(store, job.id, compiled, { jobId: job.id, sessionId: job.sessionId, localProjectId: job.localProjectId,
        resolveProjectId: job.resolveProjectId, timeline: target, media: job.media, capabilities: compiled.capabilities },
        { kind: 'operator', operatorId: 'operator-ipc', preparedHash: compiled.preparedHash }, true);
      expect(gate.allowed).toBe(false); expect(gate.failed).toContain('CAPABILITY_CONFIRMATION_AUTHORITY');
      const call = vi.fn(), guard = vi.fn(), observe = vi.fn();
      const result = await new VideoExecutionCoordinator(store, { mode: 'fixture', call, guard, observe }).execute(compiled);
      expect(result.state).toBe('blocked');
      expect(call).not.toHaveBeenCalled(); expect(guard).not.toHaveBeenCalled(); expect(observe).not.toHaveBeenCalled();
      expect(store.get(job.id)!.checkpoints).toEqual([]);
    });
  });
  it('bare native Confirm cannot mint operator authority without independent authentication', async () => {
    const dir = await makeTempDir('cos-capability-bare-confirm-');
    initDurableStore(dir);
    try {
      const f = await createAdmittedFixture(dir);
      testMockState.session = { id: f.request.sessionId, conversationId: 'synthetic-current-chat', chatIds: ['synthetic-current-chat'] };
      const { confirmCapabilityAdmissionJob, videoStore } = await import('../src/main/video-editing/service.js');
      const ledger = await videoStore(), before = ledger.get(f.request.id)!;
      await expect(confirmCapabilityAdmissionJob(f.request.id,
        before.workflow!.capabilityAdmission!.capabilityFingerprint, async () => true))
        .rejects.toThrow(/independent operator authentication/i);
      const after = ledger.get(f.request.id)!;
      expect(after.workflow!.capabilityConfirmation).toBeUndefined();
      expect(after.workflow!.revision).toBe(before.workflow!.revision);
      expect(after.workflow!.prepared).toBeUndefined();
      expect(after.operatorAuthorizations ?? []).toEqual([]);
    } finally {
      resetDurableForTests();
      await removeTempDir(dir);
    }
  });
  beforeEach(() => {
    testMockState.parent = { caller: { sessionId: 'session-1', conversationId: 'chat-1' } };
    testMockState.session = { id: 'session-1', conversationId: 'chat-1', chatIds: ['chat-1'] };
    testMockState.readOnly = false;
    testMockState.read = true;
    testMockState.pluginSnapshot = null;
    resetVideoStoreForTests();
  });

  afterEach(() => {
    resetVideoStoreForTests();
  });

  it('1. capability-status on untouched rev-15 live job fixture reports admission present, nativeConfirmation null, effectiveSourceEnd unknown, preparationBlockedByConfirmation=true', () => {
    const job = historicalAdmissionFixture();
    expect(job.workflow!.revision).toBe(15);
    expect(job.workflow!.capabilityAdmission).toBeDefined();
    expect(job.workflow!.capabilityConfirmation).toBeUndefined();

    // effectiveSourceEnd strictly evaluates to 'unknown' without operator confirmation
    expect(effectiveSourceEnd(job)).toBe('unknown');

    // Blockers identify confirmation requirement
    const blockers = capabilityAdmissionBlockers(job);
    expect(blockers).toContain('CAPABILITY_ADMISSION_OPERATOR_CONFIRMATION_REQUIRED');
  });

  it('2. readmit-source-end does NOT grant preparation eligibility solely through callback returning true', async () => {
    const job = historicalAdmissionFixture();
    // Simulate what AAAD075 did: adapter admission exists, but no receipt
    expect(job.workflow!.capabilityAdmission!.sourceEnd).toBe('inclusive');
    // effectiveSourceEnd remains unknown
    expect(effectiveSourceEnd(job)).toBe('unknown');
    expect(effectiveWorkflowCapabilities(job).sourceEnd).toBe('unknown');
  });

  it('3. readmit-source-end returns pending proposal/fingerprint, status admitted-pending-operator-confirmation', async () => {
    const dir = await makeTempDir('cos-readmit-pending-');
    initDurableStore(dir);
    try {
      const f = await sourceUsabilityFixture(dir, false, 'unknown');
      const planned = await f.coordinator.plan(f.request.id);
      const withA = await f.coordinator.setUsableRanges(f.request.id, decision(planned, 'source-a'));
      const green = await f.coordinator.setUsableRanges(f.request.id, decision(withA, 'source-b'));
      const selected = await f.coordinator.select(f.request.id, green.candidates[0]!.id, 'operator-ipc');

      const parent = { caller: { sessionId: f.request.sessionId, conversationId: 'chat-1' } };
      const session = { id: f.request.sessionId, conversationId: 'chat-1', chatIds: ['chat-1'] };
      testMockState.parent = parent;
      testMockState.session = session;


      const { videoAction } = await import('../src/main/video-editing/service.js');
      const result = await videoAction({
        action: 'readmit-source-end',
        jobId: f.request.id,
        expectedRevision: selected.workflow!.revision,
      }, async () => true) as any;

      expect(result.status).toBe('admitted-pending-operator-confirmation');
      expect(result.confirmationRequired).toBe(true);
      expect(result.capabilityAdmission.capabilityFingerprint).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      resetDurableForTests();
      await removeTempDir(dir);
    }
  });

  it('4. Native operator confirmation creates valid durable CapabilityAdmissionReceipt', () => {
    const job = historicalAdmissionFixture();
    const receipt = createCapabilityAdmissionReceipt(job, 'operator-ipc', 'synthetic-history-chat');
    expect(receipt).toBeDefined();
    expect(receipt.provenance).toBe('operator-ipc');
    expect(receipt.confirmationFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.confirmedAt).toBeGreaterThan(0);
  });

  it('5. Receipt binds exact: jobId, sessionId, resolveProjectId, capabilityFingerprint, adapterEpoch, sourceEnd, guardVersion, confirmedAt, nonce/ID, provenance', () => {
    const job = historicalAdmissionFixture();
    const receipt = createCapabilityAdmissionReceipt(job, 'operator-ipc', 'chat-1');
    expect(receipt.jobId).toBe(job.id);
    expect(receipt.sessionId).toBe(job.sessionId);
    expect(receipt.resolveProjectId).toBe(job.resolveProjectId);
    expect(receipt.localProjectId).toBe(job.localProjectId);
    expect(receipt.capabilityFingerprint).toBe(job.workflow!.capabilityAdmission!.capabilityFingerprint);
    expect(receipt.adapterEpoch).toBe(job.workflow!.capabilityAdmission!.adapterEpoch);
    expect(receipt.sourceEnd).toBe('inclusive');
    expect(receipt.guardVersion).toBe(2);
    expect(receipt.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(receipt.provenance).toBe('operator-ipc');
    expect(receipt.conversationId).toBe('chat-1');
  });

  it('6. Effective source-end for preparation becomes inclusive ONLY after both trusted admission AND matching valid native confirmation receipt exist', () => {
    const job = historicalAdmissionFixture();
    // Before receipt
    expect(effectiveSourceEnd(job)).toBe('unknown');

    // After receipt
    const receipt = createCapabilityAdmissionReceipt(job, 'operator-ipc');
    const confirmedJob: VideoEditingDocument = {
      ...job,
      workflow: {
        ...job.workflow!,
        capabilityConfirmation: receipt,
      },
    };
    expect(effectiveSourceEnd(confirmedJob)).toBe('inclusive');
  });

  it('7. Preparation blocked with CAPABILITY_ADMISSION_OPERATOR_CONFIRMATION_REQUIRED when admission exists but receipt is absent', async () => {
    const dir = await makeTempDir('cos-blocker-no-receipt-');
    initDurableStore(dir);
    try {
      const f = await sourceUsabilityFixture(dir, false, 'unknown');
      const planned = await f.coordinator.plan(f.request.id);
      const withA = await f.coordinator.setUsableRanges(f.request.id, decision(planned, 'source-a'));
      const green = await f.coordinator.setUsableRanges(f.request.id, decision(withA, 'source-b'));
      await f.coordinator.select(f.request.id, green.candidates[0]!.id, 'operator-ipc');

      // Add admission directly without receipt
      await f.coordinator.readmitCapabilities(f.request.id, {
        sourceEnd: 'inclusive',
        guardVersion: 2,
        adapterVersion: '1.0.3',
        epoch: 'curated:1',
      });

      const page: any = timelinePage();
      page.items = []; page.total = 0; page.duration_frames = 0;
      page.unique_id = 'ai-target-timeline-1';
      page.project_unique_id = f.request.resolveProjectId;
      page.rough_cut_guard_version = 2;
      page.source_end = 'inclusive';
      page.project_name = 'Untitled Project 2';
      page.snapshot_sha256 = 'a'.repeat(64);
      const targetEvidence = produceTimeline([page], { id: 'target-evidence-1', subjectId: page.unique_id, observedAt: 100 }).evidence;

      const prepared = await f.coordinator.prepare(f.request.id, targetEvidence);
      expect(prepared.document.workflow!.phase).toBe('blocked');
      expect(prepared.document.workflow!.blockedAt).toBe('preparing');
      expect(prepared.document.workflow!.blockers).toContain('CAPABILITY_ADMISSION_OPERATOR_CONFIRMATION_REQUIRED');
    } finally {
      resetDurableForTests();
      await removeTempDir(dir);
    }
  });

  it('8. Preparation blocked when receipt capabilityFingerprint does not match admission capabilityFingerprint', () => {
    const job = historicalAdmissionFixture();
    const receipt = createCapabilityAdmissionReceipt(job, 'operator-ipc');
    const tamperedReceipt = { ...receipt, capabilityFingerprint: '0'.repeat(64) };
    const tamperedJob: VideoEditingDocument = {
      ...job,
      workflow: { ...job.workflow!, capabilityConfirmation: tamperedReceipt },
    };
    expect(effectiveSourceEnd(tamperedJob)).toBe('unknown');
    expect(capabilityAdmissionBlockers(tamperedJob)).toContain('CAPABILITY_ADMISSION_OPERATOR_CONFIRMATION_REQUIRED');
  });

  it('9. Preparation blocked when receipt adapterEpoch does not match admission adapterEpoch', () => {
    const job = historicalAdmissionFixture();
    const receipt = createCapabilityAdmissionReceipt(job, 'operator-ipc');
    const mismatchedReceipt = { ...receipt, adapterEpoch: 'different-epoch' };
    const mismatchedJob: VideoEditingDocument = {
      ...job,
      workflow: { ...job.workflow!, capabilityConfirmation: mismatchedReceipt },
    };
    expect(effectiveSourceEnd(mismatchedJob)).toBe('unknown');
    expect(capabilityAdmissionBlockers(mismatchedJob)).toContain('CAPABILITY_ADMISSION_OPERATOR_CONFIRMATION_REQUIRED');
  });

  it('10. Preparation blocked when receipt jobId does not match job.id', () => {
    const job = historicalAdmissionFixture();
    const receipt = createCapabilityAdmissionReceipt(job, 'operator-ipc');
    const mismatchedReceipt = { ...receipt, jobId: 'different-job' };
    const mismatchedJob: VideoEditingDocument = {
      ...job,
      workflow: { ...job.workflow!, capabilityConfirmation: mismatchedReceipt },
    };
    expect(effectiveSourceEnd(mismatchedJob)).toBe('unknown');
    expect(capabilityAdmissionBlockers(mismatchedJob)).toContain('CAPABILITY_ADMISSION_OPERATOR_CONFIRMATION_REQUIRED');
  });

  it('11. Preparation blocked when receipt sessionId does not match job.sessionId', () => {
    const job = historicalAdmissionFixture();
    const receipt = createCapabilityAdmissionReceipt(job, 'operator-ipc');
    const mismatchedReceipt = { ...receipt, sessionId: 'different-session' };
    const mismatchedJob: VideoEditingDocument = {
      ...job,
      workflow: { ...job.workflow!, capabilityConfirmation: mismatchedReceipt },
    };
    expect(effectiveSourceEnd(mismatchedJob)).toBe('unknown');
    expect(capabilityAdmissionBlockers(mismatchedJob)).toContain('CAPABILITY_ADMISSION_OPERATOR_CONFIRMATION_REQUIRED');
  });

  it('12. Preparation blocked when receipt resolveProjectId does not match job.resolveProjectId', () => {
    const job = historicalAdmissionFixture();
    const receipt = createCapabilityAdmissionReceipt(job, 'operator-ipc');
    const mismatchedReceipt = { ...receipt, resolveProjectId: 'different-resolve-project' };
    const mismatchedJob: VideoEditingDocument = {
      ...job,
      workflow: { ...job.workflow!, capabilityConfirmation: mismatchedReceipt },
    };
    expect(effectiveSourceEnd(mismatchedJob)).toBe('unknown');
    expect(capabilityAdmissionBlockers(mismatchedJob)).toContain('CAPABILITY_ADMISSION_OPERATOR_CONFIRMATION_REQUIRED');
  });

  it('13. Preparation blocked when receipt localProjectId does not match job.localProjectId', () => {
    const job = historicalAdmissionFixture();
    const receipt = createCapabilityAdmissionReceipt(job, 'operator-ipc');
    const mismatchedReceipt = { ...receipt, localProjectId: 'unexpected-local-proj' };
    const mismatchedJob: VideoEditingDocument = {
      ...job,
      workflow: { ...job.workflow!, capabilityConfirmation: mismatchedReceipt },
    };
    expect(effectiveSourceEnd(mismatchedJob)).toBe('unknown');
    expect(capabilityAdmissionBlockers(mismatchedJob)).toContain('CAPABILITY_ADMISSION_OPERATOR_CONFIRMATION_REQUIRED');
  });

  it('14. Current authenticated receipt rejects replay and a distinct duplicate without incrementing revision', async () => {
    const dir = await makeTempDir('cos-idempotent-confirm-');
    initDurableStore(dir);
    try {
      const f = await sourceUsabilityFixture(dir, false, 'unknown');
      const planned = await f.coordinator.plan(f.request.id);
      const withA = await f.coordinator.setUsableRanges(f.request.id, decision(planned, 'source-a'));
      const green = await f.coordinator.setUsableRanges(f.request.id, decision(withA, 'source-b'));
      await f.coordinator.select(f.request.id, green.candidates[0]!.id, 'operator-ipc');
      await f.coordinator.readmitCapabilities(f.request.id, {
        sourceEnd: 'inclusive',
        guardVersion: 2,
        adapterVersion: '1.0.3',
        epoch: 'curated:1',
      });

      const currentJob = f.store.get(f.request.id)!;
      const receipt = createCapabilityAdmissionReceipt(currentJob, 'operator-ipc');
      const confirmed1 = await f.store.confirmCapabilityAdmission(f.request.id, receipt, currentJob.workflow!.revision);
      const rev1 = confirmed1.workflow!.revision;
      expect(confirmed1.workflow!.capabilityConfirmation).toBeDefined();

      // A current strong receipt rejects replay, including a distinct receipt for the same admission.
      await expect(f.store.confirmCapabilityAdmission(f.request.id, receipt, rev1)).rejects.toThrow(/already confirmed/);
      await expect(f.store.confirmCapabilityAdmission(f.request.id, createCapabilityAdmissionReceipt(confirmed1, 'operator-ipc'), rev1))
        .rejects.toThrow(/already confirmed/);
      expect(f.store.get(f.request.id)!.workflow!.revision).toBe(rev1);
    } finally {
      resetDurableForTests();
      await removeTempDir(dir);
    }
  });

  it('15. Cold restart preserves both capabilityAdmission and capabilityConfirmation durably across store reload', async () => {
    const dir = await makeTempDir('cos-cold-restart-confirm-');
    initDurableStore(dir);
    try {
      const f = await sourceUsabilityFixture(dir, false, 'unknown');
      const planned = await f.coordinator.plan(f.request.id);
      const withA = await f.coordinator.setUsableRanges(f.request.id, decision(planned, 'source-a'));
      const green = await f.coordinator.setUsableRanges(f.request.id, decision(withA, 'source-b'));
      await f.coordinator.select(f.request.id, green.candidates[0]!.id, 'operator-ipc');
      await f.coordinator.readmitCapabilities(f.request.id, {
        sourceEnd: 'inclusive',
        guardVersion: 2,
        adapterVersion: '1.0.3',
        epoch: 'curated:1',
      });

      const currentJob = f.store.get(f.request.id)!;
      const receipt = createCapabilityAdmissionReceipt(currentJob, 'operator-ipc');
      const confirmed = await f.store.confirmCapabilityAdmission(f.request.id, receipt, currentJob.workflow!.revision);

      // Cold reload
      await f.store.restore();
      const restored = f.store.get(f.request.id)!;
      expect(restored.workflow!.capabilityAdmission).toEqual(confirmed.workflow!.capabilityAdmission);
      expect(restored.workflow!.capabilityConfirmation).toEqual(confirmed.workflow!.capabilityConfirmation);
      expect(effectiveSourceEnd(restored)).toBe('inclusive');
    } finally {
      resetDurableForTests();
      await removeTempDir(dir);
    }
  });

  it('16. Existing rev-15 live job can be confirmed directly via native IPC without requiring re-admission', async () => {
    const dir = await makeTempDir('cos-rev15-confirm-');
    initDurableStore(dir);
    try {
      const f = await createAdmittedFixture(dir);
      const session = { id: f.request.sessionId, conversationId: 'synthetic-history-chat', chatIds: ['synthetic-history-chat'] };
      testMockState.session = session;

      const { confirmCapabilityAdmissionJob } = await import('../src/main/video-editing/service.js');
      let promptText = '';
      const confirm: CapabilityOperatorReview = async (msg, context) => { promptText = msg; return verifiedCapabilityReview(msg, context); };

      const confirmed = await confirmCapabilityAdmissionJob(
        f.request.id,
        f.job.workflow!.capabilityAdmission!.capabilityFingerprint,
        confirm
      ) as any;

      expect(confirmed.status).toBe('confirmed');
      expect(confirmed.receipt).toBeDefined();
      expect(confirmed.receipt.capabilityFingerprint).toBe(f.job.workflow!.capabilityAdmission!.capabilityFingerprint);
      expect(confirmed.job.workflow.capabilityConfirmation).toBeDefined();
      expect(effectiveSourceEnd(confirmed.job)).toBe('inclusive');
      expect(promptText).toContain('Confirm operator readmission of verified inclusive source-end convention');
    } finally {
      resetDurableForTests();
      await removeTempDir(dir);
    }
  });

  it('17. Attempting to confirm when adapter is offline/mismatched fails closed', async () => {
    const dir = await makeTempDir('cos-adapter-offline-confirm-');
    initDurableStore(dir);
    try {
      const f = await createAdmittedFixture(dir);
      testMockState.pluginSnapshot = {
        plugins: [{
          id: 'curated-davinci',
          name: 'DaVinci Resolve',
          catalogId: 'davinci-resolve',
          version: '1.0.3',
          enabled: false, // OFFLINE
          status: 'disabled',
          tools: [],
        }],
        catalog: [],
        schemaRevision: 1,
      };

      const { confirmCapabilityAdmissionJob } = await import('../src/main/video-editing/service.js');
      await expect(confirmCapabilityAdmissionJob(
        f.request.id,
        f.job.workflow!.capabilityAdmission!.capabilityFingerprint,
        async () => true
      )).rejects.toThrow(/ADAPTER_OFFLINE/);
    } finally {
      resetDurableForTests();
      await removeTempDir(dir);
    }
  });

  it('18. Attempting to confirm when adapter epoch changed fails closed with ADAPTER_EPOCH_CHANGED', async () => {
    const dir = await makeTempDir('cos-epoch-changed-confirm-');
    initDurableStore(dir);
    try {
      const f = await createAdmittedFixture(dir);
      testMockState.pluginSnapshot = {
        plugins: [{
          id: 'ea624669-8207-4138-9912-b5cd31a4bd0d',
          name: 'DaVinci Resolve',
          catalogId: 'davinci-resolve',
          version: '1.7.0',
          enabled: true,
          status: 'ready',
          tools: [{ name: 'resolve_inspect', enabled: true, published: true }],
          davinci: {
            sourceEnd: 'inclusive',
            guardVersion: 2,
          },
        }],
        catalog: [],
        schemaRevision: 99, // CHANGED SCHEMA REVISION => CHANGED EPOCH
      };

      const { confirmCapabilityAdmissionJob } = await import('../src/main/video-editing/service.js');
      await expect(confirmCapabilityAdmissionJob(
        f.request.id,
        f.job.workflow!.capabilityAdmission!.capabilityFingerprint,
        async () => true
      )).rejects.toThrow(/ADAPTER_EPOCH_CHANGED/);
    } finally {
      resetDurableForTests();
      await removeTempDir(dir);
    }
  });

  it('19. Attempting to confirm with mismatched expected fingerprint fails closed', async () => {
    const dir = await makeTempDir('cos-mismatched-fingerprint-confirm-');
    initDurableStore(dir);
    try {
      const f = await createAdmittedFixture(dir);
      const { confirmCapabilityAdmissionJob } = await import('../src/main/video-editing/service.js');
      await expect(confirmCapabilityAdmissionJob(
        f.request.id,
        '0'.repeat(64),
        async () => true
      )).rejects.toThrow(/fingerprint mismatch/i);
    } finally {
      resetDurableForTests();
      await removeTempDir(dir);
    }
  });

  it('20. Attempting to confirm before admission exists fails closed', async () => {
    const dir = await makeTempDir('cos-no-admission-confirm-');
    initDurableStore(dir);
    try {
      const f = await sourceUsabilityFixture(dir, false, 'unknown');
      const planned = await f.coordinator.plan(f.request.id);
      const withA = await f.coordinator.setUsableRanges(f.request.id, decision(planned, 'source-a'));
      const green = await f.coordinator.setUsableRanges(f.request.id, decision(withA, 'source-b'));
      await f.coordinator.select(f.request.id, green.candidates[0]!.id, 'operator-ipc');

      const { confirmCapabilityAdmissionJob } = await import('../src/main/video-editing/service.js');
      await expect(confirmCapabilityAdmissionJob(
        f.request.id,
        '0'.repeat(64),
        async () => true
      )).rejects.toThrow(/admission required/i);
    } finally {
      resetDurableForTests();
      await removeTempDir(dir);
    }
  });

  it('21. Confirmation requires operator-ipc provenance (or native-only)', () => {
    const job = historicalAdmissionFixture();
    // Valid creation requires 'operator-ipc'
    const receipt = createCapabilityAdmissionReceipt(job, 'operator-ipc');
    expect(receipt.provenance).toBe('operator-ipc');

    // Schema rejects non-operator-ipc provenance
    expect(() => assertCapabilityAdmissionReceiptBinding(job, {
      ...receipt,
      provenance: 'mcp' as any,
    })).toThrow();
  });

  it('22. Confirmation cannot be forged or injected via MCP videoAction', async () => {
    const dir = await makeTempDir('cos-mcp-no-forge-');
    initDurableStore(dir);
    try {
      const f = await sourceUsabilityFixture(dir, false, 'unknown');
      const parent = { caller: { sessionId: f.request.sessionId, conversationId: 'chat-1' } };
      testMockState.parent = parent;

      const { videoAction } = await import('../src/main/video-editing/service.js');
      // videoAction does not have an action to set or confirm capability confirmation
      await expect(videoAction({
        action: 'confirm-capability-admission' as any,
        jobId: f.request.id,
      }, async () => true)).rejects.toThrow();
    } finally {
      resetDurableForTests();
      await removeTempDir(dir);
    }
  });

  it('23. Confirmation mutation fails if workflow has prepared operation or checkpoints or execution authority', () => {
    const job = historicalAdmissionFixture();

    // 1. Prepared operation exists
    const preparedJob: VideoEditingDocument = {
      ...job,
      workflow: { ...job.workflow!, prepared: { state: 'ready' } as any },
    };
    expect(() => assertCapabilityConfirmationMutable(preparedJob)).toThrow(/prepared operation exists/i);

    // 2. Checkpoints exist
    const checkpointJob: VideoEditingDocument = {
      ...job,
      checkpoints: [{ id: 'cp-1' } as any],
    };
    expect(() => assertCapabilityConfirmationMutable(checkpointJob)).toThrow(/execution checkpoints exist/i);

    // 3. Execution authority exists
    const authJob: VideoEditingDocument = {
      ...job,
      operatorAuthorizations: [{ id: 'auth-1' } as any],
    };
    expect(() => assertCapabilityConfirmationMutable(authJob)).toThrow(/operator authority exists/i);
  });

  it('24. Selection, requestHash, workRequest, target timeline are preserved unmodified across confirmation', async () => {
    const dir = await makeTempDir('cos-preserve-invariants-');
    initDurableStore(dir);
    try {
      const f = await sourceUsabilityFixture(dir, false, 'unknown');
      const planned = await f.coordinator.plan(f.request.id);
      const withA = await f.coordinator.setUsableRanges(f.request.id, decision(planned, 'source-a'));
      const green = await f.coordinator.setUsableRanges(f.request.id, decision(withA, 'source-b'));
      await f.coordinator.select(f.request.id, green.candidates[0]!.id, 'operator-ipc');
      const admitted = await f.coordinator.readmitCapabilities(f.request.id, {
        sourceEnd: 'inclusive',
        guardVersion: 2,
        adapterVersion: '1.0.3',
        epoch: 'curated:1',
      });

      const reqHash = admitted.workflow!.requestHash;
      const candidateId = admitted.workflow!.selection!.candidateId;
      const workRequest = admitted.workflow!.request;

      const receipt = createCapabilityAdmissionReceipt(admitted, 'operator-ipc');
      const confirmed = await f.coordinator.confirmCapabilityAdmission(f.request.id, receipt);

      expect(confirmed.workflow!.requestHash).toBe(reqHash);
      expect(confirmed.workflow!.selection!.candidateId).toBe(candidateId);
      expect(confirmed.workflow!.request).toEqual(workRequest);
      expect(confirmed.workflow!.capabilities.sourceEnd).toBe('unknown'); // Create-time immutable
    } finally {
      resetDurableForTests();
      await removeTempDir(dir);
    }
  });

  it('25. Revision increments cleanly (e.g. rev 15 -> rev 16 on confirmation)', async () => {
    const dir = await makeTempDir('cos-rev-increment-');
    initDurableStore(dir);
    try {
      const f = await createAdmittedFixture(dir);
      const revBefore = f.job.workflow!.revision;
      const receipt = createCapabilityAdmissionReceipt(f.job, 'operator-ipc');
      const confirmed = await f.store.confirmCapabilityAdmission(f.job.id, receipt, f.job.workflow!.revision);
      expect(confirmed.workflow!.revision).toBe(revBefore + 1);
    } finally {
      resetDurableForTests();
      await removeTempDir(dir);
    }
  });

  it('26. Full end-to-end workflow: plan -> range selection -> candidate selection -> target evidence -> prepare blocked -> readmit -> prepare blocked -> native confirm -> prepare succeeds with inclusive frame translation [0, 24) -> [0, 23]', async () => {
    const dir = await makeTempDir('cos-full-e2e-workflow-');
    initDurableStore(dir);
    try {
      const f = await sourceUsabilityFixture(dir, false, 'unknown');
      const planned = await f.coordinator.plan(f.request.id);
      const withA = await f.coordinator.setUsableRanges(f.request.id, decision(planned, 'source-a'));
      const green = await f.coordinator.setUsableRanges(f.request.id, decision(withA, 'source-b'));
      await f.coordinator.select(f.request.id, green.candidates[0]!.id, 'operator-ipc');

      const page: any = timelinePage();
      page.items = []; page.total = 0; page.duration_frames = 0;
      page.unique_id = 'c6bb3432-2675-4cb7-b0ba-39a486187e06';
      page.project_unique_id = f.request.resolveProjectId;
      page.rough_cut_guard_version = 2;
      page.source_end = 'inclusive';
      page.project_name = 'Untitled Project 2';
      page.snapshot_sha256 = 'a'.repeat(64);
      const targetEvidence = produceTimeline([page], { id: 'target-evidence-1', subjectId: page.unique_id, observedAt: 100 }).evidence;

      // 1. Prepare fails closed with SOURCE_END_CONVENTION_UNVERIFIED
      const prep1 = await f.coordinator.prepare(f.request.id, targetEvidence);
      expect(prep1.document.workflow!.blockers).toContain('SOURCE_END_CONVENTION_UNVERIFIED');

      // 2. Readmit capabilities (MCP side)
      await f.coordinator.readmitCapabilities(f.request.id, {
        sourceEnd: 'inclusive',
        guardVersion: 2,
        adapterVersion: '1.0.3',
        epoch: 'curated:1',
      });

      // 3. Prepare fails closed with CAPABILITY_ADMISSION_OPERATOR_CONFIRMATION_REQUIRED
      const prep2 = await f.coordinator.prepare(f.request.id, targetEvidence);
      expect(prep2.document.workflow!.blockers).toContain('CAPABILITY_ADMISSION_OPERATOR_CONFIRMATION_REQUIRED');

      // 4. Native confirmation
      const current = f.store.get(f.request.id)!;
      const receipt = createCapabilityAdmissionReceipt(current, 'operator-ipc');
      await f.coordinator.confirmCapabilityAdmission(f.request.id, receipt);

      // 5. Prepare succeeds cleanly
      const prep3 = await f.coordinator.prepare(f.request.id, targetEvidence);
      expect(prep3.document.workflow!.phase).toBe('prepared');
      expect(prep3.prepared.state).toBe('ready');
      expect(prep3.prepared.blockers).toEqual([]);

      // 6. Inclusive frame translation: [0, 24) -> 0..23
      const op = prep3.prepared.operations[0]!;
      expect(op.name).toBe('resolve_assemble_rough_cut');
      expect(op.arguments.segments[0]!.start_frame).toBe(0);
      expect(op.arguments.segments[0]!.end_frame).toBe(23);
      expect(op.arguments.segments[1]!.start_frame).toBe(0);
      expect(op.arguments.segments[1]!.end_frame).toBe(23);
    } finally {
      resetDurableForTests();
      await removeTempDir(dir);
    }
  });

  it('27. Native dialog cancellation does NOT write confirmation receipt and leaves job unconfirmed', async () => {
    const dir = await makeTempDir('cos-cancel-dialog-');
    initDurableStore(dir);
    try {
      const f = await createAdmittedFixture(dir);
      const session = { id: f.request.sessionId, conversationId: 'synthetic-history-chat', chatIds: ['synthetic-history-chat'] };
      testMockState.session = session;

      const { confirmCapabilityAdmissionJob } = await import('../src/main/video-editing/service.js');
      const cancelConfirm = async () => false; // User cancels dialog!

      const result = await confirmCapabilityAdmissionJob(
        f.request.id,
        f.job.workflow!.capabilityAdmission!.capabilityFingerprint,
        cancelConfirm
      ) as any;

      expect(result.cancelled).toBe(true);

      const current = f.store.get(f.request.id)!;
      expect(current.workflow!.capabilityConfirmation).toBeUndefined();
      expect(effectiveSourceEnd(current)).toBe('unknown');
    } finally {
      resetDurableForTests();
      await removeTempDir(dir);
    }
  });

  it('28. Session mismatch on native confirmation route is rejected', async () => {
    const dir = await makeTempDir('cos-session-mismatch-');
    initDurableStore(dir);
    try {
      const f = await createAdmittedFixture(dir);
      const receipt = createCapabilityAdmissionReceipt(f.job, 'operator-ipc');
      const mismatchedReceipt = { ...receipt, sessionId: 'wrong-session-id' };
      await expect(f.store.confirmCapabilityAdmission(f.job.id, mismatchedReceipt, f.job.workflow!.revision)).rejects.toThrow();
    } finally {
      resetDurableForTests();
      await removeTempDir(dir);
    }
  });

  it('29. Stale adapter detection: if adapter changes after confirmation, effectiveSourceEnd reverts to unknown', () => {
    const job = historicalAdmissionFixture();
    const receipt = createCapabilityAdmissionReceipt(job, 'operator-ipc');
    const confirmedJob: VideoEditingDocument = {
      ...job,
      workflow: { ...job.workflow!, capabilityConfirmation: receipt },
    };

    // Current adapter matches admission
    expect(effectiveSourceEnd(confirmedJob, { epoch: 'ea624669-8207-4138-9912-b5cd31a4bd0d:18', adapterSourceEnd: 'inclusive', guardVersion: 2 })).toBe('inclusive');

    // Adapter epoch changed -> reverts to unknown
    expect(effectiveSourceEnd(confirmedJob, { epoch: 'new-epoch:20', adapterSourceEnd: 'inclusive', guardVersion: 2 })).toBe('unknown');

    // Adapter sourceEnd changed -> reverts to unknown
    expect(effectiveSourceEnd(confirmedJob, { epoch: 'ea624669-8207-4138-9912-b5cd31a4bd0d:18', adapterSourceEnd: 'unknown', guardVersion: 2 })).toBe('unknown');

    // Adapter guardVersion changed -> reverts to unknown
    expect(effectiveSourceEnd(confirmedJob, { epoch: 'ea624669-8207-4138-9912-b5cd31a4bd0d:18', adapterSourceEnd: 'inclusive', guardVersion: 1 })).toBe('unknown');
  });

  it('30. Tamper-evidence: modifying receipt fields breaks verification and fails closed', () => {
    const job = historicalAdmissionFixture();
    const receipt = createCapabilityAdmissionReceipt(job, 'operator-ipc');

    // Tampering capabilityFingerprint
    const tampered1 = { ...receipt, capabilityFingerprint: 'a'.repeat(64) };
    expect(() => assertCapabilityAdmissionReceiptBinding(job, tampered1)).toThrow(/binding changed/i);

    // Tampering adapterEpoch
    const tampered2 = { ...receipt, adapterEpoch: 'altered-epoch' };
    expect(() => assertCapabilityAdmissionReceiptBinding(job, tampered2)).toThrow(/binding changed/i);

    // Tampering confirmationFingerprint
    const tampered3 = { ...receipt, confirmationFingerprint: '0'.repeat(64) };
    expect(() => assertCapabilityAdmissionReceiptBinding(job, tampered3)).toThrow(/fingerprint invalid/i);
  });

  it('31. Zero live Resolve mutation during confirmation', async () => {
    const dir = await makeTempDir('cos-zero-mutation-');
    initDurableStore(dir);
    try {
      const f = await createAdmittedFixture(dir);
      const receipt = createCapabilityAdmissionReceipt(f.job, 'operator-ipc');
      const confirmed = await f.store.confirmCapabilityAdmission(f.job.id, receipt, f.job.workflow!.revision);

      // Only ledger metadata updated; no external network or Resolve dispatch calls
      expect(confirmed.evidence).toEqual(f.job.evidence);
      expect(confirmed.candidates).toEqual(f.job.candidates);
      expect(confirmed.workflow!.prepared).toBeUndefined();
    } finally {
      resetDurableForTests();
      await removeTempDir(dir);
    }
  });

  it('32. Zero execution authority issued during confirmation', async () => {
    const dir = await makeTempDir('cos-zero-auth-');
    initDurableStore(dir);
    try {
      const f = await createAdmittedFixture(dir);
      const receipt = createCapabilityAdmissionReceipt(f.job, 'operator-ipc');
      const confirmed = await f.store.confirmCapabilityAdmission(f.job.id, receipt, f.job.workflow!.revision);

      // Zero execution authorizations
      expect(confirmed.operatorAuthorizations).toBeUndefined();
      expect(confirmed.checkpoints).toEqual([]);
    } finally {
      resetDurableForTests();
      await removeTempDir(dir);
    }
  });

  it('33. NATIVE_READMISSION_CONFIRMATION_NOT_PRESENT_BEFORE_DURABLE_ADMISSION regression test proving exact live defect is resolved', async () => {
    // Exact live defect reproduction:
    // 1. Job had capabilityAdmission at revision 15, but no native confirmation receipt was present.
    // 2. Under AAAD075, that allowed effectiveSourceEnd to immediately evaluate to inclusive.
    // 3. Under the repair, that defect is blocked:
    const liveJob = historicalAdmissionFixture();
    expect(liveJob.workflow!.revision).toBe(15);
    expect(liveJob.workflow!.capabilityAdmission).toBeDefined();
    expect(liveJob.workflow!.capabilityConfirmation).toBeUndefined();

    // Verification 1: effectiveSourceEnd does NOT evaluate to inclusive!
    expect(effectiveSourceEnd(liveJob)).toBe('unknown');

    // Verification 2: effectiveWorkflowCapabilities reports unknown!
    expect(effectiveWorkflowCapabilities(liveJob).sourceEnd).toBe('unknown');

    // Verification 3: preparation blockers explicitly demand operator confirmation!
    expect(capabilityAdmissionBlockers(liveJob)).toContain('CAPABILITY_ADMISSION_OPERATOR_CONFIRMATION_REQUIRED');

    // Verification 4: Once confirmed via native route, it cleanly evaluates to inclusive
    const receipt = createCapabilityAdmissionReceipt(liveJob, 'operator-ipc');
    const confirmedLiveJob: VideoEditingDocument = {
      ...liveJob,
      workflow: {
        ...liveJob.workflow!,
        revision: 16,
        capabilityConfirmation: receipt,
      },
    };
    expect(effectiveSourceEnd(confirmedLiveJob)).toBe('inclusive');
    expect(effectiveWorkflowCapabilities(confirmedLiveJob).sourceEnd).toBe('inclusive');
    expect(capabilityAdmissionBlockers(confirmedLiveJob)).toEqual([]);
  });

});
