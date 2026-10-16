import { expect, it, vi } from 'vitest';
import { registerVideoOperatorIpc } from '../src/main/video-editing/operator-ipc.js';
import { createMediaRuntimeOperator } from '../src/main/video-editing/media-runtime-operator.js';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { consumeCapabilityOperatorProof, type CapabilityOperatorContext } from '../src/main/video-editing/capability-operator-proof.js';
import { faultGate } from './helpers.js';
import { createWindowsOperatorVerifier } from '../src/main/video-editing/operator-verification.js';

function capabilityFixture() {
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false });
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false,
    getNativeWindowHandle: () => { const handle = Buffer.alloc(8); handle.writeBigUInt64LE(123n); return handle; } });
  const handlers = new Map<string, (p: unknown, e: unknown) => Promise<unknown>>();
  const context: CapabilityOperatorContext = { jobId: 'synthetic-job', sessionId: 'synthetic-session', conversationId: 'synthetic-chat',
    localProjectId: null, resolveProjectId: 'synthetic-resolve', capabilityFingerprint: 'a'.repeat(64), admissionRevision: 7,
    workflowRevision: 7, adapterEpoch: 'synthetic:1', adapterVersion: 'synthetic-1', sourceEnd: 'inclusive', guardVersion: 2, sessionBinding: 'b'.repeat(64) };
  let receipts = 0, pending = false;
  const lifecycle = new EventEmitter();
  const ports = { lifecycle, confirm: vi.fn(async () => true), authenticateCapability: vi.fn(async (
    _window: unknown, _detail: string, _assertCurrent: () => Promise<void>
  ) => null as 'windows-user-consent-verifier' | null),
    confirmCapabilityAdmission: vi.fn(async (_id, _hash, review, guard) => {
      // The service owns the reservation; this port fixture mirrors that contract only.
      if (pending) throw new Error('Capability confirmation already pending');
      pending = true;
      try {
      const proof = await review('Synthetic native admission', context, async () => { guard(); });
      if (proof === null) return { cancelled: true };
      consumeCapabilityOperatorProof(proof, context); guard(); receipts++; return { confirmed: true };
      } finally { pending = false; }
    }) };
  registerVideoOperatorIpc((name, fn) => handlers.set(name, fn as never), () => window as never, ports as never);
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const payload = { jobId: context.jobId, expectedFingerprint: context.capabilityFingerprint };
  const run = (input: unknown = payload, from: unknown = event) => handlers.get('video:confirm-capability-admission')!(input, from);
  return { window, contents, lifecycle, ports, run, handler: handlers.get('video:confirm-capability-admission')!, payload, event, receipts: () => receipts };
}

it('native Confirm injection and renderer automation still require independent OS authentication', async () => {
  const f = capabilityFixture();
  expect(await f.run()).toEqual({ cancelled: true });
  expect(f.ports.confirm).toHaveBeenCalledOnce(); expect(f.ports.authenticateCapability).toHaveBeenCalledOnce();
  expect(f.receipts()).toBe(0);
  f.ports.authenticateCapability.mockResolvedValue('windows-user-consent-verifier');
  expect(await f.run()).toEqual({ confirmed: true }); expect(f.receipts()).toBe(1);
  expect(f.contents.listenerCount('did-start-navigation')).toBe(0);
});
it.each(['Verified', 'Canceled', 'RetriesExhausted', 'DeviceNotPresent', 'NotConfiguredForUser',
  'DisabledByPolicy', 'DeviceBusy', 'Unknown', 'NativeFailure'])('UCV %s feeds proof and receipt only on Verified', async result => {
  const f = capabilityFixture(), nativeVerify = vi.fn(async () => result);
  const verify = createWindowsOperatorVerifier({ platform: 'win32', build: async () => 26100,
    loadBridge: async () => ({ availability: async () => 'Available', verify: nativeVerify }) });
  f.ports.authenticateCapability.mockImplementation((window, detail, owner) => verify(window as never, detail, owner));
  expect(await f.run()).toEqual(result === 'Verified' ? { confirmed: true } : { cancelled: true });
  expect(f.receipts()).toBe(result === 'Verified' ? 1 : 0);
  expect(nativeVerify).toHaveBeenCalledOnce();
  expect(nativeVerify.mock.calls[0]).toEqual([123n, expect.stringContaining('Synthetic native admission')]);
});
it('direct IPC cannot provide its own proof or bypass trusted sender/payload checks', async () => {
  const f = capabilityFixture();
  await expect(f.run({ ...f.payload, proof: {} })).rejects.toThrow();
  await expect(f.run({ ...f.payload, expectedFingerprint: 'invalid' })).rejects.toThrow();
  await expect(f.run(f.payload, { ...f.event, senderFrame: {} })).rejects.toThrow(/renderer/);
  await expect(f.run(f.payload, { ...f.event, sender: {} })).rejects.toThrow(/renderer/);
  expect(f.ports.confirmCapabilityAdmission).not.toHaveBeenCalled(); expect(f.receipts()).toBe(0);
});
it.each([undefined, null, {}, { jobId: 'synthetic-job' }, { expectedFingerprint: 'a'.repeat(64) },
  { jobId: 'synthetic-job', expectedFingerprint: 'a'.repeat(64), authentication: { method: 'windows-user-consent-verifier' } }])
  ('partial or forged direct IPC payload %j cannot start authentication', async payload => {
    const f = capabilityFixture();
    // Invoke the actual handler without the fixture runner's default valid payload.
    await expect(f.handler(payload, f.event)).rejects.toThrow();
    expect(f.ports.confirmCapabilityAdmission).not.toHaveBeenCalled();
    expect(f.ports.authenticateCapability).not.toHaveBeenCalled(); expect(f.receipts()).toBe(0);
  });
it.each(['did-start-navigation', 'render-process-gone', 'destroyed', 'close'])('invalidates native review on %s including same-object navigation', async lifecycle => {
  const f = capabilityFixture(), gate = faultGate();
  f.ports.confirm.mockImplementation(async () => { await gate.hold(); return true; });
  const pending = f.run(); await gate.entered;
  (lifecycle === 'close' ? f.window : f.contents).emit(lifecycle);
  gate.release(); await expect(pending).rejects.toThrow(/lifecycle/);
  expect(f.ports.authenticateCapability).not.toHaveBeenCalled(); expect(f.receipts()).toBe(0);
});
it.each(['navigation', 'reload', 'contents-destroyed', 'window-close', 'window-destroyed', 'shutdown'])('invalidation during UCV %s discards the successful OS result', async lifecycle => {
  const f = capabilityFixture(), gate = faultGate();
  f.ports.authenticateCapability.mockImplementation(async () => { await gate.hold(); return 'windows-user-consent-verifier'; });
  const pending = f.run(); await gate.entered;
  if (lifecycle === 'shutdown') f.lifecycle.emit('before-quit');
  else if (lifecycle === 'window-close') f.window.emit('close');
  else if (lifecycle === 'window-destroyed') f.window.emit('closed');
  else if (lifecycle === 'contents-destroyed') f.contents.emit('destroyed');
  else { f.contents.emit('did-start-navigation'); f.contents.emit('did-start-navigation'); }
  gate.release(); await expect(pending).rejects.toThrow(/lifecycle/); expect(f.receipts()).toBe(0);
});
it.each([{ verified: true }, { result: 'Verified' }, { hwnd: '123' }, { windowsBuild: 26100 }, { OS_IS_WINDOWS: true }])
  ('renderer cannot supply verification authority %j', async forged => {
    const f = capabilityFixture(); await expect(f.run({ ...f.payload, ...forged })).rejects.toThrow();
    expect(f.ports.authenticateCapability).not.toHaveBeenCalled(); expect(f.receipts()).toBe(0);
  });
it('shutdown rejects new verification requests before native confirmation', async () => {
  const f = capabilityFixture(); f.lifecycle.emit('before-quit');
  await expect(f.run()).rejects.toThrow(/shutdown/); expect(f.ports.confirm).not.toHaveBeenCalled();
});
it('duplicate IPC cannot open a second native review, and cancel never authenticates', async () => {
  const f = capabilityFixture(), gate = faultGate();
  f.ports.confirm.mockImplementation(async () => { await gate.hold(); return false; });
  const pending = f.run(); await gate.entered;
  await expect(f.run()).rejects.toThrow(/already pending/); gate.release();
  expect(await pending).toEqual({ cancelled: true });
  expect(f.ports.confirm).toHaveBeenCalledOnce(); expect(f.ports.authenticateCapability).not.toHaveBeenCalled();
  expect(f.receipts()).toBe(0);
});

it('rejects foreign renderer and unconfirmed runtime admission; saves only admitted identities', async()=>{
  const handlers=new Map<string,(p:unknown,e:unknown)=>Promise<unknown>>();
  const sender={}, frame={}, window={webContents:{mainFrame:frame}};
  const admit=vi.fn(async()=>({trusted:true})), save=vi.fn(), confirm=vi.fn(async()=>false);
  const operator=createMediaRuntimeOperator({admit,save,diagnostics:vi.fn(),assertAccess:()=>{}});
  const ports={admit:operator.admit,pick:vi.fn(),confirm,diagnostics:operator.status,inspect:vi.fn(),authorize:vi.fn()};
  registerVideoOperatorIpc((name,fn)=>handlers.set(name,fn as never),()=>({...window,webContents:{...window.webContents,...sender}}) as never,ports as never);
  const handler=handlers.get('video:runtime-admit')!;
  await expect(handler({ffprobePath:'C:/probe.exe',ffmpegPath:'C:/mpeg.exe'},{sender:{},senderFrame:frame})).rejects.toThrow(/renderer/i);
  // Exact trusted object identity, including its main frame, is mandatory.
  const trusted={webContents:{mainFrame:frame}};
  registerVideoOperatorIpc((name,fn)=>handlers.set(name,fn as never),()=>trusted as never,ports as never);
  const event={sender:trusted.webContents,senderFrame:frame};
  const paths={ffprobePath:path.resolve('probe.exe'),ffmpegPath:path.resolve('mpeg.exe')};
  expect(await handlers.get('video:runtime-admit')!(paths,event)).toEqual({cancelled:true});
  expect(admit).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  confirm.mockResolvedValue(true);
  await handlers.get('video:runtime-admit')!(paths,event);
  expect(save.mock.calls[0]![0]).toEqual({trusted:true});
  await expect(handlers.get('video:authorize')!({jobId:'job',preparedHash:'0'.repeat(64)},{...event,senderFrame:{}})).rejects.toThrow(/renderer/i);
});

it('picker validates exact main renderer, enum and ownership after the native dialog',async()=>{
 const handlers=new Map<string,(p:unknown,e:unknown)=>Promise<unknown>>(),frame={};let window={webContents:{mainFrame:frame}};
 const event={sender:window.webContents,senderFrame:frame},pick=vi.fn(async()=>{window={webContents:{mainFrame:{}}};return 'C:/probe.exe';});
 registerVideoOperatorIpc((name,fn)=>handlers.set(name,fn as never),()=>window as never,{pick} as never);
 await expect(handlers.get('video:runtime-pick')!('python',event)).rejects.toThrow();expect(pick).not.toHaveBeenCalled();
 await expect(handlers.get('video:runtime-pick')!('ffprobe',{...event,sender:{}})).rejects.toThrow(/renderer/);
 await expect(handlers.get('video:runtime-pick')!('ffprobe',event)).rejects.toThrow(/renderer/);expect(pick).toHaveBeenCalledOnce();
});
