import type { TransportState } from './types.js';

/**
 * TransportAdapter Interface.
 *
 * Core protocol state machine and durable outbox logic communicate strictly through
 * this interface. Implementations can be:
 * - CurrentBridgeAdapter (wrapping local HTTP loopback / events)
 * - NativeMessagingAdapter (future Chrome native messaging host)
 * - FakeTransportAdapter (deterministic fault-injection test harness)
 */
export interface TransportAdapter {
  readonly name: string;

  /** Connect the transport */
  connect(): Promise<void>;

  /** Disconnect the transport */
  disconnect(): Promise<void>;

  /** Get current transport state */
  getState(): TransportState;

  /** Send a message payload across the wire */
  send(message: unknown): Promise<boolean>;

  /** Register an incoming message listener */
  onMessage(handler: (message: unknown) => void): () => void;

  /** Register a state change listener */
  onStateChange(handler: (state: TransportState) => void): () => void;
}
