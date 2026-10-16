import path from 'node:path';
import { app } from 'electron';

/** Privileged bridge only. No ledger, session, receipt, S7 or Resolve dependencies. */
export interface WindowsUcvBridge {
  availability(): Promise<string>;
  verify(hwnd: bigint, message: string): Promise<string>;
}
export async function loadWindowsUcvBridge(): Promise<WindowsUcvBridge> {
  if (process.platform !== 'win32') throw new Error('Windows verification unavailable');
  const k = await import('koffi');
  // Fixed application-owned payload, never PATH, cwd, renderer path or an environment override.
  const filename = app.isPackaged
    ? path.join(process.resourcesPath, 'windows-ucv', process.arch, 'cos-windows-ucv.dll')
    : path.join(app.getAppPath(), 'out', 'native', 'windows-ucv', process.arch, 'cos-windows-ucv.dll');
  const lib = k.load(filename);
  const availability = lib.func('const char * __cdecl CosUcvAvailability()');
  const verify = lib.func('const char * __cdecl CosUcvVerify(uint64_t hwnd, const char16_t *message)');
  const call = (fn: typeof availability, args: unknown[]) => new Promise<string>((resolve, reject) => {
    fn.async(...args, (error: Error | null, result: string) => {
      if (error) reject(new Error('Windows verification failed')); else resolve(result);
    });
  });
  return { availability: () => call(availability, []), verify: (hwnd, message) => call(verify, [hwnd, message]) };
}
