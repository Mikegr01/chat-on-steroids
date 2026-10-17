import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { load as loadYaml } from 'js-yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('custom application identity isolation', () => {
  it('uses one main-process owner for identity and profile selection before the singleton lock', async () => {
    const owner = path.join(root, 'src', 'main', 'app-identity.ts');
    const shared = path.join(root, 'src', 'shared', 'app-identity.ts');
    expect(existsSync(owner)).toBe(true);
    expect(existsSync(shared)).toBe(true);
    if (!existsSync(owner) || !existsSync(shared)) return;

    const { configureAppIdentity, CUSTOM_APP_IDENTITY, resolveCustomUserData } = await import('../src/main/app-identity.js');
    const appData = path.join('C:', 'Users', 'IdentityFixture', 'AppData', 'Roaming');
    const paths: Record<string, string> = { appData };
    let name = '';
    let appUserModelId = '';
    const target = {
      getPath: (key: string) => paths[key] ?? '',
      setPath: (key: string, value: string) => { paths[key] = value; },
      setName: (value: string) => { name = value; },
      setAppUserModelId: (value: string) => { appUserModelId = value; }
    };

    const expectedUserData = path.join(appData, 'chat-on-steroids-custom');
    expect(resolveCustomUserData(target)).toBe(expectedUserData);
    expect(resolveCustomUserData(target)).not.toBe(path.join(appData, 'chat-on-steroids'));
    configureAppIdentity(target);
    expect(name).toBe(CUSTOM_APP_IDENTITY.productName);
    expect(paths.userData).toBe(expectedUserData);
    if (process.platform === 'win32') expect(appUserModelId).toBe(CUSTOM_APP_IDENTITY.appId);

    const main = readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
    const identityCall = main.indexOf('configureAppIdentity();');
    const lock = main.indexOf('const hasSingleInstanceLock = app.requestSingleInstanceLock();');
    const ready = main.indexOf('void app.whenReady().then(async () => {', lock);
    const guard = main.indexOf('if (!shouldBeginAppBootstrap(hasSingleInstanceLock, quitting)) return;', ready);
    const firstUserDataRead = main.indexOf("const userData = app.getPath('userData');", ready);

    expect(identityCall).toBeGreaterThan(-1);
    expect(identityCall).toBeLessThan(lock);
    expect(guard).toBeGreaterThan(ready);
    expect(guard).toBeLessThan(firstUserDataRead);
    expect(main).not.toContain("app.setPath('userData'");
    expect(main).not.toContain('app.setAppUserModelId(');
    expect(main).not.toContain("app.setName('Chat On Steroids Custom')");
  });

  it('keeps build declarations aligned with the authoritative custom identity', async () => {
    const shared = path.join(root, 'src', 'shared', 'app-identity.ts');
    expect(existsSync(shared)).toBe(true);
    if (!existsSync(shared)) return;

    const { CUSTOM_APP_IDENTITY, OFFICIAL_APP_IDENTITY } = await import('../src/shared/app-identity.js');
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const builder = loadYaml(readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')) as any;

    expect(CUSTOM_APP_IDENTITY.packageName).not.toBe(OFFICIAL_APP_IDENTITY.packageName);
    expect(CUSTOM_APP_IDENTITY.appId).not.toBe(OFFICIAL_APP_IDENTITY.appId);
    expect(CUSTOM_APP_IDENTITY.userDataDir).not.toBe(OFFICIAL_APP_IDENTITY.userDataDir);
    expect(pkg.name).toBe(CUSTOM_APP_IDENTITY.packageName);
    expect(pkg.desktopName).toBe(CUSTOM_APP_IDENTITY.desktopName);
    expect(builder.appId).toBe(CUSTOM_APP_IDENTITY.appId);
    expect(builder.productName).toBe(CUSTOM_APP_IDENTITY.productName);
    expect(builder.nsis.shortcutName).toBe(CUSTOM_APP_IDENTITY.shortcutName);
    expect(builder.nsis.uninstallDisplayName).toBe(CUSTOM_APP_IDENTITY.uninstallDisplayName);
    expect(builder.nsis.artifactName).toBe(`${CUSTOM_APP_IDENTITY.artifactNameStem}-\${arch}.\${ext}`);

    const smoke = readFileSync(path.join(root, 'scripts', 'smoke-packaged-runtime.mjs'), 'utf8');
    expect(smoke).toContain('Chat On Steroids Custom.exe');
    expect(smoke).toContain('Chat On Steroids Custom.app');
  });

  it('keeps custom and official runtime ownership disjoint when both identities exist at once', async () => {
    const { CUSTOM_APP_IDENTITY, OFFICIAL_APP_IDENTITY } = await import('../src/shared/app-identity.js');
    const { BROWSER_BRIDGE_AUTO_PORTS } = await import('../src/shared/browser-bridge.js');
    const appData = path.join('C:', 'Users', 'IdentityFixture', 'AppData', 'Roaming');
    const customProfile = path.join(appData, CUSTOM_APP_IDENTITY.userDataDir);
    const officialProfile = path.join(appData, OFFICIAL_APP_IDENTITY.userDataDir);
    const officialBridgePorts = [8765, 8766, 8767, 8768, 8769, 18765, 18766, 18767, 18768, 18769, 38765, 38766, 38767, 38768, 38769];

    expect(customProfile).not.toBe(officialProfile);
    expect(CUSTOM_APP_IDENTITY.appId).not.toBe(OFFICIAL_APP_IDENTITY.appId);
    expect(CUSTOM_APP_IDENTITY.desktopName).not.toBe(OFFICIAL_APP_IDENTITY.desktopName);
    expect(CUSTOM_APP_IDENTITY.bridgeAppId).not.toBe(OFFICIAL_APP_IDENTITY.bridgeAppId);
    expect(BROWSER_BRIDGE_AUTO_PORTS.some(port => officialBridgePorts.includes(port))).toBe(false);
  });

  it('uses a custom bridge identity instead of trusting the official product greeting', async () => {
    const shared = path.join(root, 'src', 'shared', 'app-identity.ts');
    expect(existsSync(shared)).toBe(true);
    if (!existsSync(shared)) return;

    const { CUSTOM_APP_IDENTITY, OFFICIAL_APP_IDENTITY } = await import('../src/shared/app-identity.js');
    expect(CUSTOM_APP_IDENTITY.bridgeAppId).not.toBe(OFFICIAL_APP_IDENTITY.bridgeAppId);

    const bridge = readFileSync(path.join(root, 'src', 'main', 'bridge.ts'), 'utf8');
    const extension = readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
    expect(bridge).toContain('app: CUSTOM_APP_IDENTITY.bridgeAppId');
    expect(extension).toContain(`const BRIDGE_APP = '${CUSTOM_APP_IDENTITY.bridgeAppId}';`);
    expect(extension).toContain('body.app === BRIDGE_APP');
  });
});
