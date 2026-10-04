import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeTransportAdapter } from '../../src/main/browser-transport/fake-adapter.js';
import { BrowserTransportService } from '../../src/main/browser-transport/service.js';
import { resetDurableForTests, initDurableStore, readDurable, flushDurable } from '../../src/main/durable.js';
import { PROTOCOL_STORE_NAME } from '../../src/main/browser-transport/store.js';
import type { ProtocolStoreSnapshot } from '../../src/main/browser-transport/types.js';
import type { ProtocolEvent } from '../../src/shared/protocol/index.js';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

describe('Kosmosyn Transport Protocol V1 - 15 Fault Injection Scenarios', () => {
  let tmpDir: string;
  let adapter: FakeTransportAdapter;
  let service: BrowserTransportService;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `kosmosyn-fault-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tmpDir, { recursive: true });
    initDurableStore(tmpDir);

    adapter = new FakeTransportAdapter('CONNECTED');
    service = new BrowserTransportService(adapter, { instanceId: 'fault-tester' });
    await service.start();
  });

  afterEach(async () => {
    await service.stop();
    resetDurableForTests();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  });

  // 1. Desktop dies after persist but before dispatch
  it('Scenario 1: desktop dies after persist but before dispatch', async () => {
    // Drop next send so command stays in PERSISTED state
    adapter.faultConfig.dropNextSend = true;

    const cmd = service.createCommand('SEND_MESSAGE', {
      text: 'Persisted but not dispatched',
      targetConversationId: 'conv_1'
    }, { sessionId: 'sess_1', idempotencyKey: 'fault_1' });

    const rec = await service.submitCommand(cmd);
    expect(rec.state).toBe('PERSISTED'); // Transport dropped delivery

    // Simulate crash and restart
    await service.stop();
    const service2 = new BrowserTransportService(adapter, { instanceId: 'fault-tester-2' });
    await service2.start();

    const restored = service2.getStore().get(cmd.commandId);
    expect(restored).toBeDefined();
    expect(restored?.state).toBe('PERSISTED');

    // Safe to dispatch on restart since it was never sent to browser
    const dispatched = await service2.dispatchRecord(restored!);
    expect(dispatched).toBe(true);
    expect(restored?.state).toBe('DISPATCHED');
    await service2.stop();
  });

  // 2. Same command delivered twice
  it('Scenario 2: same command delivered twice', async () => {
    const cmd1 = service.createCommand('SEND_MESSAGE', {
      text: 'Send once',
      targetConversationId: 'conv_2'
    }, { sessionId: 'sess_2', idempotencyKey: 'fault_2' });

    const rec1 = await service.submitCommand(cmd1);
    const cmd2 = service.createCommand('SEND_MESSAGE', {
      text: 'Send once',
      targetConversationId: 'conv_2'
    }, { sessionId: 'sess_2', idempotencyKey: 'fault_2' });

    const rec2 = await service.submitCommand(cmd2);
    expect(rec2.command.commandId).toBe(rec1.command.commandId);
    expect(service.getStore().get(cmd1.commandId)?.attempts).toBe(1);

    // Mismatched payload with same idempotencyKey must be rejected
    const conflicting = service.createCommand('SEND_MESSAGE', {
      text: 'Send once (conflicting payload)',
      targetConversationId: 'conv_2'
    }, { sessionId: 'sess_2', idempotencyKey: 'fault_2' });
    await expect(service.submitCommand(conflicting)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  });

  // 3. Extension executes command then dies before ACK
  it('Scenario 3: extension executes command then dies before ACK', async () => {
    const cmd = service.createCommand('SEND_MESSAGE', {
      text: 'Executed in browser but ack lost',
      targetConversationId: 'conv_3'
    }, { sessionId: 'sess_3', idempotencyKey: 'fault_3' });

    await service.submitCommand(cmd);
    await service.claimCommand(cmd.commandId, 'tab_doc_3');

    // Execution started
    await service.handleEvent({
      protocolVersion: 1,
      eventId: 'evt_3_start',
      commandId: cmd.commandId,
      eventType: 'MESSAGE_SUBMIT_STARTED',
      source: 'content-script',
      sessionId: 'sess_3',
      conversationId: 'conv_3',
      generation: service.getGeneration(),
      sequence: 1,
      occurredAt: Date.now(),
      payload: {}
    });

    // Extension dies without emitting MESSAGE_COMMITTED or COMMAND_COMPLETED
    // Desktop restarts
    await service.stop();
    const service2 = new BrowserTransportService(adapter, { instanceId: 'fault-tester-3' });
    await service2.start();

    const restored = service2.getStore().get(cmd.commandId);
    expect(restored?.state).toBe('AMBIGUOUS');
    expect(restored?.lastError).toContain('mutation outcome uncertain');
    await service2.stop();
  });

  // 4. Browser reloads while command active
  it('Scenario 4: browser reloads while command active', async () => {
    const cmd = service.createCommand('SEND_MESSAGE', {
      text: 'Reload mid-operation',
      targetConversationId: 'conv_4'
    }, { sessionId: 'sess_4' });

    await service.submitCommand(cmd);
    await service.claimCommand(cmd.commandId, 'doc_old_page');

    // Reload triggers tab/session event reporting ambiguous status
    await service.handleEvent({
      protocolVersion: 1,
      eventId: 'evt_reload_ambig',
      commandId: cmd.commandId,
      eventType: 'MESSAGE_COMMITTED',
      source: 'content-script',
      sessionId: 'sess_4',
      conversationId: 'conv_4',
      generation: service.getGeneration(),
      sequence: 1,
      occurredAt: Date.now(),
      payload: {
        proofLevel: 'AMBIGUOUS',
        evidenceDetails: 'Document unloaded / reloaded during submit'
      }
    });

    const rec = service.getStore().get(cmd.commandId);
    expect(rec?.state).toBe('AMBIGUOUS');
  });

  // 5. Composer remounts during execution
  it('Scenario 5: composer remounts during execution', async () => {
    const cmd = service.createCommand('SEND_MESSAGE', {
      text: 'Composer remount test',
      targetConversationId: 'conv_5'
    }, { sessionId: 'sess_5' });

    await service.submitCommand(cmd);
    await service.claimCommand(cmd.commandId, 'doc_remount');

    // Event reporting composer invalidated
    await service.handleEvent({
      protocolVersion: 1,
      eventId: 'evt_remount_fail',
      commandId: cmd.commandId,
      eventType: 'COMMAND_FAILED',
      source: 'content-script',
      sessionId: 'sess_5',
      conversationId: 'conv_5',
      generation: service.getGeneration(),
      sequence: 1,
      occurredAt: Date.now(),
      payload: {
        errorCode: 'COMPOSER_STALE',
        message: 'React re-rendered composer element before input completion',
        retryable: true,
        failedAt: Date.now()
      }
    });

    const rec = service.getStore().get(cmd.commandId);
    expect(rec?.state).toBe('FAILED');
    expect(rec?.lastError).toContain('React re-rendered composer');
  });

  // 5B. Submit action issued then composer invalidates: MUST become AMBIGUOUS, then reconcile to COMMITTED
  it('Scenario 5B: submit action issued then composer invalidates becomes AMBIGUOUS and reconciles to COMMITTED', async () => {
    const cmd = service.createCommand('SEND_MESSAGE', {
      text: 'Submit issued then composer remounts',
      targetConversationId: 'conv_5b'
    }, { sessionId: 'sess_5b' });

    await service.submitCommand(cmd);
    await service.claimCommand(cmd.commandId, 'doc_5b');

    // Submit started (state = EXECUTING)
    await service.handleEvent({
      protocolVersion: 1,
      eventId: 'evt_submit_started_5b',
      commandId: cmd.commandId,
      eventType: 'MESSAGE_SUBMIT_STARTED',
      source: 'content-script',
      sessionId: 'sess_5b',
      conversationId: 'conv_5b',
      generation: service.getGeneration(),
      sequence: 1,
      occurredAt: Date.now(),
      payload: {}
    });
    expect(service.getStore().get(cmd.commandId)?.state).toBe('EXECUTING');

    // Failure event arrives AFTER submit started: outcome is ambiguous!
    await service.handleEvent({
      protocolVersion: 1,
      eventId: 'evt_remount_post_submit',
      commandId: cmd.commandId,
      eventType: 'COMMAND_FAILED',
      source: 'content-script',
      sessionId: 'sess_5b',
      conversationId: 'conv_5b',
      generation: service.getGeneration(),
      sequence: 2,
      occurredAt: Date.now(),
      payload: {
        errorCode: 'COMPOSER_STALE',
        message: 'Composer unmounted immediately after click',
        retryable: false,
        failedAt: Date.now()
      }
    });

    const rec = service.getStore().get(cmd.commandId);
    expect(rec?.state).toBe('AMBIGUOUS'); // Must NOT be FAILED (blind retry forbidden)

    // Later, message appears in DOM: reconciles from AMBIGUOUS to COMMITTED
    await service.handleEvent({
      protocolVersion: 1,
      eventId: 'evt_delayed_commit_5b',
      commandId: cmd.commandId,
      eventType: 'MESSAGE_COMMITTED',
      source: 'content-script',
      sessionId: 'sess_5b',
      conversationId: 'conv_5b',
      generation: service.getGeneration(),
      sequence: 3,
      occurredAt: Date.now(),
      payload: {
        proofLevel: 'STRONG_COMMIT',
        nativeMessageId: 'gpt_msg_5b',
        conversationId: 'conv_5b',
        candidateCount: 1
      }
    });

    expect(service.getStore().get(cmd.commandId)?.state).toBe('COMMITTED');
  });

  // 6. Message is committed but completion event is lost
  it('Scenario 6: message is committed but completion event is lost', async () => {
    const cmd = service.createCommand('SEND_MESSAGE', {
      text: 'Commit observed',
      targetConversationId: 'conv_6'
    }, { sessionId: 'sess_6' });

    await service.submitCommand(cmd);
    await service.claimCommand(cmd.commandId, 'doc_6');

    // Commit lands
    await service.handleEvent({
      protocolVersion: 1,
      eventId: 'evt_commit_6',
      commandId: cmd.commandId,
      eventType: 'MESSAGE_COMMITTED',
      source: 'content-script',
      sessionId: 'sess_6',
      conversationId: 'conv_6',
      generation: service.getGeneration(),
      sequence: 1,
      occurredAt: Date.now(),
      payload: {
        proofLevel: 'STRONG_COMMIT',
        nativeMessageId: 'gpt_msg_6',
        conversationId: 'conv_6',
        candidateCount: 1
      }
    });

    const rec = service.getStore().get(cmd.commandId);
    expect(rec?.state).toBe('COMMITTED');
    expect(rec?.committedAt).not.toBeNull();
    // Even though completion event is never received, state remains COMMITTED and MUST NOT auto-retry
  });

  // 7. Duplicate event arrives
  it('Scenario 7: duplicate event arrives', async () => {
    const cmd = service.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_7' });
    await service.submitCommand(cmd);

    const event: ProtocolEvent = {
      protocolVersion: 1,
      eventId: 'evt_dup_test',
      commandId: cmd.commandId,
      eventType: 'COMMAND_CLAIMED',
      source: 'extension-background',
      sessionId: 'sess_7',
      conversationId: null,
      generation: service.getGeneration(),
      sequence: 1,
      occurredAt: Date.now(),
      payload: { clientDocumentId: 'doc_dup_test', tabId: 7, claimedAt: Date.now() }
    };

    const first = await service.handleEvent(event);
    expect(first.accepted).toBe(true);

    const second = await service.handleEvent(event);
    expect(second.accepted).toBe(false);
    expect(second.duplicate).toBe(true);
  });

  // 8. Stale generation event arrives
  it('Scenario 8: stale generation event arrives', async () => {
    const cmd = service.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_8' });
    await service.submitCommand(cmd);

    service.advanceGeneration(); // generation -> 2

    const staleEvent: ProtocolEvent = {
      protocolVersion: 1,
      eventId: 'evt_stale_gen_test',
      commandId: cmd.commandId,
      eventType: 'COMMAND_COMPLETED',
      source: 'extension-background',
      sessionId: 'sess_8',
      conversationId: null,
      generation: 1, // older than 2
      sequence: 1,
      occurredAt: Date.now(),
      payload: {}
    };

    const res = await service.handleEvent(staleEvent);
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe('STALE_GENERATION');
  });

  // 9. Wrong conversation is targeted
  it('Scenario 9: wrong conversation is targeted', async () => {
    const cmd = service.createCommand('SEND_MESSAGE', {
      text: 'Targeted to conv A',
      targetConversationId: 'conv_A'
    }, { sessionId: 'sess_9', conversationId: 'conv_A' });

    await service.submitCommand(cmd);

    // Extension reports chat mismatch error
    await service.handleEvent({
      protocolVersion: 1,
      eventId: 'evt_wrong_chat',
      commandId: cmd.commandId,
      eventType: 'COMMAND_BLOCKED',
      source: 'extension-background',
      sessionId: 'sess_9',
      conversationId: 'conv_B',
      generation: service.getGeneration(),
      sequence: 1,
      occurredAt: Date.now(),
      payload: {
        reason: 'Active tab is conv_B, command targets conv_A'
      }
    });

    const rec = service.getStore().get(cmd.commandId);
    expect(rec?.state).toBe('BLOCKED');
    expect(rec?.lastError).toContain('conv_B');
  });

  it('does not let volatile event dedupe swallow retry after durable write failure', async () => {
    const cmd = service.createCommand('SEND_MESSAGE', { text: 'retry durable fact', targetConversationId: 'conv_retry' }, { sessionId: 'sess_retry', conversationId: 'conv_retry' });
    await service.submitCommand(cmd);
    await service.claimCommand(cmd.commandId, 'doc_retry');
    const event: ProtocolEvent = { protocolVersion: 1, eventId: 'evt_retry_write', commandId: cmd.commandId, eventType: 'MESSAGE_COMMITTED', source: 'content-script', sessionId: 'sess_retry', conversationId: 'conv_retry', generation: service.getGeneration(), sequence: 1, occurredAt: Date.now(), payload: { proofLevel: 'STRONG_COMMIT', nativeMessageId: 'native_retry_1', conversationId: 'conv_retry', candidateCount: 1 } };
    const store = service.getStore();
    const originalUpdate = store.updateCommand.bind(store);
    let writes = 0;
    store.updateCommand = async (record, immediate) => {
      writes++;
      if (writes === 1) throw new Error('injected durable write failure');
      return originalUpdate(record, immediate);
    };
    let eventNotifications = 0;
    let stateNotifications = 0;
    service.onEvent(() => eventNotifications++);
    service.onCommandState(() => stateNotifications++);
    await expect(service.handleEvent(event)).rejects.toThrow('injected durable write failure');
    expect(eventNotifications).toBe(0);
    expect(stateNotifications).toBe(0);
    const retry = await service.handleEvent(event);
    expect(retry.accepted).toBe(true);
    expect(retry.duplicate).not.toBe(true);
    expect(eventNotifications).toBe(1);
    expect(stateNotifications).toBe(1);
  });

  it('rolls back store metadata when a commit barrier fails before a later write succeeds', async () => {
    const cmd = service.createCommand('SEND_MESSAGE', { text: 'rollback metadata', targetConversationId: 'conv_rollback_meta' }, { sessionId: 'sess_rollback_meta', conversationId: 'conv_rollback_meta' });
    await service.submitCommand(cmd);
    await service.claimCommand(cmd.commandId, 'doc_rollback_meta');
    const store = service.getStore();
    const originalFlush = store.flushImmediate.bind(store);
    let failNextFlush = true;
    store.flushImmediate = async () => {
      if (failNextFlush) {
        failNextFlush = false;
        throw new Error('injected commit barrier failure');
      }
      return originalFlush();
    };
    await expect(service.handleEvent({ protocolVersion: 1, eventId: 'evt_rollback_meta', commandId: cmd.commandId, eventType: 'MESSAGE_COMMITTED', source: 'content-script', sessionId: 'sess_rollback_meta', conversationId: 'conv_rollback_meta', generation: service.getGeneration(), sequence: 1, occurredAt: Date.now(), payload: { proofLevel: 'STRONG_COMMIT', nativeMessageId: 'native_rollback_meta', conversationId: 'conv_rollback_meta', candidateCount: 1 } })).rejects.toThrow('injected commit barrier failure');
    expect(store.get(cmd.commandId)?.state).toBe('CLAIMED');

    const unrelated = service.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_unrelated_meta' });
    await service.submitCommand(unrelated);
    const snapshot = await readDurable<ProtocolStoreSnapshot>(PROTOCOL_STORE_NAME);
    expect(snapshot?.commands[cmd.commandId]?.state).toBe('CLAIMED');
    expect(snapshot?.recentCommittedIds).not.toContain(cmd.commandId);
  });

  it('supersedes a failed commit generation so background retry cannot resurrect it', async () => {
    const cmd = service.createCommand('SEND_MESSAGE', { text: 'failed generation', targetConversationId: 'conv_failed_generation' }, { sessionId: 'sess_failed_generation', conversationId: 'conv_failed_generation' });
    await service.submitCommand(cmd);
    await service.claimCommand(cmd.commandId, 'doc_failed_generation');
    const { promises: nodeFs } = await import('node:fs');
    const realRename = nodeFs.rename.bind(nodeFs);
    let failNextRename = true;
    const renameSpy = vi.spyOn(nodeFs, 'rename').mockImplementation(async (...args) => {
      if (failNextRename && String(args[1]).includes(PROTOCOL_STORE_NAME)) {
        failNextRename = false;
        throw new Error('injected protocol rename failure');
      }
      return realRename(...args);
    });
    try {
      await expect(service.handleEvent({ protocolVersion: 1, eventId: 'evt_failed_generation', commandId: cmd.commandId, eventType: 'MESSAGE_COMMITTED', source: 'content-script', sessionId: 'sess_failed_generation', conversationId: 'conv_failed_generation', generation: service.getGeneration(), sequence: 1, occurredAt: Date.now(), payload: { proofLevel: 'STRONG_COMMIT', nativeMessageId: 'native_failed_generation', conversationId: 'conv_failed_generation', candidateCount: 1 } })).rejects.toThrow('injected protocol rename failure');
      expect(service.getStore().get(cmd.commandId)?.state).toBe('CLAIMED');
      await flushDurable();
      const snapshot = await readDurable<ProtocolStoreSnapshot>(PROTOCOL_STORE_NAME);
      expect(snapshot?.commands[cmd.commandId]?.state).toBe('CLAIMED');
      expect(snapshot?.commands[cmd.commandId]?.nativeMessageId).toBeNull();
      expect(snapshot?.recentCommittedIds).not.toContain(cmd.commandId);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('waits for admitted event handling before stop flushes and returns', async () => {
    const cmd = service.createCommand('SEND_MESSAGE', { text: 'stop boundary', targetConversationId: 'conv_stop_boundary' }, { sessionId: 'sess_stop_boundary', conversationId: 'conv_stop_boundary' });
    await service.submitCommand(cmd);
    await service.claimCommand(cmd.commandId, 'doc_stop_boundary');
    const store = service.getStore();
    const originalUpdate = store.updateCommand.bind(store);
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    let updateEntered!: () => void;
    const entered = new Promise<void>((resolve) => { updateEntered = resolve; });
    store.updateCommand = async (record, immediate) => {
      if (record.command.commandId === cmd.commandId && record.state === 'EXECUTING') {
        updateEntered();
        await updateGate;
      }
      return originalUpdate(record, immediate);
    };
    const handling = service.handleEvent({ protocolVersion: 1, eventId: 'evt_stop_boundary', commandId: cmd.commandId, eventType: 'MESSAGE_SUBMIT_STARTED', source: 'content-script', sessionId: 'sess_stop_boundary', conversationId: 'conv_stop_boundary', generation: service.getGeneration(), sequence: 1, occurredAt: Date.now(), payload: {} });
    await entered;
    let stopped = false;
    const stopping = service.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopped).toBe(false);
    releaseUpdate();
    await handling;
    await stopping;
  });

  it('serializes concurrent different eventIds for the same durable commit fact', async () => {
    const cmd = service.createCommand('SEND_MESSAGE', { text: 'concurrent fact', targetConversationId: 'conv_concurrent' }, { sessionId: 'sess_concurrent', conversationId: 'conv_concurrent' });
    await service.submitCommand(cmd);
    await service.claimCommand(cmd.commandId, 'doc_concurrent');
    const makeEvent = (eventId: string): ProtocolEvent => ({ protocolVersion: 1, eventId, commandId: cmd.commandId, eventType: 'MESSAGE_COMMITTED', source: 'content-script', sessionId: 'sess_concurrent', conversationId: 'conv_concurrent', generation: service.getGeneration(), sequence: 1, occurredAt: Date.now(), payload: { proofLevel: 'STRONG_COMMIT', nativeMessageId: 'native_concurrent_1', conversationId: 'conv_concurrent', candidateCount: 1 } });
    let notifications = 0;
    service.onEvent(() => notifications++);
    const results = await Promise.all([service.handleEvent(makeEvent('evt_concurrent_a')), service.handleEvent(makeEvent('evt_concurrent_b'))]);
    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    expect(results.filter((result) => result.reason === 'FACT_ALREADY_APPLIED')).toHaveLength(1);
    expect(notifications).toBe(1);
  });

  it('serializes concurrent deliveries of the same eventId', async () => {
    const cmd = service.createCommand('SEND_MESSAGE', { text: 'same envelope', targetConversationId: 'conv_same_event' }, { sessionId: 'sess_same_event', conversationId: 'conv_same_event' });
    await service.submitCommand(cmd);
    await service.claimCommand(cmd.commandId, 'doc_same_event');
    const event: ProtocolEvent = { protocolVersion: 1, eventId: 'evt_same_concurrent', commandId: cmd.commandId, eventType: 'MESSAGE_COMMITTED', source: 'content-script', sessionId: 'sess_same_event', conversationId: 'conv_same_event', generation: service.getGeneration(), sequence: 1, occurredAt: Date.now(), payload: { proofLevel: 'STRONG_COMMIT', nativeMessageId: 'native_same_event', conversationId: 'conv_same_event', candidateCount: 1 } };
    let notifications = 0;
    service.onEvent(() => notifications++);
    const results = await Promise.all([service.handleEvent(event), service.handleEvent(event)]);
    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    expect(results.filter((result) => result.reason === 'DUPLICATE_EVENT')).toHaveLength(1);
    expect(notifications).toBe(1);
  });

  it('does not regress terminal authority when progress events replay', async () => {
    const cmd = service.createCommand('SEND_MESSAGE', { text: 'terminal progress replay', targetConversationId: 'conv_progress_replay' }, { sessionId: 'sess_progress_replay', conversationId: 'conv_progress_replay' });
    await service.submitCommand(cmd);
    await service.claimCommand(cmd.commandId, 'doc_progress_replay');
    await service.handleEvent({ protocolVersion: 1, eventId: 'evt_progress_commit', commandId: cmd.commandId, eventType: 'MESSAGE_COMMITTED', source: 'content-script', sessionId: 'sess_progress_replay', conversationId: 'conv_progress_replay', generation: service.getGeneration(), sequence: 1, occurredAt: Date.now(), payload: { proofLevel: 'STRONG_COMMIT', nativeMessageId: 'native_progress_replay', conversationId: 'conv_progress_replay', candidateCount: 1 } });
    const record = service.getStore().get(cmd.commandId)!;
    const committedAt = record.committedAt;
    await service.handleEvent({ protocolVersion: 1, eventId: 'evt_progress_claim_replay', commandId: cmd.commandId, eventType: 'COMMAND_CLAIMED', source: 'content-script', sessionId: 'sess_progress_replay', conversationId: 'conv_progress_replay', generation: service.getGeneration(), sequence: 2, occurredAt: Date.now(), payload: { clientDocumentId: 'doc_progress_replay', tabId: 1, claimedAt: Date.now() } });
    await service.handleEvent({ protocolVersion: 1, eventId: 'evt_progress_submit_replay', commandId: cmd.commandId, eventType: 'MESSAGE_SUBMIT_STARTED', source: 'content-script', sessionId: 'sess_progress_replay', conversationId: 'conv_progress_replay', generation: service.getGeneration(), sequence: 3, occurredAt: Date.now(), payload: {} });
    expect(record.state).toBe('COMMITTED');
    expect(record.committedAt).toBe(committedAt);
    expect(record.orderingBySource?.['content-script']).toEqual({ sequence: 3, eventType: 'MESSAGE_SUBMIT_STARTED', payloadIdentity: '{}' });
  });

  it('keeps ephemeral observations process-local instead of suppressing them as durable facts', async () => {
    const cmd = service.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_ephemeral' });
    await service.submitCommand(cmd);
    let notifications = 0;
    service.onEvent(() => notifications++);
    const base = { protocolVersion: 1 as const, commandId: cmd.commandId, source: 'extension-background' as const, sessionId: 'sess_ephemeral', conversationId: null, generation: service.getGeneration(), sequence: 1, occurredAt: Date.now(), payload: {} };
    expect((await service.handleEvent({ ...base, eventId: 'evt_tab_acquired_a', eventType: 'TAB_ACQUIRED' })).accepted).toBe(true);
    expect((await service.handleEvent({ ...base, eventId: 'evt_tab_acquired_b', eventType: 'TAB_ACQUIRED', sequence: 2 })).accepted).toBe(true);
    expect(notifications).toBe(2);
  });

  it('fails closed when a committed command receives a conflicting native message fact', async () => {
    const cmd = service.createCommand('SEND_MESSAGE', { text: 'conflict', targetConversationId: 'conv_conflict' }, { sessionId: 'sess_conflict', conversationId: 'conv_conflict' });
    await service.submitCommand(cmd);
    await service.claimCommand(cmd.commandId, 'doc_conflict');
    const makeEvent = (eventId: string, nativeMessageId: string): ProtocolEvent => ({ protocolVersion: 1, eventId, commandId: cmd.commandId, eventType: 'MESSAGE_COMMITTED', source: 'content-script', sessionId: 'sess_conflict', conversationId: 'conv_conflict', generation: service.getGeneration(), sequence: 1, occurredAt: Date.now(), payload: { proofLevel: 'STRONG_COMMIT', nativeMessageId, conversationId: 'conv_conflict', candidateCount: 1 } });
    await service.handleEvent(makeEvent('evt_conflict_a', 'native_conflict_a'));
    const conflict = await service.handleEvent(makeEvent('evt_conflict_b', 'native_conflict_b'));
    expect(conflict).toEqual({ accepted: false, reason: 'CONFLICTING_DURABLE_FACT' });
    expect(service.getStore().get(cmd.commandId)?.nativeMessageId).toBe('native_conflict_a');
  });

  it('does not let COMMAND_COMPLETED bypass lifecycle validation', async () => {
    adapter.faultConfig.dropNextSend = true;
    const cmd = service.createCommand('SEND_MESSAGE', { text: 'not complete', targetConversationId: 'conv_not_complete' }, { sessionId: 'sess_not_complete', conversationId: 'conv_not_complete' });
    const record = await service.submitCommand(cmd);
    expect(record.state).toBe('PERSISTED');
    const result = await service.handleEvent({ protocolVersion: 1, eventId: 'evt_invalid_complete', commandId: cmd.commandId, eventType: 'COMMAND_COMPLETED', source: 'content-script', sessionId: 'sess_not_complete', conversationId: 'conv_not_complete', generation: service.getGeneration(), sequence: 1, occurredAt: Date.now(), payload: {} });
    expect(result).toEqual({ accepted: false, reason: 'INVALID_LIFECYCLE_FACT' });
    expect(record.state).toBe('PERSISTED');
    expect(record.completedAt).toBeNull();
  });

  // 10. Tab closes during operation
  it('Scenario 10: tab closes during operation', async () => {
    const cmd = service.createCommand('SEND_MESSAGE', {
      text: 'Tab will close',
      targetConversationId: 'conv_10'
    }, { sessionId: 'sess_10' });

    await service.submitCommand(cmd);
    await service.claimCommand(cmd.commandId, 'tab_closing');

    // Extension detects chrome.tabs.onRemoved
    await service.handleEvent({
      protocolVersion: 1,
      eventId: 'evt_tab_closed',
      commandId: cmd.commandId,
      eventType: 'COMMAND_FAILED',
      source: 'extension-background',
      sessionId: 'sess_10',
      conversationId: 'conv_10',
      generation: service.getGeneration(),
      sequence: 1,
      occurredAt: Date.now(),
      payload: {
        errorCode: 'TAB_CLOSED',
        message: 'ChatGPT tab closed by user before submission',
        retryable: false,
        failedAt: Date.now()
      }
    });

    const rec = service.getStore().get(cmd.commandId);
    expect(rec?.state).toBe('FAILED');
    expect(rec?.lastError).toContain('tab closed');
  });

  // 10B. Tab closed after submit action initiated: MUST become AMBIGUOUS, not FAILED
  it('Scenario 10B: tab closed after submit action becomes AMBIGUOUS', async () => {
    const cmd = service.createCommand('SEND_MESSAGE', {
      text: 'Submit started then tab closed',
      targetConversationId: 'conv_10b'
    }, { sessionId: 'sess_10b' });

    await service.submitCommand(cmd);
    await service.claimCommand(cmd.commandId, 'tab_closing_10b');

    // Submit started (state = EXECUTING)
    await service.handleEvent({
      protocolVersion: 1,
      eventId: 'evt_exec_10b',
      commandId: cmd.commandId,
      eventType: 'MESSAGE_SUBMIT_STARTED',
      source: 'content-script',
      sessionId: 'sess_10b',
      conversationId: 'conv_10b',
      generation: service.getGeneration(),
      sequence: 1,
      occurredAt: Date.now(),
      payload: {}
    });

    // Tab closed after submit was initiated
    await service.handleEvent({
      protocolVersion: 1,
      eventId: 'evt_tab_closed_10b',
      commandId: cmd.commandId,
      eventType: 'COMMAND_FAILED',
      source: 'extension-background',
      sessionId: 'sess_10b',
      conversationId: 'conv_10b',
      generation: service.getGeneration(),
      sequence: 2,
      occurredAt: Date.now(),
      payload: {
        errorCode: 'TAB_CLOSED',
        message: 'Tab closed while submit was in-flight',
        retryable: false,
        failedAt: Date.now()
      }
    });

    const rec = service.getStore().get(cmd.commandId);
    // Must be AMBIGUOUS because server-side turn may have been initiated
    expect(rec?.state).toBe('AMBIGUOUS');
  });

  // 11. Extension reconnects with incompatible protocol
  it('Scenario 11: extension reconnects with incompatible protocol', () => {
    const reject = service.handleHandshakeHello({
      type: 'HELLO',
      protocolVersion: 99, // Incompatible version
      extensionVersion: '1.0.0',
      connectionGeneration: 1,
      capabilities: ['SEND_MESSAGE']
    });

    expect(reject.type).toBe('REJECT');
    if (reject.type === 'REJECT') {
      expect(reject.reason).toBe('PROTOCOL_MISMATCH');
      expect(reject.expectedVersion).toBe(1);
      expect(reject.actualVersion).toBe(99);
    }
  });

  // 12. Command expires
  it('Scenario 12: command expires', async () => {
    const cmd = service.createCommand('SESSION_PROBE', { probeTabs: true }, {
      sessionId: 'sess_12',
      expiresInMs: 1 // 1ms expiry
    });

    await service.submitCommand(cmd);

    // Wait 5ms for expiry
    await new Promise((r) => setTimeout(r, 10));

    const claimRes = await service.claimCommand(cmd.commandId, 'late_doc');
    expect(claimRes.ok).toBe(false);
    expect(claimRes.error).toBe('COMMAND_EXPIRED');

    const rec = service.getStore().get(cmd.commandId);
    expect(rec?.state).toBe('EXPIRED');
  });

  // 13. Cancel before commit
  it('Scenario 13: cancel before commit', async () => {
    const cmd = service.createCommand('SEND_MESSAGE', {
      text: 'Cancel me in time',
      targetConversationId: 'conv_13'
    }, { sessionId: 'sess_13' });

    await service.submitCommand(cmd);
    await service.claimCommand(cmd.commandId, 'doc_13');

    const cancel = await service.cancelCommand(cmd.commandId, 'Aborted by user');
    expect(cancel.ok).toBe(true);
    expect(cancel.status).toBe('CANCELED_BEFORE_COMMIT');

    const rec = service.getStore().get(cmd.commandId);
    expect(rec?.state).toBe('CANCELED');
  });

  // 14. Cancel after commit
  it('Scenario 14: cancel after commit', async () => {
    const cmd = service.createCommand('SEND_MESSAGE', {
      text: 'Already entered ChatGPT',
      targetConversationId: 'conv_14'
    }, { sessionId: 'sess_14' });

    await service.submitCommand(cmd);
    await service.claimCommand(cmd.commandId, 'doc_14');

    await service.handleEvent({
      protocolVersion: 1,
      eventId: 'evt_commit_14',
      commandId: cmd.commandId,
      eventType: 'MESSAGE_COMMITTED',
      source: 'content-script',
      sessionId: 'sess_14',
      conversationId: 'conv_14',
      generation: service.getGeneration(),
      sequence: 1,
      occurredAt: Date.now(),
      payload: { proofLevel: 'STRONG_COMMIT', nativeMessageId: 'gpt_msg_14', conversationId: 'conv_14', candidateCount: 1 }
    });

    const cancel = await service.cancelCommand(cmd.commandId, 'Try to cancel after commit');
    expect(cancel.ok).toBe(false);
    expect(cancel.status).toBe('COMMIT_ALREADY_OCCURRED');

    const rec = service.getStore().get(cmd.commandId);
    expect(rec?.state).toBe('COMMITTED'); // Preserves committed state!
  });

  // 15. Transport disconnect/reconnect
  it('Scenario 15: transport disconnect/reconnect', async () => {
    // 1. Disconnect transport
    await adapter.disconnect();
    expect(adapter.getState()).toBe('DISCONNECTED');

    // 2. Create and submit command while disconnected
    const cmd = service.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_15' });
    const rec = await service.submitCommand(cmd);
    expect(rec.state).toBe('PERSISTED'); // Safely retained in outbox

    // 3. Reconnect transport
    await adapter.connect();
    expect(adapter.getState()).toBe('CONNECTED');

    // 4. Redeliver unattempted command
    const redelivered = await service.dispatchRecord(rec);
    expect(redelivered).toBe(true);
    expect(rec.state).toBe('DISPATCHED');
  });
});
