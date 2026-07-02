/* ============================================================
 * AVE Scanner Telegram Signal Parser
 *
 * Supports:
 * - Original AVE format with Solscan links
 * - Markdown-stripped Telegram messages
 * - Token names with spaces
 * - Holder lines with or without URLs
 * - Optional external links
 * ============================================================
 */

export interface Holder {
  address: string;
  url?: string;
  percentageRaw: string;
  percentage: number;
}

export interface SecurityFlags {
  ownershipRenounced: boolean;
  top10HoldingsUnder30: boolean;
  stopMint: boolean;
  noBlacklist: boolean;
}

export interface SecurityInfo {
  score: number;
  risk: string;
  flags: SecurityFlags;
}

export interface ExternalLinks {
  check?: string;
  website?: string;
  app?: string;
  community?: string;
  twitter?: string;
}

export interface SolanaPoolSignal {
  tokenName: string;
  tokenAddress?: string;
  tokenUrl?: string;

  contractAddress: string;
  lpAddress: string;

  initPriceRaw: string;
  initPrice: number;

  marketCapRaw: string;
  marketCapUsd: number;

  pairTokenAmount: number;
  pairTokenSymbol: string;
  pairSolAmount: number;

  dex: string;

  liquidityRaw: string;
  liquidityUsd: number;

  insiders: number;
  insiderHoldingsPercent: number;

  snipes: number;
  rushers: number;

  holderCount: number;
  holders: Holder[];

  security: SecurityInfo;

  links?: ExternalLinks;

  raw: string;
}

/* ============================================================
 * Helpers
 * ============================================================
 */

function requireMatch(
  match: RegExpMatchArray | null,
  field: string,
): RegExpMatchArray {
  if (!match) {
    throw new Error(`Failed to parse ${field}`);
  }

  return match;
}

function requiredGroup(
  match: RegExpMatchArray,
  index: number,
  field: string,
): string {
  const value = match[index];

  if (value === undefined) {
    throw new Error(`Missing capture group ${index} for ${field}`);
  }

  return value.trim();
}

function extractUrl(text: string): string | undefined {
  return text.match(/https?:\/\/[^\s)]+/)?.[0];
}

/**
 * Converts:
 *
 * 0.0{5}6438 -> 0.000006438
 * 0.0{4}3519 -> 0.00003519
 */
export function expandCompressedDecimal(value: string): number {
  const cleaned = value.replace(/[$,%]/g, "").trim();

  const match = cleaned.match(/^(\d+)\.(0*)\{(\d+)\}(\d+)$/);

  if (!match) {
    return Number(cleaned);
  }

  const integerPart = requiredGroup(match, 1, "compressed decimal");

  const existingZeros = requiredGroup(match, 2, "compressed decimal");

  const totalZeros = Number(requiredGroup(match, 3, "compressed decimal"));

  const tail = requiredGroup(match, 4, "compressed decimal");

  const additionalZeros = Math.max(0, totalZeros - existingZeros.length);

  return Number(
    `${integerPart}.${existingZeros}${"0".repeat(additionalZeros)}${tail}`,
  );
}

/**
 * Converts:
 *
 * 6.44K -> 6440
 * 846.71M -> 846710000
 * 376.63 -> 376.63
 */
export function parseAbbreviatedUsd(value: string): number {
  const cleaned = value.replace(/[$,\s]/g, "").trim();

  const match = cleaned.match(/^([\d.]+)([KMB])?$/i);

  if (!match) {
    return Number(cleaned);
  }

  const numberValue = Number(requiredGroup(match, 1, "abbreviated number"));

  const suffix = match[2]?.toUpperCase();

  switch (suffix) {
    case "K":
      return numberValue * 1_000;

    case "M":
      return numberValue * 1_000_000;

    case "B":
      return numberValue * 1_000_000_000;

    default:
      return numberValue;
  }
}

/* ============================================================
 * Parser
 * ============================================================
 */

export function parseSolanaPoolSignal(text: string): SolanaPoolSignal {
  try {
    const tokenMatch = requireMatch(
      text.match(/^Token:\s*(.+?)(?:\s*\((https?:\/\/[^\)]+)\))?$/m),
      "token",
    );

    const tokenName = requiredGroup(tokenMatch, 1, "token name");

    const tokenUrl = tokenMatch[2] ?? "";

    const tokenAddress = tokenUrl.split("/").pop() ?? "";

    const contractAddress = requiredGroup(
      requireMatch(text.match(/^CA:\s*(.+)$/m), "contract address"),
      1,
      "contract address",
    );

    const lpAddress = requiredGroup(
      requireMatch(text.match(/^LP:\s*(.+)$/m), "lp address"),
      1,
      "lp address",
    );

    const initPriceRaw = requiredGroup(
      requireMatch(text.match(/^Init Price:\s*\$?(.+)$/m), "initial price"),
      1,
      "initial price",
    );

    const marketCapRaw = requiredGroup(
      requireMatch(text.match(/^MCap:\s*(.+)$/m), "market cap"),
      1,
      "market cap",
    );

    const pairMatch = requireMatch(
      text.match(/^Pair:\s*([\d.]+)([KMB]?)\s+(.+?)\s*\/\s*([\d.]+)\s*SOL$/m),
      "pair",
    );

    const pairTokenAmount = parseAbbreviatedUsd(
      requiredGroup(pairMatch, 1, "pair amount") + (pairMatch[2] ?? ""),
    );

    const pairTokenSymbol = requiredGroup(pairMatch, 3, "pair symbol");

    const pairSolAmount = Number(
      requiredGroup(pairMatch, 4, "pair SOL amount"),
    );

    const dex = requiredGroup(
      requireMatch(text.match(/^Dex:\s*(.+)$/m), "dex"),
      1,
      "dex",
    );

    const liquidityRaw = requiredGroup(
      requireMatch(text.match(/^Liquidity:\s*(.+)$/m), "liquidity"),
      1,
      "liquidity",
    );

    const insiderMatch = requireMatch(
      text.match(/^Insiders:\s*(\d+)\(Holdings\s*([\d.]+)%\)/m),
      "insiders",
    );

    const insiders = Number(requiredGroup(insiderMatch, 1, "insiders"));

    const insiderHoldingsPercent = Number(
      requiredGroup(insiderMatch, 2, "insider holdings"),
    );

    const sniperMatch = requireMatch(
      text.match(/SNIPES:\s*(\d+)\s+RUSHERS:\s*(\d+)/),
      "snipers",
    );

    const snipes = Number(requiredGroup(sniperMatch, 1, "snipes"));

    const rushers = Number(requiredGroup(sniperMatch, 2, "rushers"));

    const holderCount = Number(
      requiredGroup(
        requireMatch(text.match(/^Token Holders:\s*(\d+)/m), "holder count"),
        1,
        "holder count",
      ),
    );

    const holders: Holder[] = [];

    const holderRegex =
      /^\s*\|_([^\s]+)(?:\s+\((https?:\/\/[^\)]+)\))?\s+([0-9.{}]+)%$/gm;

    for (const match of text.matchAll(holderRegex)) {
      const address = requiredGroup(match, 1, "holder address");

      const url = match[2];

      const percentageRaw = requiredGroup(match, 3, "holder percentage");

      holders.push({
        address,
        url,
        percentageRaw,
        percentage: expandCompressedDecimal(percentageRaw),
      });
    }

    const securityMatch = requireMatch(
      text.match(/Security:\s*Score:\s*(\d+)\((?:🟢|🟡|🔴)?(.+?)\)/),
      "security",
    );

    /*
     * [^|]* matches any character except the pipe separator,
     * which is safer than .*? because .*? can cross pipe
     * boundaries when optional content is missing.
     */
    const securityFlags = requireMatch(
      text.match(
        /Ownership Renounced:([^|]*)\|Top10 holdings<30%:\s*([^|]*)\|Stop mint:([^|]*)\|No Blacklist:([^|]*)$/m,
      ),
      "security flags",
    );

    const security: SecurityInfo = {
      score: Number(requiredGroup(securityMatch, 1, "security score")),

      risk: requiredGroup(securityMatch, 2, "security risk"),

      flags: {
        ownershipRenounced: requiredGroup(
          securityFlags,
          1,
          "ownership",
        ).includes("✅"),

        top10HoldingsUnder30: requiredGroup(securityFlags, 2, "top10").includes(
          "✅",
        ),

        stopMint: requiredGroup(securityFlags, 3, "stop mint").includes("✅"),

        noBlacklist: requiredGroup(securityFlags, 4, "blacklist").includes(
          "✅",
        ),
      },
    };

    const links: ExternalLinks = {
      check: extractUrl(text.match(/Check\s*\((.*?)\)/)?.[1] ?? ""),

      website: extractUrl(text.match(/Website\s*\((.*?)\)/)?.[1] ?? ""),

      app: extractUrl(text.match(/App\s*\((.*?)\)/)?.[1] ?? ""),

      community: extractUrl(text.match(/Community\s*\((.*?)\)/)?.[1] ?? ""),

      twitter: extractUrl(text.match(/Twitter\s*\((.*?)\)/)?.[1] ?? ""),
    };

    return {
      tokenName,
      tokenAddress: tokenAddress || "",
      tokenUrl: tokenUrl || "",

      contractAddress,
      lpAddress,

      initPriceRaw,
      initPrice: expandCompressedDecimal(initPriceRaw),

      marketCapRaw,
      marketCapUsd: parseAbbreviatedUsd(marketCapRaw),

      pairTokenAmount,
      pairTokenSymbol,
      pairSolAmount,

      dex,

      liquidityRaw,
      liquidityUsd: parseAbbreviatedUsd(liquidityRaw),

      insiders,
      insiderHoldingsPercent,

      snipes,
      rushers,

      holderCount,
      holders,

      security,
      links,

      raw: text,
    };
  } catch (e) {
    throw new Error(
      `Failed to parse Solana pool signal: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
