import type { AppApi } from '../preload/index.js';
import type { MediaRuntimeDiagnostics } from '../shared/media-runtime.js';
import { $ } from './dom.js';

/** Candidate text is only a draft. Main owns identity, admission and persistence. */
export function initVideoMediaRuntime(api: Pick<AppApi, 'getVideoMediaRuntime' | 'admitVideoMediaRuntime' | 'pickVideoMediaExecutable'>) {
  const status = $('videoMediaState'), diagnostics = $('videoMediaDiagnostics'), error = $('videoMediaError');
  const probe = $<HTMLInputElement>('videoMediaFfprobePath'), mpeg = $<HTMLInputElement>('videoMediaFfmpegPath');
  const admit = $<HTMLButtonElement>('videoMediaAdmit'), refreshButton = $<HTMLButtonElement>('videoMediaRefresh');
  const chooseProbe = $<HTMLButtonElement>('videoMediaFfprobeChoose'), chooseMpeg = $<HTMLButtonElement>('videoMediaFfmpegChoose');
  let busy = false, edited = false;
  function paint(value: MediaRuntimeDiagnostics) {
    status.textContent = value.status;
    diagnostics.textContent = [
      ...(['ffprobe', 'ffmpeg'] as const).map(tool => {
        const row = value[tool];
        return `${tool.toUpperCase()}\nStatus: ${row.status}\nAdmitted path: ${row.path ?? '—'}\nSHA256: ${row.admittedSha256 ?? '—'}\nVersion: ${row.admittedVersion ?? '—'}`;
      }),
      `Capabilities: ${value.capabilities ? Object.entries(value.capabilities).map(([name, result]) => `${name}: ${result}`).join(', ') : '—'}`,
    ].join('\n\n');
    if (!edited) { probe.value = value.ffprobe.path ?? ''; mpeg.value = value.ffmpeg.path ?? ''; }
  }
  async function refresh() {
    const reply = await api.getVideoMediaRuntime();
    if (!reply.ok) throw new Error(reply.error);
    paint(reply.data);
  }
  async function operate(work: () => Promise<void>) {
    if (busy) return;
    busy = true; error.hidden = true;
    for (const control of [probe, mpeg, admit, refreshButton, chooseProbe, chooseMpeg]) control.disabled = true;
    try { await work(); }
    catch (failure) {
      error.textContent = failure instanceof Error ? failure.message : String(failure); error.hidden = false;
      status.textContent = 'ERROR';
    } finally {
      busy = false;
      for (const control of [probe, mpeg, admit, refreshButton, chooseProbe, chooseMpeg]) control.disabled = false;
    }
  }
  for (const field of [probe, mpeg]) field.addEventListener('input', () => { edited = true; });
  for (const [button, tool, field] of [[chooseProbe, 'ffprobe', probe], [chooseMpeg, 'ffmpeg', mpeg]] as const) {
    button.addEventListener('click', () => void operate(async () => {
      const reply = await api.pickVideoMediaExecutable(tool);
      if (!reply.ok) throw new Error(reply.error);
      if (reply.data !== null) { field.value = reply.data; edited = true; }
    }));
  }
  admit.addEventListener('click', () => void operate(async () => {
    const reply = await api.admitVideoMediaRuntime(probe.value, mpeg.value);
    if (!reply.ok) throw new Error(reply.error);
    if (!('cancelled' in reply.data)) edited = false;
    await refresh();
  }));
  refreshButton.addEventListener('click', () => void operate(refresh));
  return { refresh: () => operate(refresh) };
}
