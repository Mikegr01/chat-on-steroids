import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeTransportAdapter } from '../../src/main/browser-transport/fake-adapter.js';
import { BrowserTransportService } from '../../src/main/browser-transport/service.js';
import { initDurableStore, resetDurableForTests } from '../../src/main/durable.js';
import type { ProtocolEvent } from '../../src/shared/protocol/index.js';

describe('Kosmosyn Transport Protocol V1 - source-scoped ordering', () => {
  let tmpDir: string;
  let service: BrowserTransportService;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `kosmosyn-ordering-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tmpDir, { recursive: true });
    initDurableStore(tmpDir);
    service = new BrowserTransportService(new FakeTransportAdapter('CONNECTED'), { instanceId: 'ordering-1' });
    await service.start();
  });

  afterEach(async () => {
    await service.stop();
    resetDurableForTests();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  });

  async function command(conversationId: string) {
    const cmd = service.createCommand('SEND_MESSAGE', { text: conversationId, targetConversationId: conversationId }, { sessionId: `sess_${conversationId}`, conversationId });
    await service.submitCommand(cmd);
    await service.claimCommand(cmd.commandId, `doc_${conversationId}`);
    return cmd;
  }

  function event(commandId: string, conversationId: string, eventId: string, sequence: number, eventType: ProtocolEvent['eventType'], source: ProtocolEvent['source'] = 'content-script', payload: unknown = {}): ProtocolEvent {
    return { protocolVersion: 1, eventId, commandId, eventType, source, sessionId: `sess_${conversationId}`, conversationId, generation: service.getGeneration(), sequence, occurredAt: Date.now(), payload };
  }

  it('keeps A1 B1 B2 A2 independent across commands', async () => {
    const a = await command('A');
    const b = await command('B');
    expect((await service.handleEvent(event(a.commandId, 'A', 'evt_a1', 1, 'MESSAGE_SUBMIT_STARTED'))).accepted).toBe(true);
    expect((await service.handleEvent(event(b.commandId, 'B', 'evt_b1', 1, 'MESSAGE_SUBMIT_STARTED'))).accepted).toBe(true);
    expect((await service.handleEvent(event(b.commandId, 'B', 'evt_b2', 2, 'TURN_STARTED'))).accepted).toBe(true);
    expect((await service.handleEvent(event(a.commandId, 'A', 'evt_a2', 2, 'TURN_STARTED'))).accepted).toBe(true);
  });

  it('accepts a forward gap and rejects the late lower progress event', async () => {
    const cmd = await command('gap');
    await service.handleEvent(event(cmd.commandId, 'gap', 'evt_gap_1', 1, 'MESSAGE_SUBMIT_STARTED'));
    expect((await service.handleEvent(event(cmd.commandId, 'gap', 'evt_gap_3', 3, 'TURN_STARTED'))).accepted).toBe(true);
    expect(await service.handleEvent(event(cmd.commandId, 'gap', 'evt_gap_2', 2, 'TURN_COMPLETED'))).toEqual({ accepted: false, reason: 'LOWER_SEQUENCE' });
  });

  it('preserves strong COMMITTED truth against a late lower submit event', async () => {
    const cmd = await command('commit');
    await service.handleEvent(event(cmd.commandId, 'commit', 'evt_commit_3', 3, 'MESSAGE_COMMITTED', 'content-script', { proofLevel: 'STRONG_COMMIT', nativeMessageId: 'native_commit', conversationId: 'commit', candidateCount: 1 }));
    expect(await service.handleEvent(event(cmd.commandId, 'commit', 'evt_commit_2', 2, 'MESSAGE_SUBMIT_STARTED'))).toEqual({ accepted: false, reason: 'LOWER_SEQUENCE' });
    expect(service.getStore().get(cmd.commandId)?.state).toBe('COMMITTED');
  });

  it('rejects same-source same-sequence semantic collisions', async () => {
    const cmd = await command('collision');
    await service.handleEvent(event(cmd.commandId, 'collision', 'evt_collision_a', 1, 'MESSAGE_SUBMIT_STARTED'));
    expect(await service.handleEvent(event(cmd.commandId, 'collision', 'evt_collision_b', 1, 'TURN_STARTED'))).toEqual({ accepted: false, reason: 'SEQUENCE_COLLISION' });
  });

  it('rejects same-source same-sequence same-type events with contradictory payloads', async () => {
    const cmd = await command('payload-collision');
    await service.handleEvent(event(cmd.commandId, 'payload-collision', 'evt_payload_a', 1, 'COMMAND_BLOCKED', 'content-script', { reason: 'first reason', blockedAt: 1 }));
    expect(await service.handleEvent(event(cmd.commandId, 'payload-collision', 'evt_payload_b', 1, 'COMMAND_BLOCKED', 'content-script', { reason: 'second reason', blockedAt: 1 }))).toEqual({ accepted: false, reason: 'SEQUENCE_COLLISION' });
  });

  it('treats same-source same-sequence same-type semantically identical payloads as replay despite object key order', async () => {
    const cmd = await command('payload-replay');
    await service.handleEvent(event(cmd.commandId, 'payload-replay', 'evt_payload_replay_a', 1, 'COMMAND_BLOCKED', 'content-script', { reason: 'same reason', blockedAt: 1 }));
    expect(await service.handleEvent(event(cmd.commandId, 'payload-replay', 'evt_payload_replay_b', 1, 'COMMAND_BLOCKED', 'content-script', { blockedAt: 1, reason: 'same reason' }))).toEqual({ accepted: false, duplicate: true, reason: 'SEQUENCE_ALREADY_APPLIED' });
  });

  it('does not compare independent content-script and extension-background counters', async () => {
    const cmd = await command('sources');
    await service.handleEvent(event(cmd.commandId, 'sources', 'evt_source_content', 8, 'MESSAGE_SUBMIT_STARTED'));
    expect((await service.handleEvent(event(cmd.commandId, 'sources', 'evt_source_extension', 1, 'TURN_STARTED', 'extension-background'))).accepted).toBe(true);
    expect((await service.handleEvent(event(cmd.commandId, 'sources', 'evt_source_content_9', 9, 'TURN_COMPLETED', 'content-script'))).accepted).toBe(true);
  });

  it('does not let COMMAND_COMPLETED manufacture commit truth before MESSAGE_COMMITTED', async () => {
    const cmd = await command('early-complete');
    await service.handleEvent(event(cmd.commandId, 'early-complete', 'evt_early_submit', 1, 'MESSAGE_SUBMIT_STARTED'));
    const completion = await service.handleEvent(event(cmd.commandId, 'early-complete', 'evt_early_complete', 1, 'COMMAND_COMPLETED', 'extension-background'));
    expect(completion).toEqual({ accepted: false, reason: 'INVALID_LIFECYCLE_FACT' });
    expect(service.getStore().get(cmd.commandId)?.commitProofLevel).toBeNull();
    expect(service.getStore().get(cmd.commandId)?.orderingBySource?.['extension-background']).toBeUndefined();
    const commit = await service.handleEvent(event(cmd.commandId, 'early-complete', 'evt_early_commit', 1, 'MESSAGE_COMMITTED', 'extension-background', { proofLevel: 'STRONG_COMMIT', nativeMessageId: 'native_early', conversationId: 'early-complete', candidateCount: 1 }));
    expect(commit.accepted).toBe(true);
    expect(service.getStore().get(cmd.commandId)?.state).toBe('COMMITTED');
  });

  it('lets a same-sequence strong durable fact override a progress ordering slot', async () => {
    const cmd = await command('same-seq-fact');
    await service.handleEvent(event(cmd.commandId, 'same-seq-fact', 'evt_same_seq_progress', 2, 'TURN_STARTED'));
    const result = await service.handleEvent(event(cmd.commandId, 'same-seq-fact', 'evt_same_seq_commit', 2, 'MESSAGE_COMMITTED', 'content-script', { proofLevel: 'STRONG_COMMIT', nativeMessageId: 'native_same_seq', conversationId: 'same-seq-fact', candidateCount: 1 }));
    expect(result.accepted).toBe(true);
    expect(service.getStore().get(cmd.commandId)?.state).toBe('COMMITTED');
  });

  it('lets a lower-sequence strong durable fact override ordering evidence', async () => {
    const cmd = await command('fact');
    await service.handleEvent(event(cmd.commandId, 'fact', 'evt_fact_progress', 3, 'TURN_STARTED'));
    const result = await service.handleEvent(event(cmd.commandId, 'fact', 'evt_fact_commit', 2, 'MESSAGE_COMMITTED', 'content-script', { proofLevel: 'STRONG_COMMIT', nativeMessageId: 'native_fact', conversationId: 'fact', candidateCount: 1 }));
    expect(result.accepted).toBe(true);
    expect(service.getStore().get(cmd.commandId)?.state).toBe('COMMITTED');
  });

  it('retains source ordering high-water marks across restart', async () => {
    const cmd = await command('restart');
    await service.handleEvent(event(cmd.commandId, 'restart', 'evt_restart_3', 3, 'TURN_STARTED'));
    await service.stop();
    service = new BrowserTransportService(new FakeTransportAdapter('CONNECTED'), { instanceId: 'ordering-2' });
    await service.start();
    expect(await service.handleEvent({ ...event(cmd.commandId, 'restart', 'evt_restart_2', 2, 'TURN_COMPLETED'), generation: service.getGeneration() })).toEqual({ accepted: false, reason: 'LOWER_SEQUENCE' });
  });

  it('rolls back persisted ordering authority when its durable write fails', async () => {
    const cmd = await command('rollback');
    const store = service.getStore();
    const originalFlush = store.flushImmediate.bind(store);
    let failNextFlush = true;
    store.flushImmediate = async () => {
      if (failNextFlush) {
        failNextFlush = false;
        throw new Error('injected ordering write failure');
      }
      return originalFlush();
    };
    const first = event(cmd.commandId, 'rollback', 'evt_rollback_2', 2, 'TURN_STARTED');
    await expect(service.handleEvent(first)).rejects.toThrow('injected ordering write failure');
    expect(store.get(cmd.commandId)?.orderingBySource?.['content-script']).toBeUndefined();
    const retry = await service.handleEvent({ ...first, eventId: 'evt_rollback_retry' });
    expect(retry.accepted).toBe(true);
    expect(store.get(cmd.commandId)?.orderingBySource?.['content-script']?.sequence).toBe(2);
  });

  it('serializes seq 2 admitted before seq 1 according to ordering policy', async () => {
    const cmd = await command('concurrent-order');
    const [second, first] = await Promise.all([
      service.handleEvent(event(cmd.commandId, 'concurrent-order', 'evt_concurrent_2', 2, 'TURN_STARTED')),
      service.handleEvent(event(cmd.commandId, 'concurrent-order', 'evt_concurrent_1', 1, 'MESSAGE_SUBMIT_STARTED'))
    ]);
    expect(second.accepted).toBe(true);
    expect(first).toEqual({ accepted: false, reason: 'LOWER_SEQUENCE' });
    expect(service.getStore().get(cmd.commandId)?.orderingBySource?.['content-script']?.sequence).toBe(2);
  });

  it('converges to COMMITTED when durable commit is admitted with concurrent lower progress', async () => {
    const cmd = await command('concurrent-commit');
    await Promise.all([
      service.handleEvent(event(cmd.commandId, 'concurrent-commit', 'evt_concurrent_commit_3', 3, 'MESSAGE_COMMITTED', 'content-script', { proofLevel: 'STRONG_COMMIT', nativeMessageId: 'native_concurrent_commit', conversationId: 'concurrent-commit', candidateCount: 1 })),
      service.handleEvent(event(cmd.commandId, 'concurrent-commit', 'evt_concurrent_progress_2', 2, 'MESSAGE_SUBMIT_STARTED'))
    ]);
    const record = service.getStore().get(cmd.commandId)!;
    expect(record.state).toBe('COMMITTED');
    expect(record.nativeMessageId).toBe('native_concurrent_commit');
  });
});
