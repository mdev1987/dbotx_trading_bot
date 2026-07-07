import type { ParsedSignal } from "../telegram/telegram_listener";

interface QueuedEntry {
  signal: ParsedSignal;
  timestamp: number;
}

export class SignalQueue {
  private readonly queue = new Map<string, QueuedEntry>();

  constructor(
    private readonly maxSize: number,
    private readonly ttlSecs: number,
  ) {}

  private evictExpired(): number {
    const now = Date.now();
    const maxAge = this.ttlSecs * 1000;
    let evicted = 0;
    for (const [lp, entry] of this.queue) {
      if (now - entry.timestamp >= maxAge) {
        this.queue.delete(lp);
        evicted++;
      }
    }
    return evicted;
  }

  enqueue(signal: ParsedSignal): void {
    const expired = this.evictExpired();
    if (expired > 0) {
      console.log(`[Queue] Evicted ${expired} expired signal(s)`);
    }

    if (this.queue.has(signal.lpAddress)) {
      this.queue.delete(signal.lpAddress);
    }

    this.queue.set(signal.lpAddress, { signal, timestamp: Date.now() });

    if (this.queue.size > this.maxSize) {
      const oldest = this.queue.keys().next().value;
      if (oldest) {
        this.queue.delete(oldest);
        console.log(`[Queue] Full — dropped oldest signal ${oldest}`);
      }
    }

    console.log(`[Queue] Queued ${signal.tokenName} (size: ${this.queue.size})`);
  }

  dequeue(): ParsedSignal | null {
    const now = Date.now();
    const maxAge = this.ttlSecs * 1000;

    for (const lp of this.queue.keys()) {
      const entry = this.queue.get(lp)!;
      this.queue.delete(lp);

      if (now - entry.timestamp >= maxAge) {
        console.log(`[Queue] Expired signal for ${entry.signal.tokenName}`);
        continue;
      }

      return entry.signal;
    }

    return null;
  }

  get length(): number {
    return this.queue.size;
  }

  clear(): void {
    this.queue.clear();
  }
}
