import { beforeEach, expect, it, vi } from 'vitest';

const { invoke, expose, getPath } = vi.hoisted(() => ({
  invoke: vi.fn(async (channel: string, payload: any) => ({ ok: true, data: channel === 'sessions:dropFiles'
    ? payload.files.map((_: unknown, index: number) => ({ id: String(index), name: 'staged', size: 0, mimeType: 'application/octet-stream' }))
    : null })),
  expose: vi.fn(), getPath: vi.fn((file: any) => file.path ?? '')
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { invoke },
  webUtils: { getPathForFile: getPath }
}));

beforeEach(() => { vi.resetModules(); invoke.mockClear(); expose.mockClear(); });

it('exposes only three dedicated S7 methods, each fixed to one channel', async () => {
  await import('../src/preload/index.js');
  const api = expose.mock.calls[0]![1]; invoke.mockClear();
  expect(Object.keys(api).filter(key => /S7/i.test(key)).sort()).toEqual([
    'getKosmosynS7State', 'initializeKosmosynS7', 'setKosmosynS7Enabled'
  ]);
  expect(api.invoke).toBeUndefined(); expect(api.uninitializeKosmosynS7).toBeUndefined();
  await api.getKosmosynS7State(); await api.initializeKosmosynS7(); await api.setKosmosynS7Enabled(true); await api.setKosmosynS7Enabled(false);
  expect(invoke.mock.calls).toEqual([
    ['kosmosynS7:state', undefined], ['kosmosynS7:initialize', undefined],
    ['kosmosynS7:set-enabled', true], ['kosmosynS7:set-enabled', false]
  ]);
  invoke.mockClear();
});

it('keeps disk paths batched while transporting pathless clipboard bytes one at a time', async () => {
  await import('../src/preload/index.js');
  const api = expose.mock.calls[0]![1];
  const bytes = new Uint8Array([1, 2, 3]);
  const arrayBuffer = vi.fn(async () => bytes.buffer);
  await api.dropFiles([{ name: 'clipboard.png', size: 3, arrayBuffer }, { name: 'disk.png', size: 3, path: '/disk.png' }]);
  expect(invoke).toHaveBeenNthCalledWith(1, 'sessions:dropFiles', { files: ['/disk.png'] });
  expect(invoke).toHaveBeenNthCalledWith(2, 'sessions:dropFiles', { files: [{ name: 'clipboard.png', bytes }] });
  expect(arrayBuffer).toHaveBeenCalledOnce();
  invoke.mockClear(); arrayBuffer.mockClear();
  expect(await api.dropFiles([{ name: 'huge.png', size: 12 * 1024 * 1024 + 1, arrayBuffer }])).toMatchObject({ ok: false });
  expect(await api.dropFiles(Array(21).fill({ name: 'clipboard.png', size: 3, arrayBuffer }))).toMatchObject({ ok: false });
  expect(arrayBuffer).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
  await api.getProjectGitSnapshot('project-id');
  await api.getProjectGitDiff('project-id', 'src/main.ts');
  await api.getToolEditReview('session-id', '00000000-0000-4000-8000-000000000000', 1);
  expect(invoke).toHaveBeenNthCalledWith(1, 'projectGit:snapshot', { projectId: 'project-id' });
  expect(invoke).toHaveBeenNthCalledWith(2, 'projectGit:diff', { projectId: 'project-id', path: 'src/main.ts' });
  expect(invoke).toHaveBeenNthCalledWith(3, 'sessions:toolEditReview', {
    sessionId: 'session-id', callId: '00000000-0000-4000-8000-000000000000', changeIndex: 1
  });
});
