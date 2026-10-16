import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initVideoMediaRuntime } from '../src/renderer/video-media-runtime.js';
let dom: JSDOM;
beforeEach(() => { dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8')); vi.stubGlobal('document', dom.window.document); });
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); });
const input = (tool: string) => document.getElementById(`videoMedia${tool}Path`) as HTMLInputElement;
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
function fixture() {
  const diagnostics = { status: 'CONFIGURED', ffprobe: { status: 'CONFIGURED', path: 'C:/probe.exe', admittedSha256: 'a'.repeat(64), admittedVersion: '8.1' },
    ffmpeg: { status: 'CONFIGURED', path: 'C:/mpeg.exe', admittedSha256: 'b'.repeat(64), admittedVersion: '8.1' }, capabilities: { jsonProbe: 'SUPPORTED' } };
  const api = { getVideoMediaRuntime: vi.fn(async () => ({ ok: true as const, data: diagnostics })),
    admitVideoMediaRuntime: vi.fn(async () => ({ ok: true as const, data: diagnostics })),
    pickVideoMediaExecutable: vi.fn(async () => ({ ok: true as const, data: 'C:/chosen.exe' })) };
  return { api, control: initVideoMediaRuntime(api as never) };
}
it('shows admitted paths/hash/version/capabilities and preserves unsaved candidate paths on refresh', async () => {
  const f = fixture(); await f.control.refresh();
  expect(input('Ffprobe').value).toBe('C:/probe.exe'); expect(document.getElementById('videoMediaDiagnostics')!.textContent).toContain('8.1');
  input('Ffprobe').value = 'C:/new.exe'; input('Ffprobe').dispatchEvent(new dom.window.Event('input'));
  await f.control.refresh(); expect(input('Ffprobe').value).toBe('C:/new.exe');
});
it('selection supplies only candidate paths; admission refreshes authoritative diagnostics', async () => {
  const f = fixture(); await f.control.refresh(); button('videoMediaFfprobeChoose').click();
  await vi.waitFor(() => expect(input('Ffprobe').value).toBe('C:/chosen.exe'));
  button('videoMediaAdmit').click();
  await vi.waitFor(() => expect(f.api.admitVideoMediaRuntime).toHaveBeenCalledExactlyOnceWith('C:/chosen.exe', 'C:/mpeg.exe'));
  await vi.waitFor(() => expect(f.api.getVideoMediaRuntime).toHaveBeenCalledTimes(2));
});
it('surfaces failures, blocks duplicates and never writes generic Settings/config', async () => {
  const f = fixture(); await f.control.refresh();
  f.api.admitVideoMediaRuntime.mockResolvedValueOnce({ ok: false, error: 'identity changed' } as never);
  button('videoMediaAdmit').click(); button('videoMediaAdmit').click();
  await vi.waitFor(() => expect(document.getElementById('videoMediaError')!.textContent).toContain('identity changed'));
  expect(f.api.admitVideoMediaRuntime).toHaveBeenCalledOnce();
  const source = readFileSync('src/renderer/video-media-runtime.ts', 'utf8'); expect(source).not.toMatch(/saveSettings|writeFile|sha256\s*=/);
});
