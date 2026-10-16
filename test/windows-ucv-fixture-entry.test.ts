import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ ready: false, windowDestroyed: false, contentsDestroyed: false,
  resolveReady: () => {}, resolveDestroyed: () => {}, handle: Buffer.alloc(8),
  paths: new Map<string, string>(), create: vi.fn(), exit: vi.fn(), handleRead: vi.fn(),
  load: vi.fn(), destroy: vi.fn(), emitted: '', contents: {} as any, window: {} as any }));
vi.mock('electron', () => ({ app: {
  setName: vi.fn(), setPath: (name: string, value: string) => fixture.paths.set(name, value),
  getPath: (name: string) => fixture.paths.get(name), disableHardwareAcceleration: vi.fn(), on: vi.fn(),
  isReady: () => fixture.ready, whenReady: () => new Promise<void>(resolve => {
    fixture.resolveReady = () => { fixture.ready = true; resolve(); };
  }), exit: fixture.exit,
}, BrowserWindow: class {
  constructor(options: unknown) { fixture.create(options); return fixture.window; }
  static fromWebContents(contents: unknown) { return contents === fixture.contents ? fixture.window : null; }
  static getAllWindows() { return [fixture.window]; }
} }));

const argv = process.argv, electronDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron');
let write: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  fixture.ready = fixture.windowDestroyed = fixture.contentsDestroyed = false;
  fixture.emitted = ''; fixture.paths.clear(); fixture.handle = Buffer.alloc(8); fixture.handle.writeBigUInt64LE(7n);
  fixture.contents = { isDestroyed: () => fixture.contentsDestroyed, setWindowOpenHandler: vi.fn(), on: vi.fn(),
    once: (_name: string, resolve: () => void) => {
      fixture.resolveDestroyed = () => { fixture.contentsDestroyed = true; resolve(); };
    }, session: { setPermissionRequestHandler: vi.fn() } };
  fixture.window = { isDestroyed: () => fixture.windowDestroyed, loadURL: fixture.load,
    getNativeWindowHandle: () => { fixture.handleRead(); return fixture.handle; }, destroy: () => {
      fixture.destroy(); fixture.windowDestroyed = true;
    }, get webContents() {
      if (fixture.windowDestroyed) throw new Error('Object has been destroyed');
      return fixture.contents;
    } };
  fixture.load.mockResolvedValue(undefined);
  process.argv = [...argv, '--dry-run', 'C:\\isolated-window-fixture'];
  Object.defineProperty(process.versions, 'electron', { value: '44.3.0', configurable: true });
  write = vi.spyOn(process.stdout, 'write').mockImplementation(((value: string, callback: () => void) => {
    fixture.emitted += value; callback(); return true;
  }) as never);
});
afterEach(() => {
  write.mockRestore(); process.argv = argv;
  if (electronDescriptor) Object.defineProperty(process.versions, 'electron', electronDescriptor);
  else delete (process.versions as Record<string, string | undefined>).electron;
});

const windowsOnly = process.platform === 'win32' ? it : it.skip;
windowsOnly('FIXTURE_APP_READY_BEFORE_WINDOW_CREATE / EXACTLY_ONE_WINDOW / MAIN_PROCESS_HWND / CLEAN_EXIT', async () => {
  await import('../src/diagnostics/windows-ucv-fixture/entry.js');
  expect(fixture.create).not.toHaveBeenCalled(); expect(fixture.handleRead).not.toHaveBeenCalled();
  expect(fixture.paths.get('userData')).toBe('C:\\isolated-window-fixture\\userData');
  fixture.resolveReady();
  await vi.waitFor(() => expect(fixture.destroy).toHaveBeenCalledOnce());
  expect(fixture.create).toHaveBeenCalledOnce(); expect(fixture.handleRead).toHaveBeenCalledOnce();
  expect(fixture.create.mock.calls[0]![0]).toMatchObject({ show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  expect(fixture.create.mock.calls[0]![0].webPreferences.preload).toBeUndefined();
  expect(fixture.load).toHaveBeenCalledWith('about:blank');
  expect(fixture.exit).not.toHaveBeenCalled(); // Destruction acknowledgement, not the destroy call, owns exit.
  fixture.resolveDestroyed();
  await vi.waitFor(() => expect(fixture.exit).toHaveBeenCalledWith(0));
  expect(JSON.parse(fixture.emitted)).toMatchObject({ appReady: true, windowsCreated: 1,
    nativeHandleBufferValid: true, hwndDerivedFromFixtureWindow: true, windowDestroyed: true,
    webContentsDestroyed: true, liveVerificationRuns: 0, nativeModuleLoaded: false,
    productionStateLoaded: false, failureStage: 'STOPPED_BEFORE_VERIFICATION', failureError: null });
  expect(fixture.emitted).not.toContain('hwnd":');
});

windowsOnly.each([Buffer.alloc(8), Buffer.alloc(4)])('INVALID_HWND stops with diagnostic and cleans its window (%j)', async handle => {
  fixture.handle = handle;
  await import('../src/diagnostics/windows-ucv-fixture/entry.js'); fixture.resolveReady();
  await vi.waitFor(() => expect(fixture.destroy).toHaveBeenCalledOnce()); fixture.resolveDestroyed();
  await vi.waitFor(() => expect(fixture.exit).toHaveBeenCalledWith(2));
  expect(fixture.load).not.toHaveBeenCalled();
  expect(JSON.parse(fixture.emitted)).toMatchObject({ failureStage: 'HWND_DERIVATION',
    hwndDerivedFromFixtureWindow: false, windowDestroyed: true, liveVerificationRuns: 0,
    failureError: expect.stringContaining('Fixture native window handle unavailable') });
});

windowsOnly('FIXTURE_DOES_NOT_TRIGGER_UCV_ON_STARTUP / REJECTS_LIVE_MODE', async () => {
  process.argv = [...argv, '--live', 'C:\\isolated-window-fixture'];
  await import('../src/diagnostics/windows-ucv-fixture/entry.js');
  await vi.waitFor(() => expect(fixture.exit).toHaveBeenCalledWith(2));
  expect(fixture.create).not.toHaveBeenCalled(); expect(fixture.paths.size).toBe(0);
  expect(JSON.parse(fixture.emitted)).toMatchObject({ appReady: false, liveVerificationRuns: 0 });
});
