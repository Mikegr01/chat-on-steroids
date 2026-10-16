import { app, BrowserWindow } from 'electron';
import path from 'node:path';

// Window preflight only. There is no native bridge, IPC, preload or verification entry.
const mode = process.argv.at(-2), root = process.argv.at(-1);
const result = {
  processStarted: true, electron: process.versions.electron, executable: process.execPath,
  entry: __filename, cwd: process.cwd(), appReady: false, windowConstructionAttempted: false,
  windowCreated: false, browserWindowValid: false, nativeHandleBufferValid: false,
  hwndDerivedFromFixtureWindow: false, windowsCreated: 0, windowDestroyed: false,
  webContentsDestroyed: false, userDataIsolated: false, productionStateLoaded: false,
  nativeModuleLoaded: false, liveVerificationRuns: 0, failureStage: 'CONFIGURATION',
  failureError: null as string | null,
};
let window: BrowserWindow | null = null;

async function run(): Promise<void> {
  try {
    if (process.platform !== 'win32' || !process.versions.electron || !app ||
        typeof BrowserWindow !== 'function' || mode !== '--dry-run' || !root || !path.isAbsolute(root))
      throw new Error('Windows Electron --dry-run with an isolated absolute root required');
    app.setName('CoS isolated UCV window preflight');
    for (const key of ['userData', 'sessionData', 'crashDumps', 'logs'] as const)
      app.setPath(key, path.join(root, key));
    result.userDataIsolated = app.getPath('userData') === path.join(root, 'userData') &&
      app.getPath('sessionData') === path.join(root, 'sessionData');
    if (!result.userDataIsolated) throw new Error('Isolated Electron paths not applied');
    app.disableHardwareAcceleration();
    // Retain cleanup/output ownership after destroying the only window.
    app.on('window-all-closed', () => {});
    result.failureStage = 'APP_READY';
    await app.whenReady();
    result.appReady = app.isReady();
    if (!result.appReady) throw new Error('Electron readiness not established');
    result.failureStage = 'BROWSERWINDOW_CONSTRUCTION';
    result.windowConstructionAttempted = true;
    window = new BrowserWindow({ width: 128, height: 96, show: false,
      title: 'CoS isolated UCV window preflight',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    result.windowCreated = true;
    result.windowsCreated++;
    result.browserWindowValid = !window.isDestroyed() && !window.webContents.isDestroyed() &&
      BrowserWindow.fromWebContents(window.webContents) === window && BrowserWindow.getAllWindows().length === 1;
    if (!result.browserWindowValid) throw new Error('Exactly one process-owned fixture window required');
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    result.failureStage = 'HWND_DERIVATION';
    const handle = window.getNativeWindowHandle(); // Only main derives the handle; never emitted.
    result.nativeHandleBufferValid = Buffer.isBuffer(handle) && handle.length === 8 && handle.readBigUInt64LE() !== 0n;
    result.hwndDerivedFromFixtureWindow = result.nativeHandleBufferValid && result.browserWindowValid;
    if (!result.hwndDerivedFromFixtureWindow) throw new Error('Fixture native window handle unavailable');
    result.failureStage = 'BLANK_DOCUMENT';
    await window.loadURL('about:blank');
    result.failureStage = 'CLEANUP';
  } catch (error) {
    result.failureError = error instanceof Error ? error.stack ?? error.message : String(error);
  } finally {
    if (window) {
      const contents = window.webContents;
      const destroyed = contents.isDestroyed() ? Promise.resolve() :
        new Promise<void>(resolve => contents.once('destroyed', () => resolve()));
      if (!window.isDestroyed()) window.destroy();
      await destroyed;
      result.windowDestroyed = window.isDestroyed();
      result.webContentsDestroyed = contents.isDestroyed();
    }
  }
  const pass = !result.failureError && result.hwndDerivedFromFixtureWindow &&
    result.windowDestroyed && result.webContentsDestroyed;
  if (pass) result.failureStage = 'STOPPED_BEFORE_VERIFICATION';
  await new Promise<void>(resolve => process.stdout.write(`${JSON.stringify(result)}\n`, () => resolve()));
  app.exit(pass ? 0 : 2);
}

void run();
