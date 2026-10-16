import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initVideoOperatorControls } from '../src/renderer/video-operator-controls.js';

let dom: JSDOM;
beforeEach(() => { dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8')); vi.stubGlobal('document', dom.window.document); });
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); });
const button = (id: string) => document.getElementById(`videoOperator${id}`) as HTMLButtonElement;
const hash = 'b'.repeat(64), manifest = 'c'.repeat(64), authorizationId = '11111111-1111-4111-8111-111111111111';
function fixture(eligible = true) {
  const value = { job: { id: 'job-1', checkpoints: [], workflow: { phase: 'prepared', revision: 7,
    prepared: { preparedHash: hash, request: { timelineId: 'timeline-1', planId: 'plan-1' } } } },
    capabilityAuthority: { confirmationValid: true, sourceEnd: 'inclusive' },
    nativeExecution: eligible ? { eligible: true, expectedPreparedHash: hash, authorizationId, reviewedManifestHash: manifest } : { eligible: false } };
  const api = { inspectVideoJob: vi.fn(async () => ({ ok: true, data: value })),
    authorizeVideoJob: vi.fn(), confirmCapabilityAdmission: vi.fn(),
    executeVideoJob: vi.fn(async () => ({ ok: true, data: { status: 'VERIFIED' } })) };
  initVideoOperatorControls(api as never);
  const input = document.getElementById('videoOperatorJobId') as HTMLInputElement;
  const change = (id: string) => { input.value = id; input.dispatchEvent(new dom.window.Event('input')); };
  const inspect = async () => { change('job-1'); button('Inspect').click(); await vi.waitFor(() => expect(button('Inspect').disabled).toBe(false)); };
  return { api, value, change, inspect };
}
it('exposes native execute only after exact eligible inspection and sends bounded selectors once', async () => {
  const f = fixture();
  expect(button('Execute')).not.toBeNull(); expect(button('Execute').hidden).toBe(true);
  await f.inspect(); expect(button('Execute').hidden).toBe(false); expect(button('Execute').disabled).toBe(false);
  button('Execute').click(); button('Execute').click();
  await vi.waitFor(() => expect(f.api.inspectVideoJob).toHaveBeenCalledTimes(2));
  expect(f.api.executeVideoJob).toHaveBeenCalledExactlyOnceWith('job-1', hash, authorizationId, manifest);
  expect(document.getElementById('videoOperatorStatus')!.textContent).toContain('VERIFIED');
});
it('keeps historical or incomplete native inspection unavailable', async () => {
  const f = fixture(false); await f.inspect();
  expect(button('Execute').hidden).toBe(true); expect(button('Execute').disabled).toBe(true);
  button('Execute').click(); expect(f.api.executeVideoJob).not.toHaveBeenCalled();
  f.api.inspectVideoJob.mockResolvedValueOnce({ ok: true, data: { ...f.value, nativeExecution: { eligible: true } } } as never);
  button('Inspect').click(); await vi.waitFor(() => expect(document.getElementById('videoOperatorError')!.hidden).toBe(false));
  expect(button('Execute').disabled).toBe(true);
});
it('cancellation and ambiguity are shown truthfully and never retried', async () => {
  const f = fixture(); await f.inspect();
  f.api.executeVideoJob.mockResolvedValueOnce({ ok: true, data: { status: 'FAILED_BEFORE_MUTATION', failed: ['NATIVE_OPERATOR_CANCELLED'] } } as never);
  button('Execute').click(); await vi.waitFor(() => expect(button('Inspect').disabled).toBe(false));
  expect(document.getElementById('videoOperatorStatus')!.textContent).toContain('FAILED_BEFORE_MUTATION');
  f.api.executeVideoJob.mockResolvedValueOnce({ ok: true, data: { status: 'AMBIGUOUS' } });
  button('Execute').click(); await vi.waitFor(() => expect(button('Inspect').disabled).toBe(false));
  expect(document.getElementById('videoOperatorStatus')!.textContent).toContain('AMBIGUOUS');
  expect(f.api.executeVideoJob).toHaveBeenCalledTimes(2);
});
it('A to B to A edits invalidate a late execution response and its refresh', async () => {
  const f = fixture(); await f.inspect();
  let finish!: (value: any) => void;
  f.api.executeVideoJob.mockImplementationOnce(() => new Promise(done => { finish = done; }));
  button('Execute').click(); f.change('other-job'); f.change('job-1'); finish({ ok: true, data: { status: 'VERIFIED' } });
  await vi.waitFor(() => expect(button('Inspect').disabled).toBe(false));
  expect(button('Execute').hidden).toBe(true); expect(f.api.inspectVideoJob).toHaveBeenCalledOnce();
  expect(document.getElementById('videoOperatorStatus')!.textContent).toBe('');
});
