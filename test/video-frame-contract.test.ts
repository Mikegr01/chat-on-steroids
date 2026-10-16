import { expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DAVINCI_ADAPTER_SOURCE } from '../src/main/plugins/davinci-adapter-source.js';
import { prepareExecution, verifyExecution } from '../src/main/video-editing/execution.js';
import { checkpointIntent } from '../src/main/video-editing/identity.js';
import { produceTimeline } from '../src/main/video-editing/producers.js';
import { videoDocument } from './fixtures/video-editing.js';
import { timelinePage } from './fixtures/video-observation.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const request = { planId: 'plan-1', timelineId: 'TL-1', beforeEvidenceIds: ['before'],
  operationId: '11111111-1111-4111-8111-111111111111' };
const capabilities = { tools: ['resolve_inspect', 'resolve_assemble_rough_cut'], sourceEnd: 'inclusive', acceptance: 'fixture' };
function contractJob(lengths: number[], startFrame: number, sourceStart = 0) {
  const job = videoDocument();
  job.resolveProjectId = 'PROJECT-1';
  const plan = job.candidates[0]!.plan;
  plan.timeline.durationFrames = lengths.reduce((sum, length) => sum + length, 0);
  let position = 0;
  plan.clips = lengths.map((length, index) => {
    const clip = { ...plan.clips[0]!, id: `clip-${index}`, source: { start: sourceStart, end: sourceStart + length },
      timeline: { start: position, end: position + length } };
    position += length;
    return clip;
  });
  job.evidence.push({ id: 'before', subject: 'timeline', subjectId: request.timelineId, basis: 'fixture',
    producer: { name: 'fixture', version: '1' }, observedAt: 2, confidence: 1, parents: [],
    timelineState: { resolveProjectId: job.resolveProjectId, fps: plan.timeline.fps, durationFrames: 0, startFrame,
      complete: true, items: [], ownership: { creationOperationId: 'prepare-1', sourceTimelineId: null } } });
  return job;
}

it('round-trips 1/2/23/24/25/48 frames and adjacent cuts through compiler, adapter and verifier', async () => {
  const cases = [
    { lengths: [24, 24], origin: 0, source: 0, inclusiveEnds: [23, 23], duration: 48 },
    { lengths: [24, 24], origin: 86400, source: 0, inclusiveEnds: [23, 23], duration: 48 },
    ...[
      { length: 1, end: 7 }, { length: 2, end: 8 }, { length: 23, end: 29 },
      { length: 24, end: 30 }, { length: 25, end: 31 }, { length: 48, end: 54 },
    ].map(({ length, end }) => ({ lengths: [length], origin: 86400, source: 7, inclusiveEnds: [end], duration: length })),
  ];
  const jobs = cases.map(row => contractJob(row.lengths, row.origin, row.source));
  const dir = await makeTempDir('cos-frame-contract-');
  try {
    const adapter = path.join(dir, 'adapter.py'), input = path.join(dir, 'cases.json');
    await fs.writeFile(adapter, DAVINCI_ADAPTER_SOURCE);
    const inputs = jobs.map((job, index) => {
      const prepared = prepareExecution(job, request, capabilities);
      expect(prepared.state).toBe('ready');
      expect(prepared.operations[0]!.arguments.segments.map(row => row.end_frame)).toEqual(cases[index]!.inclusiveEnds);
      return { startFrame: job.evidence.at(-1)!.timelineState!.startFrame, arguments: prepared.operations[0]!.arguments };
    });
    await fs.writeFile(input, JSON.stringify(inputs));
    const command = process.platform === 'win32' ? 'py' : 'python3';
    const prefix = process.platform === 'win32' ? ['-3.13'] : [];
    const result = spawnSync(command, [...prefix, path.resolve('test/fixtures/davinci-adapter-contract.py'), adapter, dir, input],
      { encoding: 'utf8', timeout: 30_000 });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const report = JSON.parse(result.stdout).frame_contract as Array<{ receipt: unknown;
      payload: Array<{ startFrame: number; endFrame: number; recordFrame: number }>;
      observation: ReturnType<typeof timelinePage> }>;
    for (const [index, job] of jobs.entries()) {
      const observed = report[index]!;
      expect(observed.receipt).toMatchObject({ requested: true, executed: true, verified: true, error: null });
      expect(observed.observation.items.map(row => row.duration)).toEqual(cases[index]!.lengths);
      expect(observed.payload.map(({ startFrame, endFrame, recordFrame }) => ({ startFrame, endFrame, recordFrame })))
        .toEqual(job.candidates[0]!.plan.clips.map(clip => ({ startFrame: clip.source.start, endFrame: clip.source.end,
          recordFrame: cases[index]!.origin + clip.timeline.start })));
      const after = produceTimeline([observed.observation], { id: 'after', subjectId: request.timelineId, observedAt: 3 });
      expect(after.status).toBe('VERIFIED');
      expect(after.evidence.timelineState!.durationFrames).toBe(cases[index]!.duration);
      expect(after.evidence.timelineState!.items.map(({ source, timeline }) => ({ source, timeline })))
        .toEqual(job.candidates[0]!.plan.clips.map(({ source, timeline }) => ({ source, timeline })));
      job.evidence.push(after.evidence);
      const checkpoint = { ...checkpointIntent(job, request.planId, request.timelineId, 'assemble', ['before'], request.operationId),
        state: 'claimed' as const, afterEvidenceIds: [] };
      expect(verifyExecution(job, checkpoint, ['after'])).toEqual({ status: 'VERIFIED', blockers: [] });
    }
  } finally { await removeTempDir(dir); }
});

it('preserves the measured short result instead of normalizing it into the intended length', () => {
  const job = contractJob([24, 24], 86400);
  const page = timelinePage();
  page.unique_id = request.timelineId; page.project_unique_id = job.resolveProjectId;
  page.duration_frames = 47;
  page.items = [0, 24].map((offset, index) => ({ ...page.items[0]!, unique_id: `item-${index}`,
    start: 86400 + offset, end: 86423 + offset, duration: 23, source_start: 0, source_end: 23 }));
  page.total = 2;
  const result = produceTimeline([page], { id: 'short-result', subjectId: page.unique_id, observedAt: 3 });
  expect(result.status).toBe('VERIFIED');
  expect(result.evidence.timelineState).toMatchObject({ durationFrames: 47,
    items: [{ source: { start: 0, end: 23 }, timeline: { start: 0, end: 23 } },
      { source: { start: 0, end: 23 }, timeline: { start: 24, end: 47 } }] });
  job.evidence.push(result.evidence);
  const checkpoint = { ...checkpointIntent(job, request.planId, request.timelineId, 'assemble', ['before'], request.operationId),
    state: 'claimed' as const, afterEvidenceIds: [] };
  expect(verifyExecution(job, checkpoint, [result.evidence.id])).toEqual({ status: 'DEVIATED', blockers: ['TIMELINE_INTENT_MISMATCH'] });
  expect(verifyExecution(job, { ...checkpoint, state: 'ambiguous' }, [result.evidence.id]))
    .toEqual({ status: 'AMBIGUOUS', blockers: ['CONSUMED_AMBIGUITY_PRESERVED'] });
});

it('normalizes both independently duration-proven source end conventions without changing timeline ends', () => {
  for (const length of [1, 2, 23, 24, 25, 48]) {
    for (const inclusive of [true, false]) {
      const page = timelinePage(); page.duration_frames = length;
      page.items[0] = { ...page.items[0]!, start: 86400, end: 86400 + length, duration: length,
        source_start: 7, source_end: 7 + length - (inclusive ? 1 : 0) };
      const result = produceTimeline([page], { id: 'source-round-trip', subjectId: page.unique_id, observedAt: 3 });
      expect(result.status).toBe('VERIFIED');
      expect(result.evidence.timelineState!.items[0]).toMatchObject({ source: { start: 7, end: 7 + length },
        timeline: { start: 0, end: length } });
    }
  }
});
