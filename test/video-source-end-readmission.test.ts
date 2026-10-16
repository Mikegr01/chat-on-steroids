import { it, expect, vi } from 'vitest';
import { verifiedCapabilityReview, authenticatedCapabilityReceipt as createCapabilityAdmissionReceipt } from './fixtures/video-capability-authentication.js';
import type { CapabilityOperatorReview } from '../src/main/video-editing/capability-operator-proof.js';
import { produceTimeline } from '../src/main/video-editing/producers.js';
import { timelinePage } from './fixtures/video-observation.js';
import { sourceUsabilityFixture } from './fixtures/video-source-usability.js';
import { sourceUsabilityBinding } from '../src/main/video-editing/source-usability.js';
import {
  effectiveSourceEnd,
  effectiveWorkflowCapabilities,
  assertCapabilityAdmissionMutable,
  validateCapabilityAdmissionInput,
} from '../src/main/video-editing/source-end-admission.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import type { VideoEditingDocument } from '../src/shared/video-editing.js';

function decision(job: VideoEditingDocument, assetId = 'source-a', ranges = [{ start: 0, end: 24 }]) {
  return { binding: sourceUsabilityBinding(job, assetId), expectedRevision: job.workflow!.revision, ranges };
}

it('proves root cause fail-closed behavior, then completes same-job readmission and succeeds preparation', async () => {
  const dir = await makeTempDir('cos-source-end-fix-');
  initDurableStore(dir);
  try {
    // 1. Standalone job created with original sourceEnd='unknown' (live job condition)
    const f = await sourceUsabilityFixture(dir, false, 'unknown');
    const initialJob = f.store.get(f.request.id)!;
    expect(initialJob.workflow!.capabilities.sourceEnd).toBe('unknown');
    const initialRequestHash = initialJob.workflow!.requestHash;

    // 2. Plan candidates
    const planned = await f.coordinator.plan(f.request.id);
    expect(planned.candidates.length).toBe(2);

    // 3. Set explicit usable ranges for both sources
    const withA = await f.coordinator.setUsableRanges(f.request.id, decision(planned, 'source-a'));
    const green = await f.coordinator.setUsableRanges(f.request.id, decision(withA, 'source-b'));
    expect(green.workflow!.comparison[0]!.score).toBe(1);
    expect(green.workflow!.comparison[0]!.blockers).toEqual([]);

    // 4. Select requested candidate
    const selected = await f.coordinator.select(f.request.id, green.candidates[0]!.id, 'operator-ipc');
    expect(selected.workflow!.phase).toBe('selected');
    const selectedCandidateId = selected.workflow!.selection!.candidateId;
    const selectedRevision = selected.workflow!.revision;

    // 5. Target is fresh AI-owned empty target with adapter guardVersion=2, sourceEnd='inclusive'
    const page: any = timelinePage();
    page.items = [];
    page.total = 0;
    page.duration_frames = 0;
    page.unique_id = 'ai-target-timeline-1';
    page.project_unique_id = f.request.resolveProjectId;
    page.rough_cut_guard_version = 2;
    page.source_end = 'inclusive';
    page.project_name = 'Untitled Project 2';
    page.snapshot_sha256 = 'a'.repeat(64);
    const targetEvidence = produceTimeline([page], { id: 'target-evidence-1', subjectId: page.unique_id, observedAt: 100 }).evidence;

    // 6. Attempt preparation against the recovered target BEFORE re-admission
    const prepareResult1 = await f.coordinator.prepare(f.request.id, targetEvidence);

    // ROOT CAUSE VERIFICATION: fails closed with SOURCE_END_CONVENTION_UNVERIFIED
    expect(prepareResult1.document.workflow!.phase).toBe('blocked');
    expect(prepareResult1.document.workflow!.blockedAt).toBe('preparing');
    expect(prepareResult1.document.workflow!.blockers).toContain('SOURCE_END_CONVENTION_UNVERIFIED');
    expect(prepareResult1.prepared.blockers).toContain('SOURCE_END_CONVENTION_UNVERIFIED');
    expect(prepareResult1.prepared.operations).toEqual([]);

    const blockedRevision = prepareResult1.document.workflow!.revision;
    expect(blockedRevision).toBe(selectedRevision + 1);

    // 7. Perform same-job capability re-admission
    const adapterInfo = {
      sourceEnd: 'inclusive',
      guardVersion: 2,
      adapterVersion: '1.0.3',
      epoch: 'curated:1',
    };
    const readmitted = await f.coordinator.readmitCapabilities(f.request.id, adapterInfo);

    // Verify durable capability admission
    expect(readmitted.workflow!.phase).toBe('selected');
    expect(readmitted.workflow!.blockedAt).toBeUndefined();
    expect(readmitted.workflow!.blockers).toEqual([]);
    expect(readmitted.workflow!.revision).toBe(blockedRevision + 1);
    expect(readmitted.workflow!.capabilityAdmission).toBeDefined();
    expect(readmitted.workflow!.capabilityAdmission!.sourceEnd).toBe('inclusive');
    expect(readmitted.workflow!.capabilityAdmission!.guardVersion).toBe(2);
    expect(readmitted.workflow!.capabilityAdmission!.adapterEpoch).toBe('curated:1');
    expect(readmitted.workflow!.capabilityAdmission!.provenance).toBe('trusted-adapter');

    // Immutable create-time state preserved!
    expect(readmitted.workflow!.capabilities.sourceEnd).toBe('unknown');
    expect(readmitted.workflow!.requestHash).toBe(initialRequestHash);
    expect(readmitted.workflow!.selection!.candidateId).toBe(selectedCandidateId);

    // 8. Attempt preparation before operator confirmation -> fails closed with precise blocker
    const prepareBlocked = await f.coordinator.prepare(f.request.id, targetEvidence);
    expect(prepareBlocked.document.workflow!.phase).toBe('blocked');
    expect(prepareBlocked.document.workflow!.blockedAt).toBe('preparing');
    expect(prepareBlocked.document.workflow!.blockers).toContain('CAPABILITY_ADMISSION_OPERATOR_CONFIRMATION_REQUIRED');
    expect(prepareBlocked.prepared.state).toBe('blocked');

    // 9. Native operator confirms the exact admission
    const currentJob = f.store.get(f.request.id)!;
    const receipt = createCapabilityAdmissionReceipt(currentJob, 'operator-ipc');
    const confirmed = await f.coordinator.confirmCapabilityAdmission(f.request.id, receipt);
    expect(confirmed.workflow!.phase).toBe('selected');
    expect(confirmed.workflow!.capabilityConfirmation).toBeDefined();

    // 10. Prepare execution AGAIN against the recovered target
    const prepareResult2 = await f.coordinator.prepare(f.request.id, targetEvidence);

    // SUCCESS VERIFICATION: preparation succeeds cleanly!
    expect(prepareResult2.document.workflow!.phase).toBe('prepared');
    expect(prepareResult2.document.workflow!.revision).toBe(confirmed.workflow!.revision + 1);
    expect(prepareResult2.prepared.state).toBe('ready');
    expect(prepareResult2.prepared.blockers).toEqual([]);
    expect(prepareResult2.prepared.capabilities.sourceEnd).toBe('inclusive');

    // Operation rough cut assembled with inclusive frame translation:
    // Source [0, 24) translated to start_frame: 0, end_frame: 23!
    const op = prepareResult2.prepared.operations[0]!;
    expect(op.name).toBe('resolve_assemble_rough_cut');
    expect(op.arguments.segments[0]!.start_frame).toBe(0);
    expect(op.arguments.segments[0]!.end_frame).toBe(23); // 24 - 1
    expect(op.arguments.segments[1]!.start_frame).toBe(0);
    expect(op.arguments.segments[1]!.end_frame).toBe(23); // 24 - 1

    // Create-time capabilities still unmodified!
    expect(prepareResult2.document.workflow!.capabilities.sourceEnd).toBe('unknown');
  } finally {
    resetDurableForTests();
    await removeTempDir(dir);
  }
});

it('effectiveSourceEnd follows strict hierarchy and fails closed on any mismatch or staleness', () => {
  const baseJob: VideoEditingDocument = {
    version: 1,
    id: 'job-1',
    sessionId: 'session-1',
    localProjectId: null,
    resolveProjectId: 'project-1',
    objective: 'test',
    maxRevisions: 3,
    evidence: [],
    references: [],
    media: [],
    candidates: [],
    checkpoints: [],
    reviews: [],
    revisions: [],
    workflow: {
      request: {} as any,
      requestHash: 'hash-1',
      revision: 1,
      phase: 'selected',
      blockers: [],
      comparison: [],
      capabilities: {
        tools: ['resolve_inspect', 'resolve_assemble_rough_cut'],
        sourceEnd: 'unknown',
        acceptance: 'unverified',
      },
      selection: { candidateId: 'cand-1', operatorId: 'op-1', kind: 'operator' },
    },
  };

  // 1. Immutable create-time inclusive takes effect naturally
  const inclusiveCreateJob: VideoEditingDocument = {
    ...baseJob,
    workflow: {
      ...baseJob.workflow!,
      capabilities: { ...baseJob.workflow!.capabilities, sourceEnd: 'inclusive' },
    },
  };
  expect(effectiveSourceEnd(inclusiveCreateJob)).toBe('inclusive');

  // 2. Create-time unknown with absent admission returns unknown
  expect(effectiveSourceEnd(baseJob)).toBe('unknown');

  // 3. Valid durable re-admission establishes inclusive
  const validAdmission = {
    jobId: 'job-1',
    sessionId: 'session-1',
    localProjectId: null,
    resolveProjectId: 'project-1',
    sourceEnd: 'inclusive' as const,
    guardVersion: 2 as const,
    adapterVersion: '1.0.3',
    adapterEpoch: 'curated:1',
    capabilityFingerprint: 'f'.repeat(64),
    admittedAt: 1000,
    revision: 2,
    provenance: 'trusted-adapter' as const,
  };
  const admittedJob: VideoEditingDocument = {
    ...baseJob,
    workflow: { ...baseJob.workflow!, capabilityAdmission: validAdmission },
  };
  // Without native confirmation receipt -> fails closed!
  expect(effectiveSourceEnd(admittedJob)).toBe('unknown');

  // With matching native confirmation receipt -> establishes inclusive
  const validReceipt = createCapabilityAdmissionReceipt(admittedJob, 'operator-ipc');
  const confirmedJob: VideoEditingDocument = {
    ...admittedJob,
    workflow: { ...admittedJob.workflow!, capabilityConfirmation: validReceipt },
  };
  expect(effectiveSourceEnd(confirmedJob)).toBe('inclusive');

  // 4. Job ID mismatch fails closed
  expect(effectiveSourceEnd({ ...confirmedJob, id: 'different-job' })).toBe('unknown');

  // 5. Session ID mismatch fails closed
  expect(effectiveSourceEnd({ ...confirmedJob, sessionId: 'different-session' })).toBe('unknown');

  // 6. Local project mismatch fails closed
  expect(effectiveSourceEnd({ ...confirmedJob, localProjectId: 'proj-x' })).toBe('unknown');

  // 7. Resolve project mismatch fails closed
  expect(effectiveSourceEnd({ ...confirmedJob, resolveProjectId: 'different-resolve' })).toBe('unknown');

  // 8. Forged confirmation fingerprint fails closed
  expect(effectiveSourceEnd({
    ...confirmedJob,
    workflow: {
      ...confirmedJob.workflow!,
      capabilityConfirmation: { ...validReceipt, confirmationFingerprint: '0'.repeat(64) },
    },
  })).toBe('unknown');

  // 9. Staleness policy: adapter epoch change fails closed
  expect(effectiveSourceEnd(confirmedJob, { epoch: 'curated:2' })).toBe('unknown');
  expect(effectiveSourceEnd(confirmedJob, { epoch: 'curated:1' })).toBe('inclusive');

  // 10. Staleness policy: adapter sourceEnd changed from inclusive fails closed
  expect(effectiveSourceEnd(confirmedJob, { adapterSourceEnd: 'exclusive' })).toBe('unknown');
  expect(effectiveSourceEnd(confirmedJob, { adapterSourceEnd: 'unknown' })).toBe('unknown');
  expect(effectiveSourceEnd(confirmedJob, { adapterSourceEnd: 'inclusive' })).toBe('inclusive');

  // 11. Staleness policy: guard version changed fails closed
  expect(effectiveSourceEnd(confirmedJob, { guardVersion: 1 })).toBe('unknown');
  expect(effectiveSourceEnd(confirmedJob, { guardVersion: 3 })).toBe('unknown');
  expect(effectiveSourceEnd(confirmedJob, { guardVersion: 2 })).toBe('inclusive');

  // 12. effectiveWorkflowCapabilities reflects effective sourceEnd
  expect(effectiveWorkflowCapabilities(confirmedJob).sourceEnd).toBe('inclusive');
  expect(effectiveWorkflowCapabilities(admittedJob).sourceEnd).toBe('unknown');
  expect(effectiveWorkflowCapabilities(baseJob).sourceEnd).toBe('unknown');
});

it('assertCapabilityAdmissionMutable enforces workflow state custody', () => {
  const job: VideoEditingDocument = {
    version: 1,
    id: 'job-1',
    sessionId: 'session-1',
    localProjectId: null,
    resolveProjectId: 'project-1',
    objective: 'test',
    maxRevisions: 3,
    evidence: [],
    references: [],
    media: [],
    candidates: [],
    checkpoints: [],
    reviews: [],
    revisions: [],
    workflow: {
      request: {} as any,
      requestHash: 'hash-1',
      revision: 1,
      phase: 'selected',
      blockers: [],
      comparison: [],
      capabilities: { tools: [], sourceEnd: 'unknown', acceptance: 'unverified' },
      selection: { candidateId: 'cand-1', operatorId: 'op-1', kind: 'operator' },
    },
  };

  // Selected phase is mutable
  expect(() => assertCapabilityAdmissionMutable(job)).not.toThrow();

  // Blocked at preparing phase is mutable
  const blockedPreparingJob: VideoEditingDocument = {
    ...job,
    workflow: { ...job.workflow!, phase: 'blocked', blockedAt: 'preparing', blockers: ['SOURCE_END_CONVENTION_UNVERIFIED'] },
  };
  expect(() => assertCapabilityAdmissionMutable(blockedPreparingJob)).not.toThrow();

  // Missing selection throws
  expect(() => assertCapabilityAdmissionMutable({
    ...job,
    workflow: { ...job.workflow!, selection: undefined },
  })).toThrow(/existing candidate selection/i);

  // Prepared operation exists throws
  expect(() => assertCapabilityAdmissionMutable({
    ...job,
    workflow: { ...job.workflow!, prepared: {} as any },
  })).toThrow(/prepared operation exists/i);

  // Execution checkpoints exist throws
  expect(() => assertCapabilityAdmissionMutable({
    ...job,
    checkpoints: [{} as any],
  })).toThrow(/execution checkpoints exist/i);

  // Operator authorizations exist throws
  expect(() => assertCapabilityAdmissionMutable({
    ...job,
    operatorAuthorizations: [{} as any],
  })).toThrow(/operator authority exists/i);

  // Unselected phases throw
  for (const phase of ['requested', 'ingesting', 'evidence-ready', 'planning', 'candidates-ready'] as const) {
    expect(() => assertCapabilityAdmissionMutable({
      ...job,
      workflow: { ...job.workflow!, phase },
    })).toThrow(/selected or preparing-blocked/i);
  }
});

it('validateCapabilityAdmissionInput enforces schema and tamper-evident fingerprint', () => {
  const job: VideoEditingDocument = {
    version: 1,
    id: 'job-1',
    sessionId: 'session-1',
    localProjectId: null,
    resolveProjectId: 'project-1',
    objective: 'test',
    maxRevisions: 3,
    evidence: [],
    references: [],
    media: [],
    candidates: [],
    checkpoints: [],
    reviews: [],
    revisions: [],
    workflow: {
      request: {} as any,
      requestHash: 'hash-1',
      revision: 5,
      phase: 'selected',
      blockers: [],
      comparison: [],
      capabilities: { tools: [], sourceEnd: 'unknown', acceptance: 'unverified' },
      selection: { candidateId: 'cand-1', operatorId: 'op-1', kind: 'operator' },
    },
  };

  const admission = validateCapabilityAdmissionInput(job, {
    sourceEnd: 'inclusive',
    guardVersion: 2,
    adapterVersion: '1.0.3',
    epoch: 'curated:1',
  });

  expect(admission.jobId).toBe('job-1');
  expect(admission.sessionId).toBe('session-1');
  expect(admission.sourceEnd).toBe('inclusive');
  expect(admission.guardVersion).toBe(2);
  expect(admission.adapterVersion).toBe('1.0.3');
  expect(admission.adapterEpoch).toBe('curated:1');
  expect(admission.revision).toBe(6);
  expect(admission.provenance).toBe('trusted-adapter');
  expect(admission.capabilityFingerprint).toMatch(/^[a-f0-9]{64}$/);

  // Rejects non-inclusive sourceEnd
  expect(() => validateCapabilityAdmissionInput(job, {
    sourceEnd: 'exclusive',
    guardVersion: 2,
    adapterVersion: '1.0.3',
    epoch: 'curated:1',
  })).toThrow(/ADAPTER_SOURCE_END_UNVERIFIED/);

  // Rejects guardVersion !== 2
  expect(() => validateCapabilityAdmissionInput(job, {
    sourceEnd: 'inclusive',
    guardVersion: 1,
    adapterVersion: '1.0.3',
    epoch: 'curated:1',
  })).toThrow(/ADAPTER_GUARD_VERSION_UNSUPPORTED/);
});

it('store.setCapabilityAdmission provides idempotent replay and ledger durability across cold restart', async () => {
  const dir = await makeTempDir('cos-store-readmit-');
  initDurableStore(dir);
  try {
    const f = await sourceUsabilityFixture(dir, false, 'unknown');
    const planned = await f.coordinator.plan(f.request.id);
    const withA = await f.coordinator.setUsableRanges(f.request.id, decision(planned, 'source-a'));
    const green = await f.coordinator.setUsableRanges(f.request.id, decision(withA, 'source-b'));
    await f.coordinator.select(f.request.id, green.candidates[0]!.id, 'operator-ipc');

    const adapterInfo = {
      sourceEnd: 'inclusive',
      guardVersion: 2,
      adapterVersion: '1.0.3',
      epoch: 'curated:1',
    };

    const admitted1 = await f.store.setCapabilityAdmission(f.request.id, adapterInfo);
    expect(admitted1.workflow!.capabilityAdmission).toBeDefined();
    const rev1 = admitted1.workflow!.revision;

    // Idempotent retry: exact duplicate returns job unchanged without incrementing revision
    const admitted2 = await f.store.setCapabilityAdmission(f.request.id, adapterInfo);
    expect(admitted2.workflow!.revision).toBe(rev1);
    expect(admitted2.workflow!.capabilityAdmission!.capabilityFingerprint)
      .toBe(admitted1.workflow!.capabilityAdmission!.capabilityFingerprint);

    // Cold restart
    await f.store.restore();
    const restored = f.store.get(f.request.id)!;
    expect(restored.workflow!.capabilityAdmission).toEqual(admitted1.workflow!.capabilityAdmission);
    expect(restored.workflow!.revision).toBe(rev1);
  } finally {
    resetDurableForTests();
    await removeTempDir(dir);
  }
});

it('service actions capability-status and readmit-source-end integrate with session ownership and native confirmation', async () => {
  const dir = await makeTempDir('cos-service-readmit-');
  initDurableStore(dir);
  try {
    const f = await sourceUsabilityFixture(dir, false, 'unknown');
    const planned = await f.coordinator.plan(f.request.id);
    const withA = await f.coordinator.setUsableRanges(f.request.id, decision(planned, 'source-a'));
    const green = await f.coordinator.setUsableRanges(f.request.id, decision(withA, 'source-b'));
    const selected = await f.coordinator.select(f.request.id, green.candidates[0]!.id, 'operator-ipc');

    const parent = { caller: { sessionId: f.request.sessionId, conversationId: 'chat-1' } };
    const session = { id: f.request.sessionId, conversationId: 'chat-1', chatIds: ['chat-1'] };
    vi.doMock('../src/main/mcp/call-context.js', () => ({ currentCall: () => parent }));
    vi.doMock('../src/main/session/store.js', () => ({ getSession: async () => session }));
    vi.doMock('../src/main/config.js', () => ({
      getConfig: () => ({ readOnly: false, mediaRuntime: { test: 'admitted' } }),
      effectiveCapabilities: () => ({ read: true }),
    }));
    vi.doMock('../src/main/app-identity.js', () => ({ resolveCustomUserData: () => dir }));
    vi.doMock('../src/main/plugins/manager.js', () => ({
      pluginManager: {
        snapshot: () => ({
          plugins: [{
            id: 'curated-davinci',
            name: 'DaVinci Resolve',
            catalogId: 'davinci-resolve',
            version: '1.0.3',
            enabled: true,
            status: 'ready',
            tools: [
              { name: 'resolve_inspect', enabled: true, published: true },
              { name: 'resolve_assemble_rough_cut', enabled: true, published: true },
            ],
            davinci: { sourceEnd: 'inclusive', guardVersion: 2 },
          }],
          catalog: [],
          schemaRevision: 1,
        }),
      },
    }));

    const { videoAction, confirmCapabilityAdmissionJob } = await import('../src/main/video-editing/service.js');
    const confirm = async () => true;

    // 1. Check capability-status
    const status = await videoAction({ action: 'capability-status', jobId: f.request.id }, confirm) as any;
    expect(status.jobId).toBe(f.request.id);
    expect(status.phase).toBe('selected');
    expect(status.originalSourceEnd).toBe('unknown');
    expect(status.effectiveSourceEnd).toBe('unknown');
    expect(status.currentAdapter.ready).toBe(true);
    expect(status.currentAdapter.sourceEnd).toBe('inclusive');
    expect(status.currentAdapter.guardVersion).toBe(2);
    expect(status.currentAdmission).toBeNull();

    // 2. Reject mismatched expectedRevision
    await expect(videoAction({
      action: 'readmit-source-end',
      jobId: f.request.id,
      expectedRevision: 999,
    }, confirm)).rejects.toThrow(/revision changed/i);

    // 3. Readmit source-end via MCP (yields pending operator confirmation)
    const readmitResult = await videoAction({
      action: 'readmit-source-end',
      jobId: f.request.id,
      expectedRevision: selected.workflow!.revision,
    }, confirm) as any;
    expect(readmitResult.status).toBe('admitted-pending-operator-confirmation');
    expect(readmitResult.capabilityAdmission.sourceEnd).toBe('inclusive');
    expect(readmitResult.confirmationRequired).toBe(true);

    // 4. Status reflects pending confirmation, effectiveSourceEnd remains 'unknown'
    const statusPending = await videoAction({ action: 'capability-status', jobId: f.request.id }, confirm) as any;
    expect(statusPending.originalSourceEnd).toBe('unknown');
    expect(statusPending.effectiveSourceEnd).toBe('unknown');
    expect(statusPending.currentAdmission).toBeDefined();
    expect(statusPending.nativeConfirmation).toBeNull();
    expect(statusPending.preparationBlockedByConfirmation).toBe(true);

    // 5. Operator cancellation via native confirmation route
    const cancelConfirm = async () => false;
    const cancelledResult = await confirmCapabilityAdmissionJob(
      f.request.id,
      readmitResult.capabilityAdmission.capabilityFingerprint,
      cancelConfirm
    );
    expect(cancelledResult.cancelled).toBe(true);

    // 6. Successful operator confirmation via native route
    let operatorConfirmPrompt = '';
    const operatorConfirm: CapabilityOperatorReview = async (msg, context) => {
      operatorConfirmPrompt = msg;
      return verifiedCapabilityReview(msg, context);
    };
    const confirmedResult = await confirmCapabilityAdmissionJob(
      f.request.id,
      readmitResult.capabilityAdmission.capabilityFingerprint,
      operatorConfirm
    ) as any;
    expect(confirmedResult.status).toBe('confirmed');
    expect(confirmedResult.receipt).toBeDefined();
    expect(confirmedResult.receipt.provenance).toBe('operator-ipc');
    expect(operatorConfirmPrompt).toContain('Confirm operator readmission of verified inclusive source-end convention');

    // 7. Subsequent capability-status now reports effectiveSourceEnd = 'inclusive'
    const statusAfter = await videoAction({ action: 'capability-status', jobId: f.request.id }, confirm) as any;
    expect(statusAfter.originalSourceEnd).toBe('unknown');
    expect(statusAfter.effectiveSourceEnd).toBe('inclusive');
    expect(statusAfter.currentAdmission).toBeDefined();
    expect(statusAfter.currentAdmission.sourceEnd).toBe('inclusive');
    expect(statusAfter.nativeConfirmation).toBeDefined();
    expect(statusAfter.preparationEligible).toBe(true);
    expect(statusAfter.preparationBlockedByConfirmation).toBe(false);
  } finally {
    resetDurableForTests();
    await removeTempDir(dir);
  }
});
