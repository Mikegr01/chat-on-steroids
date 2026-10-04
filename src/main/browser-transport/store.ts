import { readDurable, writeDurableNow, writeDurableSoon } from '../durable.js';
import type { DurableCommandRecord, ProtocolStoreSnapshot } from './types.js';
import { logInfo, logWarn } from '../logger.js';
import { isTerminalState } from '../../shared/protocol/index.js';

export const PROTOCOL_STORE_NAME = 'kosmosyn-transport-outbox';
const MAX_RECENT_COMMITTED = 200;

/**
 * ProtocolStore manages the durable outbox and command ledger on disk.
 * Directly reuses the battle-tested atomic persistence of `src/main/durable.ts`.
 */
export class ProtocolStore {
  private instanceId: string;
  private commands: Map<string, DurableCommandRecord> = new Map();
  private recentCommittedIds: string[] = [];
  private loaded = false;

  constructor(instanceId: string) {
    this.instanceId = instanceId;
  }

  /**
   * Initializes store from disk or creates empty snapshot.
   */
  public async load(): Promise<void> {
    const raw = await readDurable<ProtocolStoreSnapshot>(PROTOCOL_STORE_NAME);
    this.commands.clear();
    this.recentCommittedIds = [];

    if (raw && typeof raw === 'object' && raw.commands) {
      for (const [id, record] of Object.entries(raw.commands)) {
        this.commands.set(id, record);
      }
      if (Array.isArray(raw.recentCommittedIds)) {
        this.recentCommittedIds = raw.recentCommittedIds.slice(-MAX_RECENT_COMMITTED);
      }
      logInfo(`protocol-store: loaded ${this.commands.size} commands from durable outbox`);
    } else {
      logInfo('protocol-store: initialized fresh durable outbox');
    }
    this.loaded = true;
  }

  public isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Persists a newly created command synchronously BEFORE dispatch attempt (atomic barrier).
   */
  public async persistNewCommand(record: DurableCommandRecord): Promise<void> {
    this.commands.set(record.command.commandId, record);
    await this.flushImmediate();
  }

  /**
   * Updates an existing command's record in memory and flushes to disk.
   */
  public async updateCommand(record: DurableCommandRecord, immediate = false): Promise<void> {
    record.updatedAt = Date.now();
    this.commands.set(record.command.commandId, record);

    if (record.state === 'COMMITTED' || record.state === 'COMPLETED') {
      if (!this.recentCommittedIds.includes(record.command.commandId)) {
        this.recentCommittedIds.push(record.command.commandId);
        if (this.recentCommittedIds.length > MAX_RECENT_COMMITTED) {
          this.recentCommittedIds.shift();
        }
      }
    }

    if (immediate || record.state === 'COMMITTED' || record.state === 'AMBIGUOUS' || isTerminalState(record.state)) {
      await this.flushImmediate();
    } else {
      this.flushSoon();
    }
  }

  /** Restores coherent in-memory authority after a rejected durable transition and supersedes its retry. */
  public restoreAfterFailedUpdate(record: DurableCommandRecord): void {
    this.commands.set(record.command.commandId, record);
    this.recentCommittedIds = this.recentCommittedIds.filter((id) => {
      const current = this.commands.get(id);
      return current?.state === 'COMMITTED' || current?.state === 'COMPLETED';
    });
    this.flushSoon();
  }

  /**
   * Retrieve command record by ID.
   */
  public get(commandId: string): DurableCommandRecord | undefined {
    return this.commands.get(commandId);
  }

  /**
   * Check if idempotencyKey was already committed.
   */
  public findByIdempotencyKey(key: string): DurableCommandRecord | undefined {
    for (const record of this.commands.values()) {
      if (record.command.idempotencyKey === key) {
        return record;
      }
    }
    return undefined;
  }

  public findByNativeMessageId(conversationId: string, nativeMessageId: string): DurableCommandRecord | undefined {
    for (const record of this.commands.values()) {
      if (record.commitConversationId === conversationId && record.nativeMessageId === nativeMessageId) return record;
    }
    return undefined;
  }

  /**
   * Returns all commands currently in an unresolved (non-terminal) state.
   */
  public getUnresolvedCommands(): DurableCommandRecord[] {
    const list: DurableCommandRecord[] = [];
    for (const record of this.commands.values()) {
      if (!isTerminalState(record.state)) {
        list.push(record);
      }
    }
    return list;
  }

  /**
   * Prune old terminal records past retention limit.
   */
  public pruneTerminalCommands(retentionMs = 24 * 60 * 60 * 1000): void {
    const now = Date.now();
    for (const [id, record] of this.commands.entries()) {
      if (isTerminalState(record.state) && now - record.updatedAt > retentionMs) {
        this.commands.delete(id);
      }
    }
    this.flushSoon();
  }

  /**
   * Snapshot payload for serialization.
   */
  private buildSnapshot(): ProtocolStoreSnapshot {
    const commandsObj: Record<string, DurableCommandRecord> = {};
    for (const [id, record] of this.commands.entries()) {
      commandsObj[id] = record;
    }
    return {
      version: 1,
      instanceId: this.instanceId,
      commands: commandsObj,
      recentCommittedIds: this.recentCommittedIds
    };
  }

  /**
   * Immediate synchronous atomic write to disk.
   */
  public async flushImmediate(): Promise<void> {
    try {
      await writeDurableNow(PROTOCOL_STORE_NAME, this.buildSnapshot());
    } catch (err) {
      logWarn(`protocol-store: immediate flush failed: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Debounced background write for progress transitions.
   */
  private flushSoon(): void {
    writeDurableSoon(PROTOCOL_STORE_NAME, this.buildSnapshot());
  }

  /**
   * Reset store memory (for testing).
   */
  public clear(): void {
    this.commands.clear();
    this.recentCommittedIds = [];
    this.loaded = false;
  }
}
