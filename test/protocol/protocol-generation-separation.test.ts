import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeTransportAdapter } from '../../src/main/browser-transport/fake-adapter.js';
import { BrowserTransportService } from '../../src/main/browser-transport/service.js';
import { initDurableStore, resetDurableForTests } from '../../src/main/durable.js';
import type { ProtocolEvent } from '../../src/shared/protocol/index.js';

describe('Kosmosyn Transport Protocol V1 - generation separation', () => {
  let tmpDir: string;
  let service: BrowserTransportService;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `kosmosyn-generation-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tmpDir, { recursive: true });
    initDurableStore(tmpDir);
    service = new BrowserTransportService(new FakeTransportAdapter('CONNECTED'), { instanceId: 'generation-separation' });
    await service.start();
  });

  afterEach(async () => {
    await service.stop();
    resetDurableForTests();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  });

  function negotiate() {
    const welcome = service.handleHandshakeHello({ type: 'HELLO', protocolVersion: 1, extensionVersion: '2.1.20', connectionGeneration: 1, capabilities: ['SEND_MESSAGE'] });
    if (welcome.type !== 'WELCOME') throw new Error('handshake rejected');
    service.handleHandshakeReady({ connectionGeneration: welcome.connectionGeneration, connectionEpoch: welcome.connectionEpoch });
    return welcome;
  }

  async function command(conversationId: string) {
    const cmd = service.createCommand('SEND_MESSAGE', { text: conversationId, targetConversationId: conversationId }, { sessionId: `sess_${conversationId}`, conversationId });
    const record = await service.submitCommand(cmd);
    await service.claimCommand(cmd.commandId, `doc_${conversationId}`);
    return { cmd, record };
  }

  function event(commandId: string, conversationId: string, eventId: string, sequence: number, eventType: ProtocolEvent['eventType'], connectionEpoch: string, emitterEpoch: string, payload: unknown = {}): ProtocolEvent {
    return { protocolVersion: 1, eventId, commandId, eventType, source: 'content-script', sessionId: `sess_${conversationId}`, conversationId, generation: 999999, connectionEpoch, emitterEpoch, sequence, occurredAt: Date.now(), payload };
  }

  it('rejects numeric restart collisions and never-negotiated future generations by opaque connection epoch', async () => {
    const welcome = negotiate();
    const { cmd } = await command('collision');
    expect((await service.handleEvent(event(cmd.commandId, 'collision', 'evt_old_numeric', 1, 'MESSAGE_SUBMIT_STARTED', 'old-desktop-epoch', 'doc_A'))).reason).toBe('STALE_CONNECTION_EPOCH');
    expect((await service.handleEvent(event(cmd.commandId, 'collision', 'evt_future_numeric', 1, 'MESSAGE_SUBMIT_STARTED', 'never-negotiated-epoch', 'doc_A'))).reason).toBe('STALE_CONNECTION_EPOCH');
    expect(welcome.connectionEpoch).not.toBe('old-desktop-epoch');
  });

  it('does not let late READY from handshake A make handshake B ready', () => {
    const a = service.handleHandshakeHello({ type: 'HELLO', protocolVersion: 1, extensionVersion: '2.1.20', connectionGeneration: 40, capabilities: [] });
    const b = service.handleHandshakeHello({ type: 'HELLO', protocolVersion: 1, extensionVersion: '2.1.20', connectionGeneration: 1, capabilities: [] });
    if (a.type !== 'WELCOME' || b.type !== 'WELCOME') throw new Error('handshake rejected');
    service.handleHandshakeReady({ connectionGeneration: a.connectionGeneration, connectionEpoch: a.connectionEpoch });
    expect(service.isReady()).toBe(false);
    service.handleHandshakeReady({ connectionGeneration: b.connectionGeneration, connectionEpoch: b.connectionEpoch });
    expect(service.isReady()).toBe(true);
  });

  it('allows sequence restart for a new content document but rejects old-document progress', async () => {
    const welcome = negotiate();
    const { cmd, record } = await command('reload');
    await service.handleEvent(event(cmd.commandId, 'reload', 'evt_a3', 3, 'MESSAGE_SUBMIT_STARTED', welcome.connectionEpoch, 'doc_A'));
    record.claimLeaseUntil = 0;
    expect((await service.claimCommand(cmd.commandId, 'doc_B')).ok).toBe(true);
    const claimB = event(cmd.commandId, 'reload', 'evt_claim_b', 1, 'COMMAND_CLAIMED', welcome.connectionEpoch, 'doc_B', { clientDocumentId: 'doc_B', tabId: 1, claimedAt: Date.now() });
    expect((await service.handleEvent(claimB)).accepted).toBe(true);
    expect((await service.handleEvent(event(cmd.commandId, 'reload', 'evt_old_a4', 4, 'TURN_COMPLETED', welcome.connectionEpoch, 'doc_A'))).reason).toBe('STALE_EMITTER_EPOCH');
  });

  it('reconciles an old-document strong durable fact and dedupes the same fact across epochs', async () => {
    const welcome = negotiate();
    const { cmd, record } = await command('durable');
    await service.handleEvent(event(cmd.commandId, 'durable', 'evt_a_started', 3, 'MESSAGE_SUBMIT_STARTED', welcome.connectionEpoch, 'doc_A'));
    record.claimLeaseUntil = 0;
    expect((await service.claimCommand(cmd.commandId, 'doc_B')).ok).toBe(true);
    await service.handleEvent(event(cmd.commandId, 'durable', 'evt_claim_b2', 1, 'COMMAND_CLAIMED', welcome.connectionEpoch, 'doc_B', { clientDocumentId: 'doc_B', tabId: 1, claimedAt: Date.now() }));
    const payload = { proofLevel: 'STRONG_COMMIT', nativeMessageId: 'native_durable', conversationId: 'durable', candidateCount: 1 };
    expect((await service.handleEvent(event(cmd.commandId, 'durable', 'evt_old_fact', 4, 'MESSAGE_COMMITTED', welcome.connectionEpoch, 'doc_A', payload))).accepted).toBe(true);
    expect(record.state).toBe('COMMITTED');
    expect(await service.handleEvent(event(cmd.commandId, 'durable', 'evt_new_fact', 2, 'MESSAGE_COMMITTED', welcome.connectionEpoch, 'doc_B', payload))).toEqual({ accepted: false, duplicate: true, reason: 'FACT_ALREADY_APPLIED' });
  });

  it('keeps durable command intent independent from transport connection epoch', () => {
    const a = negotiate();
    const cmd = service.createCommand('SESSION_PROBE', { probeTabs: true }, { sessionId: 'sess_intent' });
    const b = service.handleHandshakeHello({ type: 'HELLO', protocolVersion: 1, extensionVersion: '2.1.20', connectionGeneration: 1, capabilities: [] });
    if (b.type !== 'WELCOME') throw new Error('handshake rejected');
    expect(cmd).not.toHaveProperty('connectionEpoch');
    expect(a.connectionEpoch).not.toBe(b.connectionEpoch);
  });

  it('rejects epoch-less progress after epoch-aware negotiation', async () => {
    negotiate();
    const { cmd } = await command('missing-epoch');
    const missingConnection: ProtocolEvent = { protocolVersion: 1, eventId: 'evt_missing_connection', commandId: cmd.commandId, eventType: 'TURN_STARTED', source: 'content-script', sessionId: 'sess_missing-epoch', conversationId: 'missing-epoch', generation: 1, emitterEpoch: 'doc_missing-epoch', sequence: 1, occurredAt: Date.now(), payload: {} };
    expect((await service.handleEvent(missingConnection)).reason).toBe('STALE_CONNECTION_EPOCH');
    const welcome = service.handleHandshakeHello({ type: 'HELLO', protocolVersion: 1, extensionVersion: '2.1.20', connectionGeneration: 1, capabilities: [] });
    if (welcome.type !== 'WELCOME') throw new Error('handshake rejected');
    service.handleHandshakeReady({ connectionGeneration: welcome.connectionGeneration, connectionEpoch: welcome.connectionEpoch });
    const missingEmitter = { ...missingConnection, eventId: 'evt_missing_emitter', connectionEpoch: welcome.connectionEpoch, emitterEpoch: undefined };
    expect((await service.handleEvent(missingEmitter)).reason).toBe('MISSING_EMITTER_EPOCH');
  });

  it('does not let an unauthorized COMMAND_CLAIMED replace emitter authority', async () => {
    const welcome = negotiate();
    const { cmd, record } = await command('claim-authority');
    const unauthorized = event(cmd.commandId, 'claim-authority', 'evt_claim_intruder', 1, 'COMMAND_CLAIMED', welcome.connectionEpoch, 'doc_intruder', { clientDocumentId: 'doc_intruder', tabId: 1, claimedAt: Date.now() });
    expect((await service.handleEvent(unauthorized)).reason).toBe('INVALID_CLAIM_AUTHORITY');
    expect(record.activeEmitterEpochBySource?.['content-script']).not.toBe('doc_intruder');
  });

  it('does not reconcile COMMAND_COMPLETED from a stale connection or stale emitter', async () => {
    const welcomeA = negotiate();
    const { cmd, record } = await command('stale-complete');
    const commitPayload = { proofLevel: 'STRONG_COMMIT', nativeMessageId: 'native_stale_complete', conversationId: 'stale-complete', candidateCount: 1 };
    await service.handleEvent(event(cmd.commandId, 'stale-complete', 'evt_commit_a', 1, 'MESSAGE_COMMITTED', welcomeA.connectionEpoch, 'doc_stale-complete', commitPayload));
    expect(record.state).toBe('COMMITTED');
    const welcomeB = service.handleHandshakeHello({ type: 'HELLO', protocolVersion: 1, extensionVersion: '2.1.20', connectionGeneration: 1, capabilities: [] });
    if (welcomeB.type !== 'WELCOME') throw new Error('handshake rejected');
    service.handleHandshakeReady({ connectionGeneration: welcomeB.connectionGeneration, connectionEpoch: welcomeB.connectionEpoch });
    const staleConnection = event(cmd.commandId, 'stale-complete', 'evt_complete_old_connection', 2, 'COMMAND_COMPLETED', welcomeA.connectionEpoch, 'doc_stale-complete');
    expect((await service.handleEvent(staleConnection)).reason).toBe('STALE_CONNECTION_EPOCH');
    expect(record.state).toBe('COMMITTED');
    const staleEmitter = event(cmd.commandId, 'stale-complete', 'evt_complete_old_emitter', 2, 'COMMAND_COMPLETED', welcomeB.connectionEpoch, 'doc_other');
    expect((await service.handleEvent(staleEmitter)).reason).toBe('STALE_EMITTER_EPOCH');
    expect(record.state).toBe('COMMITTED');
  });
});
