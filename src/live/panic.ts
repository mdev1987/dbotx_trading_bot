import { existsSync, writeFileSync, unlinkSync } from "fs";
import { LIVE_CONFIG } from "./config";

let _panicMode = false;

export function isPanicMode(): boolean {
  if (_panicMode) return true;
  if (existsSync(LIVE_CONFIG.stopTradingPath)) {
    _panicMode = true;
    console.error(`[live/panic] STOP_TRADING file found at ${LIVE_CONFIG.stopTradingPath}`);
    return true;
  }
  return false;
}

export function enablePanic(): void {
  writeFileSync(LIVE_CONFIG.stopTradingPath, `Panic triggered at ${new Date().toISOString()}`);
  _panicMode = true;
  console.error("[live/panic] PANIC MODE ENABLED — no new positions will be opened");
}

export function disablePanic(): void {
  try {
    unlinkSync(LIVE_CONFIG.stopTradingPath);
  } catch {}
  _panicMode = false;
  console.log("[live/panic] Panic mode disabled — new positions allowed");
}
