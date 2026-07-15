import { BehaviorSubject, Subject, tap, timer } from "rxjs";
import { CONFIG } from "../config";
import { Subscription } from "rxjs";
import { telegramSignal$ } from "./telegram_client";
import type { AveScannerSignal } from "./ave_scanner_parser";
const { signalQueueMaxSize, signalQueueTtlMs } = CONFIG;

// interface for a signal entry in the queue
export interface QueuedSignal {
  signal: AveScannerSignal;
  source: string;
  timestamp: number;
}

// interval timer that evicts expired signals every 1s
const ttlIntervalSub = timer(0, 1000).pipe(
  tap(() => {
    const now = Date.now();
    const ttlMs = signalQueueTtlMs;
    for (const [token, signal] of signalQueue) {
      if (now - signal.timestamp > ttlMs) {
        removeSignal(token);
      }
    }
  }),
);

// subscription handle for telegram signal listener
let telegramSub: Subscription | null = null;

/**
 * Subscribes to telegram signals and enqueues them.
 * No-op if already initialized.
 */
let ttlSubscription: Subscription | null = null;
export function initSignalQueue(channel_name: string): void {
  if (!ttlSubscription) {
    ttlSubscription = ttlIntervalSub.subscribe();
  }

  if (telegramSub) {
    return;
  }

  // subscribe to telegram signal stream
  telegramSub = telegramSignal$.subscribe((signal) => {
    enqueueSignal({
      signal: signal,
      source: channel_name,
      timestamp: Date.now(),
    });
  });
}

/** Unsubscribes from telegram signals and resets state. */
export function stopSignalQueue(): void {
  telegramSub?.unsubscribe();
  ttlSubscription?.unsubscribe();
  telegramSub = null;
  ttlSubscription = null;
}

// internal signal queue map (token -> signal)
const signalQueue = new Map<string, QueuedSignal>();
// public observable emitting current queue state
export const signalQueue$ = new BehaviorSubject<readonly QueuedSignal[]>([]);
// emits when a signal is added to the queue
export const signalQueued$ = new Subject<QueuedSignal>();
// emits when a signal is removed from the front of the queue
export const signalDequeued$ = new Subject<QueuedSignal>();
// emits when a signal is removed by token
export const signalRemoved$ = new Subject<QueuedSignal>();
// emits when all signals are cleared
export const queueCleared$ = new Subject<void>();

function signalKey(signal: QueuedSignal): string {
  return signal.signal.Token ?? signal.signal.CA ?? "unknown";
}

/**
 * Adds a signal to the queue. Returns false if the queue is full
 * and the signal is not already queued.
 */
export function enqueueSignal(signal: QueuedSignal): boolean {
  const key = signalKey(signal);

  if (signalQueue.has(key)) {
    signalQueue.set(key, signal);
    signalQueue$.next([...signalQueue.values()]);
    signalQueued$.next(signal);
    return true;
  }

  if (signalQueue.size >= signalQueueMaxSize) {
    dequeueSignal();
  }

  signalQueue.set(key, signal);
  signalQueue$.next([...signalQueue.values()]);
  signalQueued$.next(signal);
  return true;
}

/** Removes and returns the oldest queued signal, or null if empty. */
export function dequeueSignal(): QueuedSignal | null {
  const first = signalQueue.entries().next();
  if (first.done) {
    return null;
  }
  const [token, signal] = first.value;
  signalQueue.delete(token);
  signalQueue$.next([...signalQueue.values()]);
  signalDequeued$.next(signal);
  return signal;
}

/** Returns the oldest queued signal without removing it, or null if empty. */
export function peekSignal(): QueuedSignal | null {
  const first = signalQueue.values().next();
  return first.done ? null : first.value;
}

/** Removes a signal by token. Returns true if found and removed. */
export function removeSignal(token: string): boolean {
  const signal = signalQueue.get(token);
  if (!signal) {
    return false;
  }
  signalQueue.delete(token);
  signalQueue$.next([...signalQueue.values()]);
  signalRemoved$.next(signal);
  return true;
}

/** Removes all signals from the queue. No-op if already empty. */
export function clearQueue(): void {
  if (signalQueue.size === 0) {
    return;
  }
  signalQueue.clear();
  signalQueue$.next([...signalQueue.values()]);
  queueCleared$.next();
}

/** Returns the current number of queued signals. */
export function queueSize(): number {
  return signalQueue.size;
}

/** Returns true if the queue has reached max capacity. */
export function isQueueFull(): boolean {
  return signalQueue.size >= signalQueueMaxSize;
}

/** Returns true if a signal with the given token is already queued. */
export function isSignalQueued(token: string): boolean {
  return signalQueue.has(token);
}

/** Returns a snapshot of all queued signals. */
export function getQueuedSignals(): readonly QueuedSignal[] {
  return [...signalQueue.values()];
}
