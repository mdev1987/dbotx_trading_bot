import { BehaviorSubject, map, Subject, timeInterval, timer } from "rxjs";
import { CONFIG } from "../config";
import { Subscription } from "rxjs";
import { telegramSignal$ } from "./telegram_client";

const { signalQueueSize, signalQueueTtlSecs } = CONFIG;

export interface QueuedSignal {
  token: string;
  pair: string;
  source: string;
  timestamp: number;
}

const ttlIntervalSub = timer(0, 1000).subscribe(() => {
  const now = Date.now();
  const ttlMs = signalQueueTtlSecs * 1000;

  for (const [token, signal] of signalQueue) {
    if (now - signal.timestamp > ttlMs) {
      removeSignal(token);
    }
  }
});

let telegramSub: Subscription | null = null;

export function initSignalQueue(channel_name: string): void {
  if (telegramSub) {
    return;
  }

  telegramSub = telegramSignal$.subscribe((signal) => {
    enqueueSignal({
      token: signal.Token!,
      pair: signal.LP!,
      source: channel_name,
      timestamp: Date.now(),
    });
  });
}

export function stopSignalQueue(): void {
  telegramSub?.unsubscribe();
  telegramSub = null;
}

const signalQueue = new Map<string, QueuedSignal>();
export const signalQueue$ = new BehaviorSubject<readonly QueuedSignal[]>([]);
export const signalQueued$ = new Subject<QueuedSignal>();
export const signalDequeued$ = new Subject<QueuedSignal>();
export const signalRemoved$ = new Subject<QueuedSignal>();
export const queueCleared$ = new Subject<void>();

function publishQueue(): void {
  signalQueue$.next([...signalQueue.values()]);
}

export function enqueueSignal(signal: QueuedSignal): boolean {
  if (signalQueue.has(signal.token) || signalQueue.size >= signalQueueSize) {
    return false;
  }
  signalQueue.set(signal.token, signal);
  publishQueue();
  signalQueued$.next(signal);
  return true;
}

export function dequeueSignal(): QueuedSignal | null {
  const first = signalQueue.entries().next();
  if (first.done) {
    return null;
  }
  const [token, signal] = first.value;
  signalQueue.delete(token);
  publishQueue();
  signalDequeued$.next(signal);
  return signal;
}

export function peekSignal(): QueuedSignal | null {
  const first = signalQueue.values().next();
  return first.done ? null : first.value;
}

export function removeSignal(token: string): boolean {
  const signal = signalQueue.get(token);
  if (!signal) {
    return false;
  }
  signalQueue.delete(token);
  publishQueue();
  signalRemoved$.next(signal);
  return true;
}

export function clearQueue(): void {
  if (signalQueue.size === 0) {
    return;
  }
  signalQueue.clear();
  publishQueue();
  queueCleared$.next();
}

export function queueSize(): number {
  return signalQueue.size;
}

export function isQueueFull(): boolean {
  return signalQueue.size >= signalQueueSize;
}

export function isSignalQueued(token: string): boolean {
  return signalQueue.has(token);
}

export function getQueuedSignals(): readonly QueuedSignal[] {
  return [...signalQueue.values()];
}
