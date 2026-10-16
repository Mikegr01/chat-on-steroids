import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { initUcvValidationControls } from '../src/renderer/ucv-validation.js';

let dom: JSDOM;
beforeEach(() => { dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8')); vi.stubGlobal('document', dom.window.document); });
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); });
const button = () => document.getElementById('ucvValidationRun') as HTMLButtonElement;
const result = () => document.getElementById('ucvValidationResult')!;
const validated = { status: 'validated', contextId: '11111111-1111-4111-8111-111111111111', ucvResult: 'Verified',
  proofCreated: true, bindingValid: true, ttlValid: true, firstConsumption: 'success', replay: 'rejected', receiptCreated: false, disposed: true } as const;
const ok = (data: unknown) => ({ ok: true as const, data });

it('is an explicit separate action without a job input, startup invocation or capability review', async () => {
  const api = { validateWindowsVerification: vi.fn(async () => ok(validated)) };
  initUcvValidationControls(api as never);
  expect(document.getElementById('ucvValidationControls')!.querySelector('input')).toBeNull();
  expect(api.validateWindowsVerification).not.toHaveBeenCalled();
  (document.getElementById('videoOperatorJobId') as HTMLInputElement).value = 's75-absent-scope-live-acceptance-20261010';
  button().click(); await vi.waitFor(() => expect(button().disabled).toBe(false));
  expect(api.validateWindowsVerification).toHaveBeenCalledExactlyOnceWith();
  expect(result().textContent).toContain('Verified'); expect(result().textContent).toContain('Replay: rejected');
  expect(result().textContent).not.toContain('s75-absent-scope');
});
it('suppresses duplicate clicks and paints no success until a validated terminal reply arrives', async () => {
  let release!: (reply: ReturnType<typeof ok>) => void;
  const pending = new Promise<ReturnType<typeof ok>>(resolve => { release = resolve; });
  const api = { validateWindowsVerification: vi.fn(() => pending) }; initUcvValidationControls(api as never);
  button().click(); button().dispatchEvent(new dom.window.Event('click'));
  expect(api.validateWindowsVerification).toHaveBeenCalledOnce(); expect(button().disabled).toBe(true);
  expect(result().textContent).not.toContain('Verified'); release(ok(validated));
  await vi.waitFor(() => expect(button().disabled).toBe(false));
});
it.each([ok({ ...validated, replay: 'accepted' }), ok({ ...validated, receiptCreated: true }),
  ok({ ...validated, proof: 'secret' }), ok({}), { ok: false, error: 'Unavailable' }])
  ('fails closed on malformed/failing metadata %j without retry', async reply => {
    const api = { validateWindowsVerification: vi.fn(async () => reply) }; initUcvValidationControls(api as never);
    button().click(); await vi.waitFor(() => expect(button().disabled).toBe(false));
    expect(result().textContent).toContain('Validation stopped'); expect(result().textContent).not.toContain('Verified');
    expect(result().textContent).not.toContain('secret'); expect(api.validateWindowsVerification).toHaveBeenCalledOnce();
  });
it.each(['cancelled', 'not-verified'])('displays %s without claiming proof consumption or replay success', async status => {
  const api = { validateWindowsVerification: vi.fn(async () => ok({ status, contextId: validated.contextId,
    proofCreated: false, receiptCreated: false, disposed: true })) }; initUcvValidationControls(api as never);
  button().click(); await vi.waitFor(() => expect(button().disabled).toBe(false));
  expect(result().textContent).not.toContain('Replay: rejected'); expect(result().textContent).toContain('No proof or receipt created');
});
it('transport failure stops without another request', async () => {
  const api = { validateWindowsVerification: vi.fn(async () => { throw new Error('Lost transport'); }) };
  initUcvValidationControls(api as never); button().click(); await vi.waitFor(() => expect(button().disabled).toBe(false));
  expect(result().textContent).toContain('Validation stopped'); expect(api.validateWindowsVerification).toHaveBeenCalledOnce();
});
