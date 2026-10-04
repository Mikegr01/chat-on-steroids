import { describe, it, expect } from 'vitest';
import {
  PROTOCOL_VERSION,
  protocolVersionSchema,
  protocolCommandEnvelopeSchema,
  protocolEventEnvelopeSchema,
  parseProtocolCommand,
  parseProtocolEvent,
  handshakeHelloSchema,
  handshakeWelcomeSchema,
  handshakeRejectSchema,
  protocolErrorSchema,
  ProtocolCapability
} from '../../src/shared/protocol/index.js';

describe('Kosmosyn Transport Protocol V1 - Schema Validation', () => {
  it('enforces integer Protocol Version 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(protocolVersionSchema.parse(1)).toBe(1);
    expect(() => protocolVersionSchema.parse(2)).toThrow();
    expect(() => protocolVersionSchema.parse('1')).toThrow();
  });

  describe('Command Envelopes', () => {
    it('validates a well-formed SESSION_PROBE command', () => {
      const raw = {
        protocolVersion: 1,
        commandId: 'cmd_12345678',
        commandType: 'SESSION_PROBE',
        source: 'desktop-main',
        target: 'extension-background',
        sessionId: 'session_01',
        conversationId: null,
        owner: null,
        generation: 1,
        createdAt: Date.now(),
        expiresAt: Date.now() + 30000,
        idempotencyKey: 'idemp_probe_1',
        payload: {
          probeTabs: true,
          probeModels: true
        }
      };

      const parsed = parseProtocolCommand(raw);
      expect(parsed.commandType).toBe('SESSION_PROBE');
      expect(parsed.commandId).toBe('cmd_12345678');
      expect((parsed.payload as { probeTabs: boolean }).probeTabs).toBe(true);
    });

    it('validates a well-formed SEND_MESSAGE command with explicit target conversation', () => {
      const raw = {
        protocolVersion: 1,
        commandId: 'cmd_send_9999',
        commandType: 'SEND_MESSAGE',
        source: 'desktop-main',
        target: 'extension-background',
        sessionId: 'session_01',
        conversationId: 'conv_target_456',
        owner: null,
        generation: 2,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60000,
        idempotencyKey: 'idemp_msg_456',
        payload: {
          text: 'Hello from Kosmosyn V1',
          targetConversationId: 'conv_target_456',
          model: 'gpt-4o',
          timeoutMs: 45000
        }
      };

      const parsed = parseProtocolCommand(raw);
      expect(parsed.commandType).toBe('SEND_MESSAGE');
      expect((parsed.payload as { text: string }).text).toBe('Hello from Kosmosyn V1');
    });

    it('rejects commands with missing commandId or invalid protocolVersion', () => {
      expect(() => {
        protocolCommandEnvelopeSchema.parse({
          protocolVersion: 2,
          commandType: 'SESSION_PROBE'
        });
      }).toThrow();

      expect(() => {
        parseProtocolCommand({
          protocolVersion: 1,
          commandId: 'short', // Too short (min 8)
          commandType: 'SESSION_PROBE',
          source: 'desktop-main',
          target: 'extension-background',
          sessionId: 'session_01',
          generation: 1,
          createdAt: Date.now(),
          expiresAt: Date.now() + 30000,
          idempotencyKey: 'idemp_1',
          payload: {}
        });
      }).toThrow();
    });
  });

  describe('Event Envelopes', () => {
    it('validates MESSAGE_COMMITTED event with strong commit proof level', () => {
      const raw = {
        protocolVersion: 1,
        eventId: 'evt_commit_100',
        commandId: 'cmd_send_9999',
        eventType: 'MESSAGE_COMMITTED',
        source: 'content-script',
        sessionId: 'session_01',
        conversationId: 'conv_target_456',
        generation: 2,
        sequence: 3,
        occurredAt: Date.now(),
        payload: {
          proofLevel: 'STRONG_COMMIT',
          nativeMessageId: 'msg_gpt_abc123',
          conversationId: 'conv_target_456',
          candidateCount: 1,
          evidenceDetails: 'Matching text observed in connected DOM node with id'
        }
      };

      const envelope = protocolEventEnvelopeSchema.parse(raw);
      expect(envelope.eventType).toBe('MESSAGE_COMMITTED');

      const parsed = parseProtocolEvent(raw);
      expect(parsed.eventType).toBe('MESSAGE_COMMITTED');
      expect((parsed.payload as { proofLevel: string }).proofLevel).toBe('STRONG_COMMIT');
    });

    it('validates COMMAND_FAILED event with typed error code', () => {
      const raw = {
        protocolVersion: 1,
        eventId: 'evt_fail_200',
        commandId: 'cmd_send_9999',
        eventType: 'COMMAND_FAILED',
        source: 'extension-background',
        sessionId: 'session_01',
        conversationId: 'conv_target_456',
        generation: 2,
        sequence: 4,
        occurredAt: Date.now(),
        payload: {
          errorCode: 'COMPOSER_NOT_FOUND',
          message: 'Composer DOM node was not mounted within timeout',
          retryable: false,
          failedAt: Date.now()
        }
      };

      const parsed = parseProtocolEvent(raw);
      expect(parsed.eventType).toBe('COMMAND_FAILED');
      expect((parsed.payload as { errorCode: string }).errorCode).toBe('COMPOSER_NOT_FOUND');
    });

    it('rejects zero, negative, and non-integer event sequences', () => {
      const raw = {
        protocolVersion: 1,
        eventId: 'evt_sequence_invalid',
        commandId: 'cmd_send_9999',
        eventType: 'TURN_STARTED',
        source: 'content-script',
        sessionId: 'session_01',
        conversationId: 'conv_target_456',
        generation: 2,
        occurredAt: Date.now(),
        payload: {}
      };
      for (const sequence of [0, -1, 1.5]) {
        expect(() => protocolEventEnvelopeSchema.parse({ ...raw, sequence })).toThrow();
      }
    });
  });

  describe('Handshake Negotiation', () => {
    it('accepts valid HELLO message with capabilities', () => {
      const hello = handshakeHelloSchema.parse({
        type: 'HELLO',
        protocolVersion: 1,
        extensionVersion: '2.1.20',
        connectionGeneration: 1,
        capabilities: [
          ProtocolCapability.SESSION_BINDING,
          ProtocolCapability.SEND_MESSAGE,
          ProtocolCapability.TURN_OBSERVATION
        ]
      });

      expect(hello.type).toBe('HELLO');
      expect(hello.capabilities).toContain('SEND_MESSAGE');
    });

    it('validates WELCOME and REJECT handshake responses', () => {
      const welcome = handshakeWelcomeSchema.parse({
        type: 'WELCOME',
        acceptedProtocolVersion: 1,
        desktopInstanceId: 'desktop_inst_123',
        appVersion: '2.1.20',
        negotiatedCapabilities: [ProtocolCapability.SEND_MESSAGE],
        reconcileRequested: true,
        connectionGeneration: 2,
        connectionEpoch: 'connection_epoch_2'
      });
      expect(welcome.type).toBe('WELCOME');

      const reject = handshakeRejectSchema.parse({
        type: 'REJECT',
        reason: 'PROTOCOL_MISMATCH',
        expectedVersion: 1,
        actualVersion: 2,
        message: 'Incompatible version'
      });
      expect(reject.type).toBe('REJECT');
    });
  });

  describe('Error Model', () => {
    it('validates structured typed protocol errors', () => {
      const err = protocolErrorSchema.parse({
        code: 'SESSION_NOT_BOUND',
        message: 'No active ChatGPT conversation bound to session',
        retryable: false,
        details: { sessionId: 'sess_1' }
      });
      expect(err.code).toBe('SESSION_NOT_BOUND');
      expect(err.retryable).toBe(false);
    });

    it('validates newly added error codes: IDEMPOTENCY_CONFLICT, OUT_OF_ORDER_EVENT, STORE_CORRUPT', () => {
      const err1 = protocolErrorSchema.parse({
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'Duplicate idempotency key with conflicting payload',
        retryable: false
      });
      expect(err1.code).toBe('IDEMPOTENCY_CONFLICT');

      const err2 = protocolErrorSchema.parse({
        code: 'OUT_OF_ORDER_EVENT',
        message: 'Received sequence gap',
        retryable: true
      });
      expect(err2.code).toBe('OUT_OF_ORDER_EVENT');

      const err3 = protocolErrorSchema.parse({
        code: 'STORE_CORRUPT',
        message: 'Unparseable store snapshot',
        retryable: false
      });
      expect(err3.code).toBe('STORE_CORRUPT');
    });
  });
});
