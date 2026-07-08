import type { ParsedSignal } from "../telegram/telegram_listener";

/** Internal entry stored in the queue */
interface QueuedEntry {
  signal: ParsedSignal; // The parsed trading signal
  timestamp: number; // Unix ms when the signal was queued
}

/** A FIFO queue for trading signals with max-size and TTL-based expiry */
export class SignalQueue {
  private readonly queue = new Map<string, QueuedEntry>(); // lpAddress -> entry

  constructor(
    private readonly maxSize: number, // Maximum number of entries allowed
    private readonly ttlSecs: number, // Time-to-live in seconds before eviction
  ) {}

  /** Remove entries older than the TTL; returns count of evicted items */
  private evictExpired(): number {
    const now = Date.now();
    const maxAge = this.ttlSecs * 1000; // Convert TTL to ms
    let evicted = 0;
    for (const [lp, entry] of this.queue) {
      if (now - entry.timestamp >= maxAge) {
        this.queue.delete(lp); // Expired — remove
        evicted++;
      }
    }
    return evicted;
  }

  /** Add a signal to the queue, evicting expired or oldest entries if needed */
  enqueue(signal: ParsedSignal): void {
    const expired = this.evictExpired(); // Clean stale entries first
    if (expired > 0) {
      console.log(`[Queue] Evicted ${expired} expired signal(s)`);
    }

    // If signal for this LP already exists, remove the old one (re-queue)
    if (this.queue.has(signal.lpAddress)) {
      this.queue.delete(signal.lpAddress);
    }

    // Insert the new signal with current timestamp
    this.queue.set(signal.lpAddress, { signal, timestamp: Date.now() });

    // If queue exceeds max size, drop the oldest entry (FIFO eviction)
    if (this.queue.size > this.maxSize) {
      const oldest = this.queue.keys().next().value; // First inserted key
      if (oldest) {
        this.queue.delete(oldest);
        console.log(`[Queue] Full — dropped oldest signal ${oldest}`);
      }
    }

    console.log(`[Queue] Queued ${signal.tokenName} (size: ${this.queue.size})`);
  }

  /** Remove and return the next valid (non-expired) signal, or null if empty */
  dequeue(): ParsedSignal | null {
    const now = Date.now();
    const maxAge = this.ttlSecs * 1000;

    // Iterate in insertion order (Map preserves insertion order)
    for (const lp of this.queue.keys()) {
      const entry = this.queue.get(lp)!;
      this.queue.delete(lp); // Always remove from queue

      // Skip if expired since being queued
      if (now - entry.timestamp >= maxAge) {
        console.log(`[Queue] Expired signal for ${entry.signal.tokenName}`);
        continue;
      }

      return entry.signal; // Return the first valid signal
    }

    return null; // No valid signals found
  }

  /** Current number of entries in the queue */
  get length(): number {
    return this.queue.size;
  }

  /** Remove all entries from the queue */
  clear(): void {
    this.queue.clear();
  }
}
