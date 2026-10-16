import { expect, it, vi } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  DAVINCI_PUBLIC_TOOLS,
  classifyDavinciHealth,
  createDavinciInstallPlan,
  davinciRuntimeEnvironment,
  parseDavinciHealthResult,
  parsePythonLauncherOutput,
  probeDavinciPython,
  selectDavinciPython,
  validateDavinciToolSurface,
} from '../src/main/plugins/davinci.js';
import { DAVINCI_ADAPTER_SOURCE } from '../src/main/plugins/davinci-adapter-source.js';
import { makeTempDir, removeTempDir } from './helpers.js';

function contractPython(): { command: string; prefix: string[] } | null {
  const candidates = process.platform === 'win32'
    ? [{ command: 'py', prefix: ['-3.13'] }, { command: 'python', prefix: [] }]
    : [{ command: 'python3', prefix: [] }, { command: 'python', prefix: [] }];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, [...candidate.prefix, '-c', 'import sys; print(sys.version_info[:2])'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

it('keeps the DaVinci public surface exactly bounded to the ten reviewed tools', () => {
  expect(DAVINCI_PUBLIC_TOOLS).toEqual([
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
  ]);
  expect(new Set(DAVINCI_PUBLIC_TOOLS).size).toBe(10);
  expect(DAVINCI_PUBLIC_TOOLS.join(' ')).not.toMatch(/eval|python|lua|shell|delete/i);
});

it('parses normal CPython launcher discovery without binding to one Python minor version', () => {
  const discovered = parsePythonLauncherOutput(` -V:3.13 * C:\\Users\\Example\\AppData\\Local\\Programs\\Python\\Python313\\python.exe\n -V:3.12   C:\\Python312\\python.exe\n`);
  expect(discovered).toEqual([
    'C:\\Users\\Example\\AppData\\Local\\Programs\\Python\\Python313\\python.exe',
    'C:\\Python312\\python.exe',
  ]);
});

it('rejects a crashing native probe and only selects a capability-proven interpreter', async () => {
  const runner = vi.fn(async (executable: string) => {
    if (executable.endsWith('bad.exe')) return { code: -1073741819, stdout: '', stderr: 'native crash' };
    if (executable.endsWith('closed.exe')) return { code: 3, stdout: JSON.stringify({ imported: true, connected: false }), stderr: '' };
    return { code: 0, stdout: JSON.stringify({ imported: true, connected: true, product: 'DaVinci Resolve Studio', version: '20.2.3' }), stderr: '' };
  });
  await expect(probeDavinciPython('C:\\Python\\bad.exe', { runner })).resolves.toMatchObject({ safe: false, connected: false });
  await expect(selectDavinciPython([
    'C:\\Python\\bad.exe',
    'C:\\Python\\closed.exe',
    'C:\\Python\\good.exe',
  ], { runner })).resolves.toMatchObject({ executable: 'C:\\Python\\good.exe', connected: true });
});

it('falls back to an interpreter whose disposable native probe exits safely when Resolve is closed', async () => {
  const runner = vi.fn(async (executable: string) => {
    if (executable.endsWith('safe.exe')) return { code: 3, stdout: JSON.stringify({ imported: true, connected: false, sdkPresent: true, error: 'Resolve is not running' }), stderr: '' };
    return { code: -1073741819, stdout: '', stderr: 'native crash' };
  });
  await expect(selectDavinciPython([
    'C:\\Python\\safe.exe',
    'C:\\Python\\crashes.exe',
  ], { runner })).resolves.toMatchObject({ executable: 'C:\\Python\\safe.exe', safe: true, connected: false });
});

it('classifies Resolve health without treating a running stdio adapter as backend readiness', () => {
  expect(classifyDavinciHealth({ connected: true, product: 'DaVinci Resolve Studio', version: '20.2.3' }).code).toBe('READY');
  expect(classifyDavinciHealth({ connected: false, sdkPresent: true, error: 'Resolve is not running' }).code).toBe('RESOLVE_NOT_RUNNING');
  expect(classifyDavinciHealth({ connected: false, sdkPresent: false, error: 'No local Resolve responded' }).code).toBe('RESOLVE_NOT_RUNNING');
  expect(classifyDavinciHealth({ connected: false, sdkPresent: false, error: 'DaVinciResolveScript missing' }).code).toBe('SCRIPTING_API_MISSING');
  expect(classifyDavinciHealth({ connected: false, sdkPresent: true, pythonCompatible: false, error: 'native probe failed' }).code).toBe('PYTHON_INCOMPATIBLE');
});

it('copies only non-secret Resolve scripting host variables into the native child environment', () => {
  expect(davinciRuntimeEnvironment({
    ProgramData: 'C:\\ProgramData',
    PROGRAMFILES: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    RESOLVE_SCRIPT_API: 'D:\\ResolveSDK',
    RESOLVE_SCRIPT_LIB: 'D:\\Resolve\\fusionscript.dll',
    FUSION_PYTHON3_HOME: 'C:\\Python313',
    API_TOKEN: 'must-not-leak',
  }, 'win32')).toEqual({
    RESOLVE_SCRIPT_API: 'D:\\ResolveSDK',
    RESOLVE_SCRIPT_LIB: 'D:\\Resolve\\fusionscript.dll',
    FUSION_PYTHON3_HOME: 'C:\\Python313',
    PROGRAMDATA: 'C:\\ProgramData',
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
  });
});

it('derives Resolve runtime paths when they are missing from the Windows launcher environment', () => {
  expect(davinciRuntimeEnvironment({
    SystemDrive: 'C:\\',
    ProgramFiles: 'C:\\Program Files',
  }, 'win32')).toEqual({
    PROGRAMDATA: 'C:\\ProgramData',
    PROGRAMFILES: 'C:\\Program Files',
    RESOLVE_SCRIPT_API: 'C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support\\Developer\\Scripting',
    RESOLVE_SCRIPT_LIB: 'C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\fusionscript.dll',
  });
});

it('uses the derived Resolve runtime environment for the disposable Python probe', async () => {
  const runner = vi.fn(async (_executable: string, _args: string[], env: NodeJS.ProcessEnv) => {
    expect(env.PROGRAMDATA).toBe('C:\\ProgramData');
    expect(env.RESOLVE_SCRIPT_API).toBe('C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support\\Developer\\Scripting');
    expect(env.RESOLVE_SCRIPT_LIB).toBe('C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\fusionscript.dll');
    return { code: 0, stdout: JSON.stringify({ imported: true, connected: true }), stderr: '' };
  });
  await expect(probeDavinciPython('C:\\Python\\python.exe', {
    runner,
    env: { SystemDrive: 'C:\\', ProgramFiles: 'C:\\Program Files' },
  })).resolves.toMatchObject({ safe: true, connected: true });
});

it('fails closed on tool-surface drift and on a degraded backend health result', () => {
  expect(() => validateDavinciToolSurface([...DAVINCI_PUBLIC_TOOLS])).not.toThrow();
  expect(() => validateDavinciToolSurface([...DAVINCI_PUBLIC_TOOLS, 'execute_python'])).toThrow('tool surface mismatch');
  expect(() => validateDavinciToolSurface(DAVINCI_PUBLIC_TOOLS.slice(1))).toThrow('tool surface mismatch');
  expect(parseDavinciHealthResult({ content: [{ type: 'text', text: JSON.stringify({ code: 'READY', ready: true }) }] })).toEqual({ code: 'READY', ready: true });
  expect(parseDavinciHealthResult({ content: [{ type: 'text', text: JSON.stringify({ code: 'RESOLVE_NOT_RUNNING', ready: false, error: 'Resolve is closed' }) }] })).toEqual({
    code: 'RESOLVE_NOT_RUNNING', ready: false, error: 'Resolve is closed',
  });
  expect(() => parseDavinciHealthResult({ content: [{ type: 'text', text: JSON.stringify({ code: 'UNKNOWN', ready: true }) }] })).toThrow('unknown health code');
});

it('bundles a deterministic CoS-owned adapter with durable ownership and no raw scripting escape hatch', () => {
  expect(DAVINCI_ADAPTER_SOURCE).toContain('AI_WORK_');
  expect(DAVINCI_ADAPTER_SOURCE).toContain('ownership.json');
  expect(DAVINCI_ADAPTER_SOURCE).toContain('project_unique_id');
  expect(DAVINCI_ADAPTER_SOURCE).toContain('timeline_unique_id');
  expect(DAVINCI_ADAPTER_SOURCE).toContain('requested');
  expect(DAVINCI_ADAPTER_SOURCE).toContain('executed');
  expect(DAVINCI_ADAPTER_SOURCE).toContain('verified');
  expect(DAVINCI_ADAPTER_SOURCE).toContain('AMBIGUOUS_MUTATION');
  expect(DAVINCI_ADAPTER_SOURCE).not.toContain('DVR_MCP_ENABLE_EVAL');
  expect(DAVINCI_ADAPTER_SOURCE).not.toContain('eval_unsafe');
  expect(DAVINCI_ADAPTER_SOURCE).not.toContain('execute_python');
  expect(DAVINCI_ADAPTER_SOURCE).not.toContain('execute_lua');
  for (const tool of DAVINCI_PUBLIC_TOOLS) expect(DAVINCI_ADAPTER_SOURCE).toContain(`ToolSpec("${tool}"`);
});

it('uses the selected normal CPython to create the plugin venv rather than uv venv selection', () => {
  const selected = 'C:\\Program Files\\Python313\\python.exe';
  const plan = createDavinciInstallPlan('C:\\plugin', selected, 'win32');
  expect(plan.createVenv.command).toBe(selected);
  expect(plan.createVenv.args).toEqual(['-m', 'venv', path.win32.join('C:\\plugin', 'venv')]);
  expect(plan.venvPython).toBe(path.win32.join('C:\\plugin', 'venv', 'Scripts', 'python.exe'));
  expect(plan.adapterPath).toBe(path.win32.join('C:\\plugin', 'cos-davinci-adapter.py'));
});

it.skipIf(!contractPython())('executes deterministic fake-backend safety and verification contracts in the generated Python adapter', async () => {
  const python = contractPython()!;
  const dir = await makeTempDir('cos-davinci-contract-');
  try {
    const adapter = path.join(dir, 'adapter.py');
    await fs.writeFile(adapter, DAVINCI_ADAPTER_SOURCE, 'utf8');
    const harness = path.resolve('test/fixtures/davinci-adapter-contract.py');
    const result = spawnSync(python.command, [...python.prefix, harness, adapter, dir], { encoding: 'utf8', timeout: 30_000 });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const report = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(report).toMatchObject({
      guard_duplicate_name_exact_target:true, guard_wrong_project:true, guard_stale_snapshot:true, guard_nonempty_rejected:true,
      guard_acceptance_timeline_fallback:true, guard_production_timeline_rejected:true,
      prepare_verified: true,
      prepare_saved: true,
      prepare_idempotent: true,
      primary_rejected: true,
      stale_rejected: true,
      import_verified: true,
      import_saved: true,
      rough_cut_verified: true,
      rough_cut_saved: true,
      marker_verified: true,
      marker_saved: true,
      ambiguous_no_replay: true,
      ambiguous_not_saved: true,
      properties_verified: true,
      properties_saved: true,
      render_job_verified: true,
      render_artifact_verified: true,
      foreign_render_rejected: true,
      missing_api_clear: true,
      backend_absent_classified: true,
      inspection_source_ranges: true,
      inspection_owner_receipt: true,
      inspection_track_failure_explicit: true,
      inspection_page_receipt: true,
      inspection_media_properties: true,
    });
  } finally {
    await removeTempDir(dir);
  }
});
