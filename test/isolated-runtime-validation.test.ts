import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configureAppIdentity } from '../src/main/app-identity.js';

const created: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cos-isolated-runtime-test-'));
  created.push(directory);
  return directory;
}

function identityTarget(appData: string): {
  target: {
    getPath(name: string): string;
    setPath(name: string, value: string): void;
    setName(name: string): void;
    setAppUserModelId(id: string): void;
  };
  paths: Record<string, string>;
} {
  mkdirSync(appData, { recursive: true });
  const paths: Record<string, string> = { appData };
  return {
    paths,
    target: {
      getPath: (name) => paths[name] ?? '',
      setPath: (name, value) => { paths[name] = value; },
      setName: () => {},
      setAppUserModelId: () => {}
    }
  };
}

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

describe('safe isolated real runtime validation profile', () => {
  it('keeps the canonical Custom profile when validation mode is absent', () => {
    const root = tempDir();
    const appData = path.join(root, 'appdata');
    const { target, paths } = identityTarget(appData);

    configureAppIdentity(target, ['electron.exe']);

    expect(paths.userData).toBe(path.join(appData, 'chat-on-steroids-custom'));
  });

  it('selects an explicit disposable profile before later userData consumers', () => {
    const root = tempDir();
    const appData = path.join(root, 'appdata');
    const candidate = path.join(root, 'candidate');
    const { target, paths } = identityTarget(appData);

    configureAppIdentity(target, ['electron.exe', `--validation-user-data=${candidate}`]);

    expect(paths.userData).toBe(candidate);
    expect(existsSync(path.join(candidate, '.cos-validation-profile.json'))).toBe(true);
  });

  it('rejects empty, relative, and traversal-bearing validation paths', () => {
    const root = tempDir();
    const appData = path.join(root, 'appdata');
    const bad = [
      '',
      path.join('relative', 'candidate'),
      `${root}${path.sep}nested${path.sep}..${path.sep}candidate`,
      `${root}${path.sep}${path.sep}ambiguous`
    ];

    for (const candidate of bad) {
      const { target } = identityTarget(appData);
      expect(() => configureAppIdentity(target, ['electron.exe', `--validation-user-data=${candidate}`])).toThrow();
    }
  });

  it('rejects duplicate validation profile options', () => {
    const root = tempDir();
    const appData = path.join(root, 'appdata');
    const { target } = identityTarget(appData);

    expect(() => configureAppIdentity(target, [
      'electron.exe',
      `--validation-user-data=${path.join(root, 'candidate-a')}`,
      `--validation-user-data=${path.join(root, 'candidate-b')}`
    ])).toThrow();
  });

  it('rejects overlap with protected product profiles', () => {
    const root = tempDir();
    const appData = path.join(root, 'appdata');
    const candidates = [
      path.join(appData, 'chat-on-steroids-custom'),
      path.join(appData, 'chat-on-steroids-custom', 'nested'),
      path.join(appData, 'chat-on-steroids'),
      appData
    ];

    for (const candidate of candidates) {
      const { target } = identityTarget(appData);
      expect(() => configureAppIdentity(target, ['electron.exe', `--validation-user-data=${candidate}`])).toThrow();
    }
  });

  it('rejects a non-empty unowned candidate directory', () => {
    const root = tempDir();
    const appData = path.join(root, 'appdata');
    const candidate = path.join(root, 'foreign');
    mkdirSync(candidate, { recursive: true });
    writeFileSync(path.join(candidate, 'keep.txt'), 'foreign state');
    const { target } = identityTarget(appData);

    expect(() => configureAppIdentity(target, ['electron.exe', `--validation-user-data=${candidate}`])).toThrow();
    expect(existsSync(path.join(candidate, 'keep.txt'))).toBe(true);
  });

  it('rejects an existing empty directory that validation did not create', () => {
    const root = tempDir();
    const appData = path.join(root, 'appdata');
    const candidate = path.join(root, 'foreign-empty');
    mkdirSync(candidate, { recursive: true });
    const { target } = identityTarget(appData);

    expect(() => configureAppIdentity(target, ['electron.exe', `--validation-user-data=${candidate}`])).toThrow();
    expect(existsSync(path.join(candidate, '.cos-validation-profile.json'))).toBe(false);
  });

  it('keeps the finalized validation profile immutable', () => {
    const root = tempDir();
    const appData = path.join(root, 'appdata');
    const candidateA = path.join(root, 'candidate-a');
    const candidateB = path.join(root, 'candidate-b');
    const { target, paths } = identityTarget(appData);

    configureAppIdentity(target, ['electron.exe', `--validation-user-data=${candidateA}`]);
    expect(() => configureAppIdentity(target, ['electron.exe', `--validation-user-data=${candidateB}`])).toThrow();
    expect(paths.userData).toBe(candidateA);
  });

  it('rejects a junction or symlink that resolves into the protected Custom profile', () => {
    const root = tempDir();
    const appData = path.join(root, 'appdata');
    const protectedProfile = path.join(appData, 'chat-on-steroids-custom');
    const alias = path.join(root, 'profile-alias');
    mkdirSync(protectedProfile, { recursive: true });
    symlinkSync(protectedProfile, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const { target } = identityTarget(appData);

    expect(() => configureAppIdentity(target, ['electron.exe', `--validation-user-data=${alias}`])).toThrow();
  });

  it('allows a second process target to reuse validation-owned crash residue', () => {
    const root = tempDir();
    const appData = path.join(root, 'appdata');
    const candidate = path.join(root, 'candidate');
    const first = identityTarget(appData);
    const second = identityTarget(appData);

    configureAppIdentity(first.target, ['electron.exe', `--validation-user-data=${candidate}`]);
    writeFileSync(path.join(candidate, 'runtime-residue.txt'), 'simulated crash residue');
    expect(() => configureAppIdentity(second.target, ['electron.exe', `--validation-user-data=${candidate}`])).not.toThrow();
    expect(second.paths.userData).toBe(candidate);
  });
});
