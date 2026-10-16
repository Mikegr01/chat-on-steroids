import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { makeTempDir, removeTempDir, faultGate } from './helpers.js';
import { operatorFixture } from './fixtures/video-operator-execution.js';

let dir: string;
beforeEach(async () => { vi.resetModules(); dir = await makeTempDir('cos-native-execute-'); initDurableStore(dir); });
afterEach(async () => {
  vi.restoreAllMocks(); vi.useRealTimers();
  vi.doUnmock('electron');
  for (const name of ['session/store', 'config', 'app-identity', 'video-editing/runtime-inspection',
    'video-editing/workflow-ingestion', 'video-editing/media-runtime']) vi.doUnmock(`../src/main/${name}.js`);
  (await import('../src/main/durable.js')).resetDurableForTests(); resetDurableForTests(); await removeTempDir(dir);
});

async function fixture(historical = false) {
  const f = await operatorFixture(dir, { localProjectId: null });
  if (historical) {
    const old = f.store.get(f.job.id)! as any; delete old.nativeExecutionEligible;
    const durable = await import('../src/main/durable.js'); durable.initDurableStore(dir);
    await durable.writeStrictDurableNow('video-editing-jobs', { version: 1, jobs: [old] }, 2 * 1024 * 1024);
  }
  const session = { id: f.job.sessionId, projectId: null as string | null, conversationId: 'chat-A', chatIds: ['chat-A'] };
  let mutations = 0, epoch = 'curated:1';
  const timeline = async (_id: string, stamp: { id: string; observedAt: number }) => {
    const row = structuredClone(f.context.timeline); row.id = stamp.id; row.observedAt = stamp.observedAt;
    row.adapterDispatch = { ...f.readiness.adapter, guardVersion: 2, sourceEnd: 'inclusive' };
    if (mutations) {
      row.timelineState!.durationFrames = 48;
      row.timelineState!.items = f.job.candidates[0]!.plan.clips.map((clip, index) => ({ uniqueId: `item-${index}`,
        mediaUniqueId: f.job.media.find(media => media.id === clip.mediaId)!.resolveMediaId!,
        mediaType: clip.mediaType, track: clip.track, source: clip.source, timeline: clip.timeline }));
    }
    return { evidence: row };
  };
  const dispatch = vi.fn(async () => {
    mutations++; return { requested: true, executed: true, verified: true, error: null };
  });
  vi.doMock('../src/main/session/store.js', () => ({ getSession: async () => session }));
  vi.doMock('../src/main/config.js', () => ({ getConfig: () => ({ readOnly: false, mediaRuntime: { fixture: true } }), effectiveCapabilities: () => ({ read: true }) }));
  vi.doMock('electron', () => ({ app: { getPath: (name: string) => name === 'userData' ? dir : '' } }));
  vi.doMock('../src/main/video-editing/runtime-inspection.js', () => ({
    createGuardedResolveReader: () => ({ timeline }), approvedVideoArtifactAccess: () => async (p: string) => p,
    readAdmittedWorkflowEpoch: () => epoch, readAdmittedWorkflowCapabilities: () => f.context.capabilities,
    readAdmittedWorkflowAdapterInfo: () => ({ ready: true, epoch, sourceEnd: 'inclusive', guardVersion: 2, adapterVersion: '1.0.3' }),
    createGuardedResolveDispatch: () => dispatch,
    createNativeResolveAccess: (assertOwner: () => Promise<void>) => ({ reader: { timeline }, access: async (p: string) => p,
      capabilities: f.context.capabilities, epoch, call: async () => {
        expect((await import('../src/main/mcp/call-context.js')).currentCall()).toBeNull();
        await assertOwner(); return dispatch(); } }),
  }));
  vi.doMock('../src/main/video-editing/workflow-ingestion.js', () => ({ createAssetIngestor: () => ({ ingest: async () => ({ media: f.job.media, evidence: f.job.evidence, references: f.job.references }) }) }));
  vi.doMock('../src/main/video-editing/media-runtime.js', () => ({ MediaRuntime: class {}, mediaRuntimeDiagnostics: async () => ({ status: 'CONFIGURED' }),
    admitMediaRuntime: async () => { throw new Error('Runtime admission outside fixture'); } }));
  (await import('../src/main/durable.js')).initDurableStore(dir);
  const service = await import('../src/main/video-editing/service.js');
  const ledger = await service.videoStore();
  const { createOperatorAuthorization } = await import('../src/main/video-editing/operator-authorization.js');
  const authority = await ledger.issueOperatorAuthorization(createOperatorAuthorization(f.job, 'operator-ipc'));
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false });
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false,
    getNativeWindowHandle: () => { const handle = Buffer.alloc(8); handle.writeBigUInt64LE(123n); return handle; } });
  const lifecycle = new EventEmitter(), handlers = new Map<string, (p: unknown, e: any) => Promise<any>>();
  const confirm = vi.fn(async () => true), authenticate = vi.fn(async () => 'windows-user-consent-verifier' as const);
  const { registerVideoOperatorIpc } = await import('../src/main/video-editing/operator-ipc.js');
  registerVideoOperatorIpc((name, handler) => handlers.set(name, handler), () => window as never, {
    lifecycle, confirm, authenticateCapability: authenticate,
    execute: (service as any).executeNativeVideoJob,
  } as never);
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const input = { jobId: f.job.id, expectedPreparedHash: f.prepared.preparedHash, authorizationId: authority.id, reviewedManifestHash: 'a'.repeat(64) };
  async function reviewedInput() {
    const result: any = await service.inspectVideoJob(f.job.id);
    expect(result.nativeExecution?.eligible).toBe(true);
    return { ...input, reviewedManifestHash: result.nativeExecution.reviewedManifestHash };
  }
  async function run(payload: unknown = input, from: unknown = event) {
    const handler = handlers.get('video:execute');
    expect(handler, 'fixed native execution route must exist').toBeTypeOf('function');
    return handler!(payload, from);
  }
  const untouched = () => {
    const job = ledger.get(f.job.id)!;
    expect(mutations).toBe(0); expect(dispatch).not.toHaveBeenCalled(); expect(job.checkpoints).toEqual([]);
    expect(job.operatorAuthorizations!.every(row => row.consumedAt === undefined)).toBe(true);
  };
  return { ...f, ledger, service, session, contents, window, lifecycle, confirm, authenticate, dispatch,
    input, event, run, reviewedInput, untouched, replaceEpoch: () => { epoch = 'replacement:2'; } };
}

// Missing native admission must not be repaired by manufacturing an MCP caller.
it('routes a new eligible job through the existing coordinator without any MCP CallContext', async () => {
  const f = await fixture(), input = await f.reviewedInput();
  const callModule = await import('../src/main/mcp/call-context.js');
  const runContext = vi.spyOn(callModule, 'runInCallContext');
  expect(await f.run(input)).toMatchObject({ status: 'VERIFIED' });
  expect(f.authenticate).toHaveBeenCalledOnce(); expect(f.dispatch).toHaveBeenCalledOnce();
  expect(runContext).not.toHaveBeenCalled(); expect(callModule.currentCall()).toBeNull();
  expect(f.ledger.get(f.job.id)!.checkpoints).toHaveLength(1);
  expect(f.ledger.get(f.job.id)!.operatorAuthorizations!.at(-1)!.consumedAt).toBeDefined();
});

it.each([true, {}, { verified: true }, { method: 'windows-user-consent-verifier' }])
  ('rejects a forged native principal %j without entering final confirmation', async proof => {
    const f = await fixture(), input = await f.reviewedInput();
    await expect(f.service.executeNativeVideoJob(input, async () => proof, f.confirm, () => {})).rejects.toThrow(/authentication required/);
    expect(f.confirm).not.toHaveBeenCalled(); f.untouched();
  });
it('native principals are invocation-bound, unmarshalable, expire and cannot reuse capability custody', async () => {
  const { authenticateNativeExecution: admit, consumeNativeExecutionPrincipal: consume } = await import('../src/main/video-editing/native-execution-principal.js');
  const scope = { jobId: 'job', sessionId: 'session', localProjectId: null, resolveProjectId: 'resolve', preparedHash: 'a'.repeat(64),
    authorizationId: 'authority', manifestHash: 'b'.repeat(64), workflowRevision: 1, sessionBinding: 'binding', adapterEpoch: 'owner:1' };
  let alive = true;
  const guard = () => { if (!alive) throw new Error('Lifecycle revoked'); };
  const proof = await admit(scope, 'Fixture native admission', async () => 'windows-user-consent-verifier', guard, () => 100);
  expect(() => consume(structuredClone(proof), scope, 101)).toThrow(/required/);
  expect(() => consume(JSON.parse(JSON.stringify(proof)), scope, 101)).toThrow(/required/);
  expect(consume(proof, scope, 101).method).toBe('windows-user-consent-verifier');
  expect(() => consume(proof, scope, 102)).toThrow(/required/);
  const mismatch = await admit(scope, 'Fixture', async () => 'windows-user-consent-verifier', guard, () => 100);
  expect(() => consume(mismatch, { ...scope, jobId: 'other-job' }, 101)).toThrow(/binding changed/);
  const expired = await admit(scope, 'Fixture', async () => 'windows-user-consent-verifier', guard, () => 100);
  expect(() => consume(expired, scope, 60_100)).toThrow(/stale/);
  const revoked = await admit(scope, 'Fixture', async () => 'windows-user-consent-verifier', guard, () => 100); alive = false;
  expect(() => consume(revoked, scope, 101)).toThrow(/revoked/);
  const { createCapabilityOperatorProofStore } = await import('../src/main/video-editing/capability-operator-proof.js');
  const capability = await createCapabilityOperatorProofStore<typeof scope>().authenticate(scope, 'Fixture', async () => 'windows-user-consent-verifier', () => {}, () => 100);
  expect(() => consume(capability, scope, 101)).toThrow(/required/);
});
it.each(['Verified', 'Canceled', 'DeviceNotPresent'])('fresh Windows UCV %s admits execution only on Verified', async outcome => {
  const f = await fixture(), input = await f.reviewedInput();
  const { createWindowsOperatorVerifier } = await import('../src/main/video-editing/operator-verification.js');
  const nativeVerify = vi.fn(async () => outcome);
  const verifier = createWindowsOperatorVerifier({ platform: 'win32', build: async () => 26100,
    loadBridge: async () => ({ availability: async () => 'Available', verify: nativeVerify }) });
  f.authenticate.mockImplementation(((window: import('electron').BrowserWindow, message: string, owner: () => Promise<void>) => verifier(window, message, owner)) as never);
  const result = await f.run(input);
  expect(nativeVerify).toHaveBeenCalledOnce();
  if (outcome === 'Verified') expect(result).toMatchObject({ status: 'VERIFIED' });
  else { expect(result).toEqual({ cancelled: true }); f.untouched(); }
});
it.each(['navigation', 'expiry'])('revokes an admitted principal on %s during final confirmation before claiming', async kind => {
  const f = await fixture(), input = await f.reviewedInput();
  f.confirm.mockImplementation(async () => {
    if (kind === 'navigation') { f.contents.emit('did-start-navigation'); f.contents.emit('did-start-navigation'); }
    else vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001);
    return true;
  });
  await expect(f.run(input)).rejects.toThrow(/lifecycle|expired/); f.untouched();
});
it('renderer loss during durable claim staging prevents consumption and checkpoint publication', async () => {
  const f = await fixture(), input = await f.reviewedInput();
  const fs = (await import('node:fs')).promises, originalWrite = fs.writeFile.bind(fs);
  let invalidated = false;
  vi.spyOn(fs, 'writeFile').mockImplementation((async (...args: Parameters<typeof fs.writeFile>) => {
    await originalWrite(...args);
    if (f.confirm.mock.calls.length && String(args[0]).includes('video-editing-jobs') && !invalidated) {
      invalidated = true; f.contents.emit('did-start-navigation');
    }
  }) as typeof fs.writeFile);
  await expect(f.run(input)).rejects.toThrow(/lifecycle/); expect(invalidated).toBe(true);
  f.untouched();
  const { VideoEditingStore } = await import('../src/main/video-editing/store.js');
  const restored = new VideoEditingStore(); await restored.restore();
  expect(restored.get(f.job.id)!.checkpoints).toEqual([]);
  expect(restored.get(f.job.id)!.operatorAuthorizations!.at(-1)!.consumedAt).toBeUndefined();
});
it('post-UCV awaits retain the original session binding instead of admitting a successor binding', async () => {
  const f = await fixture(), input = await f.reviewedInput(); let readsAfterVerification = 0;
  const sessions = await import('../src/main/session/store.js');
  vi.spyOn(sessions, 'getSession').mockImplementation(async () => {
    if (f.authenticate.mock.calls.length && ++readsAfterVerification === 2) {
      f.session.conversationId = 'chat-B'; f.session.chatIds.push('chat-B');
    }
    return f.session as never;
  });
  await expect(f.run(input)).rejects.toThrow(/owner changed/);
  expect(f.confirm).not.toHaveBeenCalled(); f.untouched();
});
it('requires the trusted main sender and active application lifecycle before admission', async () => {
  const f = await fixture();
  for (const from of [{ ...f.event, sender: {} }, { ...f.event, senderFrame: {} }]) await expect(f.run(f.input, from)).rejects.toThrow(/renderer/);
  f.lifecycle.emit('before-quit'); await expect(f.run()).rejects.toThrow(/shutdown/);
  expect(f.authenticate).not.toHaveBeenCalled(); f.untouched();
});
it('the shipped preload forwards only four selectors to the fixed trusted native route', async () => {
  const f = await fixture(), input = await f.reviewedInput(); let api: any;
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    expect(channel).toBe('video:execute'); return { ok: true, data: await f.run(payload) };
  });
  vi.doMock('electron', () => ({ contextBridge: { exposeInMainWorld: (_name: string, exposed: unknown) => { api = exposed; } },
    ipcRenderer: { invoke }, webUtils: {} }));
  await import('../src/preload/index.js');
  expect(await api.executeVideoJob(input.jobId, input.expectedPreparedHash, input.authorizationId, input.reviewedManifestHash,
    { toolName: 'arbitrary_python', arguments: {} })).toMatchObject({ ok: true, data: { status: 'VERIFIED' } });
  expect(invoke).toHaveBeenCalledExactlyOnceWith('video:execute', input);
  expect(api.invoke).toBeUndefined(); expect(f.dispatch).toHaveBeenCalledOnce();
});
it('new creation earns an immutable eligibility marker, while historical absence cannot be backfilled', async () => {
  const f = await fixture();
  expect((f.ledger.get(f.job.id) as any).nativeExecutionEligible).toBe(true);
  // Use a fresh request-only job to isolate identity immutability from prepared bindings.
  const { VideoWorkflowCoordinator } = await import('../src/main/video-editing/workflow.js');
  const request = { ...f.request, id: 'historical-job' };
  const coordinator = new VideoWorkflowCoordinator(f.ledger, { ingestor: f.ingestor, capabilities: f.context.capabilities });
  const fresh = await coordinator.request(request);
  const { VideoEditingStore } = await import('../src/main/video-editing/store.js');
  const old = { ...fresh } as any; delete old.nativeExecutionEligible;
  const store = new VideoEditingStore({ read: async () => ({ kind: 'valid', value: { version: 1, jobs: [old] } }), write: async () => {} });
  await store.restore();
  await expect(store.put({ ...old, nativeExecutionEligible: true })).rejects.toThrow(/immutable/);
  await expect(store.advanceWorkflow({ ...old, nativeExecutionEligible: true, workflow: { ...old.workflow, revision: 1 } }, 0)).rejects.toThrow(/immutable/);
  expect(store.get(old.id)).not.toHaveProperty('nativeExecutionEligible');
});

it('historical jobs stay unavailable without authentication, dispatch or backfill', async () => {
  const f = await fixture(true), old = f.ledger.get(f.job.id);
  expect(await f.service.inspectVideoJob(f.job.id)).toMatchObject({ nativeExecution: { eligible: false } });
  await expect(f.run()).rejects.toThrow(/native execution unavailable/i);
  expect(f.authenticate).not.toHaveBeenCalled(); f.untouched(); expect(f.ledger.get(f.job.id)).toEqual(old);
});
it.each(['operations', 'segments', 'mediaIds', 'python', 'toolName', 'arguments', 'bypass', 'checkpoint', 'policy', 'principal'])
  ('rejects renderer %s instructions before admission', async key => {
    const f = await fixture(); await expect(f.run({ ...f.input, [key]: {} })).rejects.toThrow();
    expect(f.authenticate).not.toHaveBeenCalled(); f.untouched();
  });
it.each(['missing', 'expired', 'consumed', 'claimed', 'ambiguous'])('refuses %s durable authority/custody before UCV', async kind => {
  const f = await fixture();
  if (kind === 'missing') f.input.authorizationId = '00000000-0000-4000-8000-000000000000';
  if (kind === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_001);
  if (kind === 'consumed') await f.ledger.consumeOperatorAuthorization(f.job.id, f.input.authorizationId, f.prepared.preparedHash, f.authority.targetHash);
  if (kind === 'claimed' || kind === 'ambiguous') {
    await f.ledger.claimOperator(f.job.id, f.input.authorizationId, f.prepared.preparedHash, f.authority.targetHash, Date.now(), f.context.timeline);
    if (kind === 'ambiguous') await f.ledger.finishOperator(f.job.id, f.prepared.request.operationId, []);
  }
  const before = f.ledger.get(f.job.id);
  await expect(f.run()).rejects.toThrow();
  expect(f.authenticate).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.ledger.get(f.job.id)).toEqual(before);
});
it.each(['expectedPreparedHash', 'reviewedManifestHash'])('rejects mismatched %s before UCV', async key => {
  const f = await fixture(), input = await f.reviewedInput();
  await expect(f.run({ ...input, [key]: '0'.repeat(64) })).rejects.toThrow(/changed|mismatch/i);
  expect(f.authenticate).not.toHaveBeenCalled(); f.untouched();
});
it('final native confirmation cancellation creates no claim, consumption or Resolve mutation', async () => {
  const f = await fixture(), input = await f.reviewedInput(); f.confirm.mockResolvedValue(false);
  expect(await f.run(input)).toMatchObject({ status: 'FAILED_BEFORE_MUTATION', failed: ['NATIVE_OPERATOR_CANCELLED'] });
  expect(f.confirm).toHaveBeenCalledWith(expect.stringContaining('Execute this FIRST guarded Resolve acceptance now?'));
  expect(f.authenticate).toHaveBeenCalledOnce(); f.untouched();
});
it('unverified Windows result never admits a native principal', async () => {
  const f = await fixture(), input = await f.reviewedInput(); f.authenticate.mockResolvedValue(null as never);
  expect(await f.run(input)).toMatchObject({ cancelled: true }); expect(f.confirm).not.toHaveBeenCalled(); f.untouched();
});
it.each(['did-start-navigation', 'render-process-gone', 'destroyed', 'close', 'shutdown', 'session', 'adapter'])
  ('revokes execution after %s during fresh UCV', async kind => {
    const f = await fixture(), input = await f.reviewedInput(), gate = faultGate();
    f.authenticate.mockImplementation(async () => { await gate.hold(); return 'windows-user-consent-verifier'; });
    const pending = f.run(input); await gate.entered;
    if (kind === 'shutdown') f.lifecycle.emit('before-quit');
    else if (kind === 'close') f.window.emit('close');
    else if (kind === 'session') f.session.projectId = 'changed-project';
    else if (kind === 'adapter') f.replaceEpoch();
    else { f.contents.emit(kind); if (kind === 'did-start-navigation') f.contents.emit(kind); }
    gate.release(); await expect(pending).rejects.toThrow(/changed|lifecycle/); f.untouched();
  });
it('rejects repeated IPC while one invocation is pending and never retries consumed work', async () => {
  const f = await fixture(), input = await f.reviewedInput(), gate = faultGate();
  f.confirm.mockImplementation(async () => { await gate.hold(); return true; });
  const pending = f.run(input); await gate.entered;
  await expect(f.run(input)).rejects.toThrow(/pending/); gate.release();
  expect(await pending).toMatchObject({ status: 'VERIFIED' });
  await expect(f.run(input)).rejects.toThrow(); expect(f.dispatch).toHaveBeenCalledOnce(); expect(f.authenticate).toHaveBeenCalledOnce();
});
it.each(['MCP', 'native'])('%s winner shares one durable claim with the other contender and at most one dispatch', async winner => {
  const f = await fixture(), input = await f.reviewedInput(), gate = faultGate();
  const context = await import('../src/main/mcp/call-context.js');
  const parent = { startedAt: Date.now(), transportKey: null, agent: null, outcome: null, evidence: context.emptyEvidence(),
    caller: { sessionId: f.job.sessionId, conversationId: 'chat-A', requestId: 'fixture-request', transportKey: null } };
  const mcp = (confirm: () => Promise<boolean>) => context.runInCallContext(parent, () => f.service.videoAction({ action: 'execute', jobId: f.job.id,
    authorizationId: input.authorizationId, manifestHash: input.reviewedManifestHash }, confirm));
  const wait = async () => { await gate.hold(); return true; };
  if (winner === 'MCP') f.confirm.mockImplementation(wait);
  const loser = winner === 'MCP' ? f.run(input) : mcp(wait); await gate.entered;
  const first = winner === 'MCP' ? mcp(async () => true) : f.run(input);
  await expect(first).resolves.toMatchObject({ status: 'VERIFIED' }); gate.release();
  await expect(loser).resolves.toMatchObject({ status: 'FAILED_BEFORE_MUTATION' });
  expect(f.ledger.get(f.job.id)!.checkpoints).toHaveLength(1); expect(f.dispatch).toHaveBeenCalledOnce();
});
