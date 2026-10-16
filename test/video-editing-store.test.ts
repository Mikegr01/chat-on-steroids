import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { VideoEditingStore } from '../src/main/video-editing/store.js';
import { categoryCAuthority } from '../src/main/video-editing/authority.js';
import { canonicalJson } from '../src/main/video-editing/identity.js';
import { initDurableStore, resetDurableForTests, readStrictDurable, writeStrictDurableNow } from '../src/main/durable.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import { reviewedDocument } from './fixtures/video-editing.js';

let dir: string;
const operationId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const stateName = 'video-editing-jobs';
const claim = { jobId: 'job-1', planId: 'plan-1', timelineId: 'owned-timeline-1', step: 'assemble' as const,
  beforeEvidenceIds: ['before'], operationId };

async function storeWithJob(options: ConstructorParameters<typeof VideoEditingStore>[0] = {}) {
  const store = new VideoEditingStore(options);
  await store.restore();
  const job = reviewedDocument(); job.checkpoints = []; job.reviews = [];
  await store.put(job);
  return store;
}

beforeEach(async () => { dir = await makeTempDir('cos-video-editing-'); initDurableStore(dir); });
afterEach(async () => { resetDurableForTests(); await removeTempDir(dir); });

describe('S7.5 durable artifact and consumed operation custody', () => {
  it('serializes validated documents deterministically and returns isolated copies', async () => {
    const store = await storeWithJob(); const job = store.get('job-1')!;
    const reversed = Object.fromEntries(Object.entries(job).reverse());
    expect(canonicalJson(job)).toBe(canonicalJson(reversed));
    job.objective = 'caller overwrite';
    expect(store.get('job-1')!.objective).not.toBe(job.objective);
    const restored = new VideoEditingStore(); await restored.restore();
    expect(restored.get('job-1')).toEqual(store.get('job-1'));
  });

  it('durably consumes an operation before publishing its claimed checkpoint', async () => {
    const store = await storeWithJob(); const result = await store.claim(claim);
    expect(result.newlyClaimed).toBe(true);
    const read = await readStrictDurable(stateName, 1024 * 1024);
    expect(read.kind).toBe('valid');
    const restored = new VideoEditingStore(); await restored.restore();
    expect(await restored.claim(claim)).toMatchObject({ newlyClaimed: false, checkpoint: { state: 'claimed', operationId } });
  });

  it('rejects reused IDs with different intent and fresh IDs for consumed semantic steps', async () => {
    const store = await storeWithJob(); await store.claim(claim);
    await expect(store.claim({ ...claim, step: 'render' })).rejects.toThrow(/conflict/i);
    await expect(store.claim({ ...claim, operationId: secondId })).rejects.toThrow(/consumed/i);
  });

  it('serializes concurrent claims and never gives two consumers fresh custody', async () => {
    const store = await storeWithJob();
    const results = await Promise.all([store.claim(claim), store.claim(claim)]);
    expect(results.map(row => row.newlyClaimed)).toEqual([true, false]);
    expect(store.get('job-1')!.checkpoints).toHaveLength(1);
  });

  it('holds publication until the write barrier and freezes inputs before awaits', async () => {
    let release!: () => void; let writing!: () => void;
    const paused = new Promise<void>(resolve => { writing = resolve; });
    let hold = false;
    const store = await storeWithJob({ write: async value => {
      if (hold) { writing(); await new Promise<void>(resolve => { release = resolve; }); }
      await writeStrictDurableNow(stateName, value, 1024 * 1024);
    } });
    hold = true;
    const input = structuredClone(claim); const pending = store.claim(input);
    await paused;
    input.planId = 'foreign-plan';
    expect(store.get('job-1')!.checkpoints).toHaveLength(0);
    release();
    expect((await pending).checkpoint.planId).toBe('plan-1');
  });

  it('does not publish or silently retry a failed durable claim', async () => {
    let fail = false;
    const store = await storeWithJob({ write: async value => {
      if (fail) throw new Error('disk unavailable');
      await writeStrictDurableNow(stateName, value, 1024 * 1024);
    } });
    fail = true;
    await expect(store.claim(claim)).rejects.toThrow(/disk unavailable/i);
    expect(store.get('job-1')!.checkpoints).toHaveLength(0);
    await expect(store.claim(claim)).rejects.toThrow(/unavailable/i);
    const restored = new VideoEditingStore(); await restored.restore();
    expect(restored.get('job-1')!.checkpoints).toHaveLength(0);
  });

  it('persists ambiguity across restart and refuses both replay and rewritten outcomes', async () => {
    const store = await storeWithJob(); await store.claim(claim);
    await store.settle('job-1', operationId, 'ambiguous', []);
    const restored = new VideoEditingStore(); await restored.restore();
    expect(await restored.claim(claim)).toMatchObject({ newlyClaimed: false, checkpoint: { state: 'ambiguous' } });
    await expect(restored.settle('job-1', operationId, 'verified', ['after'])).rejects.toThrow(/settled/i);
  });

  it('joins verified before/after evidence and never treats a verified operation as fresh', async () => {
    const store = await storeWithJob(); await store.claim(claim);
    await expect(store.settle('job-1', operationId, 'verified', ['render'])).rejects.toThrow(/subject/i);
    await store.settle('job-1', operationId, 'verified', ['after']);
    const job = store.get('job-1')!; job.reviews = reviewedDocument().reviews;
    await store.put(job);
    const restored = new VideoEditingStore(); await restored.restore();
    expect(await restored.claim(claim)).toMatchObject({ newlyClaimed: false, checkpoint: { state: 'verified' } });
    expect(restored.get('job-1')!.reviews).toHaveLength(1);
  });

  it('rejects deleting custody, retargeting sessions and overwriting admitted source bytes', async () => {
    const store = await storeWithJob(); await store.claim(claim);
    const job = store.get('job-1')!; job.checkpoints = [];
    await expect(store.put(job)).rejects.toThrow(/immutable/i);
    const moved = store.get('job-1')!; moved.sessionId = 'other-session';
    await expect(store.put(moved)).rejects.toThrow(/identity/i);
    const changed = store.get('job-1')!; changed.media[0]!.path = 'D:/other.mp4';
    await expect(store.put(changed)).rejects.toThrow();
  });

  it('fails closed on corrupted custody and changed disk snapshots', async () => {
    const store = await storeWithJob();
    await fs.writeFile(path.join(dir, 'state', `${stateName}.json`), '{broken');
    await expect(store.claim(claim)).rejects.toThrow(/custody/i);
    const restored = new VideoEditingStore();
    await expect(restored.restore()).rejects.toThrow(/custody/i);
    await expect(restored.put(reviewedDocument())).rejects.toThrow(/unavailable/i);
  });

  it('rejects unsupported intent and refuses inferred timeline proof', async () => {
    const store = await storeWithJob();
    await expect(store.claim({ ...claim, timelineId: 'personal-timeline' })).rejects.toThrow(/evidence/i);
    const other = reviewedDocument(); other.id = 'job-2'; other.checkpoints = []; other.reviews = [];
    other.candidates[0]!.plan.features.push('title'); await store.put(other);
    await expect(store.claim({ ...claim, jobId: 'job-2' })).rejects.toThrow(/infeasible/i);
  });

  it('refuses to verify partial inspection or a nonmatching actual cut', async () => {
    const job = reviewedDocument(); job.checkpoints = []; job.reviews = [];
    job.evidence.find(row => row.id === 'after')!.timelineState!.complete = false;
    const store = new VideoEditingStore(); await store.restore(); await store.put(job); await store.claim(claim);
    await expect(store.settle('job-1', operationId, 'verified', ['after'])).rejects.toThrow(/verification/i);
    expect(store.get('job-1')!.checkpoints[0]!.state).toBe('claimed');
  });

  it('does not claim assembly on an observed nonempty target timeline', async () => {
    const job = reviewedDocument(); job.checkpoints = []; job.reviews = [];
    job.evidence.find(row => row.id === 'before')!.timelineState = structuredClone(job.evidence.find(row => row.id === 'after')!.timelineState);
    const store = new VideoEditingStore(); await store.restore(); await store.put(job);
    await expect(store.claim(claim)).rejects.toThrow(/empty/i);
  });

  it('cannot reuse a globally consumed operation identity for a different job', async () => {
    const store = await storeWithJob(); await store.claim(claim);
    const job = reviewedDocument(); job.id = 'job-2'; job.checkpoints = []; job.reviews = [];
    await store.put(job);
    await expect(store.claim({ ...claim, jobId: 'job-2' })).rejects.toThrow(/conflict/i);
  });

  it('restores a claim when a writer fails after the durable rename', async () => {
    let rejectAfterWrite = false;
    const store = await storeWithJob({ write: async value => {
      await writeStrictDurableNow(stateName, value, 1024 * 1024);
      if (rejectAfterWrite) throw new Error('receipt lost');
    } });
    rejectAfterWrite = true;
    await expect(store.claim(claim)).rejects.toThrow(/receipt lost/i);
    const restored = new VideoEditingStore(); await restored.restore();
    expect(await restored.claim(claim)).toMatchObject({ newlyClaimed: false });
  });

  it('bounds schema-valid aggregate bytes before storing a document', async () => {
    const job = reviewedDocument(); job.checkpoints = []; job.reviews = [];
    const profile = job.references[0]!;
    job.references = Array.from({ length: 20 }, (_, index) => ({ ...profile, id: index ? `profile-${index + 1}` : 'profile-1',
      sections: Array.from({ length: 100 }, (_, section) => ({ name: 'x'.repeat(2000), startMs: section * 100,
        endMs: section * 100 + 100, evidenceIds: ['ref-observation'] })) }));
    const store = new VideoEditingStore(); await store.restore();
    await expect(store.put(job)).rejects.toThrow(/byte limit/i);
    expect(store.get('job-1')).toBeUndefined();
  });

  it('cannot reset known consumed custody by restoring a now-missing file', async () => {
    const store = await storeWithJob(); await store.claim(claim);
    await fs.unlink(path.join(dir, 'state', `${stateName}.json`));
    await expect(store.restore()).rejects.toThrow(/missing/i);
    expect(store.get('job-1')!.checkpoints).toHaveLength(1);
    await expect(store.claim({ ...claim, operationId: secondId })).rejects.toThrow(/unavailable/i);
  });

  it('cannot restore an older valid snapshot over known consumed operations', async () => {
    const store = await storeWithJob(); const old = await readStrictDurable(stateName, 1024 * 1024);
    await store.claim(claim);
    if (old.kind !== 'valid') throw new Error('Fixture custody not stored');
    await writeStrictDurableNow(stateName, old.value, 1024 * 1024);
    await expect(store.restore()).rejects.toThrow(/immutable/i);
    expect(store.get('job-1')!.checkpoints).toHaveLength(1);
  });
});

it('keeps Category C closed even for a structurally valid STRONG_COMMIT fixture', () => {
  expect(categoryCAuthority({ sessionId: 'local-session-1', commandId: `cmd_s7_${operationId}`,
    conversationId: 'provider-conversation', nativeMessageId: 'native-message', proofLevel: 'STRONG_COMMIT' }))
    .toEqual({ allowed: false, reason: 'S7_FINAL_LIVE_CANARY_DEFERRED' });
  expect(() => categoryCAuthority({ proofLevel: 'weak' })).toThrow();
});
