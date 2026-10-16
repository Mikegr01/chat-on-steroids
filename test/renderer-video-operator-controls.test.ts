import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let dom: JSDOM;
let init: typeof import('../src/renderer/video-operator-controls.js')['initVideoOperatorControls'];
beforeEach(async () => {
  dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'));
  vi.stubGlobal('document', dom.window.document);
  ({ initVideoOperatorControls: init } = await import('../src/renderer/video-operator-controls.js'));
});
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); });
const field = () => document.getElementById('videoOperatorJobId') as HTMLInputElement;
const button = (id: string) => document.getElementById(`videoOperator${id}`) as HTMLButtonElement;
const state = () => document.getElementById('videoOperatorState')!.textContent!;
const status = () => document.getElementById('videoOperatorStatus')!.textContent!;
const error = () => document.getElementById('videoOperatorError')!;
const ok = (data: unknown) => ({ ok: true as const, data });
const fingerprint = 'a'.repeat(64), preparedHash = 'b'.repeat(64);
// Inspection fixtures mirror the consumed projection of {job, preview}; no live ledger.
function selected() {
  return { capabilityAuthority: { confirmationValid: false, sourceEnd: 'unknown' }, job: { id: 'fixture-job', checkpoints: [], operatorAuthorizations: [], candidates: [{ id: 'candidate-1', plan: { id: 'plan-1' } }],
    workflow: { revision: 18, phase: 'selected', selection: { candidateId: 'candidate-1', operatorId: 'operator-ipc', kind: 'operator' },
      capabilityAdmission: { capabilityFingerprint: fingerprint, adapterEpoch: 'fixture-adapter:19' } } } };
}
function prepared() {
  const value = selected() as any;
  value.job.workflow.phase = 'prepared';
  value.job.workflow.prepared = { preparedHash, request: { timelineId: 'AI_fixture', planId: 'plan-1' } };
  value.capabilityAuthority = { confirmationValid: true, sourceEnd: 'inclusive' };
  return value;
}
function fixture(value: unknown = selected()) {
  const forbidden = vi.fn(() => { throw new Error('Unexpected authority or execution call'); });
  const api = { inspectVideoJob: vi.fn(async (_id: string) => ok(value)),
    confirmCapabilityAdmission: vi.fn(async (_id: string, _hash: string) => ok({ cancelled: true })),
    authorizeVideoJob: vi.fn(async (_id: string, _hash: string) => ok({ cancelled: true })),
    executeVideoJob: forbidden,
    execute: forbidden, liveManifest: forbidden, reconcile: forbidden, saveSettings: forbidden,
    createReceipt: forbidden, createAuthorization: forbidden };
  init(api); return { api, forbidden };
}
function change(id: string) { field().value = id; field().dispatchEvent(new dom.window.Event('input')); }
async function inspect() {
  change('fixture-job'); button('Inspect').click();
  await vi.waitFor(() => expect(button('Inspect').disabled).toBe(false));
}
function deferred() {
  let resolve!: (reply: ReturnType<typeof ok>) => void;
  const promise = new Promise<ReturnType<typeof ok>>(done => { resolve = done; });
  return { promise, resolve };
}

it('makes both native operator reviews reachable beside the existing Setup controls', () => {
  const dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'));
  try {
    const setup = dom.window.document.getElementById('videoMediaRuntimeControl')!.parentElement!;
    expect(setup.querySelector('#videoOperatorJobId')).not.toBeNull();
    expect(setup.querySelector('#videoOperatorInspect')?.textContent).toBe('Inspect job');
    expect(setup.querySelector('#videoOperatorCapabilityConfirm')?.textContent).toBe('Review capability confirmation');
    expect(setup.querySelector('#videoOperatorAuthorize')?.textContent).toBe('Review execution authorization');
  } finally { dom.window.close(); }
});

it('inspects the exact job ID, shows a compact read-only summary, and enables capability review', async () => {
  const f = fixture(); await inspect();
  expect(f.api.inspectVideoJob).toHaveBeenCalledExactlyOnceWith('fixture-job');
  for (const text of ['fixture-job', '18', 'selected', 'candidate-1', 'plan-1', fingerprint, 'fixture-adapter:19', 'Checkpoints: 0']) expect(state()).toContain(text);
  expect(button('CapabilityConfirm').disabled).toBe(false);
  expect(button('Authorize').disabled).toBe(true);
  const controls = document.getElementById('videoOperatorControls')!;
  expect(Array.from(controls.querySelectorAll('input, textarea, select')).map(node => node.id)).toEqual(['videoOperatorJobId']);
  expect(controls.querySelector('label')!.htmlFor).toBe('videoOperatorJobId');
  expect(error().getAttribute('role')).toBe('alert');
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('failed inspection clears old hashes, disables review and displays the backend error', async () => {
  const f = fixture(); await inspect();
  f.api.inspectVideoJob.mockResolvedValueOnce({ ok: false, error: 'Unknown video job' } as never);
  button('Inspect').click();
  await vi.waitFor(() => expect(error().hidden).toBe(false));
  expect(error().textContent).toContain('Unknown video job'); expect(state()).not.toContain(fingerprint);
  expect(button('CapabilityConfirm').disabled).toBe(true); expect(button('Authorize').disabled).toBe(true);
});

it('retains the legacy receipt visibly and enables fresh native review from main authority projection', async () => {
  const value = selected() as any;
  value.job.workflow.capabilityConfirmation = { id: 'historical-receipt-fixture' };
  const f = fixture(value); await inspect();
  expect(state()).toContain('historical receipt retained; fresh confirmation required');
  expect(button('CapabilityConfirm').disabled).toBe(false);
  expect(button('Authorize').disabled).toBe(true);
  button('CapabilityConfirm').click();
  expect(f.api.confirmCapabilityAdmission).toHaveBeenCalledExactlyOnceWith('fixture-job', fingerprint);
});

it('missing main authority projection disables all review', async () => {
  const value = selected() as any; delete value.capabilityAuthority;
  fixture(value); await inspect();
  expect(error().hidden).toBe(false);
  expect(button('CapabilityConfirm').disabled).toBe(true); expect(button('Authorize').disabled).toBe(true);
});

it('legacy preparation cannot enable execution authorization from receipt presence', async () => {
  const value = prepared(); value.capabilityAuthority = { confirmationValid: false, sourceEnd: 'unknown' };
  value.job.workflow.capabilityConfirmation = { id: 'historical-receipt-fixture' };
  fixture(value); await inspect(); expect(button('Authorize').disabled).toBe(true);
});

it('changing the job invalidates inspection even when returning A to B to A', async () => {
  fixture(); await inspect(); change('other-job'); change('fixture-job');
  expect(button('CapabilityConfirm').disabled).toBe(true); expect(state()).not.toContain(fingerprint);
});

it.each(['missing job', 'wrong owner', 'wrong revision', 'unknown phase', 'malformed admission', 'malformed preparation', 'missing checkpoints', 'malformed authority'])('fails closed on %s inspection', async kind => {
  const value = selected() as any;
  if (kind === 'missing job') delete value.job;
  if (kind === 'wrong owner') value.job.id = 'different-job';
  if (kind === 'wrong revision') value.job.workflow.revision = '18';
  if (kind === 'unknown phase') value.job.workflow.phase = 'executed';
  if (kind === 'malformed admission') value.job.workflow.capabilityAdmission.capabilityFingerprint = 'bad';
  if (kind === 'malformed preparation') value.job.workflow.prepared = { preparedHash };
  if (kind === 'missing checkpoints') delete value.job.checkpoints;
  if (kind === 'malformed authority') value.job.operatorAuthorizations = 'none';
  fixture(value); await inspect();
  expect(error().hidden).toBe(false); expect(button('CapabilityConfirm').disabled).toBe(true); expect(button('Authorize').disabled).toBe(true);
});

it.each(['workflow', 'selection', 'admission', 'receipt', 'preparation', 'phase', 'checkpoint', 'authority'])('withholds capability review for ineligible %s', async kind => {
  const value = selected() as any, workflow = value.job.workflow;
  if (kind === 'workflow') delete value.job.workflow;
  if (kind === 'selection') delete workflow.selection;
  if (kind === 'admission') delete workflow.capabilityAdmission;
  if (kind === 'receipt') { workflow.capabilityConfirmation = { id: 'receipt-fixture' }; value.capabilityAuthority.confirmationValid = true; }
  if (kind === 'preparation') workflow.prepared = prepared().job.workflow.prepared;
  if (kind === 'phase') workflow.phase = 'planning';
  if (kind === 'checkpoint') value.job.checkpoints = [{ state: 'claimed' }];
  if (kind === 'authority') value.job.operatorAuthorizations = [{ expiresAt: 1000 }];
  const f = fixture(value); await inspect(); button('CapabilityConfirm').click();
  expect(button('CapabilityConfirm').disabled).toBe(true); expect(f.api.confirmCapabilityAdmission).not.toHaveBeenCalled();
});

it('allows the repository-compatible selected preparation-blocked confirmation state', async () => {
  const value = selected() as any; value.job.workflow.phase = 'blocked'; value.job.workflow.blockedAt = 'preparing';
  fixture(value); await inspect(); expect(button('CapabilityConfirm').disabled).toBe(false);
});

it.each(['CapabilityConfirm', 'Authorize'])('derives %s arguments and suppresses duplicate native reviews while busy', async action => {
  const f = fixture(action === 'Authorize' ? prepared() : selected()); await inspect();
  const pending = deferred();
  const call = action === 'Authorize' ? f.api.authorizeVideoJob : f.api.confirmCapabilityAdmission;
  call.mockReturnValueOnce(pending.promise as never);
  button(action).click(); button(action).dispatchEvent(new dom.window.Event('click')); button('Inspect').click();
  expect(call).toHaveBeenCalledExactlyOnceWith('fixture-job', action === 'Authorize' ? preparedHash : fingerprint);
  expect(button('Inspect').disabled).toBe(true); expect(button('CapabilityConfirm').disabled).toBe(true); expect(button('Authorize').disabled).toBe(true);
  expect(status()).not.toMatch(/confirmed|authorized|executed/i);
  pending.resolve(ok({ cancelled: true }));
  await vi.waitFor(() => expect(f.api.inspectVideoJob).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(button('Inspect').disabled).toBe(false));
  expect(status()).toMatch(/cancelled/i); expect(status()).not.toMatch(/executed|confirmed|authorized/i);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it.each(['CapabilityConfirm', 'Authorize'])('refreshes after successful %s and paints only durable inspection state', async action => {
  const f = fixture(action === 'Authorize' ? prepared() : selected()); await inspect();
  const next = action === 'Authorize' ? prepared() : selected() as any;
  if (action === 'CapabilityConfirm') { next.job.workflow.revision = 19; next.job.workflow.capabilityConfirmation = { id: 'receipt-fixture' }; next.capabilityAuthority.confirmationValid = true; }
  else next.job.operatorAuthorizations = [{ expiresAt: Date.now() + 600000 }];
  f.api.inspectVideoJob.mockResolvedValueOnce(ok(next));
  const call = action === 'Authorize' ? f.api.authorizeVideoJob : f.api.confirmCapabilityAdmission;
  call.mockResolvedValueOnce(ok({ status: 'confirmed' }) as never);
  button(action).click();
  await vi.waitFor(() => expect(f.api.inspectVideoJob).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(button('Inspect').disabled).toBe(false));
  expect(state()).toContain(action === 'Authorize' ? 'Execution authorization: available: 1' : 'Capability confirmation: present');
  if (action === 'CapabilityConfirm') { expect(state()).toContain('Revision: 19'); expect(button(action).disabled).toBe(true); }
  expect(status()).toContain('Native review completed'); expect(f.forbidden).not.toHaveBeenCalled();
});

it.each(['CapabilityConfirm', 'Authorize'])('surfaces a stale %s rejection, refreshes, and never retries automatically', async action => {
  const f = fixture(action === 'Authorize' ? prepared() : selected()); await inspect();
  const call = action === 'Authorize' ? f.api.authorizeVideoJob : f.api.confirmCapabilityAdmission;
  call.mockResolvedValueOnce({ ok: false, error: 'Owner epoch changed' } as never);
  button(action).click();
  await vi.waitFor(() => expect(f.api.inspectVideoJob).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(button('Inspect').disabled).toBe(false));
  expect(error().textContent).toContain('Owner epoch changed'); expect(error().hidden).toBe(false); expect(call).toHaveBeenCalledOnce();
});

it.each(['CapabilityConfirm', 'Authorize'])('refreshes after a thrown %s transport error and fails closed if refresh also fails', async action => {
  const f = fixture(action === 'Authorize' ? prepared() : selected()); await inspect();
  const call = action === 'Authorize' ? f.api.authorizeVideoJob : f.api.confirmCapabilityAdmission;
  call.mockRejectedValueOnce(new Error('Transport failed'));
  f.api.inspectVideoJob.mockRejectedValueOnce(new Error('Inspection failed'));
  button(action).click(); await vi.waitFor(() => expect(button('Inspect').disabled).toBe(false));
  expect(error().textContent).toContain('Transport failed'); expect(error().textContent).toContain('Inspection failed');
  expect(button('CapabilityConfirm').disabled).toBe(true); expect(button('Authorize').disabled).toBe(true);
});

it('shows prepared hash and target and permits only authorization review', async () => {
  fixture(prepared()); await inspect();
  expect(state()).toContain(preparedHash); expect(state()).toContain('Timeline: AI_fixture'); expect(state()).toContain('Prepared: yes');
  expect(button('Authorize').disabled).toBe(false); expect(button('CapabilityConfirm').disabled).toBe(true);
  expect(document.getElementById('videoOperatorControls')!.textContent).toContain('does not execute Resolve');
});

it.each(['selected', 'blocked', 'no preparation', 'no target', 'executed'])('withholds authorization for %s state', async kind => {
  const value = prepared();
  if (kind === 'selected' || kind === 'blocked') value.job.workflow.phase = kind;
  if (kind === 'no preparation') delete value.job.workflow.prepared;
  if (kind === 'no target') delete value.job.workflow.prepared.request.timelineId;
  if (kind === 'executed') value.job.checkpoints = [{ state: 'verified' }];
  const f = fixture(value); await inspect(); button('Authorize').click();
  expect(button('Authorize').disabled).toBe(true); expect(f.api.authorizeVideoJob).not.toHaveBeenCalled();
});

it('discards late inspection after A to B to A without leaking old derived authority', async () => {
  const f = fixture(), pending = deferred(); f.api.inspectVideoJob.mockReturnValueOnce(pending.promise);
  change('fixture-job'); button('Inspect').click(); change('other-job'); change('fixture-job');
  pending.resolve(ok(selected())); await vi.waitFor(() => expect(button('Inspect').disabled).toBe(false));
  expect(state()).not.toContain(fingerprint); expect(button('CapabilityConfirm').disabled).toBe(true);
});

it.each(['CapabilityConfirm', 'Authorize'])('does not refresh or repaint another job after late %s completion', async action => {
  const f = fixture(action === 'Authorize' ? prepared() : selected()), pending = deferred(); await inspect();
  const call = action === 'Authorize' ? f.api.authorizeVideoJob : f.api.confirmCapabilityAdmission;
  call.mockReturnValueOnce(pending.promise as never); button(action).click(); change('other-job'); change('fixture-job');
  pending.resolve(ok({ cancelled: true })); await vi.waitFor(() => expect(button('Inspect').disabled).toBe(false));
  expect(f.api.inspectVideoJob).toHaveBeenCalledOnce(); expect(state()).not.toContain(fingerprint);
  expect(button('CapabilityConfirm').disabled).toBe(true); expect(button('Authorize').disabled).toBe(true);
});
