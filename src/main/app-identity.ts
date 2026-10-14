/** Main-process owner for application identity and profile selection. */
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { CUSTOM_APP_IDENTITY, OFFICIAL_APP_IDENTITY } from '../shared/app-identity.js';

export { CUSTOM_APP_IDENTITY };

export interface AppPathProvider {
  getPath(name: string): string;
}

export interface AppIdentityTarget extends AppPathProvider {
  setPath(name: string, value: string): void;
  setName(name: string): void;
  setAppUserModelId?(id: string): void;
}

const VALIDATION_USER_DATA_PREFIX = '--validation-user-data=';
const VALIDATION_USER_DATA_OPTION = '--validation-user-data';
const VALIDATION_PROFILE_SENTINEL = '.cos-validation-profile.json';
const VALIDATION_PROFILE_SENTINEL_CONTENT = JSON.stringify({
  kind: 'chat-on-steroids-validation-profile',
  version: 1,
  product: CUSTOM_APP_IDENTITY.packageName
});
const finalizedUserData = new WeakMap<AppIdentityTarget, string>();

function comparablePath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sameOrAncestor(parent: string, child: string): boolean {
  const relative = path.relative(comparablePath(parent), comparablePath(child));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function pathsOverlap(left: string, right: string): boolean {
  return sameOrAncestor(left, right) || sameOrAncestor(right, left);
}

/** Resolve existing ancestors through symlinks/junctions without creating the requested target. */
function canonicalPath(value: string): string {
  let existing = path.resolve(value);
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  const canonicalExisting = existsSync(existing) ? realpathSync.native(existing) : existing;
  return path.join(canonicalExisting, ...missing);
}

function validationUserDataArgument(argv: readonly string[]): string | null {
  if (argv.includes(VALIDATION_USER_DATA_OPTION)) {
    throw new Error(`${VALIDATION_USER_DATA_OPTION} requires an inline absolute path value`);
  }
  const matches = argv.filter((arg) => arg.startsWith(VALIDATION_USER_DATA_PREFIX));
  if (matches.length > 1) throw new Error('Validation userData may be specified only once');
  if (matches.length === 0) return null;
  const raw = matches[0]!.slice(VALIDATION_USER_DATA_PREFIX.length);
  if (!raw || raw.includes('\0')) throw new Error('Validation userData must be a non-empty absolute path');
  if (!path.isAbsolute(raw)) throw new Error('Validation userData must be absolute');
  if (raw.split(/[\\/]+/).some((segment) => segment === '.' || segment === '..')) {
    throw new Error('Validation userData must not contain traversal or normalization segments');
  }
  if (path.normalize(raw) !== raw) throw new Error('Validation userData must already be normalized');
  return canonicalPath(raw);
}

function validationSentinelIsOwned(directory: string): boolean {
  try {
    return readFileSync(path.join(directory, VALIDATION_PROFILE_SENTINEL), 'utf8') === VALIDATION_PROFILE_SENTINEL_CONTENT;
  } catch {
    return false;
  }
}

function prepareValidationUserData(directory: string, target: AppIdentityTarget): string {
  const production = canonicalPath(resolveCustomUserData(target));
  const official = canonicalPath(path.join(target.getPath('appData'), OFFICIAL_APP_IDENTITY.userDataDir));
  const root = path.parse(directory).root;
  if (comparablePath(directory) === comparablePath(root)) throw new Error('Validation userData may not be a filesystem root');
  if (pathsOverlap(directory, production) || pathsOverlap(directory, official)) {
    throw new Error('Validation userData overlaps a protected product profile');
  }

  const existed = existsSync(directory);
  if (existed) {
    if (!statSync(directory).isDirectory()) throw new Error('Validation userData must be a directory');
    if (!validationSentinelIsOwned(directory)) throw new Error('Validation userData directory is not validation-owned');
  } else {
    mkdirSync(directory, { recursive: true });
  }

  const finalized = realpathSync.native(directory);
  if (comparablePath(finalized) !== comparablePath(directory)) {
    throw new Error('Validation userData changed during canonicalization');
  }
  if (pathsOverlap(finalized, production) || pathsOverlap(finalized, official)) {
    throw new Error('Validation userData resolves into a protected product profile');
  }
  accessSync(finalized, fsConstants.W_OK);
  if (!validationSentinelIsOwned(finalized)) {
    writeFileSync(path.join(finalized, VALIDATION_PROFILE_SENTINEL), VALIDATION_PROFILE_SENTINEL_CONTENT, { encoding: 'utf8', flag: 'wx' });
  }
  return finalized;
}

export function resolveCustomUserData(provider: AppPathProvider = app): string {
  return path.join(provider.getPath('appData'), CUSTOM_APP_IDENTITY.userDataDir);
}

/** Must run before requestSingleInstanceLock() or any userData consumer. */
export function configureAppIdentity(target: AppIdentityTarget = app, argv: readonly string[] = process.argv): void {
  const requestedValidationUserData = validationUserDataArgument(argv);
  const desiredUserData = requestedValidationUserData ?? resolveCustomUserData(target);
  const previous = finalizedUserData.get(target);
  if (previous !== undefined && comparablePath(previous) !== comparablePath(desiredUserData)) {
    throw new Error('Application userData identity is already finalized');
  }
  const userData = requestedValidationUserData
    ? prepareValidationUserData(requestedValidationUserData, target)
    : desiredUserData;
  target.setName(CUSTOM_APP_IDENTITY.productName);
  if (process.platform === 'win32' && typeof target.setAppUserModelId === 'function') {
    target.setAppUserModelId(CUSTOM_APP_IDENTITY.appId);
  }
  target.setPath('userData', userData);
  finalizedUserData.set(target, userData);
}
