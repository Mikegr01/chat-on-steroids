import { z } from 'zod';
import { technicalMediaSchema, type MediaRuntimeAdmission } from '../../shared/media-runtime.js';
import { createHash } from 'node:crypto';
import type { Artifact } from './producers.js';
export interface MediaSource { jobId: string; assetId: string; artifact: Artifact }
export function ratio(raw: unknown, separator = '/') {
  if (raw === undefined || raw === null || raw === 'N/A' || raw === '0/0' || raw === '0:1') return;
  if (typeof raw !== 'string') throw new Error('Rational metadata malformed');
  const parts = raw.split(separator);
  if (parts.length !== 2 || parts.some(part => !/^\d+$/.test(part))) throw new Error('Rational metadata malformed');
  const numerator = Number(parts[0]), denominator = Number(parts[1]);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) throw new Error('Rational metadata bound');
  if (!numerator) return;
  return { numerator, denominator };
}
export function decimal(raw: unknown) {
  if (raw === undefined || raw === null || raw === 'N/A') return;
  if (typeof raw !== 'string' || !/^\d+(\.\d{1,9})?$/.test(raw)) throw new Error('Duration metadata malformed');
  const [whole, fractional = ''] = raw.split('.');
  const numerator = Number(whole + fractional), denominator = 10 ** fractional.length;
  if (!Number.isSafeInteger(numerator)) throw new Error('Duration metadata bound');
  return { numerator, denominator };
}
function integer(raw: unknown) {
  if (raw === undefined || raw === 'N/A' || raw === null) return;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) raw = Number(raw);
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) throw new Error('Integer metadata malformed');
  return raw;
}
export function normalizeProbe(raw: unknown, source: MediaSource, executable: MediaRuntimeAdmission['ffprobe'], rawBytes: Buffer = Buffer.from(JSON.stringify(raw))) {
  const parsed = z.object({ format: z.record(z.string(), z.unknown()).optional(),
    streams: z.array(z.record(z.string(), z.unknown())).min(1).max(32) }).passthrough().parse(raw);
  const indices = parsed.streams.map(row => row.index);
  if (new Set(indices).size !== indices.length) throw new Error('Duplicate stream identity');
  const format = parsed.format ?? {};
  return technicalMediaSchema.parse({ version: 1, jobId: source.jobId, assetId: source.assetId, sourceHash: source.artifact.sha256,
    rawSha256: createHash('sha256').update(rawBytes).digest('hex'), observedAt: Date.now(), normalizationVersion: '1',
    producer: { name: 'ffprobe', version: executable.version, executableHash: executable.sha256 },
    format: { name: format.format_name, duration: decimal(format.duration), bytes: integer(format.size), bitrate: integer(format.bit_rate) },
    streams: parsed.streams.map(row => ({
      index: row.index, kind: row.codec_type, codec: row.codec_name,
      width: integer(row.width), height: integer(row.height),
      avgFrameRate: ratio(row.avg_frame_rate), nominalFrameRate: ratio(row.r_frame_rate), timeBase: ratio(row.time_base),
      duration: decimal(row.duration), frameCount: integer(row.nb_frames),
      sampleAspect: ratio(row.sample_aspect_ratio, ':'), pixelFormat: row.pix_fmt,
      rotation: Array.isArray(row.side_data_list) ? row.side_data_list.find((value: unknown) => !!value && typeof value === 'object' && 'rotation' in value)?.rotation : undefined,
      sampleRate: integer(row.sample_rate), channels: integer(row.channels), channelLayout: row.channel_layout,
    })) });
}
