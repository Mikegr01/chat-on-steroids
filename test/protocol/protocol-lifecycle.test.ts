import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeTransportAdapter } from '../../src/main/browser-transport/fake-adapter.js';
import { BrowserTransportService } from '../../src/main/browser-transport/service.js';
import { resetDurableForTests, initDurableStore } from '../../src/main/durable.js';
import type { ProtocolEvent } from '../../src/shared/protocol/index.js';
import type { DurableCommandRecord } from '../../src/main/browser-transport/types.js';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

describe('Kosmosyn Transport Protocol V1 - Command Lifecycle & Idempotency', () => {
  let tmpDir: string;
  let adapter: FakeTransportAdapter;
  let service: BrowserTransportService;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `kosmosyn-lifecycle-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tmpDir, { recursive: true });
    initDurableStore(tmpDir);

    adapter = new FakeTransportAdapter('CONNECTED');
    service = new BrowserTransportService(adapter, { instanceId: 'test-instance-1' });
    await service.start();
  });

  afterEach(async () => {
    await service.stop();
    resetDurableForTests();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('completes the full positive command lifecycle from CREATED to COMPLETED', async () => {
    const cmd = service.createCommand('SEND_MESSAGE', {
      text: 'Run unit test step 1',
      targetConversationId: 'conv_123',
      timeoutMs: 30000
    }, {
      sessionId: 'sess_1',
      conversationId: 'conv_123',
      idempotencyKey: 'idemp_step_1'
    });

    // 1. Submit and persist (commit barrier before dispatch)
    const record = await service.submitCommand(cmd);
    expect(record.state).toBe('DISPATCHED');
    expect(record.dispatchedAt).not.toBeNull();
    expect(record.persistedAt).toBeGreaterThan(0);

    // 2. Extension claims responsibility
    const claimRes = await service.claimCommand(cmd.commandId, 'doc_client_tab_1');
    expect(claimRes.ok).toBe(true);
    expect(record.state).toBe('CLAIMED');
    expect(record.owner).toBe('doc_client_tab_1');

    // 3. Execution starts (typing / clicking)
    const execEvent: ProtocolEvent = {
      protocolVersion: 1,
      eventId: 'evt_exec_1',
      commandId: cmd.commandId,
      eventType: 'MESSAGE_SUBMIT_STARTED',
      source: 'content-script',
      sessionId: 'sess_1',
      conversationId: 'conv_123',
      generation: service.getGeneration(),
      sequence: 1,
      occurredAt: Date.now(),
      payload: {}
    };
    await service.handleEvent(execEvent);
    expect(record.state).toBe('EXECUTING');

    // 4. Observable commit in ChatGPT DOM
    const commitEvent: ProtocolEvent = {
      protocolVersion: 1,
      eventId: 'evt_commit_1',
      commandId: cmd.commandId,
      eventType: 'MESSAGE_COMMITTED',
      source: 'content-script',
      sessionId: 'sess_1',
      conversationId: 'conv_123',
      generation: service.getGeneration(),
      sequence: 2,
      occurredAt: Date.now(),
      payload: {
        proofLevel: 'STRONG_COMMIT',
        nativeMessageId: 'gpt_msg_xyz',
        conversationId: 'conv_123',
        candidateCount: 1
      }
    };
    await service.handleEvent(commitEvent);
    expect(record.state).toBe('COMMITTED');
    expect(record.committedAt).not.toBeNull();
    expect(record.commitProofLevel).toBe('STRONG_COMMIT');

    // 5. Completion
    const completeEvent: ProtocolEvent = {
      protocolVersion: 1,
      eventId: 'evt_comp_1',
      commandId: cmd.commandId,
      eventType: 'COMMAND_COMPLETED',
      source: 'extension-background',
      sessionId: 'sess_1',
      conversationId: 'conv_123',
      generation: service.getGeneration(),
      sequence: 3,
      occurredAt: Date.now(),
      payload: {}
    };
    await service.handleEvent(completeEvent);
    expect(record.state).toBe('COMPLETED');
    expect(record.completedAt).not.toBeNull();
  });

  it('guarantees idempotency when the same mutation is submitted twice', async () => {
    const cmd1 = service.createCommand('SEND_MESSAGE', {
      text: 'Idempotent instruction',
      targetConversationId: 'conv_idemp'
    }, {
      sessionId: 'sess_1',
      idempotencyKey: 'fixed_idempotency_key_100'
    });

    const rec1 = await service.submitCommand(cmd1);
    expect(rec1.state).toBe('DISPATCHED');

    // Create a second command with identical idempotencyKey and identical payload
    const cmd2 = service.createCommand('SEND_MESSAGE', {
      text: 'Idempotent instruction',
      targetConversationId: 'conv_idemp'
    }, {
      sessionId: 'sess_1',
      idempotencyKey: 'fixed_idempotency_key_100'
    });

    const rec2 = await service.submitCommand(cmd2);
    // Must return the exact same underlying durable record
    expect(rec2.command.commandId).toBe(rec1.command.commandId);
    expect(rec2.command.idempotencyKey).toBe('fixed_idempotency_key_100');

    // But submitting a different payload with the same key must be rejected
    const conflictingCmd = service.createCommand('SEND_MESSAGE', {
      text: 'Different payload with conflicting key',
      targetConversationId: 'conv_idemp'
    }, {
      sessionId: 'sess_1',
      idempotencyKey: 'fixed_idempotency_key_100'
    });

    await expect(service.submitCommand(conflictingCmd)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  });

  it('deduplicates incoming events delivered more than once', async () => {
    const cmd = service.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_1' });
    await service.submitCommand(cmd);

    const event: ProtocolEvent = {
      protocolVersion: 1,
      eventId: 'evt_probe_once',
      commandId: cmd.commandId,
      eventType: 'COMMAND_CLAIMED',
      source: 'extension-background',
      sessionId: 'sess_1',
      conversationId: null,
      generation: service.getGeneration(),
      sequence: 1,
      occurredAt: Date.now(),
      payload: { clientDocumentId: 'doc_probe_once', tabId: 1, claimedAt: Date.now() }
    };

    const first = await service.handleEvent(event);
    expect(first.accepted).toBe(true);
    expect(first.duplicate).toBeUndefined();

    // Re-deliver same event
    const second = await service.handleEvent(event);
    expect(second.accepted).toBe(false);
    expect(second.duplicate).toBe(true);
  });

  it('rejects stale events with an older generation number', async () => {
    const cmd = service.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_1' });
    await service.submitCommand(cmd);

    // Bump generation (e.g. extension reconnect or tab cycle)
    service.advanceGeneration(); // generation is now 2

    const staleEvent: ProtocolEvent = {
      protocolVersion: 1,
      eventId: 'evt_stale_1',
      commandId: cmd.commandId,
      eventType: 'COMMAND_COMPLETED',
      source: 'extension-background',
      sessionId: 'sess_1',
      conversationId: null,
      generation: 1, // Stale generation
      sequence: 1,
      occurredAt: Date.now(),
      payload: {}
    };

    const res = await service.handleEvent(staleEvent);
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe('STALE_GENERATION');
  });

  it('transitions to AMBIGUOUS and halts automatic replay when commit proof is ambiguous', async () => {
    const cmd = service.createCommand('SEND_MESSAGE', {
      text: 'Potentially committed prompt',
      targetConversationId: 'conv_ambig'
    }, { sessionId: 'sess_1', conversationId: 'conv_ambig' });

    const record = await service.submitCommand(cmd);
    await service.claimCommand(cmd.commandId, 'doc_ambig');

    const ambiguousEvent: ProtocolEvent = {
      protocolVersion: 1,
      eventId: 'evt_ambig_commit',
      commandId: cmd.commandId,
      eventType: 'MESSAGE_COMMITTED',
      source: 'content-script',
      sessionId: 'sess_1',
      conversationId: 'conv_ambig',
      generation: service.getGeneration(),
      sequence: 1,
      occurredAt: Date.now(),
      payload: {
        proofLevel: 'AMBIGUOUS',
        conversationId: 'conv_ambig',
        evidenceDetails: 'Tab navigated or timed out during submission'
      }
    };

    await service.handleEvent(ambiguousEvent);
    expect(record.state).toBe('AMBIGUOUS');
  });

  it('refuses cancellation after mutation has already committed', async () => {
    const cmd = service.createCommand('SEND_MESSAGE', {
      text: 'Do not cancel after send',
      targetConversationId: 'conv_cancel_test'
    }, { sessionId: 'sess_1', conversationId: 'conv_cancel_test' });

    await service.submitCommand(cmd);
    await service.claimCommand(cmd.commandId, 'doc_cancel');

    // Cancel BEFORE commit succeeds
    const uncommittedCmd = service.createCommand('SEND_MESSAGE', {
      text: 'Cancel before commit',
      targetConversationId: 'conv_cancel_test'
    }, { sessionId: 'sess_1' });
    await service.submitCommand(uncommittedCmd);
    const cancelBefore = await service.cancelCommand(uncommittedCmd.commandId, 'User changed mind');
    expect(cancelBefore.ok).toBe(true);
    expect(cancelBefore.status).toBe('CANCELED_BEFORE_COMMIT');

    // Now commit the first command
    const commitEvent: ProtocolEvent = {
      protocolVersion: 1,
      eventId: 'evt_committed_already',
      commandId: cmd.commandId,
      eventType: 'MESSAGE_COMMITTED',
      source: 'content-script',
      sessionId: 'sess_1',
      conversationId: 'conv_cancel_test',
      generation: service.getGeneration(),
      sequence: 1,
      occurredAt: Date.now(),
      payload: { proofLevel: 'STRONG_COMMIT', nativeMessageId: 'gpt_msg_cancel_1', conversationId: 'conv_cancel_test', candidateCount: 1 }
    };
    await service.handleEvent(commitEvent);

    // Cancel AFTER commit is refused
    const cancelAfter = await service.cancelCommand(cmd.commandId, 'User wants to cancel committed send');
    expect(cancelAfter.ok).toBe(false);
    expect(cancelAfter.status).toBe('COMMIT_ALREADY_OCCURRED');
  });

  it('reconciles CANCELED command to COMMITTED when external commitment evidence is observed', async () => {
    const cmd = service.createCommand('SEND_MESSAGE', {
      text: 'Cancel racing with commit',
      targetConversationId: 'conv_race'
    }, { sessionId: 'sess_1', conversationId: 'conv_race' });

    await service.submitCommand(cmd);
    await service.claimCommand(cmd.commandId, 'doc_race');

    // User or desktop issues cancel before receiving ACK
    const cancelRes = await service.cancelCommand(cmd.commandId, 'Canceled in flight');
    expect(cancelRes.ok).toBe(true);
    expect(service.getStore().get(cmd.commandId)?.state).toBe('CANCELED');

    // But the browser actually executed the send and reports MESSAGE_COMMITTED!
    const commitEvent: ProtocolEvent = {
      protocolVersion: 1,
      eventId: 'evt_commit_race',
      commandId: cmd.commandId,
      eventType: 'MESSAGE_COMMITTED',
      source: 'content-script',
      sessionId: 'sess_1',
      conversationId: 'conv_race',
      generation: service.getGeneration(),
      sequence: 2,
      occurredAt: Date.now(),
      payload: {
        proofLevel: 'STRONG_COMMIT',
        nativeMessageId: 'gpt_msg_race_1',
        conversationId: 'conv_race',
        candidateCount: 1
      }
    };

    const handleRes = await service.handleEvent(commitEvent);
    expect(handleRes.accepted).toBe(true);
    // External fact wins: command transitions to COMMITTED despite prior cancellation
    expect(service.getStore().get(cmd.commandId)?.state).toBe('COMMITTED');
  });

  it('blocks dispatch when command requires a capability not negotiated by peer', async () => {
    // Peer connects and negotiates ONLY SESSION_BINDING, not SEND_MESSAGE
    service.handleHandshakeHello({
      type: 'HELLO',
      protocolVersion: 1,
      extensionVersion: '2.1.20',
      connectionGeneration: 1,
      capabilities: ['SESSION_BINDING']
    });

    const sendCmd = service.createCommand('SEND_MESSAGE', {
      text: 'Should be blocked due to missing capability',
      targetConversationId: 'conv_cap'
    }, { sessionId: 'sess_1', conversationId: 'conv_cap' });

    const rec = await service.submitCommand(sendCmd);
    // Wire dispatch must be blocked
    expect(rec.state).toBe('BLOCKED');
    expect(rec.lastError).toContain('CAPABILITY_UNAVAILABLE: SEND_MESSAGE');
  });

  it('rejects STRONG_COMMIT for SEND_MESSAGE without a native message identity', async () => {
    const cmd = service.createCommand('SEND_MESSAGE', { text: 'identity required', targetConversationId: 'conv_native' }, { sessionId: 'sess_native', conversationId: 'conv_native' });
    const record = await service.submitCommand(cmd);
    await service.claimCommand(cmd.commandId, 'doc_native');
    await service.handleEvent({ protocolVersion: 1, eventId: 'evt_native_missing', commandId: cmd.commandId, eventType: 'MESSAGE_COMMITTED', source: 'content-script', sessionId: 'sess_native', conversationId: 'conv_native', generation: service.getGeneration(), sequence: 1, occurredAt: Date.now(), payload: { proofLevel: 'STRONG_COMMIT', conversationId: 'conv_native' } });
    expect(record.state).toBe('AMBIGUOUS');
  });

  it('accepts one native identity only for the target conversation and never reuses it across commands', async () => {
    const first = service.createCommand('SEND_MESSAGE', { text: 'same text', targetConversationId: 'conv_native' }, { sessionId: 'sess_native', conversationId: 'conv_native' });
    const second = service.createCommand('SEND_MESSAGE', { text: 'same text', targetConversationId: 'conv_native' }, { sessionId: 'sess_native', conversationId: 'conv_native' });
    const firstRecord = await service.submitCommand(first);
    const secondRecord = await service.submitCommand(second);
    await service.claimCommand(first.commandId, 'doc_first');
    await service.claimCommand(second.commandId, 'doc_second');
    const strong = (commandId: string, eventId: string, nativeMessageId: string, conversationId = 'conv_native', candidateCount = 1): ProtocolEvent => ({ protocolVersion: 1, eventId, commandId, eventType: 'MESSAGE_COMMITTED', source: 'content-script', sessionId: 'sess_native', conversationId, generation: service.getGeneration(), sequence: 1, occurredAt: Date.now(), payload: { proofLevel: 'STRONG_COMMIT', nativeMessageId, conversationId, candidateCount } });
    await service.handleEvent(strong(first.commandId, 'evt_native_first', 'native_A'));
    expect(firstRecord.state).toBe('COMMITTED');
    expect(firstRecord.nativeMessageId).toBe('native_A');
    await service.handleEvent(strong(second.commandId, 'evt_native_reuse', 'native_A'));
    expect(secondRecord.state).toBe('AMBIGUOUS');
  });

  it('keeps identical visible messages distinct when their native IDs differ', async () => {
    const ids = ['native_repeat_A', 'native_repeat_B'];
    const records = [];
    for (let index = 0; index < ids.length; index++) {
      const cmd = service.createCommand('SEND_MESSAGE', { text: 'identical', targetConversationId: 'conv_repeat' }, { sessionId: 'sess_repeat', conversationId: 'conv_repeat' });
      const record = await service.submitCommand(cmd);
      await service.claimCommand(cmd.commandId, `doc_repeat_${index}`);
      await service.handleEvent({ protocolVersion: 1, eventId: `evt_repeat_${index}`, commandId: cmd.commandId, eventType: 'MESSAGE_COMMITTED', source: 'content-script', sessionId: 'sess_repeat', conversationId: 'conv_repeat', generation: service.getGeneration(), sequence: 1, occurredAt: Date.now(), payload: { proofLevel: 'STRONG_COMMIT', nativeMessageId: ids[index], conversationId: 'conv_repeat', candidateCount: 1 } });
      records.push(record);
    }
    expect(records.map((record) => record.nativeMessageId)).toEqual(ids);
    expect(records.every((record) => record.state === 'COMMITTED')).toBe(true);
  });

  it('rejects wrong-conversation, zero-candidate, and multiple-candidate strong proofs as ambiguous', async () => {
    for (const [suffix, conversationId, candidateCount] of [['wrong', 'conv_other', 1], ['zero', 'conv_gate', 0], ['many', 'conv_gate', 2]] as const) {
      const cmd = service.createCommand('SEND_MESSAGE', { text: suffix, targetConversationId: 'conv_gate' }, { sessionId: 'sess_gate', conversationId: 'conv_gate' });
      const record = await service.submitCommand(cmd);
      await service.claimCommand(cmd.commandId, `doc_${suffix}`);
      await service.handleEvent({ protocolVersion: 1, eventId: `evt_${suffix}`, commandId: cmd.commandId, eventType: 'MESSAGE_COMMITTED', source: 'content-script', sessionId: 'sess_gate', conversationId, generation: service.getGeneration(), sequence: 1, occurredAt: Date.now(), payload: { proofLevel: 'STRONG_COMMIT', nativeMessageId: `native_${suffix}`, conversationId, candidateCount } });
      expect(record.state).toBe('AMBIGUOUS');
    }
  });
  it('fails closed when MESSAGE_COMMITTED targets a non-SEND command', async () => {
    const cmd = service.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_generic' });
    const record = await service.submitCommand(cmd);
    await service.claimCommand(cmd.commandId, 'doc_generic');
    await service.handleEvent({ protocolVersion: 1, eventId: 'evt_generic_commit', commandId: cmd.commandId, eventType: 'MESSAGE_COMMITTED', source: 'content-script', sessionId: 'sess_generic', conversationId: null, generation: service.getGeneration(), sequence: 1, occurredAt: Date.now(), payload: { proofLevel: 'STRONG_COMMIT', conversationId: 'conv_generic', nativeMessageId: 'native_generic', candidateCount: 1 } });
    expect(record.state).not.toBe('COMMITTED');
  });
  it('preserves COMMITTED mutation truth when a later workflow failure arrives', async () => {
    const cmd = service.createCommand('SEND_MESSAGE', { text: 'committed then generation fails', targetConversationId: 'conv_post_commit' }, { sessionId: 'sess_post_commit', conversationId: 'conv_post_commit' });
    const record = await service.submitCommand(cmd);
    await service.claimCommand(cmd.commandId, 'doc_post_commit');
    await service.handleEvent({ protocolVersion: 1, eventId: 'evt_post_commit', commandId: cmd.commandId, eventType: 'MESSAGE_COMMITTED', source: 'content-script', sessionId: 'sess_post_commit', conversationId: 'conv_post_commit', generation: service.getGeneration(), sequence: 1, occurredAt: Date.now(), payload: { proofLevel: 'STRONG_COMMIT', nativeMessageId: 'native_post_commit', conversationId: 'conv_post_commit', candidateCount: 1 } });
    await service.handleEvent({ protocolVersion: 1, eventId: 'evt_post_commit_failure', commandId: cmd.commandId, eventType: 'COMMAND_FAILED', source: 'content-script', sessionId: 'sess_post_commit', conversationId: 'conv_post_commit', generation: service.getGeneration(), sequence: 2, occurredAt: Date.now(), payload: { errorCode: 'INTERNAL_ERROR', message: 'assistant generation failed', retryable: false, failedAt: Date.now() } });
    expect(record.state).toBe('COMMITTED');
    expect(record.nativeMessageId).toBe('native_post_commit');
  });
  it('rejects a strong commit when a non-null command envelope conversation contradicts the SEND target', async () => {
    const cmd = service.createCommand('SEND_MESSAGE', { text: 'conversation authority', targetConversationId: 'conv_target' }, { sessionId: 'sess_authority', conversationId: 'conv_wrong' });
    const record = await service.submitCommand(cmd);
    await service.claimCommand(cmd.commandId, 'doc_authority');
    await service.handleEvent({ protocolVersion: 1, eventId: 'evt_authority', commandId: cmd.commandId, eventType: 'MESSAGE_COMMITTED', source: 'content-script', sessionId: 'sess_authority', conversationId: 'conv_target', generation: service.getGeneration(), sequence: 1, occurredAt: Date.now(), payload: { proofLevel: 'STRONG_COMMIT', nativeMessageId: 'native_authority', conversationId: 'conv_target', candidateCount: 1 } });
    expect(record.state).toBe('AMBIGUOUS');
  });

    // ======================================================================
  // AMENDMENT MATRIX TESTS: Non-Mutating Completion Semantics
  // ======================================================================

  function establishReady(srv: BrowserTransportService): string {
    const welcome = srv.handleHandshakeHello({
      type: 'HELLO',
      protocolVersion: 1,
      extensionVersion: '2.1.20',
      connectionGeneration: 1,
      capabilities: ['SESSION_BINDING', 'SEND_MESSAGE']
    });
    if (welcome.type === 'WELCOME') {
      srv.handleHandshakeReady({
        connectionGeneration: welcome.connectionGeneration,
        connectionEpoch: welcome.connectionEpoch
      });
      return welcome.connectionEpoch;
    }
    throw new Error('Handshake failed in test setup');
  }

  it('Matrix 1-7: SESSION_PROBE DISPATCHED + valid COMMAND_COMPLETED transitions to COMPLETED with valid non-mutating durable fields', async () => {
    const probe = service.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_matrix_1' });
    const record = await service.submitCommand(probe);
    expect(record.state).toBe('DISPATCHED');

    const connectionEpoch = establishReady(service);
    const completeEvent: ProtocolEvent = {
      protocolVersion: 1,
      eventId: 'evt_probe_mat_1',
      commandId: probe.commandId,
      eventType: 'COMMAND_COMPLETED',
      source: 'extension-background',
      sessionId: 'sess_matrix_1',
      conversationId: null,
      generation: service.getGeneration(),
      sequence: 1,
      occurredAt: Date.now(),
      connectionEpoch,
      emitterEpoch: 'emitter_mat_1',
      payload: { observedTabCount: 1 }
    };

    const res = await service.handleEvent(completeEvent);
    expect(res.accepted).toBe(true);

    // 1. Reaches COMPLETED
    expect(record.state).toBe('COMPLETED');
    // 2. Probe never enters COMMITTED (verified directly)
    // 3. commitProofLevel remains null
    expect(record.commitProofLevel).toBeNull();
    // 4. nativeMessageId remains null
    expect(record.nativeMessageId).toBeNull();
    // 5. commitConversationId remains null
    expect(record.commitConversationId).toBeNull();
    // 6. committedAt remains null
    expect(record.committedAt).toBeNull();
    // 7. completedAt becomes non-null
    expect(record.completedAt).toBeGreaterThan(0);
    // observedTabCount is NOT persisted in record
    expect((record as unknown as Record<string, unknown>).observedTabCount).toBeUndefined();
  });

  it('Matrix 8-9: observedTabCount=0 and bounded positive values succeed', async () => {
    const connectionEpoch = establishReady(service);

    // observedTabCount = 0 (Matrix item 8)
    const probe0 = service.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_tab_0' });
    const rec0 = await service.submitCommand(probe0);
    const res0 = await service.handleEvent({
      protocolVersion: 1,
      eventId: 'evt_tab_0',
      commandId: probe0.commandId,
      eventType: 'COMMAND_COMPLETED',
      source: 'extension-background',
      sessionId: 'sess_tab_0',
      conversationId: null,
      generation: service.getGeneration(),
      sequence: 1,
      occurredAt: Date.now(),
      connectionEpoch,
      emitterEpoch: 'emitter_tab_0',
      payload: { observedTabCount: 0 }
    });
    expect(res0.accepted).toBe(true);
    expect(rec0.state).toBe('COMPLETED');

    // observedTabCount = 25 (Matrix item 9)
    const probe25 = service.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_tab_25' });
    const rec25 = await service.submitCommand(probe25);
    const res25 = await service.handleEvent({
      protocolVersion: 1,
      eventId: 'evt_tab_25',
      commandId: probe25.commandId,
      eventType: 'COMMAND_COMPLETED',
      source: 'extension-background',
      sessionId: 'sess_tab_25',
      conversationId: null,
      generation: service.getGeneration(),
      sequence: 1,
      occurredAt: Date.now(),
      connectionEpoch,
      emitterEpoch: 'emitter_tab_25',
      payload: { observedTabCount: 25 }
    });
    expect(res25.accepted).toBe(true);
    expect(rec25.state).toBe('COMPLETED');
  });

  it('Matrix 10-16: invalid payloads fail with INVALID_LIFECYCLE_FACT without durable mutation', async () => {
    const connectionEpoch = establishReady(service);
    const invalidPayloads: Array<{ name: string; payload: unknown }> = [
      { name: 'Matrix 10: missing payload / empty object', payload: {} },
      { name: 'Matrix 11: negative tab count', payload: { observedTabCount: -1 } },
      { name: 'Matrix 12: fractional tab count', payload: { observedTabCount: 1.5 } },
      { name: 'Matrix 13: count > 10000', payload: { observedTabCount: 10001 } },
      { name: 'Matrix 14: unsafe integer', payload: { observedTabCount: Number.MAX_SAFE_INTEGER + 10 } },
      { name: 'Matrix 15: extra payload field', payload: { observedTabCount: 1, extra: 'forbidden' } },
      { name: 'Matrix 16: URL/title/full-tab payload', payload: { observedTabCount: 1, url: 'https://chatgpt.com', title: 'Chat' } }
    ];

    for (const [i, item] of invalidPayloads.entries()) {
      const { name, payload } = item;
      const probe = service.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: `sess_invalid_${i}` });
      const record = await service.submitCommand(probe);
      const res = await service.handleEvent({
        protocolVersion: 1,
        eventId: `evt_invalid_pay_${i}`,
        commandId: probe.commandId,
        eventType: 'COMMAND_COMPLETED',
        source: 'extension-background',
        sessionId: `sess_invalid_${i}`,
        conversationId: null,
        generation: service.getGeneration(),
        sequence: 1,
        occurredAt: Date.now(),
        connectionEpoch,
        emitterEpoch: `emitter_inv_${i}`,
        payload
      });
      expect(res, `Failed on: ${name}`).toEqual({ accepted: false, reason: 'INVALID_LIFECYCLE_FACT' });
      expect(record.state).toBe('DISPATCHED');
      expect(record.completedAt).toBeNull();
      expect(record.activeEmitterEpochBySource?.['extension-background']).toBeUndefined();
    }
  });

  it('Matrix 17-23: static semantic admission checks fail closed', async () => {
    const connectionEpoch = establishReady(service);

    // Matrix 17: source != extension-background (e.g. content-script)
    {
      const probe = service.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_adm_17' });
      const rec = await service.submitCommand(probe);
      const res = await service.handleEvent({
        protocolVersion: 1,
        eventId: 'evt_adm_17',
        commandId: probe.commandId,
        eventType: 'COMMAND_COMPLETED',
        source: 'content-script',
        sessionId: 'sess_adm_17',
        conversationId: null,
        generation: service.getGeneration(),
        sequence: 1,
        occurredAt: Date.now(),
        connectionEpoch,
        emitterEpoch: 'emitter_adm_17',
        payload: { observedTabCount: 1 }
      });
      expect(res).toEqual({ accepted: false, reason: 'INVALID_LIFECYCLE_FACT' });
      expect(rec.state).toBe('DISPATCHED');
    }

    // Matrix 18: command target != extension-background
    {
      const probe = service.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_adm_18' });
      (probe).target = 'content-script';
      const rec = await service.submitCommand(probe);
      const res = await service.handleEvent({
        protocolVersion: 1,
        eventId: 'evt_adm_18',
        commandId: probe.commandId,
        eventType: 'COMMAND_COMPLETED',
        source: 'extension-background',
        sessionId: 'sess_adm_18',
        conversationId: null,
        generation: service.getGeneration(),
        sequence: 1,
        occurredAt: Date.now(),
        connectionEpoch,
        emitterEpoch: 'emitter_adm_18',
        payload: { observedTabCount: 1 }
      });
      expect(res).toEqual({ accepted: false, reason: 'INVALID_LIFECYCLE_FACT' });
      expect(rec.state).toBe('DISPATCHED');
    }

    // Matrix 19: session mismatch
    {
      const probe = service.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_adm_19' });
      const rec = await service.submitCommand(probe);
      const res = await service.handleEvent({
        protocolVersion: 1,
        eventId: 'evt_adm_19',
        commandId: probe.commandId,
        eventType: 'COMMAND_COMPLETED',
        source: 'extension-background',
        sessionId: 'sess_mismatched',
        conversationId: null,
        generation: service.getGeneration(),
        sequence: 1,
        occurredAt: Date.now(),
        connectionEpoch,
        emitterEpoch: 'emitter_adm_19',
        payload: { observedTabCount: 1 }
      });
      expect(res).toEqual({ accepted: false, reason: 'INVALID_LIFECYCLE_FACT' });
      expect(rec.state).toBe('DISPATCHED');
    }

    // Matrix 20: command conversation non-null fails
    {
      const probe = service.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_adm_20', conversationId: 'conv_forbidden' });
      const rec = await service.submitCommand(probe);
      const res = await service.handleEvent({
        protocolVersion: 1,
        eventId: 'evt_adm_20',
        commandId: probe.commandId,
        eventType: 'COMMAND_COMPLETED',
        source: 'extension-background',
        sessionId: 'sess_adm_20',
        conversationId: null,
        generation: service.getGeneration(),
        sequence: 1,
        occurredAt: Date.now(),
        connectionEpoch,
        emitterEpoch: 'emitter_adm_20',
        payload: { observedTabCount: 1 }
      });
      expect(res).toEqual({ accepted: false, reason: 'INVALID_LIFECYCLE_FACT' });
      expect(rec.state).toBe('DISPATCHED');
    }

    // Matrix 21: probe targetConversationId non-null fails
    {
      const probe = service.createCommand('SESSION_PROBE', { probeTabs: true, targetConversationId: 'conv_in_payload' }, { sessionId: 'sess_adm_21' });
      const rec = await service.submitCommand(probe);
      const res = await service.handleEvent({
        protocolVersion: 1,
        eventId: 'evt_adm_21',
        commandId: probe.commandId,
        eventType: 'COMMAND_COMPLETED',
        source: 'extension-background',
        sessionId: 'sess_adm_21',
        conversationId: null,
        generation: service.getGeneration(),
        sequence: 1,
        occurredAt: Date.now(),
        connectionEpoch,
        emitterEpoch: 'emitter_adm_21',
        payload: { observedTabCount: 1 }
      });
      expect(res).toEqual({ accepted: false, reason: 'INVALID_LIFECYCLE_FACT' });
      expect(rec.state).toBe('DISPATCHED');
    }

    // Matrix 22: event conversation non-null fails
    {
      const probe = service.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_adm_22' });
      const rec = await service.submitCommand(probe);
      const res = await service.handleEvent({
        protocolVersion: 1,
        eventId: 'evt_adm_22',
        commandId: probe.commandId,
        eventType: 'COMMAND_COMPLETED',
        source: 'extension-background',
        sessionId: 'sess_adm_22',
        conversationId: 'conv_non_null_event',
        generation: service.getGeneration(),
        sequence: 1,
        occurredAt: Date.now(),
        connectionEpoch,
        emitterEpoch: 'emitter_adm_22',
        payload: { observedTabCount: 1 }
      });
      expect(res).toEqual({ accepted: false, reason: 'INVALID_LIFECYCLE_FACT' });
      expect(rec.state).toBe('DISPATCHED');
    }

    // Matrix 23: command completion before READY fails
    {
      const unreadyAdapter = new FakeTransportAdapter('CONNECTED');
      const unreadyService = new BrowserTransportService(unreadyAdapter, { instanceId: 'unready-1' });
      await unreadyService.start();

      const probe = unreadyService.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_adm_23' });
      const rec = await unreadyService.submitCommand(probe);
      // Service is NOT ready (no handshake)
      expect(unreadyService.isReady()).toBe(false);

      const res = await unreadyService.handleEvent({
        protocolVersion: 1,
        eventId: 'evt_adm_23',
        commandId: probe.commandId,
        eventType: 'COMMAND_COMPLETED',
        source: 'extension-background',
        sessionId: 'sess_adm_23',
        conversationId: null,
        generation: unreadyService.getGeneration(),
        sequence: 1,
        occurredAt: Date.now(),
        emitterEpoch: 'emitter_adm_23',
        payload: { observedTabCount: 1 }
      });
      expect(res).toEqual({ accepted: false, reason: 'INVALID_LIFECYCLE_FACT' });
      expect(rec.state).toBe('DISPATCHED');
      await unreadyService.stop();
    }
  });

  it('Matrix 29-32: completion from PERSISTED, BLOCKED, EXPIRED, CANCELED fails closed', async () => {
    const connectionEpoch = establishReady(service);

    // Matrix 29: completion from PERSISTED fails
    {
      const probe = service.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_elig_29' });
      // Put in PERSISTED by persisting without dispatching
      const record: DurableCommandRecord = {
        command: probe,
        state: 'PERSISTED',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        persistedAt: Date.now(),
        dispatchedAt: null,
        claimedAt: null,
        owner: null,
        claimLeaseUntil: null,
        committedAt: null,
        commitProofLevel: null,
        nativeMessageId: null,
        commitConversationId: null,
        completedAt: null,
        attempts: 0,
        lastError: null,
        cancellationRequested: false
      };
      await service.getStore().persistNewCommand(record);

      const res = await service.handleEvent({
        protocolVersion: 1,
        eventId: 'evt_elig_29',
        commandId: probe.commandId,
        eventType: 'COMMAND_COMPLETED',
        source: 'extension-background',
        sessionId: 'sess_elig_29',
        conversationId: null,
        generation: service.getGeneration(),
        sequence: 1,
        occurredAt: Date.now(),
        connectionEpoch,
        emitterEpoch: 'emitter_elig_29',
        payload: { observedTabCount: 1 }
      });
      expect(res).toEqual({ accepted: false, reason: 'INVALID_LIFECYCLE_FACT' });
      expect(record.state).toBe('PERSISTED');
    }

    // Matrix 30: completion from BLOCKED fails
    {
      const probe = service.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_elig_30' });
      const rec = await service.submitCommand(probe);
      rec.state = 'BLOCKED';
      await service.getStore().updateCommand(rec, true);

      const res = await service.handleEvent({
        protocolVersion: 1,
        eventId: 'evt_elig_30',
        commandId: probe.commandId,
        eventType: 'COMMAND_COMPLETED',
        source: 'extension-background',
        sessionId: 'sess_elig_30',
        conversationId: null,
        generation: service.getGeneration(),
        sequence: 1,
        occurredAt: Date.now(),
        connectionEpoch,
        emitterEpoch: 'emitter_elig_30',
        payload: { observedTabCount: 1 }
      });
      expect(res).toEqual({ accepted: false, reason: 'INVALID_LIFECYCLE_FACT' });
      expect(rec.state).toBe('BLOCKED');
    }

    // Matrix 31: completion from EXPIRED fails
    {
      const probe = service.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_elig_31' });
      const rec = await service.submitCommand(probe);
      rec.state = 'EXPIRED';
      await service.getStore().updateCommand(rec, true);

      const res = await service.handleEvent({
        protocolVersion: 1,
        eventId: 'evt_elig_31',
        commandId: probe.commandId,
        eventType: 'COMMAND_COMPLETED',
        source: 'extension-background',
        sessionId: 'sess_elig_31',
        conversationId: null,
        generation: service.getGeneration(),
        sequence: 1,
        occurredAt: Date.now(),
        connectionEpoch,
        emitterEpoch: 'emitter_elig_31',
        payload: { observedTabCount: 1 }
      });
      expect(res).toEqual({ accepted: false, reason: 'INVALID_LIFECYCLE_FACT' });
      expect(rec.state).toBe('EXPIRED');
    }

    // Matrix 32: completion from CANCELED fails
    {
      const probe = service.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_elig_32' });
      const rec = await service.submitCommand(probe);
      const cancelRes = await service.cancelCommand(probe.commandId, 'canceled before complete');
      expect(cancelRes.status).toBe('CANCELED_BEFORE_COMMIT');
      expect(rec.state).toBe('CANCELED');

      const res = await service.handleEvent({
        protocolVersion: 1,
        eventId: 'evt_elig_32',
        commandId: probe.commandId,
        eventType: 'COMMAND_COMPLETED',
        source: 'extension-background',
        sessionId: 'sess_elig_32',
        conversationId: null,
        generation: service.getGeneration(),
        sequence: 1,
        occurredAt: Date.now(),
        connectionEpoch,
        emitterEpoch: 'emitter_elig_32',
        payload: { observedTabCount: 1 }
      });
      expect(res).toEqual({ accepted: false, reason: 'INVALID_LIFECYCLE_FACT' });
      expect(rec.state).toBe('CANCELED');
    }
  });

  it('Matrix 33-37: mutating commands and other command types gain no direct completion', async () => {
    const connectionEpoch = establishReady(service);

    // Matrix 33: SEND_MESSAGE DISPATCHED -> completion without commit fails
    {
      const sendCmd = service.createCommand('SEND_MESSAGE', { text: 'test 33', targetConversationId: 'conv_33' }, { sessionId: 'sess_33', conversationId: 'conv_33' });
      const rec = await service.submitCommand(sendCmd);
      expect(rec.state).toBe('DISPATCHED');

      const res = await service.handleEvent({
        protocolVersion: 1,
        eventId: 'evt_33_comp',
        commandId: sendCmd.commandId,
        eventType: 'COMMAND_COMPLETED',
        source: 'extension-background',
        sessionId: 'sess_33',
        conversationId: 'conv_33',
        generation: service.getGeneration(),
        sequence: 1,
        occurredAt: Date.now(),
        connectionEpoch,
        emitterEpoch: 'emitter_33',
        payload: {}
      });
      expect(res).toEqual({ accepted: false, reason: 'INVALID_LIFECYCLE_FACT' });
      expect(rec.state).toBe('DISPATCHED');
    }

    // Matrix 34: SEND_MESSAGE EXECUTING -> completion without commit fails
    {
      const sendCmd = service.createCommand('SEND_MESSAGE', { text: 'test 34', targetConversationId: 'conv_34' }, { sessionId: 'sess_34', conversationId: 'conv_34' });
      const rec = await service.submitCommand(sendCmd);
      await service.claimCommand(sendCmd.commandId, 'doc_34');
      await service.handleEvent({
        protocolVersion: 1,
        eventId: 'evt_34_start',
        commandId: sendCmd.commandId,
        eventType: 'MESSAGE_SUBMIT_STARTED',
        source: 'content-script',
        sessionId: 'sess_34',
        conversationId: 'conv_34',
        generation: service.getGeneration(),
        sequence: 1,
        occurredAt: Date.now(),
        connectionEpoch,
        emitterEpoch: 'doc_34',
        payload: {}
      });
      expect(rec.state).toBe('EXECUTING');

      const res = await service.handleEvent({
        protocolVersion: 1,
        eventId: 'evt_34_comp',
        commandId: sendCmd.commandId,
        eventType: 'COMMAND_COMPLETED',
        source: 'content-script',
        sessionId: 'sess_34',
        conversationId: 'conv_34',
        generation: service.getGeneration(),
        sequence: 2,
        occurredAt: Date.now(),
        connectionEpoch,
        emitterEpoch: 'doc_34',
        payload: {}
      });
      expect(res).toEqual({ accepted: false, reason: 'INVALID_LIFECYCLE_FACT' });
      expect(rec.state).toBe('EXECUTING');
    }

    // Matrix 35: normal strong SEND_MESSAGE commit -> completion remains green
    {
      const sendCmd = service.createCommand('SEND_MESSAGE', { text: 'test 35', targetConversationId: 'conv_35' }, { sessionId: 'sess_35', conversationId: 'conv_35' });
      const rec = await service.submitCommand(sendCmd);
      await service.claimCommand(sendCmd.commandId, 'doc_35');
      await service.handleEvent({
        protocolVersion: 1,
        eventId: 'evt_35_commit',
        commandId: sendCmd.commandId,
        eventType: 'MESSAGE_COMMITTED',
        source: 'content-script',
        sessionId: 'sess_35',
        conversationId: 'conv_35',
        generation: service.getGeneration(),
        sequence: 1,
        occurredAt: Date.now(),
        connectionEpoch,
        emitterEpoch: 'doc_35',
        payload: { proofLevel: 'STRONG_COMMIT', nativeMessageId: 'gpt_35', conversationId: 'conv_35', candidateCount: 1 }
      });
      expect(rec.state).toBe('COMMITTED');

      const res = await service.handleEvent({
        protocolVersion: 1,
        eventId: 'evt_35_comp',
        commandId: sendCmd.commandId,
        eventType: 'COMMAND_COMPLETED',
        source: 'content-script',
        sessionId: 'sess_35',
        conversationId: 'conv_35',
        generation: service.getGeneration(),
        sequence: 2,
        occurredAt: Date.now(),
        connectionEpoch,
        emitterEpoch: 'doc_35',
        payload: {}
      });
      expect(res.accepted).toBe(true);
      expect(rec.state).toBe('COMPLETED');
    }

    // Matrix 36: BIND_SESSION gains no direct completion
    {
      const bindCmd = service.createCommand('BIND_SESSION', { targetConversationId: 'conv_36', sessionId: 'sess_bind_36', role: 'prime' }, { sessionId: 'sess_36' });
      const rec = await service.submitCommand(bindCmd);
      expect(rec.state).toBe('DISPATCHED');

      const res = await service.handleEvent({
        protocolVersion: 1,
        eventId: 'evt_36_comp',
        commandId: bindCmd.commandId,
        eventType: 'COMMAND_COMPLETED',
        source: 'extension-background',
        sessionId: 'sess_36',
        conversationId: null,
        generation: service.getGeneration(),
        sequence: 1,
        occurredAt: Date.now(),
        connectionEpoch,
        emitterEpoch: 'emitter_36',
        payload: {}
      });
      expect(res).toEqual({ accepted: false, reason: 'INVALID_LIFECYCLE_FACT' });
      expect(rec.state).toBe('DISPATCHED');
    }

    // Matrix 37: CANCEL_COMMAND gains no direct completion
    {
      const cancelCmd = service.createCommand('CANCEL_COMMAND', { targetCommandId: 'cmd_dummy', reason: 'abort' }, { sessionId: 'sess_37' });
      const rec = await service.submitCommand(cancelCmd);
      expect(rec.state).toBe('DISPATCHED');

      const res = await service.handleEvent({
        protocolVersion: 1,
        eventId: 'evt_37_comp',
        commandId: cancelCmd.commandId,
        eventType: 'COMMAND_COMPLETED',
        source: 'extension-background',
        sessionId: 'sess_37',
        conversationId: null,
        generation: service.getGeneration(),
        sequence: 1,
        occurredAt: Date.now(),
        connectionEpoch,
        emitterEpoch: 'emitter_37',
        payload: {}
      });
      expect(res).toEqual({ accepted: false, reason: 'INVALID_LIFECYCLE_FACT' });
      expect(rec.state).toBe('DISPATCHED');
    }
  });

  it('Matrix 38-40: duplicate probe completion is idempotent, emits no second notification, and malformed duplicate fails closed', async () => {
    const connectionEpoch = establishReady(service);
    const probe = service.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_dup_probe' });
    const record = await service.submitCommand(probe);

    let stateNotifications = 0;
    let eventNotifications = 0;
    service.onCommandState(() => { stateNotifications++; });
    service.onEvent(() => { eventNotifications++; });

    // Initial valid completion
    const initialRes = await service.handleEvent({
      protocolVersion: 1,
      eventId: 'evt_probe_dup_1',
      commandId: probe.commandId,
      eventType: 'COMMAND_COMPLETED',
      source: 'extension-background',
      sessionId: 'sess_dup_probe',
      conversationId: null,
      generation: service.getGeneration(),
      sequence: 1,
      occurredAt: Date.now(),
      connectionEpoch,
      emitterEpoch: 'emitter_dup_1',
      payload: { observedTabCount: 1 }
    });
    expect(initialRes.accepted).toBe(true);
    expect(record.state).toBe('COMPLETED');
    expect(stateNotifications).toBe(1);
    expect(eventNotifications).toBe(1);

    // Matrix 38 & 39: duplicate valid completion is idempotent and notifies no second time
    const dupRes = await service.handleEvent({
      protocolVersion: 1,
      eventId: 'evt_probe_dup_2',
      commandId: probe.commandId,
      eventType: 'COMMAND_COMPLETED',
      source: 'extension-background',
      sessionId: 'sess_dup_probe',
      conversationId: null,
      generation: service.getGeneration(),
      sequence: 2,
      occurredAt: Date.now(),
      connectionEpoch,
      emitterEpoch: 'emitter_dup_1',
      payload: { observedTabCount: 1 }
    });
    expect(dupRes.accepted).toBe(false);
    expect(dupRes.duplicate).toBe(true);
    expect(dupRes.reason).toBe('FACT_ALREADY_APPLIED');
    expect(stateNotifications).toBe(1); // No second state notification
    expect(eventNotifications).toBe(1); // No second event notification

    // Matrix 40: malformed duplicate does not obtain authority from terminal state
    const malformedDup = await service.handleEvent({
      protocolVersion: 1,
      eventId: 'evt_probe_dup_malformed',
      commandId: probe.commandId,
      eventType: 'COMMAND_COMPLETED',
      source: 'extension-background',
      sessionId: 'sess_dup_probe',
      conversationId: null,
      generation: service.getGeneration(),
      sequence: 3,
      occurredAt: Date.now(),
      connectionEpoch,
      emitterEpoch: 'emitter_dup_1',
      payload: { observedTabCount: -99 } // Malformed
    });
    expect(malformedDup).toEqual({ accepted: false, reason: 'INVALID_LIFECYCLE_FACT' });
    expect(stateNotifications).toBe(1);
    expect(eventNotifications).toBe(1);
  });

  it('Matrix 52-58: cancellation semantics: ALREADY_COMPLETED on completed probe with zero mutation, COMMIT_ALREADY_OCCURRED on committed send', async () => {
    const connectionEpoch = establishReady(service);

    // Matrix 52-56: cancel completed SESSION_PROBE
    const probe = service.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_cancel_probe' });
    const record = await service.submitCommand(probe);

    await service.handleEvent({
      protocolVersion: 1,
      eventId: 'evt_probe_cancel_comp',
      commandId: probe.commandId,
      eventType: 'COMMAND_COMPLETED',
      source: 'extension-background',
      sessionId: 'sess_cancel_probe',
      conversationId: null,
      generation: service.getGeneration(),
      sequence: 1,
      occurredAt: Date.now(),
      connectionEpoch,
      emitterEpoch: 'emitter_cancel_p',
      payload: { observedTabCount: 3 }
    });
    expect(record.state).toBe('COMPLETED');

    const updatedAtBefore = record.updatedAt;
    let cancelStateNotifications = 0;
    service.onCommandState(() => { cancelStateNotifications++; });

    const cancelRes = await service.cancelCommand(probe.commandId, 'late probe cancellation');
    // Matrix 52: returns ALREADY_COMPLETED
    expect(cancelRes).toEqual({ ok: false, status: 'ALREADY_COMPLETED' });
    // Matrix 53: cancellationRequested NOT changed (remains false)
    expect(record.cancellationRequested).toBe(false);
    // Matrix 54: lastError NOT changed (remains null)
    expect(record.lastError).toBeNull();
    // Matrix 55: no durable write (updatedAt unchanged)
    expect(record.updatedAt).toBe(updatedAtBefore);
    // Matrix 56: no state notification
    expect(cancelStateNotifications).toBe(0);

    // Matrix 57: committed SEND_MESSAGE late cancel remains COMMIT_ALREADY_OCCURRED
    const sendCmd57 = service.createCommand('SEND_MESSAGE', { text: 'test 57', targetConversationId: 'conv_57' }, { sessionId: 'sess_57', conversationId: 'conv_57' });
    const rec57 = await service.submitCommand(sendCmd57);
    await service.claimCommand(sendCmd57.commandId, 'doc_57');
    await service.handleEvent({
      protocolVersion: 1,
      eventId: 'evt_57_commit',
      commandId: sendCmd57.commandId,
      eventType: 'MESSAGE_COMMITTED',
      source: 'content-script',
      sessionId: 'sess_57',
      conversationId: 'conv_57',
      generation: service.getGeneration(),
      sequence: 1,
      occurredAt: Date.now(),
      connectionEpoch,
      emitterEpoch: 'doc_57',
      payload: { proofLevel: 'STRONG_COMMIT', nativeMessageId: 'gpt_57', conversationId: 'conv_57', candidateCount: 1 }
    });
    expect(rec57.state).toBe('COMMITTED');
    const cancelRes57 = await service.cancelCommand(sendCmd57.commandId, 'cancel 57');
    expect(cancelRes57.status).toBe('COMMIT_ALREADY_OCCURRED');

    // Matrix 58: completed SEND_MESSAGE after real commit remains COMMIT_ALREADY_OCCURRED
    await service.handleEvent({
      protocolVersion: 1,
      eventId: 'evt_57_comp',
      commandId: sendCmd57.commandId,
      eventType: 'COMMAND_COMPLETED',
      source: 'content-script',
      sessionId: 'sess_57',
      conversationId: 'conv_57',
      generation: service.getGeneration(),
      sequence: 2,
      occurredAt: Date.now(),
      connectionEpoch,
      emitterEpoch: 'doc_57',
      payload: {}
    });
    expect(rec57.state).toBe('COMPLETED');
    const cancelRes58 = await service.cancelCommand(sendCmd57.commandId, 'cancel 58');
    expect(cancelRes58.status).toBe('COMMIT_ALREADY_OCCURRED');
  });

  it('Matrix 59-62: cancellation races: cancel-first and completion-first orderings are deterministic', async () => {
    const connectionEpoch = establishReady(service);

    // Case A: cancel first (Matrix 59-60)
    {
      const probeA = service.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_race_a' });
      const recA = await service.submitCommand(probeA);
      expect(recA.state).toBe('DISPATCHED');

      // Matrix 59: cancel-first reaches CANCELED
      const cancelA = await service.cancelCommand(probeA.commandId, 'cancel first race');
      expect(cancelA.ok).toBe(true);
      expect(cancelA.status).toBe('CANCELED_BEFORE_COMMIT');
      expect(recA.state).toBe('CANCELED');

      // Matrix 60: later completion after cancel is rejected, no resurrection
      const compA = await service.handleEvent({
        protocolVersion: 1,
        eventId: 'evt_race_a_comp',
        commandId: probeA.commandId,
        eventType: 'COMMAND_COMPLETED',
        source: 'extension-background',
        sessionId: 'sess_race_a',
        conversationId: null,
        generation: service.getGeneration(),
        sequence: 1,
        occurredAt: Date.now(),
        connectionEpoch,
        emitterEpoch: 'emitter_race_a',
        payload: { observedTabCount: 2 }
      });
      expect(compA).toEqual({ accepted: false, reason: 'INVALID_LIFECYCLE_FACT' });
      expect(recA.state).toBe('CANCELED');
    }

    // Case B: completion first (Matrix 61-62)
    {
      const probeB = service.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_race_b' });
      const recB = await service.submitCommand(probeB);
      expect(recB.state).toBe('DISPATCHED');

      // Matrix 61: completion-first reaches COMPLETED
      const compB = await service.handleEvent({
        protocolVersion: 1,
        eventId: 'evt_race_b_comp',
        commandId: probeB.commandId,
        eventType: 'COMMAND_COMPLETED',
        source: 'extension-background',
        sessionId: 'sess_race_b',
        conversationId: null,
        generation: service.getGeneration(),
        sequence: 1,
        occurredAt: Date.now(),
        connectionEpoch,
        emitterEpoch: 'emitter_race_b',
        payload: { observedTabCount: 2 }
      });
      expect(compB.accepted).toBe(true);
      expect(recB.state).toBe('COMPLETED');

      // Matrix 62: later cancellation returns ALREADY_COMPLETED with no mutation
      const beforeUpdatedAt = recB.updatedAt;
      const cancelB = await service.cancelCommand(probeB.commandId, 'cancel after completion');
      expect(cancelB).toEqual({ ok: false, status: 'ALREADY_COMPLETED' });
      expect(recB.state).toBe('COMPLETED');
      expect(recB.cancellationRequested).toBe(false);
      expect(recB.lastError).toBeNull();
      expect(recB.updatedAt).toBe(beforeUpdatedAt);
    }
  });
});
