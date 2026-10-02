import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { makeTempDir, removeTempDir } from './helpers.js';

const secrets = vi.hoisted(() => new Map<string, string>());
vi.mock('../src/main/secrets.js', () => ({
  getSecret: vi.fn(async (k: string) => secrets.get(k) ?? null),
  setSecret: vi.fn(async (k: string, v: string) => {
    secrets.set(k, v);
  }),
  clearSecret: vi.fn(async (k: string) => {
    secrets.delete(k);
  }),
}));
import {
  EXPECTED_ADDON_PROTOCOL_VERSION,
  BLENDER_ADDON_FILENAME,
  BLENDER_DEFAULT_PORT,
  validateBlenderExecutablePath,
  parseBlenderVersion,
  isBlenderMcpAddonFile,
  readAddonProtocolVersion,
  queryBlenderAuthoritativePaths,
  inspectBlenderAddon,
  discoverBlenderInstallations,
  installBlenderAddon,
  checkBlenderAddonEnabled,
  enableBlenderAddon,
  getRunningBlenderProcesses,
  checkBlenderPort,
  diagnoseBlenderHealth,
  openBlender,
  authorizeBlenderExecutable,
  getBlenderExecutableVersion,
} from '../src/main/plugins/blender.js';
import * as blenderModule from '../src/main/plugins/blender.js';
import type { BlenderHealthReport } from '../src/shared/plugins.js';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { terminateProcessTree } from '../src/main/exec.js';
import { BUNDLED_BLENDER_MCP_ADDON_SOURCE } from '../src/main/plugins/blender-addon-source.js';
import { PluginManager } from '../src/main/plugins/manager.js';
import { initDurableStore } from '../src/main/durable.js';
import { pluginCatalog } from '../src/main/plugins/catalog.js';

describe('Blender MCP Integration & Hardening', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir('blender-test-');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTempDir(tempDir);
  });

  describe('1. Executable discovery & validation', () => {
    it('accepts canonical absolute blender executable paths', () => {
      const p1 = 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe';
      expect(validateBlenderExecutablePath(p1)).toBe(path.normalize(p1));

      const p2 = '/usr/bin/blender';
      expect(validateBlenderExecutablePath(p2)).toBe(path.normalize(p2));
    });

    it('rejects relative paths, non-blender binaries, empty strings, and injection attempts', () => {
      // (20) Malicious/untrusted executable path rejected
      expect(() => validateBlenderExecutablePath('')).toThrow('Blender executable path cannot be empty.');
      expect(() => validateBlenderExecutablePath('./blender.exe')).toThrow('must be an absolute path.');
      expect(() => validateBlenderExecutablePath('blender.exe')).toThrow('must be an absolute path.');
      expect(() => validateBlenderExecutablePath('C:\\Windows\\System32\\cmd.exe')).toThrow('must be blender.exe or blender.');
      expect(() => validateBlenderExecutablePath('C:\\tools\\python.exe')).toThrow('must be blender.exe or blender.');
      expect(() => validateBlenderExecutablePath('C:\\tools\\blender.exe; calc.exe')).toThrow('dangerous characters');
      expect(() => validateBlenderExecutablePath('C:\\tools\\blender.exe & notepad.exe')).toThrow('dangerous characters');
      expect(() => validateBlenderExecutablePath('C:\\tools\\blender.exe | whoami')).toThrow('dangerous characters');
      expect(() => validateBlenderExecutablePath('C:\\tools\\blender.exe\0malicious')).toThrow('dangerous characters');
    });

    it('discovers blender installations across structured Windows roots and Steam', async () => {
      // Create mock directory hierarchy mimicking Blender Foundation
      const bfDir = path.join(tempDir, 'Blender Foundation');
      const b52Dir = path.join(bfDir, 'Blender 5.2');
      await fs.mkdir(b52Dir, { recursive: true });
      const b52Exe = path.join(b52Dir, 'blender.exe');
      await fs.writeFile(b52Exe, 'fake-binary');

      const mockFs = {
        ...fs,
        readdir: async (p: string) => {
          if (p === 'C:\\Program Files\\Blender Foundation') {
            return ['Blender 5.2'];
          }
          return [];
        },
        stat: async (p: string) => {
          if (p.includes('Blender 5.2') && p.endsWith('blender.exe')) {
            return { isFile: () => true } as unknown as Awaited<ReturnType<typeof fs.stat>>;
          }
          throw new Error('ENOENT');
        },
      } as unknown as typeof fs;

      const mockExec = vi.fn(async () => ({ stdout: 'Blender 5.2.0\n', stderr: '' }));
      const discovered = await discoverBlenderInstallations({
        fsImpl: mockFs,
        execFileImpl: mockExec,
        platform: 'win32',
        env: {},
      });

      expect(discovered.length).toBeGreaterThanOrEqual(1);
      const entry = discovered.find(d => d.executablePath.includes('Blender 5.2'));
      expect(entry).toBeDefined();
      expect(entry?.version).toBe('5.2.0');
      expect(entry?.source).toBe('installer');
      expect(entry?.compatibility).toBe('SUPPORTED');
    });
  });

  describe('2. Version compatibility & parsing', () => {
    it('parses version strings and maps to compatibility tiers correctly', () => {
      expect(parseBlenderVersion('5.2.1 LTS')).toEqual({
        tuple: [5, 2, 1],
        string: '5.2.1',
        compatibility: 'SUPPORTED',
      });
      expect(parseBlenderVersion('4.2.0')).toEqual({
        tuple: [4, 2, 0],
        string: '4.2.0',
        compatibility: 'SUPPORTED',
      });
      expect(parseBlenderVersion('3.6.12')).toEqual({
        tuple: [3, 6, 12],
        string: '3.6.12',
        compatibility: 'SUPPORTED',
      });
      expect(parseBlenderVersion('2.93.0 LTS')).toEqual({
        tuple: [2, 93, 0],
        string: '2.93.0',
        compatibility: 'INCOMPATIBLE',
      });
      expect(parseBlenderVersion('6.0.0 Alpha')).toEqual({
        tuple: [6, 0, 0],
        string: '6.0.0',
        compatibility: 'UNKNOWN',
      });
      expect(parseBlenderVersion('unknown')).toEqual({
        tuple: [0, 0, 0],
        string: 'unknown',
        compatibility: 'UNKNOWN',
      });
    });
  });

  describe('3. Multiple Blender versions & ordering', () => {
    it('discovers multiple versions distinctly and sorts supported newest first', async () => {
      const mockFs = {
        ...fs,
        readdir: async (p: string) => {
          if (p === 'C:\\Program Files\\Blender Foundation') {
            return ['Blender 2.93', 'Blender 4.2', 'Blender 5.2'];
          }
          return [];
        },
        stat: async (p: string) => {
          if (p.startsWith('C:\\Program Files\\Blender Foundation') && p.endsWith('blender.exe')) {
            return { isFile: () => true } as unknown as Awaited<ReturnType<typeof fs.stat>>;
          }
          throw new Error('ENOENT');
        },
      } as unknown as typeof fs;

      const mockExec = vi.fn(async (file: string) => {
        if (file.includes('5.2')) return { stdout: 'Blender 5.2.0\n', stderr: '' };
        if (file.includes('4.2')) return { stdout: 'Blender 4.2.0\n', stderr: '' };
        if (file.includes('2.93')) return { stdout: 'Blender 2.93.0\n', stderr: '' };
        throw new Error('unknown');
      });
      const discovered = await discoverBlenderInstallations({
        fsImpl: mockFs,
        execFileImpl: mockExec,
        platform: 'win32',
        env: {},
      });

      expect(discovered.length).toBe(3);
      expect(discovered[0]?.version).toBe('5.2.0');
      expect(discovered[0]?.compatibility).toBe('SUPPORTED');
      expect(discovered[1]?.version).toBe('4.2.0');
      expect(discovered[1]?.compatibility).toBe('SUPPORTED');
      expect(discovered[2]?.version).toBe('2.93.0');
      expect(discovered[2]?.compatibility).toBe('INCOMPATIBLE');
    });
  });

  describe('4. Missing Blender / No installation found', () => {
    it('returns BLENDER_NOT_FOUND when no installation exists', async () => {
      const mockFs = {
        ...fs,
        readdir: async () => [],
        stat: async () => {
          throw new Error('ENOENT');
        },
      } as unknown as typeof fs;

      const report = await diagnoseBlenderHealth({
        fsImpl: mockFs,
      });

      expect(report.code).toBe('BLENDER_NOT_FOUND');
      expect(report.status).toBe('error');
      expect(report.actionRequired).toContain('Install Blender 3.0+');
    });

    it('returns BLENDER_NOT_FOUND if user-specified executable does not exist', async () => {
      const report = await diagnoseBlenderHealth({
        executablePath: 'C:\\Nonexistent\\blender.exe',
      });
      expect(report.code).toBe('BLENDER_NOT_FOUND');
    });
  });

  describe('5. Authoritative add-on path query & absent directory safe creation', () => {
    it('authoritatively queries scripts and addons directories via Blender Python', async () => {
      const fakeExe = 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe';
      const mockExec = vi.fn(async () => ({
        stdout: `__COS_BLENDER_DATA__:{"version":[5,2,1],"version_string":"5.2.1","scripts":"C:\\\\Users\\\\Admin\\\\AppData\\\\Roaming\\\\Blender Foundation\\\\Blender\\\\5.2\\\\scripts","addons":"C:\\\\Users\\\\Admin\\\\AppData\\\\Roaming\\\\Blender Foundation\\\\Blender\\\\5.2\\\\scripts\\\\addons"}\n`,
        stderr: '',
      }));

      const auth = await queryBlenderAuthoritativePaths(fakeExe, {
        execFileImpl: mockExec,
      });

      expect(auth.version).toEqual([5, 2, 1]);
      expect(auth.versionString).toBe('5.2.1');
      expect(auth.addonsPath).toContain('addons');
      expect(auth.compatibility).toBe('SUPPORTED');
      expect(mockExec).toHaveBeenCalledTimes(1);
    });

    it('falls back deterministically if headless query fails', async () => {
      const fakeExe = 'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe';
      const mockExec = vi.fn(async () => {
        throw new Error('Headless execution failed');
      });

      const auth = await queryBlenderAuthoritativePaths(fakeExe, {
        execFileImpl: mockExec,
      });

      expect(auth.version).toEqual([4, 2, 0]);
      expect(auth.addonsPath).toContain('4.2');
      expect(auth.addonsPath).toContain('addons');
    });

    it('safely creates absent addons directory on install (reproducing and fixing upstream failure)', async () => {
      // (6) Absent add-on directory safely created
      // (7) Original install-addon failure regression test
      const nonExistentAddonsDir = path.join(tempDir, 'NonExistent', 'scripts', 'addons');

      const result = await installBlenderAddon(undefined, {
        addonsPath: nonExistentAddonsDir,
      });

      expect(result.success).toBe(true);
      expect(result.targetPath).toBe(path.join(nonExistentAddonsDir, BLENDER_ADDON_FILENAME));

      // Verify file was written and directory was created
      const content = await fs.readFile(result.targetPath!, 'utf8');
      expect(isBlenderMcpAddonFile(content)).toBe(true);
      expect(readAddonProtocolVersion(content)).toBe(EXPECTED_ADDON_PROTOCOL_VERSION);
    });
  });

  describe('6. Add-on installation, backup & staging', () => {
    it('creates .bak backup when updating an existing modified add-on', async () => {
      const addonsDir = path.join(tempDir, 'addons');
      await fs.mkdir(addonsDir, { recursive: true });
      const targetFile = path.join(addonsDir, BLENDER_ADDON_FILENAME);
      const oldContent = '# old version\nbl_info = {"name": "MCP for Blender", "version": (1, 8, 0)}\nADDON_PROTOCOL_VERSION = 4\n';
      await fs.writeFile(targetFile, oldContent, 'utf8');

      const result = await installBlenderAddon(undefined, { addonsPath: addonsDir });
      expect(result.success).toBe(true);
      expect(result.backupPath).toBe(`${targetFile}.bak`);

      // Verify backup has old content
      const backupContent = await fs.readFile(result.backupPath!, 'utf8');
      expect(backupContent).toBe(oldContent);

      // Verify target has new content
      const newContent = await fs.readFile(targetFile, 'utf8');
      expect(newContent).toBe(BUNDLED_BLENDER_MCP_ADDON_SOURCE);
    });

    it('is idempotent when add-on is already up to date', async () => {
      const addonsDir = path.join(tempDir, 'addons');
      await fs.mkdir(addonsDir, { recursive: true });
      const targetFile = path.join(addonsDir, BLENDER_ADDON_FILENAME);
      await fs.writeFile(targetFile, BUNDLED_BLENDER_MCP_ADDON_SOURCE, 'utf8');

      const result = await installBlenderAddon(undefined, { addonsPath: addonsDir });
      expect(result.success).toBe(true);
      expect(result.message).toContain('already up to date');
      expect(result.backupPath).toBeUndefined();
    });

    it('refuses to install invalid or corrupted add-on source', async () => {
      const addonsDir = path.join(tempDir, 'addons');
      await fs.mkdir(addonsDir, { recursive: true });

      const result = await installBlenderAddon(undefined, {
        addonsPath: addonsDir,
        addonSource: 'print("not a valid blender mcp addon")',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('INVALID_SOURCE');
    });
  });

  describe('7. Add-on inspection & version mismatch diagnostics', () => {
    it('reports ADDON_NOT_INSTALLED when directory has no add-on', async () => {
      const addonsDir = path.join(tempDir, 'addons');
      await fs.mkdir(addonsDir, { recursive: true });

      const status = await inspectBlenderAddon(addonsDir);
      expect(status.installed).toBe(false);
      expect(status.path).toBeNull();
    });

    it('reports ADDON_VERSION_MISMATCH when add-on has outdated protocol', async () => {
      const addonsDir = path.join(tempDir, 'addons');
      await fs.mkdir(addonsDir, { recursive: true });
      const target = path.join(addonsDir, BLENDER_ADDON_FILENAME);
      await fs.writeFile(
        target,
        'bl_info = {"name": "MCP for Blender", "version": (1, 8, 0)}\nADDON_PROTOCOL_VERSION = 4\n',
        'utf8',
      );

      const status = await inspectBlenderAddon(addonsDir);
      expect(status.installed).toBe(true);
      expect(status.protocolVersion).toBe(4);
      expect(status.needsUpdate).toBe(true);
      expect(status.isUpToDate).toBe(false);
    });

    it('identifies up to date add-on with protocol version 5', async () => {
      const addonsDir = path.join(tempDir, 'addons');
      await fs.mkdir(addonsDir, { recursive: true });
      const target = path.join(addonsDir, BLENDER_ADDON_FILENAME);
      await fs.writeFile(target, BUNDLED_BLENDER_MCP_ADDON_SOURCE, 'utf8');

      const status = await inspectBlenderAddon(addonsDir);
      expect(status.installed).toBe(true);
      expect(status.protocolVersion).toBe(5);
      expect(status.version).toBe('1.6');
      expect(status.isUpToDate).toBe(true);
      expect(status.needsUpdate).toBe(false);
    });
  });

  describe('8. Add-on enablement checks', () => {
    it('checks whether add-on is enabled in Blender user preferences', async () => {
      const fakeExe = 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe';
      const mockExecTrue = vi.fn(async () => ({
        stdout: '__COS_ADDON_CHECK__:[true, true]\n',
        stderr: '',
      }));
      expect(await checkBlenderAddonEnabled(fakeExe, { execFileImpl: mockExecTrue })).toBe(true);

      const mockExecFalse = vi.fn(async () => ({
        stdout: '__COS_ADDON_CHECK__:[true, false]\n',
        stderr: '',
      }));
      expect(await checkBlenderAddonEnabled(fakeExe, { execFileImpl: mockExecFalse })).toBe(false);
    });

    it('enables the add-on non-interactively via python script', async () => {
      const fakeExe = 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe';
      let callCount = 0;
      const mockExec = vi.fn(async () => {
        callCount++;
        // First call is enable script, second call is verification check
        return {
          stdout: '__COS_ADDON_CHECK__:[true, true]\n__COS_ENABLE_RESULT__:True\n',
          stderr: '',
        };
      });

      const res = await enableBlenderAddon(fakeExe, { execFileImpl: mockExec });
      expect(res.success).toBe(true);
      expect(res.enabled).toBe(true);
    });
  });

  describe('9. Running processes & loopback port probing', () => {
    it('parses running Blender PIDs from Windows tasklist or powershell', async () => {
      const mockExec = vi.fn(async (_file: string, args: string[]) => {
        if (args.includes('(Get-Process blender -ErrorAction SilentlyContinue).Id')) {
          return { stdout: '1234\n5678\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const pids = await getRunningBlenderProcesses({
        execFileImpl: mockExec,
        platform: 'win32',
      });

      expect(pids).toEqual([1234, 5678]);
    });

    it('probes Blender loopback port strictly on 127.0.0.1 (no unexpected listeners)', async () => {
      // (23) No unexpected network listener (loopback only)
      const server = net.createServer((socket) => {
        socket.on('data', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'get_scene_info') {
            socket.write(JSON.stringify({ status: 'success', result: { scene: 'Scene' } }));
          }
        });
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address() as net.AddressInfo;
      const port = addr.port;

      try {
        const res = await checkBlenderPort(port);
        expect(res.listening).toBe(true);
        expect(res.respondsToProbe).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe('10. Full Health Diagnostics Scenarios (1-15, 19)', () => {
    const fakeExe = 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe';

    it('reports ADDON_DISABLED when add-on is installed but preferences report false', async () => {
      // (10) Add-on disabled
      const addonsDir = path.join(tempDir, 'addons');
      await fs.mkdir(addonsDir, { recursive: true });
      await fs.writeFile(path.join(addonsDir, BLENDER_ADDON_FILENAME), BUNDLED_BLENDER_MCP_ADDON_SOURCE, 'utf8');

      const mockExec = vi.fn(async (_cmd: string, args: string[]) => {
        const cmdStr = args.join(' ');
        if (cmdStr.includes('user_resource')) {
          return {
            stdout: `__COS_BLENDER_DATA__:{"version":[5,2,1],"version_string":"5.2.1","scripts":"${addonsDir}","addons":"${addonsDir}"}\n`,
            stderr: '',
          };
        }
        if (cmdStr.includes('addon_utils.check')) {
          return { stdout: '__COS_ADDON_CHECK__:[true, false]\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const report = await diagnoseBlenderHealth({
        executablePath: fakeExe,
        execFileImpl: mockExec,
        port: 49999, // Unused port
      });

      expect(report.code).toBe('ADDON_DISABLED');
      expect(report.actionRequired).toContain('Enable Add-on');
    });

    it('reports BLENDER_NOT_RUNNING when add-on is enabled but no blender process exists', async () => {
      // (11) Blender not running
      const addonsDir = path.join(tempDir, 'addons');
      await fs.mkdir(addonsDir, { recursive: true });
      await fs.writeFile(path.join(addonsDir, BLENDER_ADDON_FILENAME), BUNDLED_BLENDER_MCP_ADDON_SOURCE, 'utf8');

      const mockExec = vi.fn(async (_cmd: string, args: string[]) => {
        const cmdStr = args.join(' ');
        if (cmdStr.includes('user_resource')) {
          return {
            stdout: `__COS_BLENDER_DATA__:{"version":[5,2,1],"version_string":"5.2.1","scripts":"${addonsDir}","addons":"${addonsDir}"}\n`,
            stderr: '',
          };
        }
        if (cmdStr.includes('addon_utils.check')) {
          return { stdout: '__COS_ADDON_CHECK__:[true, true]\n', stderr: '' };
        }
        // No running processes
        return { stdout: '', stderr: '' };
      });

      const report = await diagnoseBlenderHealth({
        executablePath: fakeExe,
        execFileImpl: mockExec,
        port: 49999,
      });

      expect(report.code).toBe('BLENDER_NOT_RUNNING');
      expect(report.actionRequired).toContain('Open Blender');
    });

    it('reports MULTIPLE_INSTANCES_AMBIGUOUS when multiple blender processes run and none opened port', async () => {
      // (19) Multiple Blender processes ambiguity
      const addonsDir = path.join(tempDir, 'addons');
      await fs.mkdir(addonsDir, { recursive: true });
      await fs.writeFile(path.join(addonsDir, BLENDER_ADDON_FILENAME), BUNDLED_BLENDER_MCP_ADDON_SOURCE, 'utf8');

      const mockExec = vi.fn(async (_cmd: string, args: string[]) => {
        const cmdStr = args.join(' ');
        if (cmdStr.includes('user_resource')) {
          return {
            stdout: `__COS_BLENDER_DATA__:{"version":[5,2,1],"version_string":"5.2.1","scripts":"${addonsDir}","addons":"${addonsDir}"}\n`,
            stderr: '',
          };
        }
        if (cmdStr.includes('addon_utils.check')) {
          return { stdout: '__COS_ADDON_CHECK__:[true, true]\n', stderr: '' };
        }
        if (cmdStr.includes('Get-Process blender')) {
          return { stdout: '101\n102\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const report = await diagnoseBlenderHealth({
        executablePath: fakeExe,
        execFileImpl: mockExec,
        port: 49999,
      });

      expect(report.code).toBe('MULTIPLE_INSTANCES_AMBIGUOUS');
      expect(report.message).toContain('2 Blender windows are open');
      expect(report.actionRequired).toContain('In the Blender window you want to control');
    });

    it('reports BLENDER_SERVER_NOT_RUNNING when 1 blender process runs but server port is closed', async () => {
      // (12) Blender server unavailable
      const addonsDir = path.join(tempDir, 'addons');
      await fs.mkdir(addonsDir, { recursive: true });
      await fs.writeFile(path.join(addonsDir, BLENDER_ADDON_FILENAME), BUNDLED_BLENDER_MCP_ADDON_SOURCE, 'utf8');

      const mockExec = vi.fn(async (_cmd: string, args: string[]) => {
        const cmdStr = args.join(' ');
        if (cmdStr.includes('user_resource')) {
          return {
            stdout: `__COS_BLENDER_DATA__:{"version":[5,2,1],"version_string":"5.2.1","scripts":"${addonsDir}","addons":"${addonsDir}"}\n`,
            stderr: '',
          };
        }
        if (cmdStr.includes('addon_utils.check')) {
          return { stdout: '__COS_ADDON_CHECK__:[true, true]\n', stderr: '' };
        }
        if (cmdStr.includes('Get-Process blender')) {
          return { stdout: '101\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const report = await diagnoseBlenderHealth({
        executablePath: fakeExe,
        execFileImpl: mockExec,
        port: 49999,
      });

      expect(report.code).toBe('BLENDER_SERVER_NOT_RUNNING');
      expect(report.diagnostic).toContain('running without an active MCP socket server');
    });

    it('reports READY when Blender is running and port responds to probe', async () => {
      // (14) Real READY health path
      const addonsDir = path.join(tempDir, 'addons');
      await fs.mkdir(addonsDir, { recursive: true });
      await fs.writeFile(path.join(addonsDir, BLENDER_ADDON_FILENAME), BUNDLED_BLENDER_MCP_ADDON_SOURCE, 'utf8');

      const server = net.createServer((socket) => {
        socket.on('data', () => {
          socket.write(JSON.stringify({ status: 'success', result: { scene: 'Scene' } }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const testPort = (server.address() as net.AddressInfo).port;

      const mockExec = vi.fn(async (_cmd: string, args: string[]) => {
        const cmdStr = args.join(' ');
        if (cmdStr.includes('user_resource')) {
          return {
            stdout: `__COS_BLENDER_DATA__:{"version":[5,2,1],"version_string":"5.2.1","scripts":"${addonsDir}","addons":"${addonsDir}"}\n`,
            stderr: '',
          };
        }
        if (cmdStr.includes('Get-Process blender')) {
          return { stdout: '555\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      try {
        const report = await diagnoseBlenderHealth({
          executablePath: fakeExe,
          execFileImpl: mockExec,
          port: testPort,
        });

        expect(report.code).toBe('READY');
        expect(report.status).toBe('ready');
        expect(report.server?.listening).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('transitions from READY to BLENDER_NOT_RUNNING after disconnect', async () => {
      // (15) Blender disconnect after READY
      const addonsDir = path.join(tempDir, 'addons');
      await fs.mkdir(addonsDir, { recursive: true });
      await fs.writeFile(path.join(addonsDir, BLENDER_ADDON_FILENAME), BUNDLED_BLENDER_MCP_ADDON_SOURCE, 'utf8');

      const server = net.createServer((socket) => {
        socket.on('data', () => {
          socket.write(JSON.stringify({ status: 'success', result: { scene: 'Scene' } }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const testPort = (server.address() as net.AddressInfo).port;

      let isBlenderAlive = true;
      const mockExec = vi.fn(async (_cmd: string, args: string[]) => {
        const cmdStr = args.join(' ');
        if (cmdStr.includes('user_resource')) {
          return {
            stdout: `__COS_BLENDER_DATA__:{"version":[5,2,1],"version_string":"5.2.1","scripts":"${addonsDir}","addons":"${addonsDir}"}\n`,
            stderr: '',
          };
        }
        if (cmdStr.includes('addon_utils.check')) {
          return { stdout: '__COS_ADDON_CHECK__:[true, true]\n', stderr: '' };
        }
        if (cmdStr.includes('Get-Process blender')) {
          return { stdout: isBlenderAlive ? '555\n' : '', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const report1 = await diagnoseBlenderHealth({
        executablePath: fakeExe,
        execFileImpl: mockExec,
        port: testPort,
      });
      expect(report1.code).toBe('READY');

      // Close server and simulate process exit
      isBlenderAlive = false;
      await new Promise<void>((resolve) => server.close(() => resolve()));

      const report2 = await diagnoseBlenderHealth({
        executablePath: fakeExe,
        execFileImpl: mockExec,
        port: testPort,
      });
      expect(report2.code).toBe('BLENDER_NOT_RUNNING');
    });
  });

  describe('11. Process ownership & safety (16, 17, 18)', () => {
    it('opens Blender as a detached process without parent ownership', async () => {
      const mockSpawn = vi.fn(() => ({
        pid: 9999,
        unref: vi.fn(),
      })) as unknown as typeof spawn;

      const res = await openBlender('C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe', {
        spawnImpl: mockSpawn,
      });

      expect(res.success).toBe(true);
      expect(res.pid).toBe(9999);
      expect(mockSpawn).toHaveBeenCalledWith(
        'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe',
        [],
        expect.objectContaining({ detached: true, stdio: 'ignore' }),
      );
    });

    it('does not terminate the user Blender process when disabling the plugin', async () => {
      // (17) Disable does not kill Blender
      initDurableStore(tempDir);
      const manager = new PluginManager();
      await manager.initialize(tempDir);

      try {
        const recipe = pluginCatalog.find(c => c.id === 'blender');
        expect(recipe).toBeDefined();

        // Install Blender plugin
        const res = await manager.install({ catalogId: 'blender' });
        const plugin = res.plugins.find(p => p.catalogId === 'blender');
        expect(plugin).toBeDefined();

        // Spy on process.kill
        const killSpy = vi.spyOn(process, 'kill');

        // Disable plugin
        await manager.setEnabled(plugin!.id, false);

        // Verify that external Blender processes were NOT killed
        // Only internal child processes spawned by manager (if any) may be killed
        const snapshot = manager.snapshot();
        const disabledPlugin = snapshot.plugins.find(p => p.id === plugin!.id);
        expect(disabledPlugin?.enabled).toBe(false);

        // process.kill was not called with any fake external Blender PID like 29508
        expect(killSpy).not.toHaveBeenCalledWith(29508, expect.anything());
      } finally {
        await manager.close();
      }
    });

    it('does not terminate the user Blender process when uninstalling the plugin', async () => {
      // (18) Uninstall does not kill Blender
      initDurableStore(tempDir);
      const manager = new PluginManager();
      await manager.initialize(tempDir);

      try {
        const res = await manager.install({ catalogId: 'blender' });
        const plugin = res.plugins.find(p => p.catalogId === 'blender');
        expect(plugin).toBeDefined();

        const killSpy = vi.spyOn(process, 'kill');

        // Uninstall plugin
        await manager.uninstall(plugin!.id);

        expect(manager.snapshot().plugins.find(p => p.id === plugin!.id)).toBeUndefined();
        expect(killSpy).not.toHaveBeenCalledWith(29508, expect.anything());
      } finally {
        await manager.close();
      }
    });
  });

  describe('12. Catalog, Security, and Secret Integrity (21, 22)', () => {
    it('verifies Blender recipe catalog metadata, warnings, and zero exposed secrets', () => {
      // (22) No secret exposure
      const recipe = pluginCatalog.find(c => c.id === 'blender');
      expect(recipe).toBeDefined();
      expect(recipe?.maintainer).toBe('ahujasid');
      expect(recipe?.tier).toBe('specialist');
      expect(recipe?.category).toBe('3d-editor');

      // Assert no secret fields are exposed in catalog
      expect(recipe?.fields).toEqual([]);

      // Security warnings in instructions
      const joinedInstructions = recipe?.instructions.join(' ') ?? '';
      expect(joinedInstructions.toLowerCase()).toContain('high-trust');
      expect(joinedInstructions).toContain('arbitrary Python code execution');
      expect(joinedInstructions).toContain('telemetry is disabled');
    });
  });

  describe('Defect 2: Legacy addon.py migration & duplicate elimination', () => {
    it('Case A: only legacy addon.py with protocol 5 surfaces needsMigration and migrates to canonical blender_mcp.py', async () => {
      const addonsDir = path.join(tempDir, 'addons-a');
      await fs.mkdir(addonsDir, { recursive: true });
      const legacyFile = path.join(addonsDir, 'addon.py');
      await fs.writeFile(legacyFile, BUNDLED_BLENDER_MCP_ADDON_SOURCE, 'utf8');

      // Pre-check
      const preStatus = await inspectBlenderAddon(addonsDir);
      expect(preStatus.installed).toBe(true);
      expect(preStatus.canonicalInstalled).toBe(false);
      expect(preStatus.legacyInstalled).toBe(true);
      expect(preStatus.needsMigration).toBe(true);
      expect(preStatus.needsUpdate).toBe(true);
      expect(preStatus.isUpToDate).toBe(false);

      // Perform installation / migration
      const installRes = await installBlenderAddon(undefined, { addonsPath: addonsDir });
      expect(installRes.success).toBe(true);
      expect(installRes.message).toContain('migrated legacy module');

      // Post-check: canonical exists, legacy addon.py removed, backup preserved
      const canonicalFile = path.join(addonsDir, BLENDER_ADDON_FILENAME);
      expect(await fs.stat(canonicalFile).then(s => s.isFile())).toBe(true);
      await expect(fs.stat(legacyFile)).rejects.toThrow();
      expect(await fs.stat(`${legacyFile}.legacy.bak`).then(s => s.isFile())).toBe(true);

      const postStatus = await inspectBlenderAddon(addonsDir);
      expect(postStatus.installed).toBe(true);
      expect(postStatus.canonicalInstalled).toBe(true);
      expect(postStatus.legacyInstalled).toBe(false);
      expect(postStatus.needsMigration).toBe(false);
      expect(postStatus.isUpToDate).toBe(true);
      expect(postStatus.needsUpdate).toBe(false);

      // Idempotent: re-running is a no-op
      const secondRun = await installBlenderAddon(undefined, { addonsPath: addonsDir });
      expect(secondRun.success).toBe(true);
      expect(secondRun.message).toContain('already up to date');
    });

    it('Case B: only legacy addon.py with outdated protocol 4 surfaces needsMigration and updates protocol', async () => {
      const addonsDir = path.join(tempDir, 'addons-b');
      await fs.mkdir(addonsDir, { recursive: true });
      const legacyFile = path.join(addonsDir, 'addon.py');
      const oldMcpContent = '# old version\nbl_info = {"name": "MCP for Blender", "version": (1, 5, 0)}\nADDON_PROTOCOL_VERSION = 4\n';
      await fs.writeFile(legacyFile, oldMcpContent, 'utf8');

      const preStatus = await inspectBlenderAddon(addonsDir);
      expect(preStatus.installed).toBe(true);
      expect(preStatus.canonicalInstalled).toBe(false);
      expect(preStatus.legacyInstalled).toBe(true);
      expect(preStatus.needsMigration).toBe(true);
      expect(preStatus.needsUpdate).toBe(true);
      expect(preStatus.protocolVersion).toBe(4);

      const installRes = await installBlenderAddon(undefined, { addonsPath: addonsDir });
      expect(installRes.success).toBe(true);

      const postStatus = await inspectBlenderAddon(addonsDir);
      expect(postStatus.canonicalInstalled).toBe(true);
      expect(postStatus.legacyInstalled).toBe(false);
      expect(postStatus.needsMigration).toBe(false);
      expect(postStatus.isUpToDate).toBe(true);
      expect(postStatus.protocolVersion).toBe(EXPECTED_ADDON_PROTOCOL_VERSION);
    });

    it('Case C: legacy addon.py + blender_mcp.py coexisting cleans up legacy to avoid module duplicate', async () => {
      const addonsDir = path.join(tempDir, 'addons-c');
      await fs.mkdir(addonsDir, { recursive: true });
      const legacyFile = path.join(addonsDir, 'addon.py');
      const canonicalFile = path.join(addonsDir, BLENDER_ADDON_FILENAME);
      await fs.writeFile(legacyFile, BUNDLED_BLENDER_MCP_ADDON_SOURCE, 'utf8');
      await fs.writeFile(canonicalFile, BUNDLED_BLENDER_MCP_ADDON_SOURCE, 'utf8');

      const preStatus = await inspectBlenderAddon(addonsDir);
      expect(preStatus.canonicalInstalled).toBe(true);
      expect(preStatus.legacyInstalled).toBe(true);
      expect(preStatus.needsMigration).toBe(true);
      expect(preStatus.needsUpdate).toBe(true);
      expect(preStatus.isUpToDate).toBe(false);

      const installRes = await installBlenderAddon(undefined, { addonsPath: addonsDir });
      expect(installRes.success).toBe(true);
      expect(installRes.message).toContain('migrated legacy module');

      await expect(fs.stat(legacyFile)).rejects.toThrow();
      expect(await fs.stat(canonicalFile).then(s => s.isFile())).toBe(true);
      expect(await fs.stat(`${legacyFile}.legacy.bak`).then(s => s.isFile())).toBe(true);

      const postStatus = await inspectBlenderAddon(addonsDir);
      expect(postStatus.canonicalInstalled).toBe(true);
      expect(postStatus.legacyInstalled).toBe(false);
      expect(postStatus.needsMigration).toBe(false);
      expect(postStatus.isUpToDate).toBe(true);
    });

    it('Case D: does not delete or touch unrelated addon.py files', async () => {
      const addonsDir = path.join(tempDir, 'addons-d');
      await fs.mkdir(addonsDir, { recursive: true });
      const unrelatedFile = path.join(addonsDir, 'addon.py');
      const unrelatedContent = '# Unrelated Blender plugin\nbl_info = {"name": "Other Tools", "version": (1, 0, 0)}\n';
      await fs.writeFile(unrelatedFile, unrelatedContent, 'utf8');

      const preStatus = await inspectBlenderAddon(addonsDir);
      expect(preStatus.installed).toBe(false);
      expect(preStatus.legacyInstalled).toBe(false);
      expect(preStatus.needsMigration).toBe(false);

      const installRes = await installBlenderAddon(undefined, { addonsPath: addonsDir });
      expect(installRes.success).toBe(true);

      // Unrelated addon.py must still exist and be completely unmodified
      expect(await fs.readFile(unrelatedFile, 'utf8')).toBe(unrelatedContent);
      // Canonical blender_mcp.py was created
      const canonicalFile = path.join(addonsDir, BLENDER_ADDON_FILENAME);
      expect(await fs.stat(canonicalFile).then(s => s.isFile())).toBe(true);
    });
  });

  describe('Defect 3: Non-path version discovery & 0.0 path protection', () => {
    it('1. discovers version from portable path with no version in folder name', async () => {
      const portableExe = 'D:\\Tools\\Blender\\blender.exe';
      const mockExec = vi.fn(async (_file: string, args: string[]) => {
        if (args.includes('--version')) {
          return { stdout: 'Blender 5.2.1\n', stderr: '' };
        }
        throw new Error('unexpected');
      });

      const ver = await getBlenderExecutableVersion(portableExe, { execFileImpl: mockExec });
      expect(ver.tuple).toEqual([5, 2, 1]);
      expect(ver.string).toBe('5.2.1');
      expect(ver.compatibility).toBe('SUPPORTED');
    });

    it('2. discovers version from custom path with no version token', async () => {
      const customExe = 'C:\\custom_bin\\blender.exe';
      const mockExec = vi.fn(async (_file: string, args: string[]) => {
        if (args.includes('--version')) {
          return { stdout: 'Blender 4.2.0\n', stderr: '' };
        }
        throw new Error('unexpected');
      });

      const ver = await getBlenderExecutableVersion(customExe, { execFileImpl: mockExec });
      expect(ver.tuple).toEqual([4, 2, 0]);
      expect(ver.string).toBe('4.2.0');
      expect(ver.compatibility).toBe('SUPPORTED');
    });

    it('3. Blender executable reports 5.2.1 despite neutral path and resolves correct user path', async () => {
      const neutralExe = 'C:\\portable\\blender.exe';
      const mockExec = vi.fn(async (_file: string, args: string[]) => {
        if (args.includes('--version')) {
          return { stdout: 'Blender 5.2.1 LTS\n', stderr: '' };
        }
        if (args.includes('--python-expr')) {
          return {
            stdout: `__COS_BLENDER_DATA__:{"version":[5,2,1],"version_string":"5.2.1","scripts":"C:\\\\Users\\\\Admin\\\\AppData\\\\Roaming\\\\Blender Foundation\\\\Blender\\\\5.2\\\\scripts","addons":"C:\\\\Users\\\\Admin\\\\AppData\\\\Roaming\\\\Blender Foundation\\\\Blender\\\\5.2\\\\scripts\\\\addons"}\n`,
            stderr: '',
          };
        }
        throw new Error('unexpected');
      });

      const auth = await queryBlenderAuthoritativePaths(neutralExe, { execFileImpl: mockExec });
      expect(auth.version).toEqual([5, 2, 1]);
      expect(auth.versionString).toBe('5.2.1');
      expect(auth.addonsPath).toContain('5.2');
      expect(auth.addonsPath).toContain('addons');
    });

    it('4. authoritative query failure with unknown version produces empty addonsPath instead of 0.0', async () => {
      const neutralExe = 'C:\\unknown\\blender.exe';
      const mockExec = vi.fn(async () => {
        throw new Error('invocation failed');
      });

      const auth = await queryBlenderAuthoritativePaths(neutralExe, { execFileImpl: mockExec });
      expect(auth.versionString).toBe('unknown');
      expect(auth.addonsPath).toBe('');
      expect(auth.compatibility).toBe('UNKNOWN');
    });

    it('5. no write may occur to a fabricated 0.0 add-ons directory', async () => {
      const neutralExe = 'C:\\unknown\\blender.exe';
      const mockExec = vi.fn(async () => {
        throw new Error('Blender crash');
      });

      const mockFs = {
        ...fs,
        stat: async () => ({ isFile: () => true } as unknown as Awaited<ReturnType<typeof fs.stat>>),
        mkdir: vi.fn(),
        writeFile: vi.fn(),
      } as unknown as typeof fs;

      const res = await installBlenderAddon(neutralExe, {
        fsImpl: mockFs,
        execFileImpl: mockExec,
      });

      expect(res.success).toBe(false);
      expect(res.error).toBe('NO_ADDONS_DIR');
      expect(res.addonsDir).toBeUndefined();
      expect(mockFs.mkdir).not.toHaveBeenCalled();
      expect(mockFs.writeFile).not.toHaveBeenCalled();
    });
  });

  describe('Defect 4: Executable authorization & launch error handling', () => {
    it('rejects arbitrary unvalidated blender.exe outside discovered and configured paths', async () => {
      const evilExe = 'C:\\evil\\blender.exe';
      const discovered = [
        {
          executablePath: 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe',
          version: '5.2.1',
          source: 'installer' as const,
          exists: true,
          compatibility: 'SUPPORTED' as const,
        },
      ];

      await expect(
        authorizeBlenderExecutable(evilExe, {
          discoveredList: discovered,
          persistedPath: undefined,
        }),
      ).rejects.toThrow('Unauthorized Blender executable path');
    });

    it('authorizes executable matching a discovered installation', async () => {
      const validExe = 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe';
      const discovered = [
        {
          executablePath: validExe,
          version: '5.2.1',
          source: 'installer' as const,
          exists: true,
          compatibility: 'SUPPORTED' as const,
        },
      ];

      const auth = await authorizeBlenderExecutable(validExe, { discoveredList: discovered });
      expect(auth).toBe(path.normalize(validExe));
    });

    it('authorizes executable matching persisted configuration', async () => {
      const customExe = 'D:\\Tools\\Blender\\blender.exe';
      const mockFs = {
        ...fs,
        stat: async () => ({ isFile: () => true } as unknown as Awaited<ReturnType<typeof fs.stat>>),
      } as unknown as typeof fs;

      const auth = await authorizeBlenderExecutable(customExe, {
        persistedPath: customExe,
        discoveredList: [],
        fsImpl: mockFs,
      });
      expect(auth).toBe(path.normalize(customExe));
    });

    it('openBlender handles missing file gracefully without crashing or throwing', async () => {
      const res = await openBlender('C:\\nonexistent\\blender.exe');
      expect(res.success).toBe(false);
      expect(res.error).toBeDefined();
    });

    it('openBlender handles asynchronous child spawn error event gracefully', async () => {
      const validExe = 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe';
      const mockFs = {
        ...fs,
        stat: async () => ({ isFile: () => true } as unknown as Awaited<ReturnType<typeof fs.stat>>),
      } as unknown as typeof fs;

      const mockSpawn = vi.fn(() => {
        const emitter = new EventEmitter();
        setTimeout(() => emitter.emit('error', new Error('EACCES: permission denied')), 10);
        return emitter;
      }) as unknown as typeof spawn;

      const res = await openBlender(validExe, {
        fsImpl: mockFs,
        spawnImpl: mockSpawn,
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain('permission denied');
    });
  });

  describe('Defect 5: Selected installation must match port-owning Blender instance', () => {
    it('reports MULTIPLE_INSTANCES_AMBIGUOUS when port owner is a different Blender version/executable', async () => {
      const selectedExe = 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe';
      const portOwnerExe = 'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe';

      const mockExec = vi.fn(async (file: string, args: string[]) => {
        const cmd = args.join(' ');
        if (cmd.includes('(Get-NetTCPConnection')) {
          return { stdout: '12345\n', stderr: '' };
        }
        if (cmd.includes('(Get-Process -Id 12345 -ErrorAction SilentlyContinue).Path')) {
          return { stdout: `${portOwnerExe}\n`, stderr: '' };
        }
        if (file === portOwnerExe && args.includes('--version')) {
          return { stdout: 'Blender 4.2.0\n', stderr: '' };
        }
        if (file === selectedExe && args.includes('--version')) {
          return { stdout: 'Blender 5.2.1\n', stderr: '' };
        }
        if (cmd.includes('Get-Process blender -ErrorAction SilentlyContinue')) {
          return { stdout: '12345\n99999\n', stderr: '' };
        }
        throw new Error(`unknown command: ${file} ${cmd}`);
      });

      const mockFs = {
        ...fs,
        stat: async (p: string) => {
          if (p.includes('blender.exe')) return { isFile: () => true } as unknown as Awaited<ReturnType<typeof fs.stat>>;
          throw new Error('ENOENT');
        },
      } as unknown as typeof fs;

      // Mock loopback server listening on test port
      const server = net.createServer(socket => {
        socket.write('{"type":"version","protocol":5}\n');
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
      const testPort = (server.address() as net.AddressInfo).port;

      try {
        const report = await diagnoseBlenderHealth({
          executablePath: selectedExe,
          port: testPort,
          fsImpl: mockFs,
          execFileImpl: mockExec,
        });

        // Must NOT declare READY for 5.2 while 4.2 owns the port!
        expect(report.code).toBe('MULTIPLE_INSTANCES_AMBIGUOUS');
        expect(report.status).toBe('error');
        expect(report.message).toContain('different Blender instance');
        expect(report.message).toContain('4.2.0');
        expect(report.message).toContain('5.2.1');
        expect(report.actionRequired).toContain('Connect to MCP server from the selected Blender window');
      } finally {
        server.close();
      }
    });
  });

  describe('13. Live Blender Canary (Opt-In / Read-Only / Defect 6)', () => {
    it('queries real Blender installation non-destructively if installed', async (context) => {
      const realExe = 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe';
      let exists = false;
      try {
        const stat = await fs.stat(realExe);
        exists = stat.isFile();
      } catch {}

      if (!exists) {
        return context.skip('Real Blender 5.2 executable is not installed at expected location.');
      }

      // Query authoritative paths on real Blender
      const auth = await queryBlenderAuthoritativePaths(realExe);
      expect(auth.version[0]).toBe(5);
      expect(auth.version[1]).toBe(2);
      expect(auth.compatibility).toBe('SUPPORTED');
      expect(auth.addonsPath).toContain('addons');
    });

    it('performs real MCP client handshake, tool listing, and read-only scene query against live server', async (context) => {
      // 1. Opt-in: check if live Blender MCP server is listening
      const portStatus = await checkBlenderPort(BLENDER_DEFAULT_PORT);
      if (!portStatus.listening || !portStatus.isBlenderProcess) {
        return context.skip('Live Blender MCP server is not running on port 9876.');
      }

      const originalPid = portStatus.owningPid;

      // 2. Real MCP client handshake using Chat On Steroids transport
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        DISABLE_TELEMETRY: '1',
        BLENDER_MCP_DISABLE_TELEMETRY: '1',
        MCP_DISABLE_TELEMETRY: '1',
      };

      const transport = new StdioClientTransport({
        command: 'uvx',
        args: ['blender-mcp==1.9.1', 'run'],
        env,
        stderr: 'ignore',
      });

      const client = new Client({ name: 'CoS Blender Canary Client', version: '1.0.0' });

      try {
        await client.connect(transport);

        // List tools and assert core tools are present
        const toolsResult = await client.listTools();
        const toolNames = toolsResult.tools.map((t) => t.name);
        expect(toolNames).toContain('get_scene_info');
        expect(toolNames).toContain('execute_blender_code');

        // 3. Read-only tool invocation: get_scene_info with valid prompt
        const callResult = await client.callTool({
          name: 'get_scene_info',
          arguments: { user_prompt: 'CoS health check' },
        });

        expect(callResult).toBeDefined();
        expect(callResult.isError).toBeFalsy();
        expect(callResult.content).toBeDefined();
        expect(callResult.content.length).toBeGreaterThan(0);
      } finally {
        await client.close().catch(() => undefined);
        if (transport.pid) {
          await terminateProcessTree(transport.pid, true).catch(() => undefined);
        }
      }

      // 4. Process safety: assert running Blender process is still alive and listening
      const postPortStatus = await checkBlenderPort(BLENDER_DEFAULT_PORT);
      expect(postPortStatus.listening).toBe(true);
      if (originalPid) {
        expect(postPortStatus.owningPid).toBe(originalPid);
      }

      // 5. Authoritative live health diagnosis against live running Blender
      const liveReport = await diagnoseBlenderHealth({ port: BLENDER_DEFAULT_PORT });
      expect(liveReport.code).toBe('READY');
      expect(liveReport.status).toBe('ready');
      expect(liveReport.installation).toBeDefined();
      expect(liveReport.installation?.version).toBe('5.2.1');
      expect(liveReport.addon).toBeDefined();
      expect(liveReport.addon?.installed).toBe(true);
      expect(liveReport.addon?.protocolVersion).toBe(5);
      expect(liveReport.server).toBeDefined();
      expect(liveReport.server?.listening).toBe(true);
      expect(liveReport.server?.port).toBe(BLENDER_DEFAULT_PORT);
      if (originalPid) {
        expect(liveReport.server?.owningPid).toBe(originalPid);
      }
    }, 45000);
  });

  describe('14. Authoritative Blender health state preservation & presentation (Defect 7)', () => {
    it('preserves full authoritative health information upon successful connection (TEST A)', async () => {
      initDurableStore(tempDir);
      const manager = new PluginManager();
      await manager.initialize(tempDir);

      const entry = path.join(tempDir, 'blender-mcp-mock.cjs');
      await fs.writeFile(
        entry,
        `const readline = require('node:readline');
const tools = [{
  name: 'get_scene_info',
  inputSchema: {
    type: 'object',
    properties: { user_prompt: { title: 'User Prompt', type: 'string' } },
    required: ['user_prompt'],
  },
}];
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  let result;
  if (m.method === 'initialize') {
    result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'Blender Mock Server', version: '1.9.1' } };
  } else if (m.method === 'tools/list') {
    result = { tools };
  } else if (m.method === 'tools/call') {
    result = { content: [{ type: 'text', text: JSON.stringify({ scene: 'Scene', objects: ['Cube'] }) }] };
  } else {
    result = {};
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
});`,
      );

      const fakeExe = 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe';
      const mockHealth: BlenderHealthReport = {
        code: 'READY',
        status: 'ready',
        message: 'Connected to Blender 5.2.1 on port 9876.',
        diagnostic: 'Blender and the MCP server are running and ready.',
        installation: {
          executablePath: fakeExe,
          version: '5.2.1',
          source: 'installer',
          exists: true,
          compatibility: 'SUPPORTED',
        },
        addon: {
          installed: true,
          canonicalInstalled: true,
          legacyInstalled: false,
          protocolVersion: 5,
          version: '1.6',
          isUpToDate: true,
          needsUpdate: false,
          needsMigration: false,
          path: 'C:\\addons\\blender_mcp.py',
          legacyPaths: [],
        },
        server: {
          port: 9876,
          listening: true,
          owningPid: 29508,
          targetInstancePid: 29508,
          allBlenderPids: [29508],
        },
      };

      const diagSpy = vi.spyOn(blenderModule, 'diagnoseBlenderHealth').mockResolvedValue(mockHealth);

      try {
        await manager.install({
          catalogId: 'blender',
          source: { kind: 'command', command: process.execPath, args: [entry] },
          config: { blenderPath: fakeExe, BLENDER_PORT: '9876' },
        });

        const snapshot = manager.snapshot();
        const plugin = snapshot.plugins.find((p) => p.catalogId === 'blender');
        expect(plugin).toBeDefined();
        expect(plugin?.status).toBe('ready');

        // RED expectation: Authoritative health must NOT be replaced by minimal READY object
        expect(plugin?.blender).toBeDefined();
        expect(plugin?.blender?.code).toBe('READY');
        expect(plugin?.blender?.installation).toBeDefined();
        expect(plugin?.blender?.installation?.version).toBe('5.2.1');
        expect(plugin?.blender?.installation?.executablePath).toBe(fakeExe);
        expect(plugin?.blender?.addon).toBeDefined();
        expect(plugin?.blender?.addon?.installed).toBe(true);
        expect(plugin?.blender?.addon?.protocolVersion).toBe(5);
        expect(plugin?.blender?.server).toBeDefined();
        expect(plugin?.blender?.server?.listening).toBe(true);
        expect(plugin?.blender?.server?.owningPid).toBe(29508);
      } finally {
        diagSpy.mockRestore();
        await manager.close();
      }
    });

    it('enforces that READY report satisfies state invariant and is not a partial placeholder', () => {
      const { isBlenderReadyReport } = blenderModule as { isBlenderReadyReport?: (r: BlenderHealthReport) => boolean };
      expect(typeof isBlenderReadyReport).toBe('function');

      const fullReport: BlenderHealthReport = {
        code: 'READY',
        status: 'ready',
        message: 'Connected to Blender 5.2.1 on port 9876.',
        diagnostic: 'Scene probe verified. Blender and the MCP server are running and ready.',
        installation: {
          executablePath: 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe',
          version: '5.2.1',
          source: 'installer',
          exists: true,
          compatibility: 'SUPPORTED',
        },
        addon: {
          installed: true,
          canonicalInstalled: true,
          legacyInstalled: false,
          protocolVersion: 5,
          version: '1.6',
          isUpToDate: true,
          needsUpdate: false,
          needsMigration: false,
          path: 'C:\\addons\\blender_mcp.py',
          legacyPaths: [],
        },
        server: {
          port: 9876,
          listening: true,
          owningPid: 29508,
          targetInstancePid: 29508,
          allBlenderPids: [29508],
        },
      };

      expect(isBlenderReadyReport!(fullReport)).toBe(true);

      // Incomplete/minimal placeholder reports must fail invariant
      const minimalReport: BlenderHealthReport = {
        code: 'READY',
        status: 'ready',
        message: 'Connected to Blender and MCP server.',
        diagnostic: 'Scene probe verified.',
      };
      expect(isBlenderReadyReport!(minimalReport)).toBe(false);

      // Report missing addon must fail
      expect(isBlenderReadyReport!({ ...fullReport, addon: undefined })).toBe(false);

      // Report missing server must fail
      expect(isBlenderReadyReport!({ ...fullReport, server: undefined })).toBe(false);

      // Report with server not listening must fail
      expect(isBlenderReadyReport!({ ...fullReport, server: { port: 9876, listening: false } })).toBe(false);

      // Report missing installation must fail
      expect(isBlenderReadyReport!({ ...fullReport, installation: undefined })).toBe(false);
    });

    it('preserves complete READY details across Recheck action', async () => {
      initDurableStore(tempDir);
      const manager = new PluginManager();
      await manager.initialize(tempDir);

      const fakeExe = 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe';
      const mockHealth: BlenderHealthReport = {
        code: 'READY',
        status: 'ready',
        message: 'Connected to Blender 5.2.1 on port 9876.',
        diagnostic: 'Blender and the MCP server are running and ready.',
        installation: {
          executablePath: fakeExe,
          version: '5.2.1',
          source: 'installer',
          exists: true,
          compatibility: 'SUPPORTED',
        },
        addon: {
          installed: true,
          canonicalInstalled: true,
          legacyInstalled: false,
          protocolVersion: 5,
          version: '1.6',
          isUpToDate: true,
          needsUpdate: false,
          needsMigration: false,
          path: 'C:\\addons\\blender_mcp.py',
          legacyPaths: [],
        },
        server: {
          port: 9876,
          listening: true,
          owningPid: 29508,
          targetInstancePid: 29508,
          allBlenderPids: [29508],
        },
      };

      const diagSpy = vi.spyOn(blenderModule, 'diagnoseBlenderHealth').mockResolvedValue(mockHealth);

      try {
        const entry = path.join(tempDir, 'blender-recheck-mock.cjs');
        await fs.writeFile(
          entry,
          `const readline = require('node:readline');
const tools = [{ name: 'get_scene_info', inputSchema: { type: 'object', properties: { user_prompt: { type: 'string' } }, required: ['user_prompt'] } }];
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  let result = {};
  if (m.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'M', version: '1' } };
  else if (m.method === 'tools/list') result = { tools };
  else if (m.method === 'tools/call') result = { content: [{ type: 'text', text: '{}' }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
});`,
        );

        await manager.install({
          catalogId: 'blender',
          source: { kind: 'command', command: process.execPath, args: [entry] },
          config: { blenderPath: fakeExe, BLENDER_PORT: '9876' },
        });

        // Trigger Recheck
        const recheckReport = await manager.diagnoseBlender();
        expect(recheckReport.code).toBe('READY');
        expect(recheckReport.installation?.version).toBe('5.2.1');
        expect(recheckReport.addon?.protocolVersion).toBe(5);
        expect(recheckReport.server?.owningPid).toBe(29508);

        // Snapshot still has full details
        const snapshot = manager.snapshot();
        const plugin = snapshot.plugins.find((p) => p.catalogId === 'blender');
        expect(plugin?.blender?.installation?.executablePath).toBe(fakeExe);
        expect(plugin?.blender?.addon?.installed).toBe(true);
        expect(plugin?.blender?.server?.listening).toBe(true);
      } finally {
        diagSpy.mockRestore();
        await manager.close();
      }
    });

    it('preserves complete READY details across Restart MCP action', async () => {
      initDurableStore(tempDir);
      const manager = new PluginManager();
      await manager.initialize(tempDir);

      const fakeExe = 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe';
      const mockHealth: BlenderHealthReport = {
        code: 'READY',
        status: 'ready',
        message: 'Connected to Blender 5.2.1 on port 9876.',
        diagnostic: 'Blender and the MCP server are running and ready.',
        installation: {
          executablePath: fakeExe,
          version: '5.2.1',
          source: 'installer',
          exists: true,
          compatibility: 'SUPPORTED',
        },
        addon: {
          installed: true,
          canonicalInstalled: true,
          legacyInstalled: false,
          protocolVersion: 5,
          version: '1.6',
          isUpToDate: true,
          needsUpdate: false,
          needsMigration: false,
          path: 'C:\\addons\\blender_mcp.py',
          legacyPaths: [],
        },
        server: {
          port: 9876,
          listening: true,
          owningPid: 29508,
          targetInstancePid: 29508,
          allBlenderPids: [29508],
        },
      };

      const diagSpy = vi.spyOn(blenderModule, 'diagnoseBlenderHealth').mockResolvedValue(mockHealth);

      try {
        const entry = path.join(tempDir, 'blender-restart-mock.cjs');
        await fs.writeFile(
          entry,
          `const readline = require('node:readline');
const tools = [{ name: 'get_scene_info', inputSchema: { type: 'object', properties: { user_prompt: { type: 'string' } }, required: ['user_prompt'] } }];
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  let result = {};
  if (m.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'M', version: '1' } };
  else if (m.method === 'tools/list') result = { tools };
  else if (m.method === 'tools/call') result = { content: [{ type: 'text', text: '{}' }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
});`,
        );

        const row = (
          await manager.install({
            catalogId: 'blender',
            source: { kind: 'command', command: process.execPath, args: [entry] },
            config: { blenderPath: fakeExe, BLENDER_PORT: '9876' },
          })
        ).plugins[0]!;

        // Restart plugin
        await manager.restart(row.id);

        const snapshot = manager.snapshot();
        const plugin = snapshot.plugins.find((p) => p.id === row.id);
        expect(plugin?.status).toBe('ready');
        expect(plugin?.blender?.code).toBe('READY');
        expect(plugin?.blender?.installation?.version).toBe('5.2.1');
        expect(plugin?.blender?.addon?.isUpToDate).toBe(true);
        expect(plugin?.blender?.server?.listening).toBe(true);
        expect(plugin?.blender?.server?.owningPid).toBe(29508);
      } finally {
        diagSpy.mockRestore();
        await manager.close();
      }
    });

    it('does not synthesize contradictory READY report if scene probe succeeds but host diagnosis reports inconsistency', async () => {
      initDurableStore(tempDir);
      const manager = new PluginManager();
      await manager.initialize(tempDir);

      const fakeExe = 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe';
      const inconsistentHealth: BlenderHealthReport = {
        code: 'MULTIPLE_INSTANCES_AMBIGUOUS',
        status: 'error',
        message: 'Port 9876 is connected to a different Blender instance.',
        diagnostic: 'A different Blender instance owns the port.',
        installation: {
          executablePath: fakeExe,
          version: '5.2.1',
          source: 'installer',
          exists: true,
          compatibility: 'SUPPORTED',
        },
      };

      const diagSpy = vi.spyOn(blenderModule, 'diagnoseBlenderHealth').mockResolvedValue(inconsistentHealth);

      try {
        const entry = path.join(tempDir, 'blender-inconsistent-mock.cjs');
        await fs.writeFile(
          entry,
          `const readline = require('node:readline');
const tools = [{ name: 'get_scene_info', inputSchema: { type: 'object', properties: { user_prompt: { type: 'string' } }, required: ['user_prompt'] } }];
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  let result = {};
  if (m.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'M', version: '1' } };
  else if (m.method === 'tools/list') result = { tools };
  else if (m.method === 'tools/call') result = { content: [{ type: 'text', text: '{}' }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
});`,
        );

        await manager.install({
          catalogId: 'blender',
          source: { kind: 'command', command: process.execPath, args: [entry] },
          config: { blenderPath: fakeExe, BLENDER_PORT: '9876' },
        });

        const snapshot = manager.snapshot();
        const plugin = snapshot.plugins.find((p) => p.catalogId === 'blender');
        // MCP connection is retained, but health cache does NOT claim READY when host check failed
        expect(plugin?.status).toBe('ready');
        expect(plugin?.blender?.code).toBe('MULTIPLE_INSTANCES_AMBIGUOUS');
        expect(plugin?.blender?.status).toBe('error');
      } finally {
        diagSpy.mockRestore();
        await manager.close();
      }
    });
  });
});

