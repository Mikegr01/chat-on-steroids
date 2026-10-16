import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ status: 0, major: 10, build: 26100, fail: false }));
const rtl = vi.hoisted(() => vi.fn((bytes: Buffer) => {
  expect(bytes.length).toBe(284); expect(bytes.readUInt32LE(0)).toBe(284);
  bytes.writeUInt32LE(state.major, 4); bytes.writeUInt32LE(state.build, 12); return state.status;
}));
vi.mock('koffi', () => ({ load: (name: string) => {
  expect(name).toBe('ntdll.dll'); if (state.fail) throw new Error('Unavailable');
  return { func: (signature: string) => { expect(signature).toContain('RtlGetVersion'); return rtl; } };
} }));
import { readWindowsBuild } from '../src/main/video-editing/windows-build.js';
beforeEach(() => { Object.assign(state, { status: 0, major: 10, build: 26100, fail: false }); rtl.mockClear(); });
const windows = process.platform === 'win32' ? it : it.skip;
windows.each([19045, 22000, 26100])('BUILD_GATE_MAIN_PROCESS_CONTROLLED_RTL_BUILD_%i', async build => {
  state.build = build; expect(await readWindowsBuild()).toBe(build); expect(rtl).toHaveBeenCalledOnce();
});
windows.each(['status', 'major', 'zero', 'missing'])('UNKNOWN_WINDOWS_BUILD_%s_FAILS_CLOSED', async mode => {
  if (mode === 'status') state.status = -1;
  if (mode === 'major') state.major = 6;
  if (mode === 'zero') state.build = 0;
  if (mode === 'missing') state.fail = true;
  expect(await readWindowsBuild()).toBeNull();
});
