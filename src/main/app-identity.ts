/**
 * Main-process application identity and userData isolation configuration.
 */

import path from 'node:path';
import { app } from 'electron';
import { CUSTOM_APP_IDENTITY } from '../shared/app-identity.js';

export { CUSTOM_APP_IDENTITY };

export interface AppPathProvider {
  getPath(name: string): string;
}

export interface AppIdentityTarget {
  name: string;
  getPath(name: string): string;
  setPath(name: string, value: string): void;
  setAppUserModelId?(id: string): void;
}

/**
 * Resolves the isolated user-data directory for the custom build,
 * completely segregated from official %APPDATA%\chat-on-steroids.
 */
export function resolveCustomUserData(appProvider: AppPathProvider = app): string {
  const appData = appProvider.getPath('appData');
  return path.join(appData, CUSTOM_APP_IDENTITY.userDataDir);
}

/**
 * Configures the custom application identity and isolated userData path.
 *
 * MUST be called before app.requestSingleInstanceLock() so that the single-instance
 * lock socket/file is placed inside the custom userData directory rather than
 * colliding with the official Chat On Steroids lock.
 */
export function configureAppIdentity(target: AppIdentityTarget = app): void {
  target.name = CUSTOM_APP_IDENTITY.productName;

  if (process.platform === 'win32' && typeof target.setAppUserModelId === 'function') {
    target.setAppUserModelId(CUSTOM_APP_IDENTITY.appId);
  }

  const customUserData = resolveCustomUserData(target);
  target.setPath('userData', customUserData);
}
