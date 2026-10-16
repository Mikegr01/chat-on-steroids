import { workRequestSchema, mediaAssetSchema, referenceProfileSchema, videoEvidenceSchema,
  type WorkRequest, type VideoEditingDocument, type VideoEvidence } from '../../shared/video-editing.js';
import { inspectArtifact, decodeImageArtifact, type ArtifactAccess } from './producers.js';
import { ResolveEvidenceReader } from './inspection.js';
import type { MediaRuntime } from './media-runtime.js';
import { frameRateSchema } from '../../shared/video-editing.js';
import type { Artifact } from './producers.js';
import { fingerprint, requestFingerprint } from './workflow-planning.js';

export type IngestionBatch = Pick<VideoEditingDocument, 'media' | 'references' | 'evidence'>;
export interface AssetIngestor { ingest(request: WorkRequest): Promise<IngestionBatch> }
/** Only approved reads. Missing technical/semantic analysis stays absent; operator ranges are intent. */
export function createAssetIngestor(options: { access: ArtifactAccess; reader?: ResolveEvidenceReader;
  runtime?: Pick<MediaRuntime, 'probe' | 'frame'>;
  frameSink?: (jobId: string, sourceHash: string, png: Buffer) => Promise<Artifact>;
  observationBasis?: 'measured' | 'fixture'; now?: () => number }): AssetIngestor {
  return { async ingest(raw) {
    const request = workRequestSchema.parse(raw), requestHash = requestFingerprint(request);
    if (options.observationBasis === 'fixture' && (process.env.NODE_ENV !== 'test' || process.env.VITEST !== 'true')) throw new Error('Fixture ingestion requires tests');
    const result: IngestionBatch = { media: [], references: [], evidence: [] };
    const stamps = new Map(request.assets.map(input => [input.id, {
      id: `evidence-${fingerprint({ requestHash, assetId: input.id, channel: 'identity' })}`,
      observedAt: options.now?.() ?? Date.now() }]));
    const resolveInputs = request.assets.filter(input => input.resolveMediaId);
    const acquiredMedia = options.reader && resolveInputs.length ? await options.reader.mediaBatch(resolveInputs.map(input => ({
      mediaPoolId: input.resolveMediaId!, mediaId: input.id, stamp: stamps.get(input.id)! })), options.access) : [];
    const observations = new Map(acquiredMedia.map(row => [row.asset.id, row]));
    for (const input of request.assets) {
      const artifact = await inspectArtifact(input.path, options.access, input.kind === 'image' ? 5 * 1024 * 1024 : undefined);
      const { id, observedAt } = stamps.get(input.id)!;
      let record: VideoEvidence = videoEvidenceSchema.parse({ id, subject: input.role === 'reference' ? 'reference' : 'media',
        subjectId: input.id, basis: 'measured', producer: { name: 'approved-local-artifact', version: '1' },
        observedAt, confidence: 1, parents: [], locator: artifact });
      let asset = mediaAssetSchema.parse({ id: input.id, path: artifact.path, sha256: artifact.sha256,
        status: 'partial', evidenceIds: [id], usableRanges: [], sceneRanges: [] });
      if (input.resolveMediaId && options.reader) {
        const acquired = observations.get(input.id)!;
        if (acquired.resolveProjectId !== request.resolveProjectId || acquired.asset.path !== artifact.path || acquired.asset.sha256 !== artifact.sha256)
          throw new Error('Requested asset/project does not match Resolve observation');
        asset = acquired.asset; record = acquired.evidence;
        if (options.observationBasis === 'fixture') record.basis = 'fixture';
        if (input.role === 'reference') record.subject = 'reference';
      }
      result.evidence.push(record);
      let probe: Awaited<ReturnType<MediaRuntime['probe']>>['technical'] | undefined;
      if (options.runtime && input.kind !== 'image') {
        probe = (await options.runtime.probe({ jobId: request.id, assetId: input.id, artifact }, options.access)).technical;
        if (probe.sourceHash !== artifact.sha256 || probe.assetId !== input.id || probe.jobId !== request.id) throw new Error('Technical observation identity mismatch');
        const probeId = `probe-${fingerprint({ requestHash, assetId: input.id, raw: probe.rawSha256 })}`;
        result.evidence.push(videoEvidenceSchema.parse({ ...record, id: probeId, basis: 'measured', producer: { name: 'ffprobe', version: probe.producer.version },
          technical: probe, acquisition: { tool: 'ffprobe', rawSha256: probe.rawSha256 } }));
        asset.evidenceIds.push(probeId); asset.technical = probe;
        const videos = probe.streams.filter(row => row.kind === 'video'), audios = probe.streams.filter(row => row.kind === 'audio');
        asset.video = videos.length > 0; asset.audio = audios.length > 0; asset.audioChannels = audios[0]?.channels;
        asset.container = probe.format.name; asset.codec = videos[0]?.codec ?? audios[0]?.codec;
        if (videos.length === 1) {
          const video = videos[0]!; asset.width = video.width; asset.height = video.height;
          const rate = frameRateSchema.safeParse(video.avgFrameRate);
          const nominal=video.nominalFrameRate;
          const compatible=rate.success && nominal && nominal.numerator*rate.data.denominator===rate.data.numerator*nominal.denominator;
          // Unequal/unknown rates retain exact probe facts but cannot supply a constant-frame editing timebase.
          if (!compatible) asset.fps=undefined;
          if (rate.success && compatible) {
            if (asset.fps && asset.fps.numerator * rate.data.denominator !== rate.data.numerator * asset.fps.denominator) throw new Error('Resolve/probe source timebase conflict');
            asset.fps = rate.data;
          }
          if (video.frameCount) asset.durationFrames = asset.durationFrames ? Math.min(asset.durationFrames, video.frameCount) : video.frameCount;
        }
      }
      if (input.role === 'reference') {
        const technical = input.kind === 'image' ? { kind: 'image' as const, ...await decodeImageArtifact(artifact, options.access) } :
          asset.video === true ? { kind: 'video' as const, width: asset.width, height: asset.height, fps: asset.fps, durationFrames: asset.durationFrames } : undefined;
        const metadata = technical ? { kind: technical.kind, width: technical.width, height: technical.height,
          ...('fps' in technical ? { fps: technical.fps, durationFrames: technical.durationFrames } : {}) } : undefined;
        result.references.push(referenceProfileSchema.parse({ id: `profile-${fingerprint({ requestHash, assetId: input.id })}`,
          referenceId: input.id, status: 'partial', evidenceIds: asset.evidenceIds, technical: metadata, technicalProbe: probe }));
        if (probe) {
          const profile = result.references.at(-1)!, video = probe.streams.find(row => row.kind === 'video');
          profile.sampleStatus = 'UNAVAILABLE'; profile.sampleEvidenceIds = [];
          if (video?.frameCount && options.frameSink) for (const frameIndex of [...new Set([0, Math.min(1000, Math.floor(video.frameCount / 2)), Math.min(1000, video.frameCount - 1)])]) {
            try {
              const sample = await options.runtime!.frame({ jobId: request.id, assetId: input.id, artifact }, probe, { frameIndex, streamIndex: video.index }, options.access);
              const locator = await options.frameSink(request.id, artifact.sha256, sample.png);
              const sampleId = `sample-${fingerprint({ requestHash, source: artifact.sha256, frameIndex, image: locator.sha256 })}`;
              result.evidence.push(videoEvidenceSchema.parse({ id: sampleId, subject: 'reference', subjectId: input.id,
                basis: 'measured', producer: { name: 'ffmpeg', version: sample.producer.version }, observedAt: Date.now(), confidence: sample.confidence,
                parents: [], locator, mediaSample: { sourceHash: sample.sourceHash, requestedFrame: frameIndex,
                  image:sample.image, actualTimestamp: sample.actual?.timestamp, position: sample.position, executableHash: sample.producer.executableHash, decodeSha256: sample.decodeSha256 } }));
              profile.sampleEvidenceIds.push(sampleId); profile.evidenceIds.push(sampleId);
            } catch (error) {
              // Permission/identity changes revoke the whole acquisition; decoder failures stay visible as unavailable samples.
              if (!/^Error: (Media (exit|process timeout|stdout bound|stderr bound)|Frame (artifact bound|format\/dimension bound))/.test(String(error))) throw error;
            }
          }
          if (profile.sampleEvidenceIds.length) profile.sampleStatus = 'AVAILABLE';
        }
      } else {
        if (input.usable) {
          const selectedId = `evidence-${fingerprint({ requestHash, assetId: input.id, channel: 'operator-ranges' })}`;
          result.evidence.push(videoEvidenceSchema.parse({ id: selectedId, subject: 'media', subjectId: input.id, basis: 'inferred',
            producer: { name: 'operator-range-selection', version: '1' }, observedAt, confidence: 1, parents: [id] }));
          asset.evidenceIds.push(selectedId);
          asset.usableRanges = input.usable.ranges.map(range => ({ ...range, evidenceIds: [selectedId] }));
        }
        result.media.push(asset);
      }
    }
    return result;
  } };
}
