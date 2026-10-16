import { expect, it, vi } from 'vitest';
import { createWindowsOperatorVerifier, classifyWindowsVerification } from '../src/main/video-editing/operator-verification.js';
import { faultGate } from './helpers.js';

function fixture() {
  const handle = Buffer.alloc(8); handle.writeBigUInt64LE(123n);
  const window = { isDestroyed: vi.fn(() => false), webContents: { isDestroyed: vi.fn(() => false) },
    getNativeWindowHandle: vi.fn(() => handle) };
  const bridge = { availability: vi.fn(async () => 'Available'), verify: vi.fn(async () => 'Verified') };
  const build = vi.fn(async () => 26100), loadBridge = vi.fn(async () => bridge);
  const verify = createWindowsOperatorVerifier({ platform: 'win32', build, loadBridge });
  return { window, bridge, build, loadBridge, verify, handle };
}
it.each([22000, 26100, 28000])('WIN11_BUILD_%i_GATE_ALLOWED', async build => {
  const f = fixture(); f.build.mockResolvedValue(build);
  expect(await f.verify(f.window as never, 'Exact review', async () => {})).toBe('windows-user-consent-verifier');
  expect(f.bridge.verify).toHaveBeenCalledExactlyOnceWith(123n, 'Exact review');
});
it.each([19045, 21999, null, NaN, 0, 22000.5])('WIN10_OR_UNKNOWN_BUILD_%s_FAILS_CLOSED_NO_UCV_NO_FALLBACK', async build => {
  const f = fixture(); f.build.mockResolvedValue(build as never);
  await expect(f.verify(f.window as never, 'Synthetic', async () => {})).rejects.toThrow(/Windows 11/);
  expect(f.loadBridge).not.toHaveBeenCalled(); expect(f.bridge.verify).not.toHaveBeenCalled();
});
it.each(['darwin', 'linux'])('NON_WINDOWS_%s_FAILS_CLOSED', async platform => {
  const f = fixture(), verify = createWindowsOperatorVerifier({ platform, build: f.build, loadBridge: f.loadBridge });
  await expect(verify(f.window as never, 'Synthetic', async () => {})).rejects.toThrow(/Windows 11/);
  expect(f.build).not.toHaveBeenCalled(); expect(f.loadBridge).not.toHaveBeenCalled();
});
it.each(['DeviceNotPresent', 'NotConfiguredForUser', 'DisabledByPolicy', 'DeviceBusy', 'Unknown', 'NativeFailure', 'InteropMissing', 0, true])
  ('UCV_AVAILABILITY_%s_FAILS_CLOSED', async value => {
    const f = fixture(); f.bridge.availability.mockResolvedValue(value as never);
    await expect(f.verify(f.window as never, 'Synthetic', async () => {})).rejects.toThrow(/verification available/);
    expect(f.bridge.verify).not.toHaveBeenCalled();
  });
it('UCV_API_MISSING_FAILS_CLOSED', async () => {
  const f = fixture(); f.loadBridge.mockRejectedValue(new Error('missing dll'));
  await expect(f.verify(f.window as never, 'Synthetic', async () => {})).rejects.toThrow(/verification available/);
});
it.each(['Canceled', 'DeviceNotPresent', 'NotConfiguredForUser', 'DisabledByPolicy', 'DeviceBusy', 'RetriesExhausted',
  'Unknown', 'NativeFailure', 0, true, { verified: true }])('UCV_%s_CREATES_NO_AUTHENTICATION', async value => {
  const f = fixture(); f.bridge.verify.mockResolvedValue(value as never);
  expect(await f.verify(f.window as never, 'Synthetic', async () => {})).toBeNull();
});
it.each(['window', 'contents', 'zero-handle', 'malformed-handle'])('INVALID_%s_BLOCKED_BEFORE_NATIVE_CALL', async kind => {
  const f = fixture();
  if (kind === 'window') f.window.isDestroyed.mockReturnValue(true);
  if (kind === 'contents') f.window.webContents.isDestroyed.mockReturnValue(true);
  if (kind === 'zero-handle') f.handle.fill(0);
  if (kind === 'malformed-handle') f.window.getNativeWindowHandle.mockReturnValue(Buffer.alloc(3));
  await expect(f.verify(f.window as never, 'Synthetic', async () => {})).rejects.toThrow();
  expect(f.bridge.verify).not.toHaveBeenCalled();
});
it.each(['window', 'contents', 'handle', 'session', 'admission', 'shutdown'])('STALE_%s_DURING_VERIFY_BLOCKED', async kind => {
  const f = fixture(), gate = faultGate(); let valid = true;
  f.bridge.verify.mockImplementation(async () => { await gate.hold(); return 'Verified'; });
  const pending = f.verify(f.window as never, 'Synthetic', async () => { if (!valid) throw new Error('Owner changed'); });
  await gate.entered;
  if (kind === 'window') f.window.isDestroyed.mockReturnValue(true);
  else if (kind === 'contents') f.window.webContents.isDestroyed.mockReturnValue(true);
  else if (kind === 'handle') f.handle.writeBigUInt64LE(124n);
  else valid = false;
  gate.release(); await expect(pending).rejects.toThrow();
});
it('DUPLICATE_VERIFICATION_RACE_BLOCKED_ACROSS_WINDOWS', async () => {
  const f = fixture(), gate = faultGate(); f.bridge.verify.mockImplementation(async () => { await gate.hold(); return 'Verified'; });
  const pending = f.verify(f.window as never, 'Synthetic', async () => {}); await gate.entered;
  const other = fixture();
  await expect(other.verify(other.window as never, 'Synthetic', async () => {})).rejects.toThrow(/pending/);
  expect(other.bridge.verify).not.toHaveBeenCalled(); gate.release(); await pending;
});
it('UNKNOWN_NATIVE_FAILURE_FAILS_CLOSED_AND_RELEASES_RESERVATION', async () => {
  const f = fixture(); f.bridge.verify.mockRejectedValueOnce(new Error('native failure'));
  await expect(f.verify(f.window as never, 'Synthetic', async () => {})).rejects.toThrow(/verification failed/);
  expect(await f.verify(f.window as never, 'Synthetic', async () => {})).toBe('windows-user-consent-verifier');
});
it.each(['session', 'admission'])('STALE_%s_BEFORE_VERIFICATION_REQUEST_HAS_NO_NATIVE_PROMPT', async kind => {
  const f = fixture(); let valid = true;
  f.bridge.availability.mockImplementation(async () => { valid = false; return 'Available'; });
  await expect(f.verify(f.window as never, 'Synthetic', async () => { if (!valid) throw new Error(`${kind} changed`); }))
    .rejects.toThrow(/changed/);
  expect(f.bridge.verify).not.toHaveBeenCalled();
});
it('runtime classification distinguishes OS gate, missing interop and unknown availability', () => {
  expect(classifyWindowsVerification('win32', 19045, 'Available')).toMatchObject({
    OS_IS_WINDOWS: true, WINDOWS_BUILD: 19045, BUILD_22000_PLUS: false, S7_STRONG_MUTATION_AUTH_SUPPORTED: false });
  expect(classifyWindowsVerification('win32', 22000, 'Available')).toMatchObject({
    UCV_DESKTOP_INTEROP_PRESENT: true, UCV_AVAILABLE_FOR_CURRENT_USER: true, S7_STRONG_MUTATION_AUTH_SUPPORTED: true });
  expect(classifyWindowsVerification('win32', 26100, 'InteropMissing').UCV_DESKTOP_INTEROP_PRESENT).toBe(false);
  expect(classifyWindowsVerification('win32', 26100, 'Unknown').S7_STRONG_MUTATION_AUTH_SUPPORTED).toBe(false);
});
