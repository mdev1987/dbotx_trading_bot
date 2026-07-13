import type { AveScannerSignal } from "./ave_scanner_parser";

function parseHumanNumber(raw: string): number {
  let s = raw.replace(/,/g, "").trim();
  const match = s.match(/^([\d.]+)\s*([KMB]?)$/i);
  if (!match) return Number(s) || 0;
  const num = Number(match[1]);
  const suffix = (match[2] ?? "").toUpperCase();
  const multipliers: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9 };
  return num * (multipliers[suffix] ?? 1);
}

export function parseSolTrendingSignal(text: string): AveScannerSignal | null {
  try {
    text = text.replace(/\r\n/g, "\n");

    const headerMatch = text.match(
      /^\s*(?:⏺|🥇|🥈|🥉)\s*\|\s*(.*?)\s*\/\s*(.*?)\s*\(https:\/\/t\.me\//m,
    );
    if (!headerMatch) return null;
    const tokenName = headerMatch[1]!.trim();

    const buyMatch = text.match(/Buy\s*\((https:\/\/jup\.ag\/swap\/SOL-([A-Za-z0-9]+))\)/);
    if (!buyMatch) return null;
    const ca = buyMatch[2]!;

    const dexTMatch = text.match(/DexT\s*\((https:\/\/www\.dextools\.io\/app\/en\/solana\/pair-explorer\/([A-Za-z0-9]+))\)/);
    const screenerMatch = text.match(/Screener\s*\((https:\/\/dexscreener\.com\/solana\/([A-Za-z0-9]+))\)/);

    const pairAddress = dexTMatch?.[2] ?? screenerMatch?.[2] ?? "";

    const mcapMatch = text.match(/💸\s*Market\s*Cap\s*\$([\d.,]+)\s*([KMB]?)/);
    const marketCapUSD = mcapMatch
      ? parseHumanNumber(`${mcapMatch[1]}${mcapMatch[2]}`)
      : 0;

    const priceMatch = text.match(/🔀\s*\$([\d.,]+)\s*\(/);
    const initPriceUSD = priceMatch ? Number(priceMatch[1]!.replace(/,/g, "")) : undefined;

    const dex = ca.endsWith("pump") ? "Pump" : "Unknown";

    return {
      Token: tokenName,
      CA: ca,
      LP: pairAddress,
      initPriceUSD,
      marketCapUSD,
      dex,
    };
  } catch (error) {
    console.error("[SolTrading Parser] Failed to parse signal:", error);
    return null;
  }
}
