import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { initKosmosynS7Control } from '../src/renderer/kosmosyn-s7-control.js';

let dom: JSDOM;
const off = { initialized: false, enabled: false }, initialized = { initialized: true, enabled: false };
const ok = (data: typeof off) => ({ ok: true as const, data });
beforeEach(() => {
  const html = readFileSync('src/renderer/index.html', 'utf8');
  dom = new JSDOM(html); vi.stubGlobal('document', dom.window.document);
});
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); });
const button = () => document.getElementById('kosmosynS7Initialize') as HTMLButtonElement;
const toggle = () => document.getElementById('kosmosynS7Enabled') as HTMLInputElement;
const status = () => document.getElementById('kosmosynS7State')!.textContent;
const error = () => document.getElementById('kosmosynS7Error')!;
const change = (checked: boolean) => { toggle().checked = checked; toggle().dispatchEvent(new dom.window.Event('change')); };

it('paints all three authoritative states and disables ineligible actions', () => {
  const api = { getKosmosynS7State: vi.fn(async () => ok(off)), initializeKosmosynS7: vi.fn(async () => ok(initialized)), setKosmosynS7Enabled: vi.fn(async () => ok(initialized)) };
  const control = initKosmosynS7Control(api);
  control.apply(off); expect(status()).toBe('Uninitialized'); expect(toggle().disabled).toBe(true); expect(button().disabled).toBe(false);
  control.apply(initialized); expect(status()).toBe('Initialized — Off'); expect(button().disabled).toBe(true); expect(toggle().disabled).toBe(false);
  control.apply({ ...initialized, enabled: true }); expect(status()).toBe('Enabled'); expect(toggle().checked).toBe(true);
});

it('blocks duplicate actions and stale pushes while waiting, then paints the main reply', async () => {
  let finish!: (reply: ReturnType<typeof ok>) => void;
  const pending = new Promise<ReturnType<typeof ok>>(resolve => { finish = resolve; });
  const api = { getKosmosynS7State: vi.fn(async () => ok(off)), initializeKosmosynS7: vi.fn(() => pending), setKosmosynS7Enabled: vi.fn(async () => ok(initialized)) };
  const control = initKosmosynS7Control(api); control.apply(off);
  button().click(); button().click(); change(true); control.apply({ ...initialized, enabled: true });
  expect(api.initializeKosmosynS7).toHaveBeenCalledOnce(); expect(api.setKosmosynS7Enabled).not.toHaveBeenCalled();
  expect(status()).toBe('Uninitialized'); expect(toggle().checked).toBe(false); expect(toggle().disabled).toBe(true);
  finish(ok(initialized)); await vi.waitFor(() => expect(status()).toBe('Initialized — Off'));
  expect(button().disabled).toBe(true); expect(toggle().disabled).toBe(false);
});

it.each(['initialize', 'enable'] as const)('failed %s refreshes authoritative OFF state and displays the error', async operation => {
  const state = operation === 'initialize' ? off : initialized;
  const failed = { ok: false as const, error: 'Custody refused' };
  const api = { getKosmosynS7State: vi.fn(async () => ok(state)), initializeKosmosynS7: vi.fn(async () => failed), setKosmosynS7Enabled: vi.fn(async () => failed) };
  const control = initKosmosynS7Control(api); control.apply(state);
  if (operation === 'initialize') button().click(); else change(true);
  await vi.waitFor(() => expect(error().hidden).toBe(false));
  expect(api.getKosmosynS7State).toHaveBeenCalledOnce(); expect(toggle().checked).toBe(false);
  expect(status()).toBe(operation === 'initialize' ? 'Uninitialized' : 'Initialized — Off');
});

it('enable and disable use the dedicated method and wait for authoritative completion', async () => {
  let finish!: (reply: ReturnType<typeof ok>) => void;
  const pending = new Promise<ReturnType<typeof ok>>(resolve => { finish = resolve; });
  const api = { getKosmosynS7State: vi.fn(async () => ok(initialized)), initializeKosmosynS7: vi.fn(async () => ok(initialized)),
    setKosmosynS7Enabled: vi.fn((_enabled: boolean) => pending) };
  const control = initKosmosynS7Control(api); control.apply(initialized); change(true); change(true);
  expect(toggle().checked).toBe(false); expect(api.setKosmosynS7Enabled).toHaveBeenCalledExactlyOnceWith(true);
  finish(ok({ ...initialized, enabled: true })); await vi.waitFor(() => expect(status()).toBe('Enabled'));
  api.setKosmosynS7Enabled.mockResolvedValueOnce(ok(initialized)); change(false);
  expect(toggle().checked).toBe(true); await vi.waitFor(() => expect(status()).toBe('Initialized — Off'));
  expect(api.setKosmosynS7Enabled).toHaveBeenLastCalledWith(false);
});

it('failed inspection leaves controls unavailable and visibly OFF; no ordinary Settings save wiring exists', async () => {
  const api = { getKosmosynS7State: vi.fn(async () => { throw new Error('IPC unavailable'); }),
    initializeKosmosynS7: vi.fn(async () => ok(initialized)), setKosmosynS7Enabled: vi.fn(async () => ok(initialized)) };
  const control = initKosmosynS7Control(api); await control.refresh();
  expect(toggle().checked).toBe(false); expect(toggle().disabled).toBe(true); expect(button().disabled).toBe(true); expect(error().hidden).toBe(false);
  expect(readFileSync('src/renderer/kosmosyn-s7-control.ts', 'utf8')).not.toContain('saveSettings');
  const preload = readFileSync('src/preload/index.ts', 'utf8');
  expect(preload.slice(preload.indexOf('export interface SettingsPatch'), preload.indexOf('/** One page'))).not.toContain('kosmosynS7');
});
