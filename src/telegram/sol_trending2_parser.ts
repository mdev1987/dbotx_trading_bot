import type { AveScannerSignal } from "./ave_scanner_parser";

function parseHumanNumber(raw: string): number {
  let s = raw.replace(/,/g, "").replace(/\s+/g, "").trim();
  const match = s.match(/^([\d.]+)\s*([KMB]?)$/i);
  if (!match) return Number(s) || 0;
  const num = Number(match[1]);
  const suffix = (match[2] ?? "").toUpperCase();
  const multipliers: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9 };
  return num * (multipliers[suffix] ?? 1);
}

export function parseTrendingssolSignal(text: string): AveScannerSignal | null {
  try {
    text = text.replace(/\r\n/g, "\n");

    const headerMatch = text.match(
      /^\s*(?:\[.*?\]\s*)?SOL TRENDING:\s*(.*?)\s*\(https:\/\/t\.me\//m,
    );
    if (!headerMatch) return null;
    const tokenName = headerMatch[1]!.trim();

    const chartMatch = text.match(
      /📈\s*Chart\s*\(https:\/\/dexscreener\.com\/solana\/([A-Za-z0-9]+)\)/,
    );
    if (!chartMatch) return null;
    const pairAddress = chartMatch[1]!;

    const mcapMatch = text.match(/💸\s*Market\s*Cap\s*\$([\d.\s]+)(?:\s*([KMB]))?/);
    const marketCapUSD = mcapMatch
      ? parseHumanNumber(`${mcapMatch[1]}${mcapMatch[2] ?? ""}`)
      : 0;

    const priceLineMatch = text.match(/💲\s*(?:\S+\s+)?Price:\s*\$([\d.]+)/);
    const initPriceUSD = priceLineMatch
      ? Number(priceLineMatch[1])
      : 0;

    const dex = pairAddress.endsWith("pump") ? "Pump" : "Unknown";

    return {
      Token: tokenName,
      CA: pairAddress,
      LP: pairAddress,
      initPriceUSD: initPriceUSD || undefined,
      marketCapUSD,
      dex,
    };
  } catch (error) {
    console.error("[Trendingssol Parser] Failed to parse signal:", error);
    return null;
  }
}
