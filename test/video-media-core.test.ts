import { beforeEach, expect, it, vi } from 'vitest';
import path from 'node:path';
const f = vi.hoisted(() => ({ parent: { caller: { sessionId: 'local', conversationId: 'chat' } } as unknown,
  session: { id: 'local', conversationId: 'chat', projectId: 'project', chatIds: ['chat'] },
  status: vi.fn(async () => ({ status: 'NOT_CONFIGURED' })), admit: vi.fn(async (_paths: unknown, _confirm: unknown, _owner: unknown) => ({ status: 'CONFIGURED' })) }));
vi.mock('../src/main/mcp/call-context.js', () => ({ currentCall: () => f.parent }));
vi.mock('../src/main/session/store.js', () => ({ getSession: async () => f.session }));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({ readOnly: false }), effectiveCapabilities: () => ({ read: true }) }));
vi.mock('../src/main/video-editing/media-runtime-operator.js', async importOriginal => ({ ...await importOriginal<object>(), mediaRuntimeOperator: { status: f.status, admit: f.admit } }));
import { videoAction } from '../src/main/video-editing/service.js';
beforeEach(() => { vi.clearAllMocks(); f.parent = { caller: { sessionId: 'local', conversationId: 'chat' } }; });
it.each(['media-runtime-status', 'media-runtime-refresh'])('routes %s to fresh trusted diagnostics once', async action => {
  expect(await videoAction({ action }, async () => true)).toEqual({ status: 'NOT_CONFIGURED' }); expect(f.status).toHaveBeenCalledOnce();
});
it('routes explicit admission once with native confirmation and exact-session assertion', async () => {
  const confirm = vi.fn(async () => true), paths = { ffprobePath: path.resolve('probe.exe'), ffmpegPath: path.resolve('mpeg.exe') };
  expect(await videoAction({ action: 'media-runtime-admit', ...paths }, confirm)).toEqual({ status: 'CONFIGURED' });
  expect(f.admit).toHaveBeenCalledOnce(); expect(f.admit.mock.calls[0]![0]).toEqual(paths);
  expect(f.admit.mock.calls[0]![1]).toBe(confirm);
  const assertOwner = f.admit.mock.calls[0]![2] as () => Promise<void>; await assertOwner();
  f.parent = null; await expect(assertOwner()).rejects.toThrow(/owner|session/);
});
it('rejects malformed/forged requests before admission', async () => {
  await expect(videoAction({ action: 'media-runtime-admit', ffprobePath: 'relative', ffmpegPath: 'relative', sha256: 'fake' }, async () => true)).rejects.toThrow();
  expect(f.admit).not.toHaveBeenCalled();
});
it('surfaces admission errors and refuses unattributed or wrong-chat calls', async () => {
  f.admit.mockRejectedValueOnce(Error('capability unsupported'));
  await expect(videoAction({ action: 'media-runtime-admit', ffprobePath: path.resolve('probe.exe'), ffmpegPath: path.resolve('mpeg.exe') }, async () => true)).rejects.toThrow('capability unsupported');
  f.parent = { caller: { sessionId: 'local', conversationId: 'other' } };
  await expect(videoAction({ action: 'media-runtime-status' }, async () => true)).rejects.toThrow(/session/);
});
