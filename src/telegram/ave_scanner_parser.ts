import removeMarkdown from "remove-markdown";

export interface Security {
  score?: number;
  riskLevel?: string;

  ownershipRenounced?: boolean;
  top10HoldingsBelow30Pct?: boolean;
  stopMint?: boolean;
  noBlacklist?: boolean;
}

export interface TokenHolder {
  address?: string;
  percentage?: number;
}

export interface AveScannerSignal {
  Token?: string;
  // solScanUrl?: string;

  CA?: string;
  LP?: string;

  initPriceUSD?: number;
  marketCapUSD?: number;

  dex?: string;

  pairTokenAmount?: number;
  pairTokenSymbol?: string;
  pairSolAmount?: number;

  LiquidityUSD?: number;

  Insiders?: number;
  snipes?: number;
  rushers?: number;

  tokenHoldersCount?: number;
  tokenHolders?: TokenHolder[];

  security?: Security;
}

function parseInitPriceUSD(match: RegExpMatchArray | null): number {
  if (!match) return 0;

  // Normal decimal value
  if (!match[3]) {
    return Number(match[1]);
  }

  const prefix = match[2];
  const zeroCount = Number(match[3]);
  const suffix = match[4];

  const decimal = prefix?.split(".")[1] ?? "";
  const zerosAlreadyPresent = decimal.length;

  return Number(
    prefix + "0".repeat(Math.max(0, zeroCount - zerosAlreadyPresent)) + suffix,
  );
}

export function parseAveScannerSignal(text: string): AveScannerSignal | null {
  try {
    text = removeMarkdown(text);
    // Normalize line endings
    text = text.replace(/\r\n/g, "\n");

    // ------------------------------------------------------------
    // Local Helpers
    // ------------------------------------------------------------

    const capture = (regex: RegExp): string | undefined =>
      text.match(regex)?.[1]?.trim();

    const captureGroups = (regex: RegExp): RegExpMatchArray | null =>
      text.match(regex);

    const parseHumanNumber = (value?: string): number | undefined => {
      if (!value) return undefined;

      value = value.replace(/,/g, "").trim();

      const match = value.match(/^([\d.]+)\s*([KMBT]?)$/i);

      if (!match) {
        const num = Number(value);
        return Number.isFinite(num) ? num : undefined;
      }

      const number = Number(match[1]);
      const suffix = match?.[2]?.toUpperCase();

      switch (suffix) {
        case "K":
          return number * 1e3;

        case "M":
          return number * 1e6;

        case "B":
          return number * 1e9;

        case "T":
          return number * 1e12;

        default:
          return number;
      }
    };

    const parseFlag = (value?: string): boolean | undefined => {
      if (!value) return undefined;

      return value.includes("✅");
    };

    // ------------------------------------------------------------
    // Basic Information
    // ------------------------------------------------------------

    const tokenMatch = captureGroups(
      /^Token:\s*(.*?)(?:\s*\((https:\/\/solscan\.io\/token\/[A-Za-z0-9]+)\))?\s*$/m,
    );

    const Token = tokenMatch?.[1];
    // const solScan = tokenMatch?.[2];

    const CA = capture(/^CA:\s*([1-9A-HJ-NP-Za-km-z]{32,44})$/m);

    const LP = capture(/^LP:\s*([1-9A-HJ-NP-Za-km-z]{32,44})$/m);

    if (!CA || !LP) {
      return null;
    }

    // ------------------------------------------------------------
    // Initial Price
    // ------------------------------------------------------------

    const initPriceMatch = captureGroups(
      /^Init Price:\s*\$(([\d.]+?)(?:\{(\d+)\}(\d+))?)$/m,
    );

    const initPriceUSD = parseInitPriceUSD(initPriceMatch);

    // ------------------------------------------------------------
    // Market Cap
    // ------------------------------------------------------------

    const marketCapMatch = captureGroups(/^MCap:\s*\$([\d.]+)\s*([KMBT]?)/m);

    const marketCapUSD = marketCapMatch
      ? parseHumanNumber(`${marketCapMatch[1]}${marketCapMatch[2]}`)
      : undefined;

    // ------------------------------------------------------------
    // Pair
    // ------------------------------------------------------------

    const pairMatch = captureGroups(
      /^Pair:\s*([\d.,]+)\s*([KMBT]?)\s+(.+?)\s*\/\s*([\d.,]+)\s*SOL$/m,
    );

    let pairTokenAmount: number | undefined;
    let pairTokenSymbol: string | undefined;
    let pairSolAmount: number | undefined;

    if (pairMatch) {
      pairTokenAmount = parseHumanNumber(`${pairMatch[1]}${pairMatch[2]}`);

      pairTokenSymbol = pairMatch?.[3]?.trim();

      pairSolAmount = Number(pairMatch?.[4]?.replace(/,/g, ""));
    }

    // ------------------------------------------------------------
    // Dex
    // ------------------------------------------------------------

    const dex = capture(/^Dex:\s*(.+)$/m);

    // ------------------------------------------------------------
    // Liquidity
    // ------------------------------------------------------------

    const liquidityMatch = captureGroups(
      /^Liquidity:\s*\$([\d.,]+)\s*([KMBT]?)/m,
    );

    const LiquidityUSD = liquidityMatch
      ? parseHumanNumber(`${liquidityMatch[1]}${liquidityMatch[2]}`)
      : undefined;

    // ------------------------------------------------------------
    // Insiders
    // ------------------------------------------------------------

    const insidersMatch = captureGroups(
      /^Insiders:\s*(\d+)\s*\(Holdings\s*([\d.]+)%\)$/m,
    );

    const Insiders = insidersMatch ? Number(insidersMatch[1]) : undefined;

    // Available if you later decide to expose it
    const insiderHoldingsPct = insidersMatch
      ? Number(insidersMatch[2])
      : undefined;

    // ------------------------------------------------------------
    // Snipes / Rushers
    // ------------------------------------------------------------

    const activityMatch = captureGroups(
      /^SNIPES:\s*(\d+)\s+RUSHERS:\s*(\d+)$/m,
    );

    const snipes = activityMatch ? Number(activityMatch[1]) : undefined;

    const rushers = activityMatch ? Number(activityMatch[2]) : undefined;

    // ------------------------------------------------------------
    // Token Holders Count
    // ------------------------------------------------------------

    const tokenHoldersCountMatch = captureGroups(/^Token Holders:\s*(\d+)/m);

    const tokenHoldersCount = tokenHoldersCountMatch
      ? Number(tokenHoldersCountMatch[1])
      : undefined;

    // ------------------------------------------------------------
    // Top Token Holders
    // ------------------------------------------------------------

    const tokenHolders: TokenHolder[] = [];

    const holderRegex =
      /^\s*\|_([1-9A-HJ-NP-Za-km-z]{32,44})(?:\s*\([^)]*\))?\s*([\d.]+)%/gm;

    for (const match of text.matchAll(holderRegex)) {
      tokenHolders.push({
        address: match?.[1],
        percentage: Number(match?.[2] ?? 0),
      });
    }

    // ------------------------------------------------------------
    // Security
    // ------------------------------------------------------------

    const security: Security = {};

    const securityMatch = captureGroups(
      /^Security:\s*Score:\s*(\d+)\s*\((.*?)\)\s*$/m,
    );

    if (securityMatch) {
      security.score = Number(securityMatch[1]);

      // Remove emojis (🟢🟡🔴...) while preserving the text
      security.riskLevel = securityMatch?.[2]
        ?.replace(/[\u{1F300}-\u{1FAFF}\u2600-\u26FF\u2700-\u27BF]/gu, "")
        .replace(/\s+/g, " ")
        .trim();
    }

    const securityFlagsMatch = captureGroups(
      /\|_Ownership Renounced:\s*(✅|❌)\|Top10 holdings<30%:\s*(✅|❌)\|Stop mint:\s*(✅|❌)\|No Blacklist:\s*(✅|❌)/m,
    );

    if (securityFlagsMatch) {
      security.ownershipRenounced = parseFlag(securityFlagsMatch[1]);

      security.top10HoldingsBelow30Pct = parseFlag(securityFlagsMatch[2]);

      security.stopMint = parseFlag(securityFlagsMatch[3]);

      security.noBlacklist = parseFlag(securityFlagsMatch[4]);
    }

    // ------------------------------------------------------------
    // Return Parsed Signal
    // ------------------------------------------------------------

    return {
      Token,
      // solScanUrl,
      CA,
      LP,

      initPriceUSD,
      marketCapUSD,

      dex,

      pairTokenAmount,
      pairTokenSymbol,
      pairSolAmount,

      LiquidityUSD,

      Insiders,
      snipes,
      rushers,

      tokenHoldersCount,
      tokenHolders,

      security,
    };
  } catch (error) {
    console.error("[AveScanner Parser] Failed to parse signal:", error);

    return null;
  }
}
