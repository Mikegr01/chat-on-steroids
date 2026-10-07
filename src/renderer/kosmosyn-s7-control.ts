import type { AppApi } from '../preload/index.js';
import type { Config } from '../shared/types.js';
import { $ } from './dom.js';

/** This control never participates in the generic Settings snapshot/save queue. */
export function initKosmosynS7Control(api: Pick<AppApi, 'getKosmosynS7State' | 'initializeKosmosynS7' | 'setKosmosynS7Enabled'>) {
  const status = $('kosmosynS7State'), error = $('kosmosynS7Error');
  const initialize = $<HTMLButtonElement>('kosmosynS7Initialize');
  const enabled = $<HTMLInputElement>('kosmosynS7Enabled');
  let state: Config['kosmosynS7'] | null = null;
  let busy = false;
  function paint() {
    status.textContent = !state?.initialized ? 'Uninitialized' : state.enabled ? 'Enabled' : 'Initialized — Off';
    initialize.disabled = busy || !state || state.initialized;
    enabled.disabled = busy || !state?.initialized;
    enabled.checked = !!state?.initialized && state.enabled;
  }
  async function operate(work: () => ReturnType<AppApi['getKosmosynS7State']>) {
    if (busy) return;
    busy = true; error.hidden = true; paint();
    try {
      const reply = await work();
      if (reply.ok) state = reply.data;
      else {
        // A rejected transition leaves the published main-process gate authoritative.
        const current = await api.getKosmosynS7State();
        state = current.ok ? current.data : null;
        error.textContent = reply.error; error.hidden = false;
      }
    } catch {
      state = null;
      error.textContent = 'S7 state unavailable. Reopen Settings to retry.'; error.hidden = false;
    } finally { busy = false; paint(); }
  }
  initialize.addEventListener('click', () => { if (!initialize.disabled) void operate(() => api.initializeKosmosynS7()); });
  enabled.addEventListener('change', () => {
    const requested = enabled.checked;
    paint();
    if (!enabled.disabled) void operate(() => api.setKosmosynS7Enabled(requested));
  });
  paint();
  return {
    apply(next: Config['kosmosynS7']) { if (!busy) { state = next ?? null; paint(); } },
    refresh() { return operate(() => api.getKosmosynS7State()); }
  };
}
