import { z } from 'zod';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const rational = z.object({ numerator: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  denominator: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
export const executableIdentitySchema = z.object({ path: z.string().min(1).max(4096), sha256: hash,
  bytes: z.number().int().positive().max(256 * 1024 * 1024), version: z.string().min(1).max(128),
  versionOutput: z.string().min(1).max(8192), platform: z.string().min(1).max(32), admittedAt: z.number().int().nonnegative() }).strict();
export const mediaRuntimeAdmissionSchema = z.object({ version: z.literal(1), strategy: z.literal('operator-managed'),
  ffprobe: executableIdentitySchema, ffmpeg: executableIdentitySchema,
  capabilities: z.object({ jsonProbe: z.literal('SUPPORTED'), pngFrames: z.literal('SUPPORTED'), decodedFramePositions:z.literal('SUPPORTED') }).strict() }).strict();
export type MediaRuntimeAdmission = z.infer<typeof mediaRuntimeAdmissionSchema>;
export interface MediaRuntimeDiagnostics {
  status: 'CONFIGURED' | 'NOT_CONFIGURED' | 'IDENTITY_CHANGED' | 'UNSUPPORTED' | 'ERROR';
  ffprobe: { status: string; path?: string; admittedVersion?: string; admittedSha256?: string };
  ffmpeg: { status: string; path?: string; admittedVersion?: string; admittedSha256?: string };
  capabilities?: MediaRuntimeAdmission['capabilities'];
  runtime?: MediaRuntimeAdmission;
}
export type MediaRuntimeOperatorResult = MediaRuntimeDiagnostics | { cancelled: true };
export const technicalMediaSchema = z.object({ version: z.literal(1), jobId: z.string().min(1).max(128), assetId: z.string().min(1).max(128),
  sourceHash: hash, rawSha256: hash, observedAt: z.number().int().nonnegative(), normalizationVersion: z.literal('1'),
  producer: z.object({ name: z.enum(['ffprobe', 'ffmpeg']), version: z.string().max(128), executableHash: hash }).strict(),
  format: z.object({ name: z.string().max(200).optional(), duration: rational.optional(), bytes: z.number().int().nonnegative().optional(),
    bitrate: z.number().int().nonnegative().optional() }).strict(),
  streams: z.array(z.object({ index: z.number().int().nonnegative().max(100), kind: z.enum(['video', 'audio', 'subtitle', 'data', 'attachment']),
    codec: z.string().max(128).optional(), width: z.number().int().positive().max(65536).optional(), height: z.number().int().positive().max(65536).optional(),
    avgFrameRate: rational.optional(), nominalFrameRate: rational.optional(), timeBase: rational.optional(),
    duration: rational.optional(), frameCount: z.number().int().positive().max(1e9).optional(),
    sampleAspect: rational.optional(), pixelFormat: z.string().max(128).optional(), rotation: z.number().min(-360).max(360).optional(),
    sampleRate: z.number().int().positive().max(768000).optional(), channels: z.number().int().positive().max(128).optional(),
    channelLayout: z.string().max(128).optional() }).strict()).min(1).max(32),
}).strict();
export type TechnicalMedia = z.infer<typeof technicalMediaSchema>;
