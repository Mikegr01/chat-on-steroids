/**
 * Bounded Event Deduplicator.
 *
 * Implements a bounded FIFO/LRU set of recently processed Event IDs to ensure
 * idempotent processing of incoming protocol events without unbounded memory growth.
 */
export class EventDeduplicator {
  private readonly maxCapacity: number;
  private readonly processedIds: Set<string> = new Set();
  private readonly idQueue: string[] = [];

  constructor(maxCapacity = 1000) {
    this.maxCapacity = Math.max(10, maxCapacity);
  }

  /**
   * Checks if an event has already been processed.
   * If not seen, records it as processed and returns false.
   * If already seen, returns true (duplicate).
   */
  public isDuplicate(eventId: string): boolean {
    if (this.processedIds.has(eventId)) {
      return true;
    }
    this.markProcessed(eventId);
    return false;
  }

  /**
   * Check without marking as processed.
   */
  public has(eventId: string): boolean {
    return this.processedIds.has(eventId);
  }

  public markProcessed(eventId: string): void {
    if (this.processedIds.has(eventId)) return;
    this.processedIds.add(eventId);
    this.idQueue.push(eventId);
    if (this.idQueue.length > this.maxCapacity) {
      const evicted = this.idQueue.shift();
      if (evicted !== undefined) this.processedIds.delete(evicted);
    }
  }

  /**
   * Current tracked count.
   */
  public get size(): number {
    return this.processedIds.size;
  }

  /**
   * Reset deduplication state (e.g. for testing).
   */
  public clear(): void {
    this.processedIds.clear();
    this.idQueue.length = 0;
  }
}
