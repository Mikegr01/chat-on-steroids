import type { TransportAdapter } from './adapter.js';
import type { TransportState } from './types.js';

export interface FaultConfig {
  dropNextSend?: boolean;
  dropCount?: number;
  duplicateNextSend?: boolean;
  delayMs?: number;
  disconnectOnSend?: boolean;
  reorderBuffer?: unknown[];
}

/**
 * FakeTransportAdapter for deterministic fault-injection testing.
 * Allows simulating drops, duplicates, latency, reordering, disconnects, and reconnects.
 */
export class FakeTransportAdapter implements TransportAdapter {
  public readonly name = 'fake-transport';
  private state: TransportState = 'CONNECTED';
  private messageListeners: Set<(message: unknown) => void> = new Set();
  private stateListeners: Set<(state: TransportState) => void> = new Set();

  public faultConfig: FaultConfig = {};
  public sentMessages: unknown[] = [];
  public peerAdapter?: FakeTransportAdapter;

  constructor(initialState: TransportState = 'CONNECTED') {
    this.state = initialState;
  }

  public async connect(): Promise<void> {
    this.state = 'CONNECTED';
    this.notifyState();
  }

  public async disconnect(): Promise<void> {
    this.state = 'DISCONNECTED';
    this.notifyState();
  }

  public getState(): TransportState {
    return this.state;
  }

  public async send(message: unknown): Promise<boolean> {
    if (this.state !== 'CONNECTED') {
      return false;
    }

    if (this.faultConfig.disconnectOnSend) {
      this.faultConfig.disconnectOnSend = false;
      await this.disconnect();
      return false;
    }

    if (this.faultConfig.dropCount && this.faultConfig.dropCount > 0) {
      this.faultConfig.dropCount--;
      return false;
    }

    if (this.faultConfig.dropNextSend) {
      this.faultConfig.dropNextSend = false;
      return false;
    }

    this.sentMessages.push(message);

    const deliver = (msg: unknown): void => {
      if (this.peerAdapter && this.peerAdapter.getState() === 'CONNECTED') {
        this.peerAdapter.receiveMessage(msg);
      }
    };

    if (this.faultConfig.delayMs && this.faultConfig.delayMs > 0) {
      const delay = this.faultConfig.delayMs;
      setTimeout(() => {
        deliver(message);
        if (this.faultConfig.duplicateNextSend) {
          this.faultConfig.duplicateNextSend = false;
          deliver(message);
        }
      }, delay);
    } else {
      deliver(message);
      if (this.faultConfig.duplicateNextSend) {
        this.faultConfig.duplicateNextSend = false;
        deliver(message);
      }
    }

    return true;
  }

  /**
   * Directly simulates incoming message delivery from wire.
   */
  public receiveMessage(message: unknown): void {
    if (this.state !== 'CONNECTED') {
      return;
    }
    for (const listener of this.messageListeners) {
      try {
        listener(message);
      } catch (err) {
        console.error('FakeTransportAdapter listener error:', err);
      }
    }
  }

  public onMessage(handler: (message: unknown) => void): () => void {
    this.messageListeners.add(handler);
    return () => {
      this.messageListeners.delete(handler);
    };
  }

  public onStateChange(handler: (state: TransportState) => void): () => void {
    this.stateListeners.add(handler);
    return () => {
      this.stateListeners.delete(handler);
    };
  }

  private notifyState(): void {
    for (const listener of this.stateListeners) {
      listener(this.state);
    }
  }

  /**
   * Links two FakeTransportAdapters as two ends of a bidirectional channel.
   */
  public static link(client: FakeTransportAdapter, server: FakeTransportAdapter): void {
    client.peerAdapter = server;
    server.peerAdapter = client;
  }
}
