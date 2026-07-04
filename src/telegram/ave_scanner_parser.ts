// AVE Scanner Telegram Signal Parser for Solana pool launch messages

/** Details of a single top token holder */
export interface Holder {
  /** Wallet address of the holder */
  address: string;
  /** Optional Solscan URL for this holder */
  url?: string;
  /** Raw percentage string (may use compressed notation like 0.0{2}50 for 0.0050%) */
  percentageRaw: string;
  /** Parsed percentage value as a number */
  percentage: number;
}

/** Security flags indicating token safety properties */
export interface SecurityFlags {
  /** Contract ownership has been renounced */
  ownershipRenounced: boolean;
  /** Top 10 holders hold less than 30% of supply */
  top10HoldingsUnder30: boolean;
  /** Minting has been stopped */
  stopMint: boolean;
  /** No blacklist function exists */
  noBlacklist: boolean;
}

/** Security assessment info for a token */
export interface SecurityInfo {
  /** Numeric security score (0 = safest) */
  score: number;
  /** Risk label (e.g., "Low Risk") */
  risk: string;
  /** Individual security flags */
  flags: SecurityFlags;
}

/** External links associated with the token */
export interface ExternalLinks {
  /** Ave.ai check URL */
  check?: string;
  /** Project website URL */
  website?: string;
  /** App/download URL */
  app?: string;
  /** Community/Telegram URL */
  community?: string;
  /** Twitter/X URL */
  twitter?: string;
}

/** Full parsed signal data for a Solana pool */
export interface AveScannerSignal {
  /** Signal type identifier */
  type: "ave_scanner";
  /** Token name (e.g., "BULLHOUSE") */
  tokenName?: string;
  /** Token address extracted from the Solscan URL path */
  tokenAddress?: string;
  /** Full Solscan URL for the token */
  tokenUrl?: string;

  /** Contract address (CA) */
  contractAddress: string;
  /** Liquidity pool address (LP) */
  lpAddress: string;

  /** Raw initial price string before parsing */
  initPriceRaw?: string;
  /** Parsed initial price in USD */
  initPrice?: number;

  /** Raw market cap string before parsing */
  marketCapRaw?: string;
  /** Parsed market cap in USD */
  marketCapUsd?: number;

  /** Amount of the base token in the pool */
  pairTokenAmount?: number;
  /** Symbol of the base token */
  pairTokenSymbol?: string;
  /** Amount of SOL in the pool */
  pairSolAmount?: number;

  /** DEX name (e.g., "Pumpfunamm", "Pump") */
  dex?: string;

  /** Blockchain network (e.g., "solana", "eth") */
  chain?: string;

  /** Raw liquidity string before parsing */
  liquidityRaw?: string;
  /** Parsed liquidity in USD */
  liquidityUsd?: number;

  /** Number of insider holders detected */
  insiders?: number;
  /** Percentage of supply held by insiders */
  insiderHoldingsPercent?: number;

  /** Number of sniper bots detected */
  snipes?: number;
  /** Number of rusher bots detected */
  rushers?: number;

  /** Total number of token holders */
  holderCount?: number;
  /** Details of top token holders */
  holders?: Holder[];

  /** Security assessment information */
  security?: SecurityInfo;

  /** External project links */
  links?: ExternalLinks;

  /** Expected max pump multiplier (e.g., 2x becomes 2) */
  maxPumpX?: number;
  /** Original raw message text as received from Telegram */
  raw: string;
}

/**
 * Ensure a regex match exists, throwing a descriptive error if it does not.
 *
 * @param match - The regex match result (possibly null).
 * @param field - Name of the field being parsed (used in the error message).
 * @returns The non-null match array.
 * @throws Error if match is null.
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

/**
 * Extract a required capture group from a regex match, trimming whitespace.
 *
 * @param match - The non-null regex match result.
 * @param index - The capture group index to extract.
 * @param field - Name of the field being extracted (used in error message).
 * @returns The trimmed capture group string.
 * @throws Error if the capture group value is undefined.
 */
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

/**
 * Extract the first URL found in a text string.
 *
 * @param text - The text to search for a URL.
 * @returns The first matched URL, or undefined if none is found.
 */
function extractUrl(text: string): string | undefined {
  /** Match any http/https URL, stopping at whitespace or closing parenthesis */
  return text.match(/https?:\/\/[^\s)]+/)?.[0];
}

/**
 * Convert compressed decimal notation (e.g., "0.0{2}50") to a JavaScript number.
 *
 * The format "0.0{N}XXXX" represents a number where N indicates the total
 * number of zeros after the decimal point. For example, "0.0{2}50" means
 * 0.0050 (two zeros after the decimal, then "50").
 *
 * @param value - The string to parse (may include $, %, or comma characters).
 * @returns The parsed numeric value.
 */
export function expandCompressedDecimal(value: string): number {
  /** Remove currency symbols, percentage signs, commas, and surrounding whitespace */
  const cleaned = value.replace(/[$,%]/g, "").trim();

  /** Match compressed format: digit(s) . zero(s) {digit(s)} tail */
  const match = cleaned.match(/^(\d+)\.(0*)\{(\d+)\}(\d+)$/);

  /** If the string has no compressed notation, parse as a plain number */
  if (!match) {
    return Number(cleaned);
  }

  /** Extract the integer part before the decimal point */
  const integerPart = requiredGroup(match, 1, "compressed decimal");
  /** Extract any zeros that already exist after the decimal point */
  const existingZeros = requiredGroup(match, 2, "compressed decimal");
  /** Extract the total number of zeros specified in braces */
  const totalZeros = Number(requiredGroup(match, 3, "compressed decimal"));
  /** Extract the significant trailing digits after the compressed zeros */
  const tail = requiredGroup(match, 4, "compressed decimal");

  /** Calculate how many additional zeros must be inserted beyond those already present */
  const additionalZeros = Math.max(0, totalZeros - existingZeros.length);

  /** Reconstruct the full decimal string and convert to a number */
  return Number(
    `${integerPart}.${existingZeros}${"0".repeat(additionalZeros)}${tail}`,
  );
}

/**
 * Convert abbreviated USD values (e.g., "$6.44K") to their full numeric value.
 *
 * Supports K (thousands), M (millions), and B (billions) suffixes.
 * Values without a suffix are returned as-is.
 *
 * @param value - The abbreviated string to parse.
 * @returns The full numeric value, rounded to the nearest integer.
 */
export function parseAbbreviatedUsd(value: string): number {
  /** Strip dollar signs, commas, and whitespace from the input */
  const cleaned = value.replace(/[$,\s]/g, "").trim();

  /** Match an optional numeric portion followed by an optional K/M/B suffix */
  const match = cleaned.match(/^([\d.]+)([KMB])?$/i);

  /** If the suffix pattern does not match, attempt a direct numeric parse */
  if (!match) {
    return Number(cleaned);
  }

  /** Extract the numeric base value */
  const numberValue = Number(requiredGroup(match, 1, "abbreviated number"));
  /** Read the suffix (if any) and normalize to uppercase */
  const suffix = match[2]?.toUpperCase();

  /** Apply the appropriate multiplier based on the suffix character */
  switch (suffix) {
    case "K":
      return Math.round(numberValue * 1_000);
    case "M":
      return Math.round(numberValue * 1_000_000);
    case "B":
      return Math.round(numberValue * 1_000_000_000);
    default:
      return numberValue;
  }
}

/**
 * Parse a Solana pool launch signal from raw Telegram message text.
 *
 * Handles the AVE Scanner bot message format, extracting token metadata,
 * pool details, holder data, security assessments, and external links.
 * Validates market cap and initial price before returning the result.
 *
 * @param text - The raw Telegram message text.
 * @returns A fully parsed AveScannerSignal object.
 * @throws Error if any required field is missing or if validation fails.
 */
export function parseAveScannerSignal(text: string): AveScannerSignal {
  try {
    /**
     * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     * STEP 1: Extract token identity (name, URL, and address)
     * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     */
    /** Match "Token:" line with optional URL in parentheses */
    const tokenMatch = text.match(
      /^Token:\s*(.+?)(?:\s*\((https?:\/\/[^\)]+)\))?$/m,
    );
    /** Extract the token name; fall back to "unknown" if missing */
    const tokenName = tokenMatch?.[1]?.trim() ?? "unknown";
    /** Extract the optional Solscan URL from the capture group */
    const tokenUrl = tokenMatch?.[2] ?? "";
    /** Derive the token address from the last segment of the URL path */
    const tokenAddress = tokenUrl.split("/").pop() ?? "";

    /**
     * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     * STEP 2: Parse contract and liquidity pool addresses
     * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     */
    /** Parse the contract address (CA) line; required — throws on failure */
    const contractAddress = requiredGroup(
      requireMatch(text.match(/^CA:\s*(.+)$/m), "contract address"),
      1,
      "contract address",
    );

    /** Parse the liquidity pool address (LP) line; required */
    const lpAddress = requiredGroup(
      requireMatch(text.match(/^LP:\s*(.+)$/m), "lp address"),
      1,
      "lp address",
    );

    /**
     * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     * STEP 3: Parse initial price with compressed decimal support
     * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     */
    /** Extract the raw price string after "Init Price:" */
    const initPriceRaw = requiredGroup(
      requireMatch(text.match(/^Init Price:\s*\$?(.+)$/m), "initial price"),
      1,
      "initial price",
    );
    /** Expand any compressed decimal notation into a real number */
    const initPrice = expandCompressedDecimal(initPriceRaw);

    /**
     * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     * STEP 4: Parse market cap with abbreviation support
     * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     */
    /** Extract the raw market cap string after "MCap:" */
    const marketCapRaw = requiredGroup(
      requireMatch(text.match(/^MCap:\s*(.+)$/m), "market cap"),
      1,
      "market cap",
    );
    /** Expand any abbreviated notation (e.g., "6.44K" → 6440) */
    const marketCapUsd = parseAbbreviatedUsd(marketCapRaw);

    /**
     * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     * STEP 5: Parse pair token and SOL amounts
     * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     */
    /** Match "Pair:" line: "1000.00M TOKEN / 84.99 SOL" */
    const pairMatch = requireMatch(
      text.match(/^Pair:\s*([\d.]+)([KMB]?)\s+(.+?)\s*\/\s*([\d.]+)\s*SOL$/m),
      "pair",
    );
    /** Parse the token amount (may include abbreviation suffix) */
    const pairTokenAmount = parseAbbreviatedUsd(
      requiredGroup(pairMatch, 1, "pair amount") + (pairMatch[2] ?? ""),
    );
    /** Extract the token symbol (e.g., "BULLHOUSE") */
    const pairTokenSymbol = requiredGroup(pairMatch, 3, "pair symbol");
    /** Extract the SOL side of the pair as a plain number */
    const pairSolAmount = Number(
      requiredGroup(pairMatch, 4, "pair SOL amount"),
    );

    /**
     * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     * STEP 6: Parse DEX and liquidity values
     * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     */
    /** Parse the DEX name (e.g., "Pumpfunamm") */
    const dex = requiredGroup(
      requireMatch(text.match(/^Dex:\s*(.+)$/m), "dex"),
      1,
      "dex",
    );

    /** Extract the raw liquidity value string */
    const liquidityRaw = requiredGroup(
      requireMatch(text.match(/^Liquidity:\s*(.+)$/m), "liquidity"),
      1,
      "liquidity",
    );

    /**
     * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     * STEP 7: Parse insider data (count + holdings percentage)
     * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     */
    /** Match "Insiders: N (Holdings X.XX%)" pattern */
    const insiderMatch = requireMatch(
      text.match(/^Insiders:\s*(\d+)\(Holdings\s*([\d.]+)%\)/m),
      "insiders",
    );
    /** Extract the number of insider wallets detected */
    const insiders = Number(requiredGroup(insiderMatch, 1, "insiders"));
    /** Extract the percentage of supply held by insiders */
    const insiderHoldingsPercent = Number(
      requiredGroup(insiderMatch, 2, "insider holdings"),
    );

    /**
     * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     * STEP 8: Parse sniper and rusher bot counts
     * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     */
    /** Match "SNIPES: N  RUSHERS: N" line */
    const sniperMatch = requireMatch(
      text.match(/SNIPES:\s*(\d+)\s+RUSHERS:\s*(\d+)/),
      "snipers",
    );
    /** Extract the number of sniper bots */
    const snipes = Number(requiredGroup(sniperMatch, 1, "snipes"));
    /** Extract the number of rusher bots */
    const rushers = Number(requiredGroup(sniperMatch, 2, "rushers"));

    /**
     * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     * STEP 9: Parse token holder count and individual holder details
     * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     */
    /** Match optional "Token Holders:" line for total holder count */
    const holderMatch = text.match(/^Token Holders:\s*(\d+)/m);
    /** If found, parse the numeric count; otherwise leave undefined */
    const holderCount = holderMatch ? Number(holderMatch[1]) : undefined;

    /** Container for all parsed holder entries */
    const holders: Holder[] = [];
    /** Only parse individual holders if the total count line was present */
    if (holderMatch) {
      /** Pattern matching: |_address (url)? percentage% */
      const holderRegex =
        /^\s*\|_([^\s]+)(?:\s+\((https?:\/\/[^\)]+)\))?\s+([0-9.{}]+)%$/gm;

      /** Iterate over every holder line in the message */
      for (const match of text.matchAll(holderRegex)) {
        const address = requiredGroup(match, 1, "holder address");
        const url = match[2];
        const percentageRaw = requiredGroup(match, 3, "holder percentage");

        holders.push({
          address,
          url,
          percentageRaw,
          /** Expand compressed decimal notation in the percentage value */
          percentage: expandCompressedDecimal(percentageRaw),
        });
      }
    }

    /**
     * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     * STEP 10: Parse security assessment data
     * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     */
    /** Match "Security:" line containing score and risk label */
    const securityMatch = requireMatch(
      text.match(/Security:\s*Score:\s*(\d+)\((?:🟢|🟡|🔴)?(.+?)\)/),
      "security",
    );
    /** Match the pipe-separated boolean flags line */
    const securityFlags = requireMatch(
      text.match(
        /Ownership Renounced:([^|]*)\|Top10 holdings<30%:\s*([^|]*)\|Stop mint:([^|]*)\|No Blacklist:([^|]*)$/m,
      ),
      "security flags",
    );

    /** Assemble the security info object from parsed components */
    const security: SecurityInfo = {
      score: Number(requiredGroup(securityMatch, 1, "security score")),
      risk: requiredGroup(securityMatch, 2, "security risk"),
      flags: {
        /** Each flag field is true if it contains the green checkmark emoji */
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

    /**
     * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     * STEP 11: Parse external project links
     * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     */
    /** Extract optional links: Check, Website, App, Community, Twitter */
    const links: ExternalLinks = {
      /** Extract the URL from inside "Check (url)" */
      check: extractUrl(text.match(/Check\s*\((.*?)\)/)?.[1] ?? ""),
      /** Extract the URL from inside "Website (url)" */
      website: extractUrl(text.match(/Website\s*\((.*?)\)/)?.[1] ?? ""),
      /** Extract the URL from inside "App (url)" */
      app: extractUrl(text.match(/App\s*\((.*?)\)/)?.[1] ?? ""),
      /** Extract the URL from inside "Community (url)" */
      community: extractUrl(text.match(/Community\s*\((.*?)\)/)?.[1] ?? ""),
      /** Extract the URL from inside "Twitter (url)" */
      twitter: extractUrl(text.match(/Twitter\s*\((.*?)\)/)?.[1] ?? ""),
    };

    /**
     * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     * STEP 12: Validate parsed numeric values
     * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     */
    /** Alias for readability in validation checks */
    const mc = marketCapUsd;
    const ip = initPrice;
    /** Collect all validation errors before throwing */
    const errors: string[] = [];

    /** Market cap must be a non-negative finite number to be considered valid */
    if (
      mc !== undefined &&
      (typeof mc !== "number" || !Number.isFinite(mc) || mc < 0)
    ) {
      errors.push(`invalid marketCapUsd: ${mc}`);
    }
    /** Initial price must be a positive finite number (> 0) to be valid */
    if (
      ip !== undefined &&
      (typeof ip !== "number" || !Number.isFinite(ip) || ip <= 0)
    ) {
      errors.push(`invalid initPrice: ${ip}`);
    }
    /** If any validation checks failed, throw a combined error message */
    if (errors.length > 0) {
      throw new Error(`Signal validation failed: ${errors.join(", ")}`);
    }

    /**
     * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     * STEP 13: Assemble and return the final parsed signal object
     * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
     */
    return {
      type: "ave_scanner",
      tokenName,
      tokenAddress: tokenAddress || "",
      tokenUrl: tokenUrl || "",
      contractAddress,
      lpAddress,
      initPriceRaw,
      initPrice: ip,
      marketCapRaw,
      marketCapUsd: mc,
      pairTokenAmount,
      pairTokenSymbol,
      pairSolAmount,
      dex,
      liquidityRaw,
      /** Parse liquidity value (may use abbreviated notation) */
      liquidityUsd: parseAbbreviatedUsd(liquidityRaw),
      insiders,
      insiderHoldingsPercent,
      snipes,
      rushers,
      holderCount,
      holders,
      security,
      links,
      /** Preserve the original raw text for downstream debugging/logging */
      raw: text,
    };
  } catch (e) {
    /** Wrap any parse error with a descriptive context prefix */
    throw new Error(
      `Failed to parse Solana pool signal: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
