/* ============================================================
 * Ave Signal Monitor Telegram Parser
 *
 * Handles two message types from @AveSignalMonitor:
 *   1. Signal — buy signal with token, CA, max pump, MC, buy
 *   2. Pump result — pump proof with multiplier, jumped range
 *
 * Both types are detected by their prefix emoji patterns.
 * ============================================================
 */

export interface AveSignalMonitorSignal {
  type: "signal";
  tokenName: string;
  contractAddress: string;
  chain: string;
  maxPumpX: number;
  marketCapUsd: number;
  walletBuyCount: number;
  totalBuySol: number;
  raw: string;
}

export interface AveSignalMonitorPump {
  type: "pump";
  tokenName: string;
  contractAddress: string;
  multiplier: number;
  jumpedFromK: number;
  jumpedToK: number;
  raw: string;
}

export type AveSignalMonitorMessage = AveSignalMonitorSignal | AveSignalMonitorPump;

/* ============================================================
 * Common helpers
 * ============================================================
 */

function matchGroup(re: RegExp, text: string, idx: number): string | null {
  const m = text.match(re);
  return m?.[idx]?.trim() ?? null;
}

function parseAbbreviated(val: string): number {
  const cleaned = val.replace(/[$,\s]/g, "").trim();
  const m = cleaned.match(/^([\d.]+)([KMBkmb])?$/);
  if (!m) return Number(cleaned);
  const num = Number(m[1]);
  const suffix = m[2]?.toUpperCase();
  switch (suffix) {
    case "K": return Math.round(num * 1_000);
    case "M": return Math.round(num * 1_000_000);
    case "B": return Math.round(num * 1_000_000_000);
    default: return num;
  }
}

/* ============================================================
 * Signal parser
 * ============================================================
 * Pattern:
 *   🪙 $TOKEN (from pump.fun)
 *   🔗 solana
 *   CA: 0x...
 *   ...
 *   💹 Max Pump: 2x
 *   💰 2 KOL Wallet Buy
 *   🤑 Current MC: 40.94K
 *   💸 Total Buy 10.0122 SOL
 */

export function parseSignalMonitorSignal(text: string): AveSignalMonitorSignal | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("\u{1FA99}")) return null;

  const tokenMatch = trimmed.match(/^🪙\s+\$(.+?)\s+\(from\s+/);
  if (!tokenMatch?.[1]) return null;
  const tokenName = tokenMatch[1].trim();
  if (!tokenName) return null;

  const ca = matchGroup(/^CA:\s*(\S+)/m, trimmed, 1);
  if (!ca) return null;

  const chain = matchGroup(/^🔗\s*(\w+)/m, trimmed, 1) ?? "solana";

  const pumpMatch = trimmed.match(/^💹\s*Max Pump:\s*(<)?\s*([\d.]+)x/m);
  const isUncertain = pumpMatch?.[1] === "<";
  const maxPumpX = pumpMatch ? (isUncertain ? 0 : Math.max(0, Number(pumpMatch[2]))) : 0;

  const mcMatch = trimmed.match(/^🤑\s*Current MC:\s*(\S+)/m);
  const mcRaw = mcMatch?.[1];
  const marketCapUsd = mcRaw ? parseAbbreviated(mcRaw) : 0;

  const walletMatch = trimmed.match(/^💰\s+(\d+)\s+(?:KOL|Smart)\s+Wallet\s+Buy/m);
  const walletCountRaw = walletMatch?.[1];
  const walletBuyCount = walletCountRaw ? Number(walletCountRaw) : 0;

  const buyMatch = trimmed.match(/^💸\s*Total Buy\s+([\d.]+)\s+(\w+)/m);
  const buyAmountRaw = buyMatch?.[1];
  const buyCurrency = buyMatch?.[2];
  let totalBuySol = buyAmountRaw ? Number(buyAmountRaw) : 0;
  if (buyCurrency && buyCurrency.toUpperCase() !== "SOL") {
    totalBuySol = 0;
  }

  /* Validate parsed values. */
  if (!ca || ca.length < 10) return null;
  if (typeof marketCapUsd !== "number" || !Number.isFinite(marketCapUsd) || marketCapUsd < 0) return null;
  if (maxPumpX < 0) return null;
  if (totalBuySol < 0) return null;

  return {
    type: "signal",
    tokenName,
    contractAddress: ca,
    chain,
    maxPumpX,
    marketCapUsd,
    walletBuyCount,
    totalBuySol,
    raw: trimmed,
  };
}

/* ============================================================
 * Pump result parser
 * ============================================================
 * Pattern:
 *   🚀 x24 🚀 $Balloon 🆙 🆙 🆙
 *   <blank>
 *   Jumped from 13.22K to now 127.26K
 *   <blank>
 *   CA: 0x...
 *   <blank>
 *   Powered by @AveSignalMonitor 🤑
 */

export function parseSignalMonitorPump(text: string): AveSignalMonitorPump | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("\u{1F680}")) return null;

  const headMatch = trimmed.match(/^🚀\s*x([\d.]+)\s*🚀\s+\$(\S+)/);
  if (!headMatch?.[1] || !headMatch[2]) return null;
  const multiplier = Number(headMatch[1]);
  const tokenName = headMatch[2].trim();
  if (!tokenName) return null;

  const ca = matchGroup(/^CA:\s*(\S+)/m, trimmed, 1);
  if (!ca) return null;

  const jumpMatch = trimmed.match(/^Jumped from\s+([\d.]+[KMBkmb]?)\s+to\s+now\s+([\d.]+[KMBkmb]?)/m);
  const jumpedFrom = jumpMatch?.[1];
  const jumpedToVal = jumpMatch?.[2];
  const jumpedFromK = jumpedFrom ? parseAbbreviated(jumpedFrom) : 0;
  const jumpedToK = jumpedToVal ? parseAbbreviated(jumpedToVal) : 0;

  if (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier <= 0) return null;
  if (!ca || ca.length < 10) return null;

  return {
    type: "pump",
    tokenName,
    contractAddress: ca,
    multiplier,
    jumpedFromK,
    jumpedToK,
    raw: trimmed,
  };
}

/* ============================================================
 * Dispatch — tries signal first, then pump
 * ============================================================
 */

export function parseSignalMonitorMessage(
  text: string,
): AveSignalMonitorMessage | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("\u{1FA99}")) {
    return parseSignalMonitorSignal(trimmed);
  }
  if (trimmed.startsWith("\u{1F680}")) {
    return parseSignalMonitorPump(trimmed);
  }
  return null;
}
