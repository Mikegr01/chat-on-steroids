import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CUSTOM_APP_IDENTITY, OFFICIAL_APP_IDENTITY } from '../src/shared/app-identity.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Mirrors Chromium's crx_file::id_util::GenerateIdForPath for the host platform.
 * Chromium normalizes only the Windows drive-letter case before hashing the native
 * FilePath bytes, then maps the first 16 SHA-256 bytes from hex to the a-p alphabet.
 */
function chromeExtensionIdForPath(extensionPath: string): string {
  let normalized = path.resolve(extensionPath);
  if (process.platform === 'win32' && /^[a-z]:/.test(normalized)) {
    normalized = normalized[0]!.toUpperCase() + normalized.slice(1);
  }
  const pathBytes = Buffer.from(normalized, process.platform === 'win32' ? 'utf16le' : 'utf8');
  const hash = createHash('sha256').update(pathBytes).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    const byte = hash[i]!;
    id += String.fromCharCode(97 + ((byte >> 4) & 0x0f));
    id += String.fromCharCode(97 + (byte & 0x0f));
  }
  return id;
}

describe('Browser extension identity and dual-install isolation', () => {
  it('defines distinct centralized identity constants for official and custom extensions', () => {
    expect(CUSTOM_APP_IDENTITY.extensionName).toBe('Chat On Steroids Custom');
    expect(CUSTOM_APP_IDENTITY.bridgeAppId).toBe('chat-on-steroids-custom');
    expect(CUSTOM_APP_IDENTITY.extensionActionTitle).toBe('Chat On Steroids Custom');

    expect(OFFICIAL_APP_IDENTITY.extensionName).toBe('Chat On Steroids companion');
    expect(OFFICIAL_APP_IDENTITY.bridgeAppId).toBe('chat-on-steroids');

    expect(CUSTOM_APP_IDENTITY.extensionName).not.toBe(OFFICIAL_APP_IDENTITY.extensionName);
    expect(CUSTOM_APP_IDENTITY.bridgeAppId).not.toBe(OFFICIAL_APP_IDENTITY.bridgeAppId);
  });

  it('declares custom human-facing extension identity in manifest and English locale messages', () => {
    const enMessages = JSON.parse(
      readFileSync(path.join(root, 'extension', '_locales', 'en', 'messages.json'), 'utf8')
    ) as {
      extension_name: { message: string };
      extension_action_title: { message: string };
      extension_description: { message: string };
    };
    const manifest = JSON.parse(
      readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8')
    ) as {
      name: string;
      action: { default_title: string };
      key?: string;
    };

    expect(manifest.name).toBe('__MSG_extension_name__');
    expect(manifest.action.default_title).toBe('__MSG_extension_action_title__');
    expect(manifest.key).toBeUndefined();

    expect(enMessages.extension_name.message).toBe('Chat On Steroids Custom');
    expect(enMessages.extension_name.message).not.toBe('Chat On Steroids companion');
    expect(enMessages.extension_action_title.message).toBe('Chat On Steroids Custom');
    expect(enMessages.extension_action_title.message).not.toBe('Chat On Steroids');
    expect(enMessages.extension_description.message).toContain('Chat On Steroids Custom');
  });

  it('proves unpacked official and custom directories derive distinct deterministic Chromium IDs', () => {
    const fakeAppData = process.platform === 'win32'
      ? 'C:\\Users\\Admin\\AppData\\Roaming'
      : '/home/admin/.config';
    const officialExtensionPath = path.join(fakeAppData, OFFICIAL_APP_IDENTITY.userDataDir, 'extension');
    const customExtensionPath = path.join(fakeAppData, CUSTOM_APP_IDENTITY.userDataDir, 'extension');

    expect(officialExtensionPath).not.toBe(customExtensionPath);

    const officialExtId = chromeExtensionIdForPath(officialExtensionPath);
    const customExtId = chromeExtensionIdForPath(customExtensionPath);

    expect(officialExtId).toMatch(/^[a-p]{32}$/);
    expect(customExtId).toMatch(/^[a-p]{32}$/);
    expect(customExtId).not.toBe(officialExtId);
  });

  it('custom desktop bridge /hello identifies as chat-on-steroids-custom to prevent cross-talk', () => {
    const bridgeSource = readFileSync(path.join(root, 'src', 'main', 'bridge.ts'), 'utf8');

    const helloBlockMatch = bridgeSource.match(/if\s*\(route\s*===\s*'\/hello'\)\s*\{[\s\S]*?app:\s*([^\r\n,]+)/);
    expect(helloBlockMatch).not.toBeNull();
    const appValueExpression = helloBlockMatch![1]!.trim();

    expect(appValueExpression).not.toBe("'chat-on-steroids'");
    expect(appValueExpression).toMatch(/CUSTOM_APP_IDENTITY\.bridgeAppId|'chat-on-steroids-custom'/);
  });

  it('custom extension background worker targets custom bridge app and rejects official bridge', () => {
    const backgroundCode = readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');

    expect(backgroundCode).toContain("const BRIDGE_APP = 'chat-on-steroids-custom';");
    expect(backgroundCode).not.toContain("return body && body.app === 'chat-on-steroids'");
  });
});
