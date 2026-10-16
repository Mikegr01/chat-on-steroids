import type { BrowserWindow } from 'electron';
import { readWindowsBuild } from './windows-build.js';
import { loadWindowsUcvBridge, type WindowsUcvBridge } from './windows-ucv-bridge.js';

const unsupported = 'Strong S7.5 mutation authorization requires Windows 11 with Windows verification available.';
const availabilityStates = new Set(['Available', 'DeviceNotPresent', 'NotConfiguredForUser', 'DisabledByPolicy', 'DeviceBusy']);
export function classifyWindowsVerification(platform: string, build: number | null, availability?: string) {
  const knownBuild = Number.isSafeInteger(build) && build! > 0 ? build : null;
  const gated = platform === 'win32' && knownBuild !== null && knownBuild >= 22000;
  const present = !gated || availability === 'InteropMissing' ? false
    : availabilityStates.has(availability ?? '') ? true : null;
  const available = gated && availability === 'Available';
  return { OS_IS_WINDOWS: platform === 'win32', WINDOWS_BUILD: platform === 'win32' ? knownBuild : null,
    BUILD_22000_PLUS: gated, UCV_DESKTOP_INTEROP_PRESENT: present,
    UCV_AVAILABLE_FOR_CURRENT_USER: available, S7_STRONG_MUTATION_AUTH_SUPPORTED: available && present === true };
}

// One process-wide reservation, including across windows and availability awaits. No cached success.
let pending = false;
export function createWindowsOperatorVerifier(ports: {
  platform: string; build(): Promise<number | null>; loadBridge(): Promise<WindowsUcvBridge>;
}) {
  return async (window: BrowserWindow, message: string, assertCurrent: () => Promise<void>): Promise<'windows-user-consent-verifier' | null> => {
    if (pending) throw new Error('Windows verification already pending');
    pending = true;
    const handle = () => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) throw new Error('Operator window destroyed');
      const bytes = window.getNativeWindowHandle();
      if (!Buffer.isBuffer(bytes) || ![4, 8].includes(bytes.length)) throw new Error('Invalid operator window handle');
      const value = bytes.length === 8 ? bytes.readBigUInt64LE() : BigInt(bytes.readUInt32LE());
      if (!value) throw new Error('Invalid operator window handle');
      return value;
    };
    try {
      await assertCurrent();
      if (ports.platform !== 'win32') throw new Error(unsupported);
      const build = await ports.build();
      if (!classifyWindowsVerification(ports.platform, build).BUILD_22000_PLUS) throw new Error(unsupported);
      await assertCurrent();
      const hwnd = handle();
      let bridge: WindowsUcvBridge;
      try {
        bridge = await ports.loadBridge();
        const availability = await bridge.availability();
        if (!classifyWindowsVerification(ports.platform, build, availability).S7_STRONG_MUTATION_AUTH_SUPPORTED)
          throw new Error(unsupported);
      } catch { throw new Error(unsupported); }
      await assertCurrent();
      if (handle() !== hwnd) throw new Error('Operator window handle changed');
      let result: string;
      try { result = await bridge.verify(hwnd, message); }
      catch { throw new Error('Windows verification failed'); }
      await assertCurrent();
      if (handle() !== hwnd) throw new Error('Operator window handle changed');
      return result === 'Verified' ? 'windows-user-consent-verifier' : null;
    } finally { pending = false; }
  };
}
export const authenticateWindowsOperator = createWindowsOperatorVerifier({
  platform: process.platform, build: readWindowsBuild, loadBridge: loadWindowsUcvBridge,
});
