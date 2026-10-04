import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { ChatObservation } from '../src/main/session/recorder.js';
import {
  enqueueShadowV0,
  observationDocumentMetadata,
  resetShadowV0ForTests,
  setShadowV0FaultForTests,
  settleShadowV0ForTests,
  shadowV0SnapshotForTests
} from '../src/main/browser-transport/shadow.js';

const conversation = 'conversation-a';
const assistant = (messageId: string, providerMessageId?: string, state: 'streaming' | 'final' = 'streaming', extra: Record<string, unknown> = {}): ChatObservation =>
  ({ kind: 'assistant_message', time: 100, messageId, ...(providerMessageId ? { providerMessageId } : {}), state, ...extra }) as ChatObservation;
const start = (turnId: string): ChatObservation => ({ kind: 'turn_start', time: 100, turnId });
const end = (turnId: string, outcome: ChatObservation['outcome'], time = 100): ChatObservation => ({ kind: 'turn_end', time, turnId, outcome });
const user = (messageId: string): ChatObservation => ({ kind: 'user_message', time: 100, messageId, text: 'secret user text' });
function send(...observations: ChatObservation[]) { enqueueShadowV0(conversation, observations); }
async function facts() { await settleShadowV0ForTests(); return shadowV0SnapshotForTests().observations as Array<Record<string, any>>; }
function document(observation: ChatObservation, browserDocumentId: string) {
  observationDocumentMetadata.set(observation, { browserDocumentId });
  return observation;
}

beforeEach(() => { resetShadowV0ForTests(); process.env.CLF_KOSMOSYN_SHADOW_V0 = '1'; });
afterEach(() => { delete process.env.CLF_KOSMOSYN_SHADOW_V0; resetShadowV0ForTests(); });

describe('Kosmosyn S2 read-only observation', () => {
  it('admits assistant first sight and streaming to final once', async () => {
    send(assistant('M1', 'P1'), assistant('M1', 'P1', 'final'), assistant('M1', 'P1', 'final'));
    expect((await facts()).map(f => [f.kind, f.state])).toEqual([
      ['ASSISTANT_MESSAGE_OBSERVED', 'streaming'], ['ASSISTANT_MESSAGE_OBSERVED', 'final']
    ]);
  });

  it('converges provider evolution and logical reload aliases without a second entity', async () => {
    send(assistant('M1', 'P1'), assistant('M1', 'P2'), assistant('M2', 'P1'));
    const rows = await facts();
    expect(rows).toHaveLength(3);
    expect(rows.map(f => f.firstLogicalMessageId)).toEqual(['M1', 'M1', 'M1']);
    expect(rows[2]!.observedLogicalMessageId).toBe('M2');
  });

  it('keeps unproved identities distinct and rejects conflicting aliases', async () => {
    send(assistant('M1'), assistant('M2', 'P1'), assistant('M1', 'P2'), assistant('M2', 'P2'));
    const rows = await facts();
    expect(rows.filter(f => f.changes?.includes('ENTITY_CREATED'))).toHaveLength(2);
    expect(shadowV0SnapshotForTests().counters.rejected).toBe(1);
  });

  it('admits named turn starts and terminal outcomes', async () => {
    send(start('T1'), end('T1', 'completed'));
    expect((await facts()).map(f => f.kind)).toEqual(['TURN_START_OBSERVED', 'TURN_END_OBSERVED']);
  });

  it('preserves first turn start and terminal provenance while accepting stopped strengthening', async () => {
    send(document(start('T1'), 'A'), document(start('T1'), 'B'), document(end('T1', 'completed', 100), 'A'), document(end('T1', 'stopped', 101), 'B'));
    expect((await facts()).map(f => [f.kind, f.browserDocumentId])).toEqual([
      ['TURN_START_OBSERVED', 'A'], ['TURN_END_OBSERVED', 'A'], ['TURN_END_OBSERVED', 'B']
    ]);
  });

  it('clears pending alias knowledge after processing failure', async () => {
    setShadowV0FaultForTests('processing');
    send(assistant('M1', 'P1'));
    await facts();
    setShadowV0FaultForTests(null);
    send(assistant('M2', 'P1'));
    expect((await facts())[0]!.firstLogicalMessageId).toBe('M2');
  });

  it('shares the 256 fact cap and does not remember a dropped alias', async () => {
    send(assistant('M1', 'P1'), ...Array.from({ length: 255 }, (_, i) => user(`U${i}`)));
    await facts();
    send(assistant('M2', 'P1'));
    expect((await facts())).toHaveLength(256);
    expect(shadowV0SnapshotForTests().counters.dropped).toBe(1);
  });

  it('adds a provider to a provider-less logical entity and keeps historical provider aliases', async () => {
    send(assistant('M1'), assistant('M1', 'P1'), assistant('M1', 'P2'), assistant('M1', 'P3'), assistant('M2', 'P1'));
    const rows = await facts();
    expect(rows.map(f => f.firstLogicalMessageId)).toEqual(['M1', 'M1', 'M1', 'M1', 'M1']);
    expect(shadowV0SnapshotForTests().aliasCounts).toEqual({ entities: 1, logical: 2, provider: 3 });
  });

  it('scopes logical and provider identity to conversation', async () => {
    send(assistant('M1', 'P1'));
    enqueueShadowV0('conversation-b', [assistant('M1', 'P1')]);
    expect((await facts()).filter(f => f.kind === 'ASSISTANT_MESSAGE_OBSERVED')).toHaveLength(2);
    expect(shadowV0SnapshotForTests().aliasCounts.entities).toBe(2);
  });

  it('keeps final monotonic across stale streaming retries and safely adds a late alias', async () => {
    send(assistant('M1', 'P1', 'final'), assistant('M1', 'P1'), assistant('M2', 'P1'));
    const rows = await facts();
    expect(rows).toHaveLength(2);
    expect(rows.map(f => f.state)).toEqual(['final', 'final']);
    expect(rows[1]!.changes).toContain('LOGICAL_ALIAS_ADDED');
    expect(rows[1]!.changes).not.toContain('FINALIZED');
  });

  it('keeps first assistant turn association and ignores conflicting turn fields', async () => {
    send(assistant('M1', 'P1', 'streaming', { turnId: 'T1' }), assistant('M1', 'P2', 'final', { turnId: 'T2' }));
    const rows = await facts();
    expect(rows[0]!.turnId).toBe('T1');
    expect(rows[1]!.turnId).toBeUndefined();
    expect(rows[1]!.changes).not.toContain('TURN_ASSOCIATED');
    send(assistant('M2', 'P1', 'final', { turnId: 'T1' }));
    expect((await facts())[2]!.firstLogicalMessageId).toBe('M1');
  });

  it('associates a turn only when first supplied and admits one fact for multiple changes', async () => {
    send(assistant('M1'), assistant('M1', 'P1', 'final', { turnId: 'T1' }));
    const rows = await facts();
    expect(rows).toHaveLength(2);
    expect(rows[1]!.changes).toEqual(['PROVIDER_ALIAS_ADDED', 'FINALIZED', 'TURN_ASSOCIATED']);
  });

  it('preserves document provenance across alias and final transitions without a replay transition', async () => {
    send(document(assistant('M1', 'P1'), 'A'), document(assistant('M1', 'P1'), 'B'), document(assistant('M2', 'P1', 'final'), 'B'));
    expect((await facts()).map(f => [f.browserDocumentId, f.firstLogicalMessageId])).toEqual([['A', 'M1'], ['B', 'M1']]);
  });

  it('ignores text, markup, model, authored time, and document-only revisions', async () => {
    send(document(assistant('M1', 'P1', 'streaming', { text: 'private-a', renderedHtml: '<b>a</b>' }), 'A'));
    await facts();
    send(document(assistant('M1', 'P1', 'streaming', { text: 'private-b', renderedHtml: '<b>b</b>', resolvedModel: 'secret-model', authoredAt: 999 }), 'B'));
    const rows = await facts();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toMatch(/private|secret-model|renderedHtml|authoredAt/);
    expect(rows[0]!.browserDocumentId).toBe('A');
  });

  it('uses pending identity before drain and contains a failed pending alias', async () => {
    send(assistant('M1', 'P1'), assistant('M2', 'P1'));
    expect(shadowV0SnapshotForTests().pending).toBe(2);
    expect((await facts()).map(f => f.firstLogicalMessageId)).toEqual(['M1', 'M1']);
    setShadowV0FaultForTests('processing');
    send(assistant('M3', 'P1'));
    await facts();
    expect(shadowV0SnapshotForTests().aliasCounts.logical).toBe(2);
    setShadowV0FaultForTests(null);
    send(assistant('M4', 'P1'));
    expect((await facts()).at(-1)!.firstLogicalMessageId).toBe('M1');
    expect(shadowV0SnapshotForTests().aliasCounts.logical).toBe(3);
  });

  it('does not let a forgotten pending alias authorize a later merge', async () => {
    send(assistant('M1'));
    await facts();
    setShadowV0FaultForTests('processing');
    send(assistant('M1', 'P1'));
    await facts();
    setShadowV0FaultForTests(null);
    send(assistant('M2', 'P1'));
    expect((await facts()).at(-1)!.firstLogicalMessageId).toBe('M2');
    expect(shadowV0SnapshotForTests().aliasCounts.entities).toBe(2);
  });

  it('forgets all assistant identity on a full reset', async () => {
    send(assistant('M1', 'P1'));
    await facts();
    resetShadowV0ForTests();
    send(assistant('M2', 'P1'));
    expect((await facts())[0]!.firstLogicalMessageId).toBe('M2');
  });

  it('collapses duplicate turn starts and outcomes across documents and timestamps', async () => {
    send(document(start('T1'), 'A'), document(start('T1'), 'B'), document(end('T1', 'completed'), 'A'), document(end('T1', 'completed', 999), 'B'));
    expect((await facts()).map(f => f.browserDocumentId)).toEqual(['A', 'A']);
    expect(shadowV0SnapshotForTests().counters.duplicates).toBe(2);
  });

  it('does not strengthen a terminal turn with older stopped evidence', async () => {
    send(end('T1', 'failed', 200), end('T1', 'stopped', 199));
    expect((await facts()).map(f => f.outcome)).toEqual(['failed']);
  });

  it('retains each contradictory non-stopped outcome once without rewriting first evidence', async () => {
    send(end('T1', 'completed'), end('T1', 'failed'), end('T1', 'failed'));
    expect((await facts()).map(f => f.outcome)).toEqual(['completed', 'failed']);
  });

  it.each(['assistant-first', 'turn-first'])('allows assistant final and turn end in %s order', async order => {
    const rows = [assistant('M1', 'P1', 'final', { turnId: 'T1' }), end('T1', 'completed')];
    send(...(order === 'assistant-first' ? rows : rows.reverse()));
    expect((await facts()).map(f => f.kind).sort()).toEqual(['ASSISTANT_MESSAGE_OBSERVED', 'TURN_END_OBSERVED']);
  });

  it('preserves user identity, accepts absent provenance, and rejects malformed metadata only in Shadow', async () => {
    const bad = user('U2');
    observationDocumentMetadata.set(bad, { malformed: true });
    send(document(user('U1'), 'A'), document(user('U1'), 'B'), user('U3'), bad);
    expect((await facts()).map(f => [f.nativeMessageId, f.browserDocumentId])).toEqual([['U1', 'A'], ['U3', undefined]]);
    expect(shadowV0SnapshotForTests().counters.rejected).toBe(1);
  });

  it('never treats a direct observation document field as provenance', async () => {
    send({ ...assistant('M1', 'P1'), browserDocumentId: 'spoof' } as ChatObservation);
    expect((await facts())[0]!.browserDocumentId).toBeUndefined();
  });

  it('admits nothing when the kill switch is off', async () => {
    delete process.env.CLF_KOSMOSYN_SHADOW_V0;
    send(user('U1'), assistant('M1', 'P1'), start('T1'), end('T1', 'completed'));
    expect(await facts()).toEqual([]);
  });

  it('ignores unsupported kinds and retains no original payload or Protocol authority', async () => {
    const secret = 'never-retain-this-secret';
    send(
      { kind: 'conversation_title', time: 100, text: secret },
      { kind: 'page_tool', time: 100, text: secret },
      { kind: 'chat_error', time: 100, detail: secret },
      { kind: 'native_image', time: 100, previewDataUrl: secret },
      { kind: 'tool_evidence', time: 100, text: secret },
      assistant('M1', 'P1', 'final', { text: secret, renderedHtml: secret, resolvedModel: secret, attachments: [{ name: secret }], requestId: secret })
    );
    const snapshot = shadowV0SnapshotForTests();
    expect(snapshot.pending).toBe(1);
    const json = JSON.stringify(await facts());
    expect(json).not.toContain(secret);
    expect(json).not.toMatch(/connectionEpoch|emitterEpoch|sessionId|commandId|MESSAGE_COMMITTED|requestId/);
    expect(shadowV0SnapshotForTests().counters.rejected).toBe(0);
  });

  it('bounds entities and both alias indexes by the shared fact envelope', async () => {
    send(...Array.from({ length: 256 }, (_, i) => assistant(`M${i}`, `P${i}`)));
    await facts();
    expect(shadowV0SnapshotForTests().aliasCounts).toEqual({ entities: 256, logical: 256, provider: 256 });
    send(assistant('M257', 'P0'));
    expect(shadowV0SnapshotForTests().aliasCounts).toEqual({ entities: 256, logical: 256, provider: 256 });
  });
});
