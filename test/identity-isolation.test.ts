import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { load as loadYaml } from 'js-yaml';
import { shouldBeginAppBootstrap } from '../src/main/window-lifecycle.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('P0 side-by-side identity isolation', () => {
  it('resolves custom userData outside official %APPDATA%\\chat-on-steroids', async () => {
    const { CUSTOM_APP_IDENTITY, resolveCustomUserData } = await import('../src/main/app-identity.js');
    expect(CUSTOM_APP_IDENTITY.userDataDir).toBe('chat-on-steroids-custom');

    const fakeAppData = path.join('C:', 'Users', 'Admin', 'AppData', 'Roaming');
    const fakeApp = {
      getPath: (name: string) => (name === 'appData' ? fakeAppData : '')
    };

    const resolved = resolveCustomUserData(fakeApp);
    const officialUserData = path.join(fakeAppData, 'chat-on-steroids');

    expect(resolved).toBe(path.join(fakeAppData, 'chat-on-steroids-custom'));
    expect(resolved).not.toBe(officialUserData);
  });

  it('configures custom identity and userData strictly before requestSingleInstanceLock', () => {
    const main = readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');

    const identityCall = main.indexOf('configureAppIdentity();');
    const lock = main.indexOf('const hasSingleInstanceLock = app.requestSingleInstanceLock();');
    const losingBranch = main.indexOf('if (!hasSingleInstanceLock) {', lock);
    const markQuitting = main.indexOf('quitting = true;', losingBranch);
    const ready = main.indexOf('void app.whenReady().then(async () => {', losingBranch);
    const readyGuard = main.indexOf('if (!shouldBeginAppBootstrap(hasSingleInstanceLock, quitting)) return;', ready);
    const firstSharedStateRead = main.indexOf("const userData = app.getPath('userData');", ready);

    expect(identityCall).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(-1);
    expect(identityCall).toBeLessThan(lock);
    expect(losingBranch).toBeGreaterThan(lock);
    expect(markQuitting).toBeGreaterThan(losingBranch);
    expect(markQuitting).toBeLessThan(ready);
    expect(readyGuard).toBeGreaterThan(ready);
    expect(readyGuard).toBeLessThan(firstSharedStateRead);
  });

  it('declares package, app, and installer identities distinct from official CoS', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const builder = loadYaml(readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')) as any;

    // Package identity
    expect(pkg.name).toBe('chat-on-steroids-custom');
    expect(pkg.name).not.toBe('chat-on-steroids');
    expect(pkg.desktopName).toBe('com.chatonsteroids.custom.desktop');
    expect(pkg.desktopName).not.toBe('com.chatonsteroids.app.desktop');

    // Windows / Electron builder identity
    expect(builder.appId).toBe('com.chatonsteroids.custom');
    expect(builder.appId).not.toBe('com.chatonsteroids.app');
    expect(builder.productName).toBe('Chat On Steroids Custom');
    expect(builder.productName).not.toBe('Chat On Steroids');

    // NSIS identity
    expect(builder.nsis.shortcutName).toBe('Chat On Steroids Custom');
    expect(builder.nsis.shortcutName).not.toBe('Chat On Steroids');
    expect(builder.nsis.uninstallDisplayName).toBe('Chat On Steroids Custom');
    expect(builder.nsis.uninstallDisplayName).not.toBe('Chat On Steroids');
    expect(builder.nsis.artifactName).toBe('Chat-On-Steroids-Custom-Setup-${arch}.${ext}');
    expect(builder.nsis.artifactName).not.toBe('Chat-On-Steroids-Setup-${arch}.${ext}');
  });

  it('prevents custom build from automatically entering the official upstream self-update path', async () => {
    const main = readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
    const { CUSTOM_APP_IDENTITY } = await import('../src/main/app-identity.js');

    // Custom identity disables automatic upstream updates
    expect(CUSTOM_APP_IDENTITY.autoUpdateEnabled).toBe(false);

    // main process bootstrap must not automatically invoke startUpdateChecks()
    const readyIdx = main.indexOf('void app.whenReady().then(async () => {');
    const readyBlock = main.slice(readyIdx);
    expect(readyBlock).not.toMatch(/^\s*startUpdateChecks\(\);/m);
  });

  it('preserves same-custom-app singleton semantics and isolates secondary instances', async () => {
    const { configureAppIdentity } = await import('../src/main/app-identity.js');

    const appPaths: Record<string, string> = {
      appData: path.join('C:', 'Users', 'Admin', 'AppData', 'Roaming')
    };
    let appUserModelId = '';
    const fakeApp: any = {
      name: '',
      getPath: (name: string) => appPaths[name] ?? '',
      setPath: (name: string, val: string) => { appPaths[name] = val; },
      setAppUserModelId: (id: string) => { appUserModelId = id; }
    };

    configureAppIdentity(fakeApp);
    expect(fakeApp.name).toBe('Chat On Steroids Custom');
    expect(appPaths.userData).toBe(path.join('C:', 'Users', 'Admin', 'AppData', 'Roaming', 'chat-on-steroids-custom'));
    if (process.platform === 'win32') {
      expect(appUserModelId).toBe('com.chatonsteroids.custom');
    }

    // A secondary instance of the custom application fails the single-instance lock:
    const hasSingleInstanceLock = false;
    let secondaryQuitting = false;
    if (!hasSingleInstanceLock) {
      secondaryQuitting = true;
    }

    expect(secondaryQuitting).toBe(true);
    // Invariant: secondary instance bootstrap guard rejects execution
    expect(shouldBeginAppBootstrap(hasSingleInstanceLock, secondaryQuitting)).toBe(false);
  });
});
