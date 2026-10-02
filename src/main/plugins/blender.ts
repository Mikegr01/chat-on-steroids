import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  BlenderCompatibility,
  BlenderHealthCode,
  BlenderHealthReport,
  BlenderAddonStatus,
  DiscoveredBlenderInstallation,
  BlenderAddonInstallResult,
  BlenderAddonEnableResult,
} from '../../shared/plugins.js';
export type {
  BlenderCompatibility,
  BlenderHealthCode,
  BlenderHealthReport,
  BlenderAddonStatus,
  DiscoveredBlenderInstallation,
  BlenderAddonInstallResult,
  BlenderAddonEnableResult,
};
import { BUNDLED_BLENDER_MCP_ADDON_SOURCE } from './blender-addon-source.js';
import { pathEntries } from '../env.js';
import { pluginEnvironment } from './installer.js';

const execFileAsync = promisify(execFile);

export const BLENDER_DEFAULT_PORT = 9876;
export const EXPECTED_ADDON_PROTOCOL_VERSION = 5;
export const BLENDER_ADDON_FILENAME = 'blender_mcp.py';

const ADDON_PROTOCOL_REGEX = /ADDON_PROTOCOL_VERSION\s*=\s*(\d+)/;
const BL_INFO_NAME_REGEX = /["']name["']\s*:\s*["'](?:MCP for Blender|Blender MCP)["']/;
const BL_INFO_VERSION_REGEX = /["']version["']\s*:\s*\(\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(\d+))?\s*\)/;

/** Validate and normalize an executable path strictly; rejects injection and non-blender targets. */
export function validateBlenderExecutablePath(inputPath: string): string {
  if (typeof inputPath !== 'string' || !inputPath.trim()) {
    throw new Error('Blender executable path cannot be empty.');
  }
  const clean = path.normalize(inputPath.trim());
  if (!path.isAbsolute(clean)) {
    throw new Error('Blender executable path must be an absolute path.');
  }
  if (/[\r\n\0&|;<>"`$]/.test(clean)) {
    throw new Error('Blender executable path contains invalid or dangerous characters.');
  }
  const base = path.basename(clean).toLowerCase();
  if (base !== 'blender.exe' && base !== 'blender') {
    throw new Error('Selected executable must be blender.exe or blender.');
  }
  return clean;
}

export function parseBlenderVersion(raw: string): {
  tuple: [number, number, number];
  string: string;
  compatibility: BlenderCompatibility;
} {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw);
  if (!match) {
    return { tuple: [0, 0, 0], string: raw, compatibility: 'UNKNOWN' };
  }
  const major = parseInt(match[1]!, 10);
  const minor = parseInt(match[2]!, 10);
  const patch = match[3] ? parseInt(match[3], 10) : 0;
  let compatibility: BlenderCompatibility = 'SUPPORTED';
  if (major < 3) {
    compatibility = 'INCOMPATIBLE';
  } else if (major > 5) {
    compatibility = 'UNKNOWN';
  }
  return {
    tuple: [major, minor, patch],
    string: `${major}.${minor}.${patch}`,
    compatibility,
  };
}

export function isBlenderMcpAddonFile(content: string): boolean {
  return BL_INFO_NAME_REGEX.test(content);
}

export function readAddonProtocolVersion(content: string): number | null {
  const match = ADDON_PROTOCOL_REGEX.exec(content);
  return match ? parseInt(match[1]!, 10) : null;
}

export function readAddonBlInfoVersion(content: string): string | null {
  const match = BL_INFO_VERSION_REGEX.exec(content);
  if (!match) return null;
  return `${match[1]}.${match[2]}${match[3] ? '.' + match[3] : ''}`;
}

export interface BlenderAuthoritativePaths {
  version: [number, number, number];
  versionString: string;
  scriptsPath: string;
  addonsPath: string;
  compatibility: BlenderCompatibility;
}

type ExecFileFn = (file: string, args: string[], options?: unknown) => Promise<{ stdout: string; stderr: string }>;

/** Query Blender version authoritatively from executable invocation (--version or python expression). */
export async function getBlenderExecutableVersion(
  executablePath: string,
  options?: { execFileImpl?: ExecFileFn; timeoutMs?: number },
): Promise<{
  tuple: [number, number, number];
  string: string;
  compatibility: BlenderCompatibility;
}> {
  const validExe = validateBlenderExecutablePath(executablePath);
  const execFn = options?.execFileImpl ?? (execFileAsync as unknown as ExecFileFn);
  const timeout = options?.timeoutMs ?? 5000;

  // 1. First choice: fast `--version` query
  try {
    const { stdout } = await execFn(validExe, ['--version'], { timeout, windowsHide: true });
    const match = /Blender\s+(\d+)\.(\d+)(?:\.(\d+))?/i.exec(stdout);
    if (match) {
      return parseBlenderVersion(match[0]);
    }
  } catch {}

  // 2. Headless python expression
  try {
    const { stdout } = await execFn(
      validExe,
      ['--factory-startup', '-b', '--python-expr', "import bpy; print('__COS_VER__:' + bpy.app.version_string)"],
      { timeout, windowsHide: true },
    );
    const marker = '__COS_VER__:';
    const idx = stdout.indexOf(marker);
    if (idx !== -1) {
      const verStr = stdout.slice(idx + marker.length).split('\n')[0]!.trim();
      return parseBlenderVersion(verStr);
    }
  } catch {}

  // 3. Fallback to path parsing only if execution failed
  const baseParent = path.basename(path.dirname(validExe));
  const hint = parseBlenderVersion(baseParent);
  if (hint.tuple[0] > 0) {
    return hint;
  }

  return { tuple: [0, 0, 0], string: 'unknown', compatibility: 'UNKNOWN' };
}

/** Authoritatively query user scripts and addons directory directly from the Blender executable. */
export async function queryBlenderAuthoritativePaths(
  executablePath: string,
  options?: {
    execFileImpl?: ExecFileFn;
    timeoutMs?: number;
  },
): Promise<BlenderAuthoritativePaths> {
  const validExe = validateBlenderExecutablePath(executablePath);
  const execFn = options?.execFileImpl ?? (execFileAsync as unknown as ExecFileFn);
  const timeout = options?.timeoutMs ?? 15_000;

  const pythonScript = [
    'import bpy, json',
    'try:',
    "    addons = bpy.utils.user_resource('SCRIPTS', path='addons', create=True)",
    'except Exception:',
    "    addons = ''",
    'try:',
    "    scripts = bpy.utils.user_resource('SCRIPTS')",
    'except Exception:',
    "    scripts = ''",
    "print('__COS_BLENDER_DATA__:' + json.dumps({",
    "    'version': list(bpy.app.version),",
    "    'version_string': bpy.app.version_string,",
    "    'scripts': scripts,",
    "    'addons': addons",
    '}))',
  ].join('\n');

  try {
    const { stdout } = await execFn(
      validExe,
      ['--factory-startup', '-b', '--python-expr', pythonScript],
      { timeout, windowsHide: true },
    );

    const marker = '__COS_BLENDER_DATA__:';
    const idx = stdout.indexOf(marker);
    if (idx !== -1) {
      const line = stdout.slice(idx + marker.length).split('\n')[0]!.trim();
      const parsed = JSON.parse(line) as {
        version: number[];
        version_string: string;
        scripts: string;
        addons: string;
      };
      const major = parsed.version[0] ?? 0;
      const minor = parsed.version[1] ?? 0;
      const patch = parsed.version[2] ?? 0;
      const compatibility: BlenderCompatibility =
        major < 3 ? 'INCOMPATIBLE' : major <= 5 ? 'SUPPORTED' : 'UNKNOWN';

      return {
        version: [major, minor, patch],
        versionString: parsed.version_string || `${major}.${minor}.${patch}`,
        scriptsPath: parsed.scripts,
        addonsPath: parsed.addons,
        compatibility,
      };
    }
  } catch {
    // If running headless fails or in fallback environment, compute deterministic Windows user path
  }

  // Fallback: estimate based on executable version authority
  const ver = await getBlenderExecutableVersion(validExe, { execFileImpl: execFn });
  if (ver.tuple[0] === 0) {
    // Unknown version: DO NOT synthesize a fabricated 0.0 path!
    return {
      version: [0, 0, 0],
      versionString: 'unknown',
      scriptsPath: '',
      addonsPath: '',
      compatibility: 'UNKNOWN',
    };
  }

  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const baseDir = path.join(appData, 'Blender Foundation', 'Blender');
  const versionFolder = `${ver.tuple[0]}.${ver.tuple[1]}`;
  const scriptsPath = path.join(baseDir, versionFolder, 'scripts');
  const addonsPath = path.join(scriptsPath, 'addons');

  return {
    version: ver.tuple,
    versionString: ver.string,
    scriptsPath,
    addonsPath,
    compatibility: ver.compatibility,
  };
}

/** Check status of the Blender MCP addon in a specific directory. */
export async function inspectBlenderAddon(
  addonsDir: string,
  options?: { fsImpl?: typeof fs },
): Promise<BlenderAddonStatus> {
  const fsApi = options?.fsImpl ?? fs;
  const legacyPaths: string[] = [];

  try {
    const entries = await fsApi.readdir(addonsDir);
    let canonicalFile: string | null = null;
    let canonicalContent = '';
    let legacyContent = '';

    for (const entry of entries) {
      if (entry.endsWith('.py')) {
        const full = path.join(addonsDir, entry);
        try {
          const content = await fsApi.readFile(full, 'utf8');
          if (isBlenderMcpAddonFile(content)) {
            if (entry.toLowerCase() === BLENDER_ADDON_FILENAME.toLowerCase()) {
              canonicalFile = full;
              canonicalContent = content;
            } else {
              legacyPaths.push(full);
              if (!legacyContent) legacyContent = content;
            }
          }
        } catch {}
      }
    }

    const canonicalInstalled = Boolean(canonicalFile);
    const legacyInstalled = legacyPaths.length > 0;
    const needsMigration = legacyInstalled;

    if (!canonicalFile) {
      const proto = legacyContent ? readAddonProtocolVersion(legacyContent) : null;
      const ver = legacyContent ? readAddonBlInfoVersion(legacyContent) : null;
      return {
        installed: legacyInstalled,
        path: legacyPaths[0] ?? null,
        version: ver,
        protocolVersion: proto,
        isUpToDate: false,
        needsUpdate: true,
        legacyPaths,
        canonicalInstalled,
        legacyInstalled,
        needsMigration,
      };
    }

    const proto = readAddonProtocolVersion(canonicalContent);
    const version = readAddonBlInfoVersion(canonicalContent);
    const isUpToDate = proto === EXPECTED_ADDON_PROTOCOL_VERSION && !needsMigration;
    const needsUpdate = proto === null || proto < EXPECTED_ADDON_PROTOCOL_VERSION || needsMigration;

    return {
      installed: true,
      path: canonicalFile,
      version,
      protocolVersion: proto,
      isUpToDate,
      needsUpdate,
      legacyPaths,
      canonicalInstalled: true,
      legacyInstalled,
      needsMigration,
    };
  } catch {
    return {
      installed: false,
      path: null,
      version: null,
      protocolVersion: null,
      isUpToDate: false,
      needsUpdate: false,
      legacyPaths: [],
      canonicalInstalled: false,
      legacyInstalled: false,
      needsMigration: false,
    };
  }
}

/** Robust Windows Blender installation discovery across known roots, registry, Steam, and PATH. */
export async function discoverBlenderInstallations(options?: {
  customPath?: string;
  fsImpl?: typeof fs;
  env?: Record<string, string>;
  platform?: NodeJS.Platform;
  execFileImpl?: ExecFileFn;
}): Promise<DiscoveredBlenderInstallation[]> {
  const fsApi = options?.fsImpl ?? fs;
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const execFn = options?.execFileImpl ?? (execFileAsync as unknown as ExecFileFn);
  const results: DiscoveredBlenderInstallation[] = [];
  const seenPaths = new Set<string>();

  const registerCandidate = async (
    candidatePath: string,
    source: DiscoveredBlenderInstallation['source'],
  ): Promise<void> => {
    try {
      const valid = validateBlenderExecutablePath(candidatePath);
      const normalized = path.normalize(valid);
      const key = normalized.toLowerCase();
      if (seenPaths.has(key)) return;

      const stat = await fsApi.stat(normalized);
      if (!stat.isFile()) return;

      seenPaths.add(key);
      const ver = await getBlenderExecutableVersion(normalized, { execFileImpl: execFn });
      results.push({
        executablePath: normalized,
        version: ver.string,
        source,
        exists: true,
        compatibility: ver.compatibility,
      });
    } catch {}
  };

  // 1. Explicit user custom path
  if (options?.customPath) {
    await registerCandidate(options.customPath, 'user');
  }

  // 2. Well-known Windows paths
  if (platform === 'win32') {
    const searchRoots = [
      'C:\\Program Files\\Blender Foundation',
      'C:\\Program Files (x86)\\Blender Foundation',
      path.join(env.LOCALAPPDATA || 'C:\\Users\\Default\\AppData\\Local', 'Programs', 'Blender Foundation'),
    ];

    for (const root of searchRoots) {
      try {
        const entries = await fsApi.readdir(root);
        for (const entry of entries) {
          const exe = path.join(root, entry, 'blender.exe');
          await registerCandidate(exe, 'installer');
        }
      } catch {}
    }

    // Steam default installations
    const steamCandidates = [
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Blender\\blender.exe',
      'C:\\Program Files\\Steam\\steamapps\\common\\Blender\\blender.exe',
      'D:\\Steam\\steamapps\\common\\Blender\\blender.exe',
    ];
    for (const steamExe of steamCandidates) {
      await registerCandidate(steamExe, 'steam');
    }

    // Registry inspection via reg.exe if available
    const execFn = options?.execFileImpl ?? (execFileAsync as unknown as ExecFileFn);
    try {
      const regQueries = [
        ['query', 'HKLM\\SOFTWARE\\Microsoft\Windows\\CurrentVersion\\App Paths\\blender.exe', '/ve'],
        ['query', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\blender.exe', '/ve'],
      ];
      for (const args of regQueries) {
        try {
          const { stdout } = await execFn('reg.exe', args, { timeout: 3000, windowsHide: true });
          const match = /REG_SZ\s+(.+blender\.exe)/i.exec(stdout);
          if (match && match[1]) {
            await registerCandidate(match[1].trim(), 'registry');
          }
        } catch {}
      }
    } catch {}
  }

  // 3. PATH search
  for (const dir of pathEntries(pluginEnvironment(env as Record<string, string>, platform))) {
    const candidate = path.join(dir, platform === 'win32' ? 'blender.exe' : 'blender');
    await registerCandidate(candidate, 'path');
  }

  // Sort: supported first, then newest version descending
  return results.sort((a, b) => {
    const score = (item: DiscoveredBlenderInstallation): number =>
      item.compatibility === 'SUPPORTED' ? 2 : item.compatibility === 'UNKNOWN' ? 1 : 0;
    const diff = score(b) - score(a);
    if (diff !== 0) return diff;
    const [ma, na, pa] = parseBlenderVersion(a.version).tuple;
    const [mb, nb, pb] = parseBlenderVersion(b.version).tuple;
    return mb - ma || nb - na || pb - pa;
  });
}

/** Install or safely repair the Blender MCP addon into the authoritative addons directory. */
export async function installBlenderAddon(
  executablePath?: string,
  options?: {
    addonsPath?: string;
    addonSource?: string;
    fsImpl?: typeof fs;
    execFileImpl?: ExecFileFn;
  },
): Promise<BlenderAddonInstallResult> {
  const fsApi = options?.fsImpl ?? fs;
  let targetAddonsDir = options?.addonsPath;

  if (!targetAddonsDir) {
    if (executablePath) {
      const paths = await queryBlenderAuthoritativePaths(executablePath, {
        execFileImpl: options?.execFileImpl,
      });
      targetAddonsDir = paths.addonsPath;
    } else {
      const discovered = await discoverBlenderInstallations({ fsImpl: fsApi, execFileImpl: options?.execFileImpl });
      if (discovered[0]) {
        const paths = await queryBlenderAuthoritativePaths(discovered[0].executablePath, {
          execFileImpl: options?.execFileImpl,
        });
        targetAddonsDir = paths.addonsPath;
      }
    }
  }

  if (!targetAddonsDir || /[\/\\]0\.0[\/\\]?$/.test(targetAddonsDir)) {
    return {
      success: false,
      message: 'Could not determine Blender addons directory. Please ensure Blender is installed or specify its executable path.',
      error: 'NO_ADDONS_DIR',
    };
  }

  try {
    await fsApi.mkdir(targetAddonsDir, { recursive: true });
  } catch (err) {
    return {
      success: false,
      message: `Failed to create Blender addons folder: ${(err as Error).message}`,
      addonsDir: targetAddonsDir,
      error: 'MKDIR_FAILED',
    };
  }

  const sourceContent = options?.addonSource ?? BUNDLED_BLENDER_MCP_ADDON_SOURCE;
  if (!isBlenderMcpAddonFile(sourceContent) || readAddonProtocolVersion(sourceContent) === null) {
    return {
      success: false,
      message: 'Add-on source validation failed: invalid bl_info or missing protocol version.',
      addonsDir: targetAddonsDir,
      error: 'INVALID_SOURCE',
    };
  }

  const targetFile = path.join(targetAddonsDir, BLENDER_ADDON_FILENAME);
  const preStatus = await inspectBlenderAddon(targetAddonsDir, { fsImpl: fsApi });
  let backupPath: string | undefined;

  // If already up to date and no legacy migration needed, no-op
  if (preStatus.canonicalInstalled && preStatus.isUpToDate && !preStatus.needsMigration) {
    return {
      success: true,
      message: `MCP for Blender add-on in ${targetAddonsDir} is already up to date.`,
      targetPath: targetFile,
      addonsDir: targetAddonsDir,
    };
  }

  // Backup existing modified canonical file
  if (preStatus.canonicalInstalled && preStatus.path) {
    try {
      const existing = await fsApi.readFile(targetFile, 'utf8');
      if (existing !== sourceContent) {
        backupPath = `${targetFile}.bak`;
        await fsApi.writeFile(backupPath, existing, 'utf8');
      }
    } catch {}
  }

  // Atomic write via staging file
  const stagingFile = path.join(targetAddonsDir, `${BLENDER_ADDON_FILENAME}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`);
  try {
    await fsApi.writeFile(stagingFile, sourceContent, 'utf8');
    await fsApi.rename(stagingFile, targetFile);
  } catch (err) {
    try {
      await fsApi.unlink(stagingFile);
    } catch {}
    return {
      success: false,
      message: `Failed to write add-on file: ${(err as Error).message}`,
      targetPath: targetFile,
      addonsDir: targetAddonsDir,
      error: 'WRITE_FAILED',
    };
  }

  // Migrate legacy add-ons: only touch files positively identified as MCP for Blender
  let migratedCount = 0;
  const legacyCandidates = new Set<string>(preStatus.legacyPaths);
  legacyCandidates.add(path.join(targetAddonsDir, 'addon.py'));

  for (const legacyFile of legacyCandidates) {
    try {
      const legacyContent = await fsApi.readFile(legacyFile, 'utf8');
      if (isBlenderMcpAddonFile(legacyContent)) {
        const legacyBak = `${legacyFile}.legacy.bak`;
        await fsApi.writeFile(legacyBak, legacyContent, 'utf8');
        await fsApi.unlink(legacyFile);
        migratedCount++;
      }
    } catch {}
  }

  const message = migratedCount > 0
    ? `Installed MCP for Blender add-on to ${targetFile} and migrated legacy module.`
    : `Installed MCP for Blender add-on to ${targetFile}.`;

  return {
    success: true,
    message,
    targetPath: targetFile,
    addonsDir: targetAddonsDir,
    backupPath,
  };
}

/** Check if the Blender MCP addon is enabled in user preferences. Returns null if undetermined. */
export async function checkBlenderAddonEnabled(
  executablePath: string,
  options?: { execFileImpl?: ExecFileFn; timeoutMs?: number },
): Promise<boolean | null> {
  const validExe = validateBlenderExecutablePath(executablePath);
  const execFn = options?.execFileImpl ?? (execFileAsync as unknown as ExecFileFn);
  const timeout = options?.timeoutMs ?? 15_000;

  try {
    const { stdout } = await execFn(
      validExe,
      ['-b', '--python-expr', "import addon_utils, json; print('__COS_ADDON_CHECK__:' + json.dumps(addon_utils.check('blender_mcp')))" ],
      { timeout, windowsHide: true },
    );
    const marker = '__COS_ADDON_CHECK__:';
    const idx = stdout.indexOf(marker);
    if (idx !== -1) {
      const line = stdout.slice(idx + marker.length).split('\n')[0]!.trim();
      const parsed = JSON.parse(line) as [boolean, boolean];
      return Boolean(parsed[1]);
    }
  } catch {}
  return null;
}

/** Safely enable the Blender MCP addon in user preferences non-interactively. */
export async function enableBlenderAddon(
  executablePath: string,
  options?: { execFileImpl?: ExecFileFn; timeoutMs?: number },
): Promise<BlenderAddonEnableResult> {
  const validExe = validateBlenderExecutablePath(executablePath);
  const execFn = options?.execFileImpl ?? (execFileAsync as unknown as ExecFileFn);
  const timeout = options?.timeoutMs ?? 15_000;

  try {
    const pyScript = [
      'import addon_utils, bpy',
      "res = addon_utils.enable('blender_mcp', default_set=True)",
      'try:',
      '    bpy.ops.wm.save_userpref()',
      'except Exception:',
      '    pass',
      "print('__COS_ENABLE_RESULT__:' + str(bool(res)))",
    ].join('\n');

    await execFn(
      validExe,
      ['-b', '--python-expr', pyScript],
      { timeout, windowsHide: true },
    );

    const isEnabled = await checkBlenderAddonEnabled(validExe, options);
    if (isEnabled === true) {
      return {
        success: true,
        message: 'Blender MCP add-on enabled in Blender preferences.',
        enabled: true,
      };
    }
  } catch {}

  return {
    success: false,
    message: "Could not automatically enable add-on. In Blender: Preferences → Add-ons → enable 'Interface: MCP for Blender'.",
    enabled: false,
  };
}

/** Enumerate running Blender processes on the system. */
export async function getRunningBlenderProcesses(options?: {
  execFileImpl?: ExecFileFn;
  platform?: NodeJS.Platform;
}): Promise<number[]> {
  const platform = options?.platform ?? process.platform;
  const execFn = options?.execFileImpl ?? (execFileAsync as unknown as ExecFileFn);
  const pids: number[] = [];

  if (platform === 'win32') {
    try {
      const { stdout } = await execFn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', '(Get-Process blender -ErrorAction SilentlyContinue).Id'],
        { timeout: 4000, windowsHide: true },
      );
      for (const line of stdout.split('\n')) {
        const id = parseInt(line.trim(), 10);
        if (!isNaN(id) && id > 0) pids.push(id);
      }
      return pids;
    } catch {}

    try {
      const { stdout } = await execFn(
        'tasklist.exe',
        ['/FI', 'IMAGENAME eq blender.exe', '/FO', 'CSV', '/NH'],
        { timeout: 4000, windowsHide: true },
      );
      for (const line of stdout.split('\n')) {
        const parts = line.split(',');
        if (parts.length >= 2) {
          const id = parseInt(parts[1]!.replace(/"/g, '').trim(), 10);
          if (!isNaN(id) && id > 0 && !pids.includes(id)) pids.push(id);
        }
      }
    } catch {}
  } else {
    try {
      const { stdout } = await execFn('pgrep', ['-x', 'blender'], { timeout: 3000 });
      for (const line of stdout.split('\n')) {
        const id = parseInt(line.trim(), 10);
        if (!isNaN(id) && id > 0) pids.push(id);
      }
    } catch {}
  }

  return pids;
}

/** Check local port availability and determine if it responds as Blender MCP. */
export async function checkBlenderPort(
  port = BLENDER_DEFAULT_PORT,
  options?: {
    timeoutMs?: number;
    execFileImpl?: ExecFileFn;
    platform?: NodeJS.Platform;
  },
): Promise<{
  listening: boolean;
  owningPid?: number;
  isBlenderProcess: boolean;
  respondsToProbe: boolean;
}> {
  const timeout = options?.timeoutMs ?? 1500;
  const platform = options?.platform ?? process.platform;
  const execFn = options?.execFileImpl ?? (execFileAsync as unknown as ExecFileFn);

  let listening = false;
  let respondsToProbe = false;

  await new Promise<void>((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = () => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve();
      }
    };

    socket.setTimeout(timeout);
    socket.once('connect', () => {
      listening = true;
      try {
        socket.write(JSON.stringify({ type: 'get_scene_info', params: {} }));
      } catch {
        finish();
      }
    });

    socket.on('data', (chunk) => {
      try {
        const text = chunk.toString('utf8');
        const parsed = JSON.parse(text) as { status?: string; result?: unknown };
        if (parsed.status === 'success' || (parsed.result && typeof parsed.result === 'object')) {
          respondsToProbe = true;
        }
      } catch {}
      finish();
    });

    socket.once('timeout', finish);
    socket.once('error', finish);

    socket.connect(port, '127.0.0.1');
  });

  if (!listening) {
    return { listening: false, isBlenderProcess: false, respondsToProbe: false };
  }

  let owningPid: number | undefined;
  if (platform === 'win32') {
    try {
      const { stdout } = await execFn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess`,
        ],
        { timeout: 3000, windowsHide: true },
      );
      const pidNum = parseInt(stdout.trim().split('\n')[0]!, 10);
      if (!isNaN(pidNum) && pidNum > 0) owningPid = pidNum;
    } catch {}
  }

  const runningBlenders = await getRunningBlenderProcesses({ execFileImpl: execFn, platform });
  const isBlenderProcess = owningPid !== undefined ? runningBlenders.includes(owningPid) : respondsToProbe;

  return {
    listening,
    owningPid,
    isBlenderProcess,
    respondsToProbe,
  };
}

/** Query the executable path of a running process by PID. */
export async function getProcessExecutablePath(
  pid: number,
  options?: { execFileImpl?: ExecFileFn; platform?: NodeJS.Platform },
): Promise<string | null> {
  const platform = options?.platform ?? process.platform;
  const execFn = options?.execFileImpl ?? (execFileAsync as unknown as ExecFileFn);

  if (platform === 'win32') {
    try {
      const { stdout } = await execFn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Path`,
        ],
        { timeout: 3000, windowsHide: true },
      );
      const line = stdout.trim().split('\n')[0]!.trim();
      if (line && path.isAbsolute(line)) {
        return path.normalize(line);
      }
    } catch {}
  } else {
    try {
      const { stdout } = await execFn('readlink', [`/proc/${pid}/exe`], { timeout: 2000 });
      const line = stdout.trim();
      if (line && path.isAbsolute(line)) return line;
    } catch {}
  }
  return null;
}

/** Authorize an executable path against discovered installations or persisted settings. */
export async function authorizeBlenderExecutable(
  candidatePath: string | undefined,
  options?: {
    persistedPath?: string;
    discoveredList?: DiscoveredBlenderInstallation[];
    fsImpl?: typeof fs;
    execFileImpl?: ExecFileFn;
  },
): Promise<string> {
  const fsApi = options?.fsImpl ?? fs;

  if (!candidatePath) {
    const list = options?.discoveredList ?? (await discoverBlenderInstallations({ fsImpl: fsApi, execFileImpl: options?.execFileImpl }));
    if (!list[0]) {
      throw new Error('No Blender installation found to execute.');
    }
    return list[0].executablePath;
  }

  const valid = validateBlenderExecutablePath(candidatePath);
  const norm = path.normalize(valid).toLowerCase();

  // 1. Check against discovered list
  const list = options?.discoveredList ?? (await discoverBlenderInstallations({ fsImpl: fsApi, execFileImpl: options?.execFileImpl }));
  const matched = list.find(d => path.normalize(d.executablePath).toLowerCase() === norm);
  if (matched) {
    return matched.executablePath;
  }

  // 2. Check against persisted config path
  if (options?.persistedPath) {
    const persistedNorm = path.normalize(options.persistedPath).toLowerCase();
    if (persistedNorm === norm) {
      const stat = await fsApi.stat(valid);
      if (stat.isFile()) {
        return valid;
      }
    }
  }

  throw new Error(`Unauthorized Blender executable path: ${valid}. Target must be discovered by Chat On Steroids or saved in configuration.`);
}

/** Diagnose the full Blender MCP health chain and produce clear actionable guidance. */
export async function diagnoseBlenderHealth(options?: {
  executablePath?: string;
  port?: number;
  fsImpl?: typeof fs;
  execFileImpl?: ExecFileFn;
}): Promise<BlenderHealthReport> {
  const port = options?.port ?? BLENDER_DEFAULT_PORT;
  const fsApi = options?.fsImpl ?? fs;
  const execFn = options?.execFileImpl;

  // 1. Discover or validate Blender executable
  let selectedInstallation: DiscoveredBlenderInstallation | undefined;
  if (options?.executablePath) {
    try {
      const valid = validateBlenderExecutablePath(options.executablePath);
      const stat = await fsApi.stat(valid);
      if (stat.isFile()) {
        const ver = await getBlenderExecutableVersion(valid, { execFileImpl: execFn });
        selectedInstallation = {
          executablePath: valid,
          version: ver.string,
          source: 'user',
          exists: true,
          compatibility: ver.compatibility,
        };
      } else {
        return {
          code: 'BLENDER_NOT_FOUND',
          status: 'error',
          message: `Specified Blender executable is not a file: ${valid}`,
          diagnostic: 'The configured executable path does not point to a valid file.',
          actionRequired: 'Verify your Blender executable path in plugin settings.',
        };
      }
    } catch {
      return {
        code: 'BLENDER_NOT_FOUND',
        status: 'error',
        message: `Specified Blender executable not found: ${options.executablePath}`,
        diagnostic: 'The configured executable path does not exist on disk.',
        actionRequired: 'Verify your Blender executable path in plugin settings or use automatic discovery.',
      };
    }
  }

  if (!selectedInstallation) {
    const discovered = await discoverBlenderInstallations({ fsImpl: fsApi, execFileImpl: execFn });
    selectedInstallation = discovered[0];
  }

  if (!selectedInstallation) {
    return {
      code: 'BLENDER_NOT_FOUND',
      status: 'error',
      message: 'Blender is not installed or could not be found.',
      diagnostic: 'No Blender executable found in Program Files, Registry, Steam, or PATH.',
      actionRequired: 'Install Blender 3.0+ from https://www.blender.org/download/ or configure your Blender executable path in plugin settings.',
    };
  }

  if (selectedInstallation.compatibility === 'INCOMPATIBLE') {
    return {
      code: 'BLENDER_INCOMPATIBLE',
      status: 'error',
      installation: selectedInstallation,
      message: `Blender ${selectedInstallation.version} is not compatible with Blender MCP.`,
      diagnostic: 'Blender MCP requires Blender 3.0 or higher.',
      actionRequired: 'Please install or switch to Blender 3.0+ (Blender 4.x or 5.x LTS recommended).',
    };
  }

  // 2. Query authoritative paths and check add-on status
  let addonsPath = '';
  try {
    const auth = await queryBlenderAuthoritativePaths(selectedInstallation.executablePath, { execFileImpl: execFn });
    addonsPath = auth.addonsPath;
  } catch {}

  if (!addonsPath) {
    return {
      code: 'BLENDER_INCOMPATIBLE',
      status: 'error',
      installation: selectedInstallation,
      message: `Could not authoritatively determine user scripts directory for Blender ${selectedInstallation.version}.`,
      diagnostic: 'Unable to query user resources from Blender executable.',
      actionRequired: 'Ensure the Blender executable is operational and not blocked by permissions or security policies.',
    };
  }

  const addonStatus = await inspectBlenderAddon(addonsPath, { fsImpl: fsApi });

  if (addonStatus.needsMigration) {
    return {
      code: addonStatus.canonicalInstalled ? 'ADDON_VERSION_MISMATCH' : 'ADDON_NOT_INSTALLED',
      status: 'error',
      installation: selectedInstallation,
      addon: addonStatus,
      message: addonStatus.canonicalInstalled
        ? 'Duplicate legacy add-on detected (addon.py).'
        : 'Legacy Blender MCP add-on detected (addon.py). Migration to blender_mcp.py is required.',
      diagnostic: `Legacy module at ${addonStatus.path} must be migrated to canonical blender_mcp.py to prevent duplicate registration.`,
      actionRequired: addonStatus.canonicalInstalled
        ? 'Click "Repair Add-on" to remove duplicate legacy add-on.'
        : 'Click "Install Add-on" to migrate to canonical blender_mcp.py.',
    };
  }

  if (!addonStatus.installed) {
    return {
      code: 'ADDON_NOT_INSTALLED',
      status: 'error',
      installation: selectedInstallation,
      addon: addonStatus,
      message: 'The Blender MCP add-on is not installed.',
      diagnostic: `Add-on file blender_mcp.py is missing from ${addonsPath}.`,
      actionRequired: 'Click "Install Add-on" to install the managed add-on, then enable it in Blender.',
    };
  }

  if (addonStatus.needsUpdate) {
    return {
      code: 'ADDON_VERSION_MISMATCH',
      status: 'error',
      installation: selectedInstallation,
      addon: addonStatus,
      message: `The installed Blender MCP add-on is outdated (protocol ${addonStatus.protocolVersion ?? 'unknown'}, expected ${EXPECTED_ADDON_PROTOCOL_VERSION}).`,
      diagnostic: `Add-on at ${addonStatus.path} needs update to match the server package.`,
      actionRequired: 'Click "Repair Add-on" to update to protocol version 5, then recheck.',
    };
  }

  // 3. Inspect running Blender processes and port
  const runningPids = await getRunningBlenderProcesses({ execFileImpl: execFn });
  const portStatus = await checkBlenderPort(port, { execFileImpl: execFn });

  if (portStatus.listening && !portStatus.isBlenderProcess) {
    return {
      code: 'PORT_COLLISION',
      status: 'error',
      installation: selectedInstallation,
      addon: addonStatus,
      server: {
        port,
        listening: true,
        owningPid: portStatus.owningPid,
        allBlenderPids: runningPids,
      },
      message: `Port ${port} is occupied by another application (PID ${portStatus.owningPid ?? 'unknown'}).`,
      diagnostic: 'Another process is listening on the default Blender MCP port.',
      actionRequired: 'Close the conflicting application or configure a different port in Blender and plugin settings.',
    };
  }

  if (portStatus.listening && portStatus.isBlenderProcess) {
    if (portStatus.owningPid) {
      const owningExe = await getProcessExecutablePath(portStatus.owningPid, {
        execFileImpl: execFn,
      });
      if (owningExe) {
        const owningNorm = path.normalize(owningExe).toLowerCase();
        const selectedNorm = path.normalize(selectedInstallation.executablePath).toLowerCase();
        if (owningNorm !== selectedNorm) {
          const activeVer = await getBlenderExecutableVersion(owningExe, { execFileImpl: execFn });
          return {
            code: 'MULTIPLE_INSTANCES_AMBIGUOUS',
            status: 'error',
            installation: selectedInstallation,
            addon: addonStatus,
            server: {
              port,
              listening: true,
              owningPid: portStatus.owningPid,
              targetInstancePid: portStatus.owningPid,
              allBlenderPids: runningPids,
            },
            message: `Port ${port} is connected to a different Blender instance (${activeVer.string} at ${owningExe}), not the selected Blender (${selectedInstallation.version} at ${selectedInstallation.executablePath}).`,
            diagnostic: 'A different Blender installation or instance is currently running the MCP server.',
            actionRequired: 'Connect to MCP server from the selected Blender window, or switch the configured Blender path to match the running instance.',
          };
        }
      }
    }

    return {
      code: 'READY',
      status: 'ready',
      installation: selectedInstallation,
      addon: addonStatus,
      server: {
        port,
        listening: true,
        owningPid: portStatus.owningPid,
        targetInstancePid: portStatus.owningPid ?? runningPids[0],
        allBlenderPids: runningPids,
      },
      message: `Connected to Blender ${selectedInstallation.version} on port ${port}.`,
      diagnostic: 'Blender and the MCP server are running and ready.',
    };
  }

  // If server is not listening, check whether add-on is enabled in Blender preferences
  const isEnabled = await checkBlenderAddonEnabled(selectedInstallation.executablePath, { execFileImpl: execFn });
  if (isEnabled === false) {
    return {
      code: 'ADDON_DISABLED',
      status: 'error',
      installation: selectedInstallation,
      addon: addonStatus,
      server: { port, listening: false, allBlenderPids: runningPids },
      message: 'The Blender MCP add-on is installed but disabled in Blender preferences.',
      diagnostic: 'The add-on is not active in Blender user preferences.',
      actionRequired: 'Click "Enable Add-on" or in Blender: Preferences → Add-ons → enable "Interface: MCP for Blender".',
    };
  }

  if (runningPids.length === 0) {
    return {
      code: 'BLENDER_NOT_RUNNING',
      status: 'error',
      installation: selectedInstallation,
      addon: addonStatus,
      server: { port, listening: false, allBlenderPids: [] },
      message: 'Blender is not running.',
      diagnostic: 'No running blender.exe process was found.',
      actionRequired: 'Open Blender, navigate to 3D Viewport sidebar (press N) → "MCP for Blender", and click "Connect to MCP server".',
    };
  }

  if (runningPids.length > 1) {
    return {
      code: 'MULTIPLE_INSTANCES_AMBIGUOUS',
      status: 'error',
      installation: selectedInstallation,
      addon: addonStatus,
      server: { port, listening: false, allBlenderPids: runningPids },
      message: `${runningPids.length} Blender windows are open, but none has started the MCP server.`,
      diagnostic: 'Multiple live Blender processes detected; cannot determine target project.',
      actionRequired: 'In the Blender window you want to control, open the 3D Viewport sidebar (press N) → "MCP for Blender", click "Connect to MCP server", and click Recheck.',
    };
  }

  return {
    code: 'BLENDER_SERVER_NOT_RUNNING',
    status: 'error',
    installation: selectedInstallation,
    addon: addonStatus,
    server: { port, listening: false, allBlenderPids: runningPids },
    message: `Blender is running, but the Blender MCP server is not started on port ${port}.`,
    diagnostic: 'Blender is running without an active MCP socket server.',
    actionRequired: `In Blender: press N in the 3D Viewport, open the "MCP for Blender" panel, and click "Connect to MCP server". Then click Recheck.`,
  };
}

/**
 * State invariant: BlenderHealthReport.code === 'READY' MUST imply enough evidence
 * for the renderer to present truthfully:
 * - code is READY and status is ready
 * - installation exists with executablePath and version
 * - addon exists, is installed, and does not need update
 * - server exists and is listening
 */
export function isBlenderReadyReport(report: BlenderHealthReport): boolean {
  if (report.code !== 'READY' || report.status !== 'ready') return false;
  if (!report.installation || !report.installation.executablePath || !report.installation.version) {
    return false;
  }
  if (!report.addon || !report.addon.installed || report.addon.needsUpdate) {
    return false;
  }
  if (!report.server || !report.server.listening) {
    return false;
  }
  return true;
}

/** Open Blender detached so CoS never owns or terminates the user application process. */
export async function openBlender(
  executablePath: string,
  options?: { spawnImpl?: typeof spawn; fsImpl?: typeof fs },
): Promise<{ success: boolean; pid?: number; error?: string }> {
  try {
    const valid = validateBlenderExecutablePath(executablePath);
    const fsApi = options?.fsImpl ?? fs;
    try {
      const stat = await fsApi.stat(valid);
      if (!stat.isFile()) {
        return { success: false, error: `Path is not a regular file: ${valid}` };
      }
    } catch (statErr) {
      return { success: false, error: `Executable not found: ${(statErr as Error).message}` };
    }

    const spawnFn = options?.spawnImpl ?? spawn;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: { success: boolean; pid?: number; error?: string }) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      try {
        const child = spawnFn(valid, [], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });

        if ('on' in child && typeof child.on === 'function') {
          child.on('error', (err: Error) => {
            finish({ success: false, error: err.message });
          });

          child.on('spawn', () => {
            if ('unref' in child && typeof child.unref === 'function') child.unref();
            finish({ success: true, pid: child.pid });
          });
        } else {
          if ('unref' in child && typeof child.unref === 'function') child.unref();
          finish({ success: true, pid: child.pid });
        }

        setTimeout(() => {
          if (!settled) {
            if ('unref' in child && typeof child.unref === 'function') child.unref();
            finish({ success: true, pid: child.pid });
          }
        }, 250);
      } catch (err) {
        finish({ success: false, error: (err as Error).message });
      }
    });
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
