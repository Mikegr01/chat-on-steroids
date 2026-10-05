import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeTransportAdapter } from '../../src/main/browser-transport/fake-adapter.js';
import { BrowserTransportService } from '../../src/main/browser-transport/service.js';
import { resetDurableForTests, initDurableStore, readDurable } from '../../src/main/durable.js';
import { PROTOCOL_STORE_NAME } from '../../src/main/browser-transport/store.js';
import type { ProtocolStoreSnapshot } from '../../src/main/browser-transport/types.js';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

describe('Kosmosyn Transport Protocol V1 - Durability & Restart Reconciliation', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `kosmosyn-durability-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tmpDir, { recursive: true });
    initDurableStore(tmpDir);
  });

  afterEach(async () => {
    resetDurableForTests();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('persists commands to disk immediately using existing durable.ts store', async () => {
    const adapter = new FakeTransportAdapter('CONNECTED');
    const service = new BrowserTransportService(adapter, { instanceId: 'inst_dur_1' });
    await service.start();

    const cmd = service.createCommand('SEND_MESSAGE', {
      text: 'Must survive power loss',
      targetConversationId: 'conv_dur_1'
    }, { sessionId: 'sess_dur_1', idempotencyKey: 'idemp_dur_1' });

    await service.submitCommand(cmd);

    // Read directly from disk using readDurable from durable.ts
    const snapshot = await readDurable<ProtocolStoreSnapshot>(PROTOCOL_STORE_NAME);
    expect(snapshot).not.toBeNull();
    const cmdRecord = snapshot?.commands[cmd.commandId];
    expect(cmdRecord).toBeDefined();
    if (!cmdRecord) throw new Error('Command record missing from snapshot');
    expect(cmdRecord.command.payload).toEqual({
      text: 'Must survive power loss',
      targetConversationId: 'conv_dur_1',
      timeoutMs: 30000
    });
    expect(cmdRecord.state).toBe('DISPATCHED');

    await service.stop();
  });

  it('reconciles in-flight mutating commands to AMBIGUOUS on restart without blind replay', async () => {
    // Phase 1: Service 1 runs, dispatches a mutation, claims it, and then dies (crashes)
    const adapter1 = new FakeTransportAdapter('CONNECTED');
    const service1 = new BrowserTransportService(adapter1, { instanceId: 'inst_crash_1' });
    await service1.start();

    const cmd1 = service1.createCommand('SEND_MESSAGE', {
      text: 'In-flight prompt before crash',
      targetConversationId: 'conv_crash_target'
    }, { sessionId: 'sess_crash_1', idempotencyKey: 'idemp_crash_1' });

    await service1.submitCommand(cmd1);
    await service1.claimCommand(cmd1.commandId, 'tab_doc_crash');

    // Also dispatch a probe command
    const probeCmd = service1.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_crash_1' });
    await service1.submitCommand(probeCmd);

    // Simulate abrupt crash: stop service1 without orderly completion
    await service1.stop();

    // Phase 2: Desktop application restarts (fresh service instance against same durable store)
    const adapter2 = new FakeTransportAdapter('CONNECTED');
    const service2 = new BrowserTransportService(adapter2, { instanceId: 'inst_restart_2' });

    // When service starts, reconcileOnRestart() runs
    await service2.start();

    const store = service2.getStore();
    const restoredRecord1 = store.get(cmd1.commandId);
    expect(restoredRecord1).toBeDefined();
    // CRITICAL DESIGN REQUIREMENT: Mutating command MUST NOT be blindly replayed;
    // It must become AMBIGUOUS because we do not know if the browser executed it while desktop was offline!
    expect(restoredRecord1?.state).toBe('AMBIGUOUS');
    expect(restoredRecord1?.reconciledOnRestart).toBe(true);
    expect(restoredRecord1?.lastError).toContain('Interrupted by application restart');

    // Read-only probe command can safely be expired
    const restoredProbe = store.get(probeCmd.commandId);
    expect(restoredProbe?.state).toBe('EXPIRED');

    await service2.stop();
  });

  it('persists COMMITTED native message identity across restart without redispatch', async () => {
    const adapter1 = new FakeTransportAdapter('CONNECTED');
    const service1 = new BrowserTransportService(adapter1, { instanceId: 'inst_commit_1' });
    await service1.start();
    const cmd = service1.createCommand('SEND_MESSAGE', { text: 'durable commit', targetConversationId: 'conv_commit' }, { sessionId: 'sess_commit', conversationId: 'conv_commit' });
    await service1.submitCommand(cmd);
    await service1.claimCommand(cmd.commandId, 'doc_commit');
    await service1.handleEvent({ protocolVersion: 1, eventId: 'evt_commit_durable', commandId: cmd.commandId, eventType: 'MESSAGE_COMMITTED', source: 'content-script', sessionId: 'sess_commit', conversationId: 'conv_commit', generation: service1.getGeneration(), sequence: 1, occurredAt: Date.now(), payload: { proofLevel: 'STRONG_COMMIT', nativeMessageId: 'native_durable_1', conversationId: 'conv_commit', candidateCount: 1 } });
    await service1.stop();

    const adapter2 = new FakeTransportAdapter('CONNECTED');
    const service2 = new BrowserTransportService(adapter2, { instanceId: 'inst_commit_2' });
    await service2.start();
    const restored = service2.getStore().get(cmd.commandId);
    expect(restored?.state).toBe('COMMITTED');
    expect(restored?.nativeMessageId).toBe('native_durable_1');
    expect(adapter2.sentMessages).toHaveLength(0);
    await service2.stop();
  });

  it('treats the same durable MESSAGE_COMMITTED fact with a new eventId after restart as a no-op', async () => {
    const adapter1 = new FakeTransportAdapter('CONNECTED');
    const service1 = new BrowserTransportService(adapter1, { instanceId: 'inst_fact_1' });
    await service1.start();
    const cmd = service1.createCommand('SEND_MESSAGE', { text: 'restart fact', targetConversationId: 'conv_fact' }, { sessionId: 'sess_fact', conversationId: 'conv_fact' });
    await service1.submitCommand(cmd);
    await service1.claimCommand(cmd.commandId, 'doc_fact');
    const event = { protocolVersion: 1 as const, eventId: 'evt_fact_before', commandId: cmd.commandId, eventType: 'MESSAGE_COMMITTED' as const, source: 'content-script' as const, sessionId: 'sess_fact', conversationId: 'conv_fact', generation: service1.getGeneration(), sequence: 1, occurredAt: Date.now(), payload: { proofLevel: 'STRONG_COMMIT', nativeMessageId: 'native_fact_1', conversationId: 'conv_fact', candidateCount: 1 } };
    await service1.handleEvent(event);
    await service1.stop();

    const service2 = new BrowserTransportService(new FakeTransportAdapter('CONNECTED'), { instanceId: 'inst_fact_2' });
    await service2.start();
    const restored = service2.getStore().get(cmd.commandId);
    const committedAt = restored?.committedAt;
    const updatedAt = restored?.updatedAt;
    let notifications = 0;
    service2.onEvent(() => notifications++);
    const replay = await service2.handleEvent({ ...event, eventId: 'evt_fact_after', generation: service2.getGeneration(), occurredAt: Date.now() + 100 });
    expect(replay).toEqual({ accepted: false, duplicate: true, reason: 'FACT_ALREADY_APPLIED' });
    expect(restored?.committedAt).toBe(committedAt);
    expect(restored?.updatedAt).toBe(updatedAt);
    expect(notifications).toBe(0);
    await service2.stop();
  });

  it('treats COMMAND_COMPLETED replay after restart as an idempotent ordering replay', async () => {
    const service1 = new BrowserTransportService(new FakeTransportAdapter('CONNECTED'), { instanceId: 'inst_complete_1' });
    await service1.start();
    const cmd = service1.createCommand('SEND_MESSAGE', { text: 'complete fact', targetConversationId: 'conv_complete' }, { sessionId: 'sess_complete', conversationId: 'conv_complete' });
    await service1.submitCommand(cmd);
    await service1.claimCommand(cmd.commandId, 'doc_complete');
    await service1.handleEvent({ protocolVersion: 1, eventId: 'evt_complete_commit', commandId: cmd.commandId, eventType: 'MESSAGE_COMMITTED', source: 'content-script', sessionId: 'sess_complete', conversationId: 'conv_complete', generation: service1.getGeneration(), sequence: 1, occurredAt: Date.now(), payload: { proofLevel: 'STRONG_COMMIT', nativeMessageId: 'native_complete', conversationId: 'conv_complete', candidateCount: 1 } });
    await service1.handleEvent({ protocolVersion: 1, eventId: 'evt_complete_before', commandId: cmd.commandId, eventType: 'COMMAND_COMPLETED', source: 'content-script', sessionId: 'sess_complete', conversationId: 'conv_complete', generation: service1.getGeneration(), sequence: 2, occurredAt: Date.now(), payload: {} });
    await service1.stop();

    const service2 = new BrowserTransportService(new FakeTransportAdapter('CONNECTED'), { instanceId: 'inst_complete_2' });
    await service2.start();
    const replay = await service2.handleEvent({ protocolVersion: 1, eventId: 'evt_complete_after', commandId: cmd.commandId, eventType: 'COMMAND_COMPLETED', source: 'content-script', sessionId: 'sess_complete', conversationId: 'conv_complete', generation: service2.getGeneration(), sequence: 2, occurredAt: Date.now(), payload: {} });
    expect(replay).toEqual({ accepted: false, duplicate: true, reason: 'SEQUENCE_ALREADY_APPLIED' });
    expect(service2.getStore().get(cmd.commandId)?.state).toBe('COMPLETED');
    await service2.stop();
  });
  // ======================================================================
  // AMENDMENT MATRIX TESTS: Non-Mutating Completion Semantics
  // ======================================================================

  it('Matrix 41-44: mutation commit retention in ProtocolStore preserves real mutation commits and never indexes SESSION_PROBE', async () => {
    const adapter = new FakeTransportAdapter('CONNECTED');
    const service = new BrowserTransportService(adapter, { instanceId: 'durability-matrix-1' });
    await service.start();
    const store = service.getStore();

    // Matrix 41: completed SESSION_PROBE never enters recentCommittedIds
    const probe = service.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_dur_probe' });
    const probeRec = await service.submitCommand(probe);
    probeRec.state = 'COMPLETED';
    probeRec.completedAt = Date.now();
    await store.updateCommand(probeRec, true);

    const snapshotAfterProbe = await readDurable<ProtocolStoreSnapshot>(PROTOCOL_STORE_NAME);
    expect(snapshotAfterProbe?.recentCommittedIds).not.toContain(probe.commandId);

    // Matrix 42: real COMMITTED SEND_MESSAGE remains in recentCommittedIds
    const sendCmd = service.createCommand('SEND_MESSAGE', { text: 'mutation commit', targetConversationId: 'conv_dur_mut' }, { sessionId: 'sess_dur_mut', conversationId: 'conv_dur_mut' });
    const sendRec = await service.submitCommand(sendCmd);
    sendRec.state = 'COMMITTED';
    sendRec.committedAt = Date.now();
    sendRec.commitProofLevel = 'STRONG_COMMIT';
    sendRec.nativeMessageId = 'native_dur_msg_1';
    sendRec.commitConversationId = 'conv_dur_mut';
    await store.updateCommand(sendRec, true);

    const snapshotAfterCommit = await readDurable<ProtocolStoreSnapshot>(PROTOCOL_STORE_NAME);
    expect(snapshotAfterCommit?.recentCommittedIds).toContain(sendCmd.commandId);

    // Matrix 43: real COMPLETED SEND_MESSAGE after strong commit remains represented
    sendRec.state = 'COMPLETED';
    sendRec.completedAt = Date.now();
    await store.updateCommand(sendRec, true);

    const snapshotAfterComplete = await readDurable<ProtocolStoreSnapshot>(PROTOCOL_STORE_NAME);
    expect(snapshotAfterComplete?.recentCommittedIds).toContain(sendCmd.commandId);
    expect(snapshotAfterComplete?.recentCommittedIds).not.toContain(probe.commandId);

    // Matrix 44: restoreAfterFailedUpdate uses mutation-commit semantics
    // Artificially simulate an invalid record being restored
    const invalidRec = structuredClone(probeRec);
    store.restoreAfterFailedUpdate(invalidRec);
    const snapshotAfterRestore = await readDurable<ProtocolStoreSnapshot>(PROTOCOL_STORE_NAME);
    expect(snapshotAfterRestore?.recentCommittedIds).toContain(sendCmd.commandId);
    expect(snapshotAfterRestore?.recentCommittedIds).not.toContain(probe.commandId);

    await service.stop();
  });

  it('Matrix 63-64: restart with dispatched SESSION_PROBE transitions to EXPIRED with no auto-replay', async () => {
    // Phase 1: Service 1 runs, dispatches SESSION_PROBE, and crashes
    const adapter1 = new FakeTransportAdapter('CONNECTED');
    const service1 = new BrowserTransportService(adapter1, { instanceId: 'dur-restart-1' });
    await service1.start();

    const probe = service1.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_restart_probe' });
    const probeRec = await service1.submitCommand(probe);
    expect(probeRec.state).toBe('DISPATCHED');
    expect(probeRec.attempts).toBe(1);

    await service1.stop();

    // Phase 2: Fresh service instance starts against same durable outbox
    const adapter2 = new FakeTransportAdapter('CONNECTED');
    const service2 = new BrowserTransportService(adapter2, { instanceId: 'dur-restart-2' });
    await service2.start();

    // Matrix 63: probe in DISPATCHED transitions to EXPIRED on restart
    const restoredProbe = service2.getStore().get(probe.commandId);
    expect(restoredProbe).toBeDefined();
    expect(restoredProbe?.state).toBe('EXPIRED');
    expect(restoredProbe?.reconciledOnRestart).toBe(true);

    // Matrix 64: no automatic replay is introduced
    expect(restoredProbe?.attempts).toBe(1);
    expect(adapter2.sentMessages.length).toBe(0);

    await service2.stop();
  });
});
