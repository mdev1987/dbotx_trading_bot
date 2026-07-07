import { BehaviorSubject } from "rxjs";
import { distinctUntilChanged } from "rxjs/operators";

const _paused$ = new BehaviorSubject<boolean>(false);

export const signalPaused$ = _paused$.pipe(distinctUntilChanged());

export function pauseSignals(): void {
  if (_paused$.value) return;
  _paused$.next(true);
  console.log("[signal] Paused — new signals will be ignored");
}

export function resumeSignals(): void {
  if (!_paused$.value) return;
  _paused$.next(false);
  console.log("[signal] Resumed — accepting new signals");
}

export function isSignalPaused(): boolean {
  return _paused$.value;
}
