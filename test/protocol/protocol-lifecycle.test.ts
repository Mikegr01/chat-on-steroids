import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeTransportAdapter } from '../../src/main/browser-transport/fake-adapter.js';
import { BrowserTransportService } from '../../src/main/browser-transport/service.js';
import { resetDurableForTests, initDurableStore } from '../../src/main/durable.js';
import type { ProtocolEvent } from '../../src/shared/protocol/index.js';
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
});
