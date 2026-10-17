import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureAppIdentity, CUSTOM_APP_IDENTITY } from '../src/main/app-identity.js';
import { OFFICIAL_APP_IDENTITY } from '../src/shared/app-identity.js';

const sentinel = '.cos-validation-profile.json';
const marker = JSON.stringify({ kind: 'chat-on-steroids-validation-profile', version: 1, product: CUSTOM_APP_IDENTITY.packageName });
const roots: string[] = [];
function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cos-validation-test-')));
  roots.push(root);
  const appData = path.join(root, 'appdata');
  fs.mkdirSync(appData);
  const paths: Record<string, string> = { appData };
  const target = {
    getPath: (name: string) => paths[name] ?? '',
    setPath: (name: string, value: string) => { paths[name] = value; },
    setName: vi.fn(), setAppUserModelId: vi.fn()
  };
  return { root, appData, paths, target, candidate: path.join(root, 'disposable') };
}
function select(target: Parameters<typeof configureAppIdentity>[0], candidate: string) {
  configureAppIdentity(target, [`--validation-user-data=${candidate}`]);
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    // Only roots created by this test; never a real application profile.
    if (!path.basename(root).startsWith('cos-validation-test-') || path.dirname(root) !== fs.realpathSync.native(os.tmpdir())) throw new Error('Unsafe fixture cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('isolated real-runtime profile admission', () => {
  it('keeps ordinary startup Custom, with no validation marker or preference', () => {
    const { target, paths, appData } = fixture();
    configureAppIdentity(target, []);
    expect(paths.userData).toBe(path.join(appData, CUSTOM_APP_IDENTITY.userDataDir));
    expect(fs.readdirSync(appData)).toEqual([]);
  });

  it('selects an explicit missing profile and writes only the stable ownership marker', () => {
    const { target, paths, candidate } = fixture();
    select(target, candidate);
    expect(paths.userData).toBe(candidate);
    expect(fs.readdirSync(candidate)).toEqual([sentinel]);
    expect(fs.readFileSync(path.join(candidate, sentinel), 'utf8')).toBe(marker);
    expect(target.setName).toHaveBeenCalledWith(CUSTOM_APP_IDENTITY.productName);
    if (process.platform === 'win32') expect(target.setAppUserModelId).toHaveBeenCalledWith(CUSTOM_APP_IDENTITY.appId);
  });

  it.each([CUSTOM_APP_IDENTITY.userDataDir, OFFICIAL_APP_IDENTITY.userDataDir])('protects %s in both ancestor directions, including case aliases', name => {
    const { target, appData, paths } = fixture();
    const profile = path.join(appData, name);
    fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile, 'keep'), 'production fixture');
    const candidates = [profile, path.join(profile, 'child'), appData];
    if (process.platform === 'win32') candidates.push(profile.toUpperCase(), path.join(profile.toUpperCase(), 'CHILD'));
    for (const candidate of candidates) expect(() => select(target, candidate)).toThrow();
    expect(paths.userData).toBeUndefined();
    expect(fs.readdirSync(profile)).toEqual(['keep']);
  });

  it.each([CUSTOM_APP_IDENTITY.userDataDir, OFFICIAL_APP_IDENTITY.userDataDir])('rejects junction/symlink and missing children pointing into %s', name => {
    const { target, root, appData } = fixture();
    const profile = path.join(appData, name);
    fs.mkdirSync(profile);
    const alias = path.join(root, 'alias');
    fs.symlinkSync(profile, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => select(target, alias)).toThrow();
    expect(() => select(target, path.join(alias, 'missing', 'child'))).toThrow();
    expect(fs.readdirSync(profile)).toEqual([]);
  });

  it('canonicalizes an existing alias before creating missing descendants', () => {
    const { target, root, paths } = fixture();
    const actual = path.join(root, 'actual');
    const alias = path.join(root, 'alias');
    fs.mkdirSync(actual);
    fs.symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
    select(target, path.join(alias, 'missing', 'child'));
    expect(paths.userData).toBe(path.join(actual, 'missing', 'child'));
    expect(fs.readFileSync(path.join(paths.userData!, sentinel), 'utf8')).toBe(marker);
  });

  it.each([CUSTOM_APP_IDENTITY.userDataDir, OFFICIAL_APP_IDENTITY.userDataDir])('protects %s even when a copied sentinel or product-profile junction could claim ownership', name => {
    const { target, root, appData } = fixture();
    const actual = path.join(root, 'external-product');
    fs.mkdirSync(actual);
    fs.writeFileSync(path.join(actual, sentinel), marker);
    fs.symlinkSync(actual, path.join(appData, name), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => select(target, actual)).toThrow();
    fs.writeFileSync(path.join(appData, sentinel), marker);
    expect(() => select(target, appData)).toThrow();
    expect(fs.readdirSync(actual)).toEqual([sentinel]);
  });

  it('allows an unrelated sibling whose name merely starts with a protected profile name', () => {
    const { target, appData, paths } = fixture();
    const candidate = path.join(appData, `${CUSTOM_APP_IDENTITY.userDataDir}-validation`);
    select(target, candidate);
    expect(paths.userData).toBe(candidate);
  });

  it.each([false, true])('preserves an existing unowned directory (populated=%s)', populated => {
    const { target, candidate } = fixture();
    fs.mkdirSync(candidate);
    if (populated) fs.writeFileSync(path.join(candidate, 'keep'), 'unrelated');
    expect(() => select(target, candidate)).toThrow();
    expect(fs.readdirSync(candidate)).toEqual(populated ? ['keep'] : []);
    if (populated) expect(fs.readFileSync(path.join(candidate, 'keep'), 'utf8')).toBe('unrelated');
  });

  it.each(['', '{}', marker + '\n', marker.replace('"version":1', '"version":2'), marker.replace(CUSTOM_APP_IDENTITY.packageName, OFFICIAL_APP_IDENTITY.packageName)])('rejects a corrupted/foreign marker: %s', content => {
    const { target, candidate } = fixture();
    fs.mkdirSync(candidate);
    fs.writeFileSync(path.join(candidate, sentinel), content);
    expect(() => select(target, candidate)).toThrow();
    expect(fs.readFileSync(path.join(candidate, sentinel), 'utf8')).toBe(content);
  });

  it('reuses owned crash residue across process targets without contaminating ordinary startup', () => {
    const { target, paths, candidate } = fixture();
    select(target, candidate);
    fs.writeFileSync(path.join(candidate, 'crash-residue'), 'retain');
    const otherPaths = { ...paths };
    const other = { ...target, getPath: (name: string) => otherPaths[name]!, setPath: (name: string, value: string) => { otherPaths[name] = value; } };
    select(other, candidate);
    expect(otherPaths.userData).toBe(candidate);
    const ordinary = { ...other };
    configureAppIdentity(ordinary, []);
    expect(otherPaths.userData).toBe(path.join(paths.appData!, CUSTOM_APP_IDENTITY.userDataDir));
    expect(fs.readFileSync(path.join(candidate, 'crash-residue'), 'utf8')).toBe('retain');
  });

  it('cannot switch a finalized target, including validation to ordinary or ordinary to validation', () => {
    const { target, paths, candidate, root } = fixture();
    select(target, candidate);
    select(target, candidate);
    expect(() => select(target, path.join(root, 'second'))).toThrow();
    expect(() => configureAppIdentity(target, [])).toThrow();
    expect(paths.userData).toBe(candidate);
    expect(fs.existsSync(path.join(root, 'second'))).toBe(false);
    const ordinary = fixture();
    configureAppIdentity(ordinary.target, []);
    expect(() => select(ordinary.target, ordinary.candidate)).toThrow();
    expect(fs.existsSync(ordinary.candidate)).toBe(false);
  });

  it('rejects malformed CLI and path spellings before identity or filesystem publication', () => {
    const { target, candidate, root, paths } = fixture();
    const bad = [
      ['--validation-user-data'], ['--validation-user-data', candidate], ['--validation-user-data='],
      [`--validation-user-data=${candidate}`, `--validation-user-data=${candidate}`],
      ['--validation-user-data=relative'], [`--validation-user-data=${path.parse(root).root}`],
      [`--validation-user-data=${root}${path.sep}..${path.sep}escape`],
      [`--validation-user-data=${root}${path.sep}.${path.sep}child`],
      [`--validation-user-data=${root}${path.sep}${path.sep}child`],
      [`--validation-user-data=${candidate}${path.sep}`], [`--validation-user-data=${candidate}\0`]
    ];
    if (process.platform === 'win32') bad.push(
      ['--validation-user-data=\\\\server\\share\\profile'], ['--validation-user-data=\\\\?\\C:\\profile'],
      [`--validation-user-data=${candidate}.`], [`--validation-user-data=${candidate} `],
      [`--validation-user-data=${candidate}:stream`], [`--validation-user-data=${root}\\NUL`]
    );
    for (const argv of bad) expect(() => configureAppIdentity(target, argv), JSON.stringify(argv)).toThrow();
    expect(paths.userData).toBeUndefined();
    expect(target.setName).not.toHaveBeenCalled();
    expect(fs.existsSync(candidate)).toBe(false);
  });

  it('rejects files and dangling aliases without replacing them', () => {
    const { target, candidate, root } = fixture();
    fs.writeFileSync(candidate, 'keep');
    expect(() => select(target, candidate)).toThrow();
    expect(fs.readFileSync(candidate, 'utf8')).toBe('keep');
    const alias = path.join(root, 'dangling');
    fs.symlinkSync(path.join(root, 'absent'), alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => select(target, alias)).toThrow();
    expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
  });

  it('does not claim a foreign directory that appears at exclusive creation', () => {
    const { target, candidate, paths } = fixture();
    const mkdir = fs.mkdirSync;
    vi.spyOn(fs, 'mkdirSync').mockImplementation(((directory, options) => {
      if (directory === candidate) { mkdir(candidate); fs.writeFileSync(path.join(candidate, 'foreign'), 'keep'); }
      return mkdir(directory, options);
    }) as typeof fs.mkdirSync);
    expect(() => select(target, candidate)).toThrow();
    expect(fs.readdirSync(candidate)).toEqual(['foreign']);
    expect(paths.userData).toBeUndefined();
  });

  it('fails closed when an existing prefix disappears during canonicalization', () => {
    const { target, candidate, root, paths } = fixture();
    const prefix = path.join(root, 'prefix');
    fs.mkdirSync(prefix);
    const realpath = fs.realpathSync.native;
    vi.spyOn(fs.realpathSync, 'native').mockImplementation((value: fs.PathLike) => {
      if (value === prefix) fs.rmdirSync(prefix);
      return realpath(value);
    });
    expect(() => select(target, path.join(prefix, path.basename(candidate)))).toThrow();
    expect(paths.userData).toBeUndefined();
    expect(fs.existsSync(prefix)).toBe(false);
  });

  it('does not publish a profile redirected to a protected junction during creation', () => {
    const { target, candidate, appData, paths } = fixture();
    const profile = path.join(appData, CUSTOM_APP_IDENTITY.userDataDir);
    fs.mkdirSync(profile);
    const mkdir = fs.mkdirSync;
    vi.spyOn(fs, 'mkdirSync').mockImplementation(((directory, options) => {
      const result = mkdir(directory, options);
      if (directory === candidate) { fs.rmdirSync(candidate); fs.symlinkSync(profile, candidate, process.platform === 'win32' ? 'junction' : 'dir'); }
      return result;
    }) as typeof fs.mkdirSync);
    expect(() => select(target, candidate)).toThrow();
    expect(paths.userData).toBeUndefined();
    expect(fs.readdirSync(profile)).toEqual([]);
  });

  it('requires actual write access even for an owned profile', () => {
    const { target, candidate, paths } = fixture();
    select(target, candidate);
    const second = { ...target };
    const open = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((file, flags, mode) => {
      if (String(file).startsWith(candidate + path.sep) && flags === 'wx') throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return open(file, flags, mode);
    }) as typeof fs.openSync);
    expect(() => select(second, candidate)).toThrow();
    expect(fs.readdirSync(candidate)).toEqual([sentinel]);
    expect(paths.userData).toBe(candidate);
  });

  it.runIf(process.platform === 'win32')('rejects an owned Windows directory whose ACL denies writes', () => {
    const { target, candidate } = fixture();
    select(target, candidate);
    const sid = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-[\d-]+/)![0];
    try {
      execFileSync('icacls', [candidate, '/deny', `*${sid}:(W)`], { windowsHide: true, stdio: 'pipe' });
      expect(() => select({ ...target }, candidate)).toThrow();
    } finally {
      execFileSync('icacls', [candidate, '/remove:d', `*${sid}`], { windowsHide: true, stdio: 'pipe' });
    }
    expect(fs.readdirSync(candidate)).toEqual([sentinel]);
  });

  it('keeps Electron singleton ownership scoped to the finalized disposable profile', async () => {
    const { root, appData, candidate } = fixture();
    const owner = path.join(root, 'owner.cjs');
    buildSync({ entryPoints: [path.resolve('src/main/app-identity.ts')], outfile: owner,
      bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
    const entry = path.join(root, 'entry.cjs');
    fs.writeFileSync(entry, `
      const {app} = require('electron');
      app.setPath('appData', ${JSON.stringify(appData)});
      try {
        if (process.argv.includes('--fixture-helper')) {
          require(${JSON.stringify(path.resolve('scripts/fixtures/app-defaults.cjs'))}).validationUserData(${JSON.stringify(path.join(root, 'fixture-profile'))});
        }
        require(${JSON.stringify(owner)}).configureAppIdentity();
        const userData = app.getPath('userData');
        const locked = app.requestSingleInstanceLock();
        app.on('second-instance', () => {});
        app.whenReady().then(() => {
          console.log('PROFILE_PROOF=' + JSON.stringify({userData, locked, name: app.getName()}));
          if (!process.argv.includes('--hold')) app.exit(0);
        });
      } catch { app.exit(2); }
    `);
    const electron = createRequire(import.meta.url)('electron') as string;
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const first = spawn(electron, [entry, `--validation-user-data=${candidate}`, '--hold'], { env, windowsHide: true });
    let output = '';
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Electron profile startup timed out')), 15000);
        first.on('error', error => { clearTimeout(timer); reject(error); });
        first.on('exit', code => { clearTimeout(timer); reject(new Error(`Electron exited early: ${code}`)); });
        first.stdout.on('data', data => { output += data; if (output.includes('PROFILE_PROOF=')) { clearTimeout(timer); resolve(); } });
      });
      const run = (args: string[]) => {
        const result = spawnSync(electron, [entry, ...args], { env, encoding: 'utf8', timeout: 15000, windowsHide: true });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        return JSON.parse(result.stdout.split('PROFILE_PROOF=')[1]!.split(/\r?\n/)[0]!);
      };
      expect(JSON.parse(output.split('PROFILE_PROOF=')[1]!.split(/\r?\n/)[0]!)).toEqual({ userData: candidate, locked: true, name: CUSTOM_APP_IDENTITY.productName });
      expect(run([`--validation-user-data=${candidate}`])).toMatchObject({ userData: candidate, locked: false });
      expect(run([`--validation-user-data=${path.join(root, 'independent')}`])).toMatchObject({ locked: true });
      expect(run(['--fixture-helper'])).toMatchObject({ userData: path.join(root, 'fixture-profile'), locked: true });
      const ordinary = run([]);
      expect(ordinary).toMatchObject({ userData: path.join(appData, CUSTOM_APP_IDENTITY.userDataDir), locked: true });
      expect(fs.existsSync(path.join(ordinary.userData, sentinel))).toBe(false);
      const rejected = spawnSync(electron, [entry, '--validation-user-data=relative'], { env, timeout: 15000, windowsHide: true });
      expect(rejected.status).toBe(2);
    } finally {
      const exited = new Promise<void>(resolve => first.once('exit', () => resolve()));
      first.kill();
      await exited;
    }
  });
});
