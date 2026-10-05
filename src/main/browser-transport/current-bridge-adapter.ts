import type { TransportAdapter } from './adapter.js';
import type { TransportState } from './types.js';
import { parseProtocolCommand, type ProtocolCommand } from '../../shared/protocol/index.js';

export function isS4Probe(command: ProtocolCommand): boolean {
  const p = command.payload as Record<string, unknown> | null;
  return command.protocolVersion === 1 && command.commandType === 'SESSION_PROBE' &&
    command.source === 'desktop-main' && command.target === 'extension-background' &&
    command.conversationId === null && command.owner === null && !!p &&
    Object.keys(p).length === 3 && p.probeTabs === true && p.probeModels === false &&
    p.targetConversationId === null;
}

/** One volatile handout slot. The Protocol outbox alone owns durable command identity. */
export class CurrentBridgeAdapter implements TransportAdapter {
  readonly name = 'current-bridge';
  private state: TransportState = 'DISCONNECTED';
  private pending: ProtocolCommand | null = null;
  private expectedCommandId: string | null = null;
  private restricted = false;
  private messages = new Set<(message: unknown) => void>();
  private states = new Set<(state: TransportState) => void>();
  async connect(): Promise<void> { this.setState('CONNECTED'); }
  async disconnect(): Promise<void> { this.pending = null; this.expectedCommandId = null; this.restricted = true; this.setState('DISCONNECTED'); }
  getState(): TransportState { return this.state; }
  async send(message: unknown): Promise<boolean> {
    if (this.state !== 'CONNECTED' || this.pending || !message || typeof message !== 'object') return false;
    const envelope = message as Record<string, unknown>;
    if (Object.keys(envelope).length !== 2 || envelope.kind !== 'PROTOCOL_COMMAND') return false;
    try {
      // Check the original payload before schema defaults/stripping can broaden admission.
      if (!isS4Probe(envelope.command as ProtocolCommand)) return false;
      const command = parseProtocolCommand(envelope.command);
      if (this.restricted && command.commandId !== this.expectedCommandId) return false;
      if (command.expiresAt <= Date.now()) return false;
      this.pending = structuredClone(command);
      return true;
    } catch { return false; }
  }
  poll(): ProtocolCommand | null {
    return this.state === 'CONNECTED' && this.pending && this.pending.expiresAt > Date.now()
      ? structuredClone(this.pending) : null;
  }
  expectCommand(commandId: string): void { this.restricted = true; this.expectedCommandId = commandId; }
  clear(): void { this.pending = null; }
  onMessage(handler: (message: unknown) => void): () => void {
    this.messages.add(handler); return () => { this.messages.delete(handler); };
  }
  onStateChange(handler: (state: TransportState) => void): () => void {
    this.states.add(handler); return () => { this.states.delete(handler); };
  }
  private setState(state: TransportState): void {
    this.state = state;
    for (const listener of this.states) listener(state);
  }
}
