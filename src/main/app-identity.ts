/** Main-process owner for application identity and profile selection. */
import path from 'node:path';
import { app } from 'electron';
import { CUSTOM_APP_IDENTITY } from '../shared/app-identity.js';

export { CUSTOM_APP_IDENTITY };

export interface AppPathProvider {
  getPath(name: string): string;
}

export interface AppIdentityTarget extends AppPathProvider {
  setPath(name: string, value: string): void;
  setName(name: string): void;
  setAppUserModelId?(id: string): void;
}

export function resolveCustomUserData(provider: AppPathProvider = app): string {
  return path.join(provider.getPath('appData'), CUSTOM_APP_IDENTITY.userDataDir);
}

/** Must run before requestSingleInstanceLock() or any userData consumer. */
export function configureAppIdentity(target: AppIdentityTarget = app): void {
  target.setName(CUSTOM_APP_IDENTITY.productName);
  if (process.platform === 'win32' && typeof target.setAppUserModelId === 'function') {
    target.setAppUserModelId(CUSTOM_APP_IDENTITY.appId);
  }
  target.setPath('userData', resolveCustomUserData(target));
}
