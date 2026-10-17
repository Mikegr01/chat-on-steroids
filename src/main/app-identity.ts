/** Main-process owner for application identity and profile selection. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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

const VALIDATION_OPTION = '--validation-user-data';
const VALIDATION_SENTINEL = '.cos-validation-profile.json';
// Exact, stable ownership contract; app release versions and user paths do not belong here.
const VALIDATION_MARKER = JSON.stringify({
  kind: 'chat-on-steroids-validation-profile', version: 1, product: CUSTOM_APP_IDENTITY.packageName
});
const finalizedUserData = new WeakMap<AppIdentityTarget, string>();

function comparablePath(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function sameOrAncestor(parent: string, child: string): boolean {
  const relative = path.relative(comparablePath(parent), comparablePath(child));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Only ENOENT means missing. A dangling link, unreadable prefix or non-directory fails closed. */
function canonicalPath(value: string): string {
  let existing = value;
  const missing: string[] = [];
  for (;;) {
    try { fs.lstatSync(existing); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(existing) === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = path.dirname(existing);
      continue;
    }
    const canonical = fs.realpathSync.native(existing);
    if (!fs.statSync(canonical).isDirectory()) throw new Error('Validation userData requires directory ancestors');
    return path.join(canonical, ...missing);
  }
}

function validationArgument(argv: readonly string[]): string | null {
  const options = argv.filter(arg => arg.startsWith(VALIDATION_OPTION));
  if (options.length === 0) return null;
  if (options.length !== 1 || !options[0]!.startsWith(`${VALIDATION_OPTION}=`)) {
    throw new Error('Validation userData requires exactly one inline absolute path');
  }
  const raw = options[0]!.slice(VALIDATION_OPTION.length + 1);
  if (!raw || raw.includes('\0') || !path.isAbsolute(raw) || path.normalize(raw) !== raw ||
      raw.split(/[\\/]/).some(segment => segment === '.' || segment === '..') || raw.endsWith(path.sep)) {
    throw new Error('Validation userData must be an absolute normalized non-root directory without traversal');
  }
  // Local drive paths only. Win32 device/UNC namespaces, ADS and trimmed/device components can
  // alias a different filesystem identity despite looking normalized to node:path.
  if (process.platform === 'win32' && (!/^[a-z]:\\/i.test(raw) || raw.slice(3).split('\\').some(segment =>
    /[<>:"|?*\x00-\x1f]/.test(segment) || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment)))) {
    throw new Error('Validation userData requires an unambiguous local drive path');
  }
  return canonicalPath(raw);
}

function assertDisposablePath(directory: string, target: AppPathProvider): void {
  if (comparablePath(directory) === comparablePath(path.parse(directory).root)) throw new Error('Validation userData may not be a filesystem root');
  for (const identity of [CUSTOM_APP_IDENTITY, OFFICIAL_APP_IDENTITY]) {
    const protectedPath = canonicalPath(path.join(target.getPath('appData'), identity.userDataDir));
    if (sameOrAncestor(directory, protectedPath) || sameOrAncestor(protectedPath, directory)) {
      throw new Error('Validation userData overlaps a protected product profile');
    }
  }
}

function ownsValidationDirectory(directory: string): boolean {
  let fd: number | undefined;
  try {
    const file = path.join(directory, VALIDATION_SENTINEL);
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.size !== Buffer.byteLength(VALIDATION_MARKER)) return false;
    fd = fs.openSync(file, 'r');
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return false;
    const bytes = Buffer.alloc(before.size + 1);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    return bytes.subarray(0, length).toString('utf8') === VALIDATION_MARKER;
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function prepareValidationDirectory(directory: string, target: AppPathProvider): void {
  assertDisposablePath(directory, target);
  let existing: fs.Stats | undefined;
  try { existing = fs.lstatSync(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (existing) {
    if (!existing.isDirectory() || !ownsValidationDirectory(directory)) throw new Error('Validation userData directory is not validation-owned');
  } else {
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    if (comparablePath(canonicalPath(directory)) !== comparablePath(directory)) throw new Error('Validation userData ancestor changed');
    assertDisposablePath(directory, target);
    // Unlike recursive mkdir on the target, this cannot claim a foreign directory appearing now.
    fs.mkdirSync(directory);
  }
  const identity = existing ?? fs.lstatSync(directory);
  const assertStable = () => {
    const current = fs.lstatSync(directory);
    if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino ||
        comparablePath(fs.realpathSync.native(directory)) !== comparablePath(directory)) {
      throw new Error('Validation userData changed during preparation');
    }
    assertDisposablePath(directory, target);
  };
  assertStable();
  // W_OK alone does not establish Windows ACL write access. Never remove a profile directory.
  const probe = path.join(directory, `.cos-validation-write-${randomUUID()}`);
  const fd = fs.openSync(probe, 'wx');
  try { fs.closeSync(fd); } finally { fs.unlinkSync(probe); }
  assertStable();
  if (!existing) fs.writeFileSync(path.join(directory, VALIDATION_SENTINEL), VALIDATION_MARKER, { flag: 'wx' });
  if (!ownsValidationDirectory(directory)) throw new Error('Validation userData ownership changed');
  assertStable();
}

export function resolveCustomUserData(provider: AppPathProvider = app): string {
  return path.join(provider.getPath('appData'), CUSTOM_APP_IDENTITY.userDataDir);
}

/** Must run before requestSingleInstanceLock() or any userData consumer. */
export function configureAppIdentity(target: AppIdentityTarget = app, argv: readonly string[] = process.argv): void {
  const validation = validationArgument(argv);
  const userData = validation ?? resolveCustomUserData(target);
  const previous = finalizedUserData.get(target);
  if (previous !== undefined) {
    if (comparablePath(previous) !== comparablePath(userData) || target.getPath('userData') !== previous) {
      throw new Error('Application userData identity is already finalized');
    }
    return;
  }
  if (validation !== null) prepareValidationDirectory(validation, target);
  target.setName(CUSTOM_APP_IDENTITY.productName);
  if (process.platform === 'win32' && typeof target.setAppUserModelId === 'function') {
    target.setAppUserModelId(CUSTOM_APP_IDENTITY.appId);
  }
  target.setPath('userData', userData);
  finalizedUserData.set(target, userData);
}
