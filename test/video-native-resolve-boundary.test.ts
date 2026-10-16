import { afterEach, expect, it, vi } from 'vitest';
import { PluginManager } from '../src/main/plugins/manager.js';
import { faultGate, makeTempDir, removeTempDir } from './helpers.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const manager = new PluginManager(), internals = manager as any;
  const tools = ['resolve_inspect', 'resolve_assemble_rough_cut'].map(name => ({ name, inputSchema: { type: 'object' } }));
  const row = { id: 'fixture-resolve', name: 'Synthetic Resolve', catalogId: 'davinci-resolve', version: '1.0.3', license: 'MIT',
    source: { kind: 'command', command: 'synthetic' }, enabled: true, status: 'ready', catalog: tools, disabledTools: [] as string[], config: {}, credentialKeys: [] };
  const upstream = vi.fn(async () => ({ content: [{ type: 'text', text: '{"fixture":true}' }] }));
  const live = { client: { callTool: upstream }, tools, users: 0 };
  internals.records = [row]; internals.live.set(row.id, live); internals.revision = 1;
  const resetExposure = () => { internals.exposureCache = null; };
  return { manager, internals, row, upstream, live, resetExposure, epoch: `${row.id}:1` };
}
it('native Resolve uses the existing bounded/redacted plugin invocation without reconnecting or conversational bookkeeping', async () => {
  const f = fixture(), owner = vi.fn(async () => {});
  f.internals.secretValues.add('fixture-secret');
  f.upstream.mockResolvedValueOnce({ content: [{ type: 'text', text: '{"secret":"fixture-secret"}' }] });
  const result = await f.manager.callCuratedResolve('resolve_inspect', { selector: 'timeline' }, f.epoch, owner);
  expect(result.content).toEqual([{ type: 'text', text: '{"secret":"[redacted]"}' }]);
  expect(f.upstream).toHaveBeenCalledExactlyOnceWith({ name: 'resolve_inspect', arguments: { selector: 'timeline' } },
    { timeout: 120000, toolDefinition: f.live.tools[0] });
  expect(f.live.users).toBe(0);
  f.upstream.mockResolvedValueOnce({ content: [{ type: 'text', text: 'x'.repeat(16 * 1024 * 1024) }] });
  expect(await f.manager.callCuratedResolve('resolve_inspect', {}, f.epoch, owner)).toMatchObject({ isError: true });
});
it.each(['owner', 'epoch', 'disabled', 'not-ready', 'exposure'])('queued %s replacement refuses the original Resolve invocation before upstream dispatch', async kind => {
  const f = fixture(), gate = faultGate();
  const blocker = f.internals.serial(f.row.id, () => gate.hold()); await gate.entered;
  const pending = f.manager.callCuratedResolve('resolve_assemble_rough_cut', { fixture: true }, f.epoch, async () => {});
  await Promise.resolve();
  if (kind === 'owner') f.row.id = 'replacement-resolve';
  if (kind === 'epoch') f.internals.revision++;
  if (kind === 'disabled') f.row.enabled = false;
  if (kind === 'not-ready') f.row.status = 'disabled';
  if (kind === 'exposure') f.row.disabledTools.push('resolve_assemble_rough_cut');
  f.resetExposure(); gate.release(); await blocker;
  const result = await pending.catch(error => ({ isError: true, error }));
  expect(result).toMatchObject({ isError: true }); expect(f.upstream).not.toHaveBeenCalled();
});
it('lifecycle invalidation at the final manager await rejects dispatch and releases acquired custody', async () => {
  const f = fixture(); let checks = 0;
  const result = await f.manager.callCuratedResolve('resolve_assemble_rough_cut', {}, f.epoch, async () => {
    if (++checks === 3) throw new Error('Renderer lifecycle lost');
  });
  expect(result).toMatchObject({ isError: true }); expect(f.upstream).not.toHaveBeenCalled(); expect(f.live.users).toBe(0);
});
it('queued native owner refusal keeps its pre-dispatch error classification', async () => {
  const f = fixture(), gate = faultGate();
  const blocker = f.internals.serial(f.row.id, () => gate.hold()); await gate.entered;
  const pending = f.manager.callCuratedResolve('resolve_inspect', {}, f.epoch, async () => {});
  await Promise.resolve(); await Promise.resolve(); f.internals.revision++; gate.release(); await blocker;
  const result = await pending;
  expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain('PLUGIN_OWNER_CHANGED');
  expect(JSON.stringify(result)).not.toContain('PLUGIN_START_FAILED'); expect(f.upstream).not.toHaveBeenCalled();
});
it('the narrow native Resolve method rejects other plugin tools even if a caller bypasses TypeScript', async () => {
  const f = fixture(); await expect(f.manager.callCuratedResolve('arbitrary_python' as never, { code: 'fixture' }, f.epoch, async () => {})).rejects.toThrow(/owner/);
  expect(f.upstream).not.toHaveBeenCalled();
});
it('the real native factory keeps the existing operation translator and approved-path/live-policy guards', async () => {
  const dir = await makeTempDir('native-resolve-access-'), file = path.join(dir, 'source.txt');
  await fs.writeFile(file, 'Synthetic local media');
  const config = { readOnly: false, roots: [{ name: 'media', path: dir }] }, f = fixture();
  vi.resetModules();
  vi.doMock('../src/main/config.js', () => ({ getConfig: () => config, effectiveCapabilities: () => ({ read: true }) }));
  try {
    const { pluginManager } = await import('../src/main/plugins/manager.js');
    vi.spyOn(pluginManager, 'snapshot').mockImplementation(() => f.manager.snapshot());
    vi.spyOn(pluginManager, 'callCuratedResolve').mockImplementation((...args) => f.manager.callCuratedResolve(...args));
    const { createNativeResolveAccess } = await import('../src/main/video-editing/runtime-inspection.js');
    const access = createNativeResolveAccess(async () => {});
    expect(await access.access(file)).toBe(await fs.realpath(file));
    await expect(access.access(path.join(dir, '..', 'unapproved.txt'))).rejects.toThrow();
    expect(await access.call({ name: 'resolve_assemble_rough_cut', arguments: { timeline_unique_id: 'target', segments: [] } } as never,
      { projectId: 'resolve-project', snapshotSha256: 'a'.repeat(64) })).toEqual({ fixture: true });
    expect(f.upstream).toHaveBeenCalledExactlyOnceWith({ name: 'resolve_assemble_rough_cut', arguments: {
      timeline_unique_id: 'target', segments: [], guard_version: 2, expected_project_unique_id: 'resolve-project', expected_snapshot_sha256: 'a'.repeat(64) } },
      { timeout: 120000, toolDefinition: f.live.tools[1] });
    f.upstream.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'PLUGIN_FIXTURE_REJECTED: synthetic refusal' }] } as never);
    await expect(access.call({ name: 'resolve_assemble_rough_cut', arguments: {} } as never,
      { projectId: 'resolve-project', snapshotSha256: 'a'.repeat(64) })).rejects.toThrow(/PLUGIN_FIXTURE_REJECTED/);
    config.readOnly = true;
    await expect(access.call({ name: 'resolve_assemble_rough_cut', arguments: {} } as never, { projectId: 'resolve-project', snapshotSha256: 'a'.repeat(64) })).rejects.toThrow(/permission/);
    await expect(access.access(file)).rejects.toThrow(/permission/); expect(f.upstream).toHaveBeenCalledTimes(2);
    config.readOnly = false;
    let checks = 0;
    const revoked = createNativeResolveAccess(async () => { if (++checks === 2) config.roots = []; });
    await expect(revoked.access(file)).rejects.toThrow();
  } finally { vi.doUnmock('../src/main/config.js'); vi.restoreAllMocks(); await removeTempDir(dir); }
});
