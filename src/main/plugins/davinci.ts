import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const DAVINCI_PUBLIC_TOOLS = [
  'resolve_health',
  'resolve_inspect',
  'resolve_prepare_ai_timeline',
  'resolve_import_media',
  'resolve_assemble_rough_cut',
  'resolve_set_marker',
  'resolve_set_basic_clip_properties',
  'resolve_render_review',
  'resolve_render_status',
  'resolve_capture_frame',
] as const;

export type DavinciHealthCode =
  | 'READY'
  | 'RESOLVE_NOT_RUNNING'
  | 'SCRIPTING_API_MISSING'
  | 'PYTHON_INCOMPATIBLE'
  | 'CONNECTION_FAILED'
  | 'VERSION_OR_CAPABILITY_UNSUPPORTED';

export interface DavinciProbeResult {
  executable: string;
  safe: boolean;
  imported: boolean;
  connected: boolean;
  sdkPresent?: boolean;
  product?: string;
  version?: string;
  python?: string;
  error?: string;
}

export interface DavinciProbeRunResult { code: number | null; stdout: string; stderr: string }
export type DavinciProbeRunner = (
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<DavinciProbeRunResult>;

export interface DavinciInstallPlan {
  venvDirectory: string;
  venvPython: string;
  createVenv: { command: string; args: string[] };
  adapterPath: string;
}

export function davinciRuntimeEnvironment(
  host: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): Record<string, string> {
  const wanted = [
    'RESOLVE_SCRIPT_API',
    'RESOLVE_SCRIPT_LIB',
    'FUSION_PYTHON3_HOME',
    ...(platform === 'win32' ? ['PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)'] : []),
  ];
  const entries = Object.entries(host);
  const result: Record<string, string> = {};
  const valueFor = (key: string) => entries.find(([candidate, value]) =>
    candidate.toUpperCase() === key && typeof value === 'string' && value.length > 0)?.[1];
  for (const key of wanted) {
    const value = valueFor(key);
    if (value) result[key] = value;
  }
  if (platform === 'win32') {
    if (!result.PROGRAMDATA) {
      const systemDrive = valueFor('SYSTEMDRIVE');
      if (systemDrive && /^[A-Za-z]:\\?$/.test(systemDrive)) {
        result.PROGRAMDATA = path.win32.join(systemDrive, 'ProgramData');
      }
    }
    if (!result.RESOLVE_SCRIPT_API && result.PROGRAMDATA) {
      result.RESOLVE_SCRIPT_API = path.win32.join(
        result.PROGRAMDATA,
        'Blackmagic Design',
        'DaVinci Resolve',
        'Support',
        'Developer',
        'Scripting',
      );
    }
    if (!result.RESOLVE_SCRIPT_LIB && result.PROGRAMFILES) {
      result.RESOLVE_SCRIPT_LIB = path.win32.join(
        result.PROGRAMFILES,
        'Blackmagic Design',
        'DaVinci Resolve',
        'fusionscript.dll',
      );
    }
  }
  return result;
}

export function createDavinciInstallPlan(
  directory: string,
  selectedPython: string,
  platform = process.platform,
): DavinciInstallPlan {
  if (!path.isAbsolute(directory) || !path.isAbsolute(selectedPython)) throw new Error('DaVinci installation paths must be absolute');
  const venvDirectory = path.join(directory, 'venv');
  const scripts = path.join(venvDirectory, platform === 'win32' ? 'Scripts' : 'bin');
  return {
    venvDirectory,
    venvPython: path.join(scripts, platform === 'win32' ? 'python.exe' : 'python'),
    createVenv: { command: selectedPython, args: ['-m', 'venv', venvDirectory] },
    adapterPath: path.join(directory, 'cos-davinci-adapter.py'),
  };
}

const PROBE_SCRIPT = String.raw`
import json, os, pathlib, sys

def sdk_candidates():
    out = []
    explicit = os.environ.get("RESOLVE_SCRIPT_API")
    if explicit:
        out.append(pathlib.Path(explicit))
    if sys.platform.startswith("win"):
        pd = os.environ.get("PROGRAMDATA")
        if pd:
            out.append(pathlib.Path(pd) / "Blackmagic Design" / "DaVinci Resolve" / "Support" / "Developer" / "Scripting")
    elif sys.platform == "darwin":
        out.append(pathlib.Path("/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting"))
    else:
        out.append(pathlib.Path("/opt/resolve/Developer/Scripting"))
    return out

sdk = next((p for p in sdk_candidates() if (p / "Modules" / "DaVinciResolveScript.py").is_file()), None)
if sdk is not None:
    modules = str(sdk / "Modules")
    if modules not in sys.path:
        sys.path.insert(0, modules)
    os.environ.setdefault("RESOLVE_SCRIPT_API", str(sdk))
    if sys.platform.startswith("win") and not os.environ.get("RESOLVE_SCRIPT_LIB"):
        pf = os.environ.get("PROGRAMFILES")
        if pf:
            candidate = pathlib.Path(pf) / "Blackmagic Design" / "DaVinci Resolve" / "fusionscript.dll"
            if candidate.is_file():
                os.environ["RESOLVE_SCRIPT_LIB"] = str(candidate)

try:
    import DaVinciResolveScript as dvr_script
except BaseException as exc:
    print(json.dumps({"imported": False, "connected": False, "sdkPresent": sdk is not None, "python": sys.version.split()[0], "error": f"{type(exc).__name__}: {exc}"}))
    raise SystemExit(4)

try:
    resolve = dvr_script.scriptapp("Resolve")
except BaseException as exc:
    print(json.dumps({"imported": True, "connected": False, "sdkPresent": True, "python": sys.version.split()[0], "error": f"{type(exc).__name__}: {exc}"}))
    raise SystemExit(5)

if resolve is None:
    print(json.dumps({"imported": True, "connected": False, "sdkPresent": True, "python": sys.version.split()[0], "error": "Resolve is not running or external scripting is unavailable"}))
    raise SystemExit(3)

product = ""
for name in ("GetProductName", "GetProduct"):
    method = getattr(resolve, name, None)
    if callable(method):
        try:
            product = str(method() or "")
        except BaseException:
            pass
        if product:
            break
version = ""
try:
    version = str(resolve.GetVersionString() or "")
except BaseException:
    pass
print(json.dumps({"imported": True, "connected": True, "sdkPresent": True, "python": sys.version.split()[0], "product": product, "version": version}))
`;

function defaultProbeRunner(executable: string, args: string[], env: NodeJS.ProcessEnv): Promise<DavinciProbeRunResult> {
  return new Promise(resolve => {
    const child = spawn(executable, args, {
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const limit = 256 * 1024;
    child.stdout?.on('data', chunk => { if (stdout.length < limit) stdout += String(chunk).slice(0, limit - stdout.length); });
    child.stderr?.on('data', chunk => { if (stderr.length < limit) stderr += String(chunk).slice(0, limit - stderr.length); });
    const timer = setTimeout(() => child.kill(), 10000);
    child.once('error', error => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.once('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export function parsePythonLauncherOutput(output: string): string[] {
  const found: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/(?:^|\s)([A-Za-z]:\\[^\r\n]*?python(?:\.exe)?)\s*$/i);
    if (match?.[1]) found.push(match[1].trim());
  }
  return [...new Set(found.map(value => path.win32.normalize(value)))];
}

async function runDiscovery(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const result = await defaultProbeRunner(command, args, env);
  return result.code === 0 ? result.stdout : '';
}

/** Discover normal installed CPython candidates. No uv-managed interpreter is considered here. */
export async function discoverDavinciPythonCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): Promise<string[]> {
  const found: string[] = [];
  const add = async (candidate: string) => {
    if (!path.isAbsolute(candidate)) return;
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) found.push(path.normalize(candidate));
    } catch { /* not installed */ }
  };

  if (platform === 'win32') {
    const launcher = await runDiscovery('py.exe', ['-0p'], env).catch(() => '');
    for (const candidate of parsePythonLauncherOutput(launcher)) await add(candidate);
    for (const entry of (env.PATH ?? env.Path ?? '').split(';').filter(Boolean)) {
      await add(path.win32.join(entry, 'python.exe'));
      await add(path.win32.join(entry, 'python3.exe'));
    }
    const local = env.LOCALAPPDATA;
    if (local) {
      const root = path.win32.join(local, 'Programs', 'Python');
      try {
        for (const name of await fs.readdir(root)) await add(path.win32.join(root, name, 'python.exe'));
      } catch { /* optional discovery root */ }
    }
  } else {
    for (const entry of (env.PATH ?? '').split(':').filter(Boolean)) {
      await add(path.join(entry, 'python3'));
      await add(path.join(entry, 'python'));
    }
  }
  const seen = new Set<string>();
  return found.filter(candidate => {
    const key = platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function probeDavinciPython(
  executable: string,
  options: { runner?: DavinciProbeRunner; env?: NodeJS.ProcessEnv } = {},
): Promise<DavinciProbeResult> {
  const runner = options.runner ?? defaultProbeRunner;
  const hostEnv = options.env ?? process.env;
  const result = await runner(executable, ['-I', '-c', PROBE_SCRIPT], {
    ...hostEnv,
    ...davinciRuntimeEnvironment(hostEnv),
  });
  let payload: Partial<DavinciProbeResult> = {};
  try {
    const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (line) payload = JSON.parse(line) as Partial<DavinciProbeResult>;
  } catch { /* a native crash or malformed probe is unsafe */ }
  const imported = payload.imported === true;
  const connected = payload.connected === true && result.code === 0;
  return {
    executable,
    safe: imported && (result.code === 0 || result.code === 3),
    imported,
    connected,
    sdkPresent: payload.sdkPresent,
    product: payload.product,
    version: payload.version,
    python: payload.python,
    error: payload.error ?? (result.code === 0 ? undefined : result.stderr.trim() || `probe exited ${result.code ?? 'without a code'}`),
  };
}

export async function selectDavinciPython(
  candidates: readonly string[],
  options: { runner?: DavinciProbeRunner; env?: NodeJS.ProcessEnv } = {},
): Promise<DavinciProbeResult> {
  const failures: string[] = [];
  let safeFallback: DavinciProbeResult | undefined;
  for (const executable of candidates) {
    const result = await probeDavinciPython(executable, options);
    if (result.safe && result.connected) return result;
    if (!safeFallback && result.safe && result.imported) safeFallback = result;
    failures.push(`${path.basename(executable)}: ${result.error ?? 'Resolve connection was not proven'}`);
  }
  if (safeFallback) return safeFallback;
  throw new Error(`No compatible normal CPython interpreter could safely connect to DaVinci Resolve.${failures.length ? ` ${failures.join('; ')}` : ''}`);
}

export function classifyDavinciHealth(input: {
  connected: boolean;
  sdkPresent?: boolean;
  pythonCompatible?: boolean;
  product?: string;
  version?: string;
  error?: string;
}): { code: DavinciHealthCode; ready: boolean } {
  if (input.connected) {
    const major = Number.parseInt(input.version?.split('.')[0] ?? '', 10);
    if (Number.isFinite(major) && major > 0 && major < 18) return { code: 'VERSION_OR_CAPABILITY_UNSUPPORTED', ready: false };
    return { code: 'READY', ready: true };
  }
  if (/not running|no local resolve responded|external scripting|could not connect|timed out/i.test(input.error ?? ''))
    return { code: 'RESOLVE_NOT_RUNNING', ready: false };
  if (input.sdkPresent === false) return { code: 'SCRIPTING_API_MISSING', ready: false };
  if (input.pythonCompatible === false) return { code: 'PYTHON_INCOMPATIBLE', ready: false };
  return { code: 'CONNECTION_FAILED', ready: false };
}

export function validateDavinciToolSurface(names: readonly string[]): void {
  if (names.length !== DAVINCI_PUBLIC_TOOLS.length ||
      names.some((name, index) => name !== DAVINCI_PUBLIC_TOOLS[index]))
    throw new Error(`DaVinci adapter tool surface mismatch; expected exactly ${DAVINCI_PUBLIC_TOOLS.join(', ')}`);
}

export function parseDavinciHealthResult(result: {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
}): { code: DavinciHealthCode; ready: boolean; error?: string } {
  if (result.isError) throw new Error('DaVinci resolve_health returned an MCP error');
  let value: unknown = result.structuredContent;
  if (!value) {
    const text = result.content?.find(block => block.type === 'text')?.text;
    if (!text) throw new Error('DaVinci resolve_health returned no readable result');
    try { value = JSON.parse(text); } catch { throw new Error('DaVinci resolve_health returned invalid JSON'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DaVinci resolve_health returned an invalid payload');
  const payload = value as Record<string, unknown>;
  if (typeof payload.code !== 'string' || ![
    'READY', 'RESOLVE_NOT_RUNNING', 'SCRIPTING_API_MISSING', 'PYTHON_INCOMPATIBLE', 'CONNECTION_FAILED', 'VERSION_OR_CAPABILITY_UNSUPPORTED',
  ].includes(payload.code)) throw new Error('DaVinci resolve_health returned an unknown health code');
  return {
    code: payload.code as DavinciHealthCode,
    ready: payload.ready === true && payload.code === 'READY',
    ...(typeof payload.error === 'string' ? { error: payload.error } : {}),
  };
}
