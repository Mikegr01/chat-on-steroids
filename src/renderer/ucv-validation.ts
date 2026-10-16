import type { AppApi } from '../preload/index.js';
import { ucvValidationResultSchema } from '../shared/ucv-validation.js';
import { $ } from './dom.js';

/** Explicit action only. No job identity, startup probe, credentials, retry or authority call. */
export function initUcvValidationControls(api: Pick<AppApi, 'validateWindowsVerification'>): void {
  const button = $<HTMLButtonElement>('ucvValidationRun'), result = $('ucvValidationResult');
  let busy = false;
  button.addEventListener('click', () => void run());
  async function run() {
    if (busy) return;
    busy = true; button.disabled = true;
    result.textContent = 'Waiting for native review and Windows verification…';
    try {
      const reply = await api.validateWindowsVerification();
      if (!reply.ok) throw new Error(reply.error);
      const parsed = ucvValidationResultSchema.safeParse(reply.data);
      if (!parsed.success) throw new Error('Invalid validation result');
      const value = parsed.data;
      result.textContent = value.status === 'validated'
        ? `Windows: Verified\nProof binding and lifetime: valid\nFirst consumption: success\nReplay: rejected\nReceipt: none\nContext: ${value.contextId}\nDisposed: yes`
        : `${value.status === 'cancelled' ? 'Native review cancelled.' : 'Windows verification did not succeed.'}\nNo proof or receipt created. Disposable context released.`;
    } catch {
      // Keep unvalidated transport/error payloads out of the metadata-only UI.
      result.textContent = 'Validation stopped. No success is established. No automatic retry.';
    } finally { busy = false; button.disabled = false; }
  }
}
