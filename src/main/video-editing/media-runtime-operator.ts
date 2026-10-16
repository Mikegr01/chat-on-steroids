import path from 'node:path';
import { z } from 'zod';
import { effectiveCapabilities, getConfig, updateConfig } from '../config.js';
import { mediaRuntimeAdmissionSchema } from '../../shared/media-runtime.js';
import { admitMediaRuntime, mediaRuntimeDiagnostics } from './media-runtime.js';

export const mediaRuntimePathsSchema = z.object({
  ffprobePath: z.string().min(1).max(4096).refine(path.isAbsolute, 'Absolute ffprobe path required'),
  ffmpegPath: z.string().min(1).max(4096).refine(path.isAbsolute, 'Absolute ffmpeg path required'),
}).strict();
type AssertOwner = () => Promise<void>;
interface OperatorPorts<T> {
  assertAccess(): void;
  admit(paths: z.infer<typeof mediaRuntimePathsSchema>): Promise<unknown>;
  save(admission: unknown, assertOwner: AssertOwner): Promise<void>;
  diagnostics(): Promise<T>;
}
/** One reservation for native renderer and exact-session Core requests; the engine owns trust. */
export function createMediaRuntimeOperator<T>(ports: OperatorPorts<T>) {
  let admitting = false;
  return {
    status: () => ports.diagnostics(),
    async admit(raw: unknown, confirm: (detail: string) => Promise<boolean>, assertOwner: AssertOwner) {
      const paths = mediaRuntimePathsSchema.parse(raw);
      if (admitting) throw new Error('Media runtime admission already active');
      admitting = true;
      const assertCurrent = async () => { await assertOwner(); ports.assertAccess(); };
      try {
        await assertCurrent();
        if (!await confirm(`Admit operator-managed media executables?\nffprobe: ${paths.ffprobePath}\nffmpeg: ${paths.ffmpegPath}\nThis runs version and generated-media capability checks and persists exact identities. No installation or download.`)) return { cancelled: true as const };
        await assertCurrent();
        const admission = await ports.admit(paths);
        await assertCurrent();
        await ports.save(admission, assertCurrent);
        return ports.diagnostics();
      } finally { admitting = false; }
    },
  };
}
function assertAccess(config = getConfig()) {
  if (config.readOnly || !effectiveCapabilities(config).read) throw new Error('Media runtime admission permission unavailable');
}
export const mediaRuntimeOperator = createMediaRuntimeOperator({
  assertAccess, admit: admitMediaRuntime,
  save: async (raw, assertOwner) => {
    const admission = mediaRuntimeAdmissionSchema.parse(raw);
    await updateConfig(async latest => { await assertOwner(); assertAccess(latest); return { ...latest, mediaRuntime: admission }; });
  },
  diagnostics: () => mediaRuntimeDiagnostics(getConfig().mediaRuntime),
});
