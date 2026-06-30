/**
 * Recorder – persists every incoming DBotX payload.
 *
 * Two layers are kept:
 * 1. `raw_events` – an append-only, schema-less log of every wire message.
 * 2. `snapshots`  – normalised per-pair snapshots with typed columns.
 *
 * The raw log guarantees that *nothing* is lost when DBotX adds fields.
 */

import { CONFIG } from "./config";
import { insertRawEvent, insertSnapshot } from "./db";
import type { PairInfoResult } from "./models";

/**
 * Save every WebSocket payload verbatim into `raw_events`.
 *
 * Call this for **every** message before any processing so the
 * original wire data is always available for later re-analysis.
 */
export function saveRawEvent(
  eventTs: number,
  eventType: string | null,
  mint: string | null,
  pair: string | null,
  payload: unknown,
): void {
  if (!CONFIG.saveRawJson) return;

  insertRawEvent(
    eventTs,
    eventType,
    mint,
    pair,
    JSON.stringify(payload),
  );
}

/**
 * Save a normalised snapshot row extracted from a `pairInfo` message.
 *
 * @param tradeId  The open trade id this snapshot belongs to (nullable).
 * @param mint     Token mint address.
 * @param data     The `result` object from `pairInfo` – treated as
 *                 `Record<string, unknown>` so unknown fields never
 *                 cause a crash.
 * @param rawJson  The complete original message serialised.
 */
export function saveSnapshot(
  tradeId: number | null,
  mint: string,
  data: Record<string, unknown>,
  rawJson: string,
): void {
  insertSnapshot(tradeId, mint, Date.now(), data, rawJson);
}
