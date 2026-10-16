import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { registerVideoOperatorIpc, type VideoOperatorPorts } from '../src/main/video-editing/operator-ipc.js';
import { createWindowsOperatorVerifier } from '../src/main/video-editing/operator-verification.js';
import { faultGate } from './helpers.js';

function fixture(result = 'Verified', build = 26300, availability = 'Available') {
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false });
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false,
    getNativeWindowHandle: vi.fn(() => { const handle = Buffer.alloc(8); handle.writeBigUInt64LE(123n); return handle; }) });
  let currentWindow = window;
  const native = { availability: vi.fn(async () => availability), verify: vi.fn(async (_hwnd: bigint, _detail: string) => result) };
  const load = vi.fn(async () => native), windowsBuild = vi.fn(async () => build);
  const verifier = createWindowsOperatorVerifier({ platform: 'win32', build: windowsBuild, loadBridge: load });
  const forbidden = vi.fn(async () => { throw new Error('Production mutation or job access reached'); });
  const lifecycle = new EventEmitter(), confirm = vi.fn(async () => true);
  const ports = { lifecycle, confirm, authenticateCapability: vi.fn(verifier),
    confirmCapabilityAdmission: forbidden, inspect: forbidden, authorize: forbidden, admit: forbidden,
    pick: forbidden, diagnostics: forbidden } as unknown as VideoOperatorPorts;
  const handlers = new Map<string, (p: unknown, e: unknown) => Promise<unknown>>();
  registerVideoOperatorIpc((name, fn) => handlers.set(name, fn as never), () => currentWindow as never, ports);
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const run = (payload: unknown = undefined, from: unknown = event) => handlers.get('video:validate-ucv')!(payload, from);
  return { run, event, contents, window, lifecycle, confirm, native, windowsBuild, load, ports, forbidden,
    replaceWindow: () => { currentWindow = Object.assign(new EventEmitter(), window); } };
}
it('trusted real IPC orchestration uses the production Windows gates, HWND, issuer and consumer', async () => {
  const f = fixture(); expect(await f.run()).toMatchObject({ status: 'validated', ucvResult: 'Verified',
    firstConsumption: 'success', replay: 'rejected', receiptCreated: false, disposed: true });
  expect(f.windowsBuild).toHaveBeenCalledOnce(); expect(f.load).toHaveBeenCalledOnce();
  expect(f.native.availability).toHaveBeenCalledOnce(); expect(f.native.verify).toHaveBeenCalledOnce();
  expect(f.native.verify.mock.calls[0]![0]).toBe(123n);
  expect(f.forbidden).not.toHaveBeenCalled(); expect(f.contents.listenerCount('did-start-navigation')).toBe(0);
  expect(f.window.listenerCount('close')).toBe(0); expect(f.lifecycle.listenerCount('before-quit')).toBe(1);
});
it.each([null, {}, { jobId: 's75-absent-scope-live-acceptance-20261010' }, { context: {} },
  { proof: {} }, { hwnd: '123' }, { mode: 'production' }])('cannot address a job or supply authority through payload %j', async payload => {
  const f = fixture(); await expect(f.run(payload)).rejects.toThrow();
  expect(f.confirm).not.toHaveBeenCalled(); expect(f.native.verify).not.toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled();
});
it('foreign contents, subframes and absent windows fail before confirmation', async () => {
  const f = fixture();
  for (const event of [{ ...f.event, sender: {} }, { ...f.event, senderFrame: {} }]) await expect(f.run(undefined, event)).rejects.toThrow(/renderer/);
  expect(f.confirm).not.toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled();
});
it('missing authenticator fails closed without entering production confirmation', async () => {
  const f = fixture(); f.ports.authenticateCapability = undefined;
  await expect(f.run()).rejects.toThrow(/unavailable/); expect(f.native.verify).not.toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled();
});
it.each(['did-start-navigation', 'render-process-gone', 'destroyed', 'close', 'closed', 'before-quit', 'replacement'])
  ('owner %s invalidation during confirmation stops before UCV and releases listeners', async kind => {
    const f = fixture(), gate = faultGate(); f.confirm.mockImplementation(async () => { await gate.hold(); return true; });
    const pending = f.run(); await gate.entered;
    if (kind === 'replacement') f.replaceWindow();
    else if (kind === 'before-quit') f.lifecycle.emit(kind);
    else if (kind === 'close' || kind === 'closed') f.window.emit(kind);
    else { f.contents.emit(kind); if (kind === 'did-start-navigation') f.contents.emit(kind); }
    gate.release(); await expect(pending).rejects.toThrow(/lifecycle|renderer/);
    expect(f.native.verify).not.toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled();
    expect(f.contents.listenerCount('did-start-navigation')).toBe(0);
  });
it('navigation during a successful Windows response prevents proof success', async () => {
  const f = fixture(), gate = faultGate();
  f.native.verify.mockImplementation(async () => { await gate.hold(); return 'Verified'; });
  const pending = f.run(); await gate.entered; f.contents.emit('did-start-navigation'); gate.release();
  await expect(pending).rejects.toThrow(/lifecycle/); expect(f.native.verify).toHaveBeenCalledOnce(); expect(f.forbidden).not.toHaveBeenCalled();
});
it('duplicate actions do not prompt twice; cancellation never invokes UCV', async () => {
  const f = fixture(), gate = faultGate(); f.confirm.mockImplementation(async () => { await gate.hold(); return false; });
  const pending = f.run(); await gate.entered; await expect(f.run()).rejects.toThrow(/pending/);
  gate.release(); expect(await pending).toMatchObject({ status: 'cancelled', proofCreated: false });
  expect(f.confirm).toHaveBeenCalledOnce(); expect(f.native.verify).not.toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled();
});
it.each(['Canceled', 'DeviceBusy', 'DeviceNotPresent', 'DisabledByPolicy', 'RetriesExhausted', 'Unknown', 'NativeFailure'])
  ('UCV %s creates no proof and cannot fall back to production', async result => {
    const f = fixture(result); expect(await f.run()).toMatchObject({ status: 'not-verified', proofCreated: false, disposed: true });
    expect(f.native.verify).toHaveBeenCalledOnce(); expect(f.forbidden).not.toHaveBeenCalled();
  });
it.each([[21999, 'Available'], [26300, 'DeviceNotPresent'], [26300, 'Unknown']])
  ('production Windows gate %s/%s cannot be bypassed by validation', async (build, availability) => {
    const f = fixture('Verified', build as number, availability as string);
    await expect(f.run()).rejects.toThrow(/Windows/); expect(f.native.verify).not.toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled();
  });
it('shutdown blocks new validation, and native errors never retry or invoke a receipt route', async () => {
  const f = fixture(); f.lifecycle.emit('before-quit'); await expect(f.run()).rejects.toThrow(/shutdown/); expect(f.confirm).not.toHaveBeenCalled();
  const q = fixture(); q.native.verify.mockRejectedValue(new Error('native failed'));
  await expect(q.run()).rejects.toThrow(/Windows verification failed/); expect(q.native.verify).toHaveBeenCalledOnce(); expect(q.forbidden).not.toHaveBeenCalled();
});
