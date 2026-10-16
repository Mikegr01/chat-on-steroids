import { expect, it, vi } from 'vitest';
import path from 'node:path';
import { createMediaRuntimeOperator } from '../src/main/video-editing/media-runtime-operator.js';

function fixture() {
  let saved: unknown = null;
  const ports = { assertAccess: vi.fn(), admit: vi.fn(async () => ({ trusted: true })),
    save: vi.fn(async (value: unknown, assertOwner: () => Promise<void>) => { await assertOwner(); saved = value; }),
    diagnostics: vi.fn(async () => saved ? { status: 'CONFIGURED' } : { status: 'NOT_CONFIGURED' }) };
  return { ports, operator: createMediaRuntimeOperator(ports), paths: { ffprobePath: path.resolve('probe.exe'), ffmpegPath: path.resolve('mpeg.exe') } };
}
it('confirms explicit paths and persists one complete engine result before diagnostics', async () => {
  const f = fixture(), confirm = vi.fn(async (_detail: string) => true), owner = vi.fn(async () => {});
  expect(await f.operator.status()).toEqual({ status: 'NOT_CONFIGURED' });
  expect(await f.operator.admit(f.paths, confirm, owner)).toEqual({ status: 'CONFIGURED' });
  expect(confirm.mock.calls[0]![0]).toContain(f.paths.ffprobePath);
  expect(f.ports.admit).toHaveBeenCalledExactlyOnceWith(f.paths);
  expect(f.ports.save).toHaveBeenCalledOnce(); expect(owner.mock.calls.length).toBeGreaterThan(2);
});
it.each([{ ffprobePath: 'probe', ffmpegPath: path.resolve('mpeg') }, { ffprobePath: path.resolve('probe') },
  { ffprobePath: path.resolve('probe'), ffmpegPath: '' }, { ffprobePath: path.resolve('probe'), ffmpegPath: path.resolve('mpeg'), sha256: 'forged' }])('rejects malformed candidate paths before confirmation/execution: %j', async paths => {
  const f = fixture(), confirm = vi.fn(async () => true);
  await expect(f.operator.admit(paths, confirm, async () => {})).rejects.toThrow();
  expect(confirm).not.toHaveBeenCalled(); expect(f.ports.admit).not.toHaveBeenCalled(); expect(f.ports.save).not.toHaveBeenCalled();
});
it.each(['missing executable', 'identity changed', 'capability unsupported', 'version malformed'])('surfaces %s without partial persistence', async error => {
  const f = fixture(); f.ports.admit.mockRejectedValueOnce(new Error(error));
  await expect(f.operator.admit(f.paths, async () => true, async () => {})).rejects.toThrow(error);
  expect(f.ports.save).not.toHaveBeenCalled(); expect(await f.operator.status()).toEqual({ status: 'NOT_CONFIGURED' });
});
it('cancellation and revoked owner do not save; persistence failure does not report success', async () => {
  const f = fixture();
  expect(await f.operator.admit(f.paths, async () => false, async () => {})).toEqual({ cancelled: true });
  expect(f.ports.admit).not.toHaveBeenCalled();
  await expect(f.operator.admit(f.paths, async () => true, async () => { throw Error('owner changed'); })).rejects.toThrow('owner changed');
  f.ports.save.mockRejectedValueOnce(Error('disk failed'));
  await expect(f.operator.admit(f.paths, async () => true, async () => {})).rejects.toThrow('disk failed');
  expect(await f.operator.status()).toEqual({ status: 'NOT_CONFIGURED' });
});
it('shares one admission reservation and rechecks permissions after native confirmation', async () => {
  const f = fixture(); let release!: (value: boolean) => void;
  const first = f.operator.admit(f.paths, () => new Promise(resolve => { release = resolve; }), async () => {});
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await expect(f.operator.admit(f.paths, async () => true, async () => {})).rejects.toThrow(/active/);
  f.ports.assertAccess.mockImplementation(() => { throw Error('permission revoked'); }); release(true);
  await expect(first).rejects.toThrow('permission revoked'); expect(f.ports.admit).not.toHaveBeenCalled();
});
