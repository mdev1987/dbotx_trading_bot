// Ave Signal Monitor Telegram Parser — handles buy signals and pump results

/** Parsed buy signal from Ave Signal Monitor (starts with 🪙 emoji) */
export interface AveSignalMonitorSignal {
  /** Discriminant field for signal-type messages */
  type: "ave_monitor_signal";
  /** Token name (e.g., "nitro") extracted from the "$TOKEN" header */
  tokenName: string;
  /** Decentralized exchange source (e.g., "pump.fun") */
  fromDEX: string;
  /** Contract address (CA) of the token */
  contractAddress: string;
  /** LP address of the token (currently using CA as a fallback) */
  lpAddress: string;
  /** Blockchain network label (e.g., "solana", "eth") */
  chain: string;
  /** Vibe signal ordinal number (e.g., 2 for 2nd signal) */
  nVibeSignal?: number;
  /** Maximum expected pump multiplier (0 if uncertain — indicated by "<" prefix) */
  maxPumpX: number;
  /** Current market cap in USD */
  marketCapUsd: number;
  /** Number of KOL/Smart wallets that bought the token */
  walletBuyCount: number;
  /** Total buy volume in SOL (set to 0 if the currency is not SOL) */
  totalBuySol: number;
  /** Original raw message text as received from Telegram */
  raw: string;
}

/** Parsed pump result message from Ave Signal Monitor (starts with 🚀 emoji) */
export interface AveSignalMonitorPump {
  /** Discriminant field for pump-result-type messages */
  type: "ave_monitor_pump";
  /** Token name extracted from the header line */
  tokenName: string;
  /** Contract address (CA) of the pumped token */
  contractAddress: string;
  /** LP address (currently using CA as a fallback) */
  lpAddress: string;
  /** Achieved pump multiplier (e.g., 24 for x24) */
  multiplier: number;
  /** Market cap before the pump event (in USD) */
  jumpedFromK: number;
  /** Market cap after the pump event (in USD) */
  jumpedToK: number;
  /** Original raw message text as received from Telegram */
  raw: string;
}

/** Union type for any parsed Ave Signal Monitor message (signal or pump) */
export type AveSignalMonitorMessage =
  | AveSignalMonitorSignal
  | AveSignalMonitorPump;

/**
 * Extract a specific capture group from a regex match applied to text.
 * Returns null if the regex does not match or the group is missing.
 *
 * @param re - The regular expression to execute.
 * @param text - The text to search against.
 * @param idx - The capture group index (0-based) to extract.
 * @returns The trimmed capture group string, or null if not found.
 */
function matchGroup(re: RegExp, text: string, idx: number): string | null {
  /** Run the regex against the text */
  const m = text.match(re);
  /** Return the trimmed group if it exists, otherwise null */
  return m?.[idx]?.trim() ?? null;
}

/**
 * Parse abbreviated numeric values (e.g., "40.94K" → 40940).
 *
 * Supports K (thousands), M (millions), and B (billions) suffixes.
 * Values without a recognised suffix are returned as-is after cleaning.
 *
 * @param val - The abbreviated string to parse.
 * @returns The full numeric value, rounded to the nearest integer.
 */
function parseAbbreviated(val: string): number {
  /** Strip currency symbols ($), commas, and whitespace from the input */
  const cleaned = val.replace(/[$,\s]/g, "").trim();
  /** Match an optional numeric portion followed by an optional K/M/B suffix */
  const m = cleaned.match(/^([\d.]+)([KMBkmb])?$/);
  /** If the pattern does not match, attempt a direct numeric conversion */
  if (!m) return Number(cleaned);
  /** Extract the numeric base value from the first capture group */
  const num = Number(m[1]);
  /** Normalise the suffix to uppercase for case-insensitive matching */
  const suffix = m[2]?.toUpperCase();
  /** Apply the appropriate multiplier based on the suffix character */
  switch (suffix) {
    case "K":
      return Math.round(num * 1_000);
    case "M":
      return Math.round(num * 1_000_000);
    case "B":
      return Math.round(num * 1_000_000_000);
    default:
      return num;
  }
}

/**
 * Parse a buy signal message from the Ave Signal Monitor bot.
 *
 * Signals start with the 🪙 (gem) emoji.  The parser extracts token identity,
 * DEX source, contract address, chain, vibe ordinal, pump multiplier, market
 * cap, wallet activity, and buy volume from the structured message format.
 *
 * @param text - The raw Telegram message text.
 * @returns A parsed AveSignalMonitorSignal, or null if the text does not
 *          match the expected format.
 */
export function parseSignalMonitorSignal(
  text: string,
): AveSignalMonitorSignal | null {
  /** Trim surrounding whitespace to normalise the input */
  const trimmed = text.trim();

  /** Reject the message if it does not start with the 🪙 gem emoji (signal indicator) */
  if (!trimmed.startsWith("\u{1FA99}")) return null;

  /**
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * SECTION 1: Extract token name and DEX source from the header line
   *            Format: "🪙  $TOKEN (from pump.fun)"
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */
  const tokenName =
    matchGroup(/^🪙\s+\$(.+?)\s+\(from\s+(.*?)\)/m, trimmed, 1)?.trim() ?? "";
  const fromDEX =
    matchGroup(/^🪙\s+\$(.+?)\s+\(from\s+(.*?)\)/m, trimmed, 2)?.trim() ?? "";

  /**
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * SECTION 2: Extract the contract address from the "CA:" line.
   *            If missing, this is not a valid signal — return null.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */
  const ca = matchGroup(/^CA:\s*(\S+)/m, trimmed, 1)?.trim();
  if (!ca) return null;

  /**
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * SECTION 3: Extract the blockchain chain from the 🔗 line.
   *            Defaults to "solana" if the line is absent.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */
  const chain = matchGroup(/^🔗\s*(\w+)/m, trimmed, 1)?.trim() ?? "solana";

  /**
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * SECTION 4: Extract the Vibe signal ordinal from the "🔢" line.
   *            e.g., "🔢 2nd Vibe Buy Signal" → nVibeSignal = 2.
   *            Defaults to 1 if the line is absent.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */
  const nVibeSignal = Number(
    matchGroup(
      /^🔢\s+(\d+)(?:st|nd|rd|th)?\s+Vibe\s+Buy\s+Signal/im,
      trimmed,
      1,
    )?.trim() ?? 1,
  );

  /**
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * SECTION 5: Parse the max pump multiplier from the "💹 Max Pump:" line.
   *            An optional "<" prefix indicates an uncertain pump
   *            (e.g., "< 1x"), which we store as 0.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */
  const pumpMatch = trimmed.match(/^💹\s*Max Pump:\s*(<)?\s*([\d.]+)x/m);
  /** True if a "<" character precedes the pump value (uncertain estimate) */
  const isUncertain = pumpMatch?.[1] === "<";
  /** Return 0 for uncertain pumps; clamp negative values to 0 */
  const maxPumpX = pumpMatch
    ? isUncertain
      ? 0
      : Math.max(0, Number(pumpMatch[2]))
    : 0;

  /**
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * SECTION 6: Parse the current market cap from the "🤑 Current MC:" line.
   *            Falls back to 0 if the line is absent.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */
  const mcMatch = trimmed.match(/^🤑\s*Current MC:\s*(\S+)/m);
  const mcRaw = mcMatch?.[1];
  const marketCapUsd = mcRaw ? parseAbbreviated(mcRaw) : 0;

  /**
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * SECTION 7: Parse the number of KOL / Smart wallets that bought.
   *            Format: "💰  N KOL Wallet Buy" or "💰  N Smart Wallet Buy".
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */
  const walletMatch = trimmed.match(
    /^💰\s+(\d+)\s+(?:KOL|Smart)\s+Wallet\s+Buy/m,
  );
  const walletCountRaw = walletMatch?.[1];
  const walletBuyCount = walletCountRaw ? Number(walletCountRaw) : 0;

  /**
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * SECTION 8: Parse the total buy amount and validate the currency.
   *            If the currency is not SOL, zero out the value to avoid
   *            misinterpreting non-SOL buy volumes.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */
  const buyMatch = trimmed.match(/^💸\s*Total Buy\s+([\d.]+)\s+(\w+)/m);
  const buyAmountRaw = buyMatch?.[1];
  const buyCurrency = buyMatch?.[2];
  let totalBuySol = buyAmountRaw ? Number(buyAmountRaw) : 0;
  /** Reset to 0 if the buy currency exists but is not SOL (incomparable) */
  if (buyCurrency && buyCurrency.toUpperCase() !== "SOL") {
    totalBuySol = 0;
  }

  /**
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * SECTION 9: Validate all parsed values before returning.
   *            Returns null if any essential constraint is violated.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */
  /** Reject if contract address is missing or too short to be realistic (< 10 chars) */
  if (!ca || ca.length < 10) return null;
  /** Market cap must be a non-negative finite number */
  if (
    typeof marketCapUsd !== "number" ||
    !Number.isFinite(marketCapUsd) ||
    marketCapUsd < 0
  )
    return null;
  /** Pump multiplier must not be negative */
  if (maxPumpX < 0) return null;
  /** Buy volume must not be negative */
  if (totalBuySol < 0) return null;

  /**
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * SECTION 10: Assemble and return the final parsed signal object.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */
  return {
    type: "ave_monitor_signal",
    tokenName,
    fromDEX,
    contractAddress: ca,
    /** Use contract address as the LP address (the bot does not emit a separate LP field) */
    lpAddress: ca,
    chain,
    nVibeSignal,
    maxPumpX,
    marketCapUsd,
    walletBuyCount,
    totalBuySol,
    /** Preserve the trimmed raw text for downstream debugging */
    raw: trimmed,
  };
}

/**
 * Parse a pump result message from the Ave Signal Monitor bot.
 *
 * Pump results start with the 🚀 (rocket) emoji.  The parser extracts the
 * achieved multiplier, token name, contract address, and the market cap
 * range before and after the pump event.
 *
 * @param text - The raw Telegram message text.
 * @returns A parsed AveSignalMonitorPump, or null if the text does not
 *          match the expected format.
 */
export function parseSignalMonitorPump(
  text: string,
): AveSignalMonitorPump | null {
  /** Trim surrounding whitespace to normalise the input */
  const trimmed = text.trim();

  /** Reject the message if it does not start with the 🚀 rocket emoji (pump indicator) */
  if (!trimmed.startsWith("\u{1F680}")) return null;

  /**
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * SECTION 1: Extract multiplier and token name from the header.
   *            Format: "🚀  x24  🚀  $TOKENNAME"
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */
  const headMatch = trimmed.match(/^🚀\s*x([\d.]+)\s*🚀\s+\$(\S+)/);
  /** If either capture group is missing, the header is malformed — reject */
  if (!headMatch?.[1] || !headMatch[2]) return null;
  /** Convert the multiplier string to a number */
  const multiplier = Number(headMatch[1]);
  const tokenName = headMatch[2].trim();
  if (!tokenName) return null;

  /**
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * SECTION 2: Extract the contract address from the "CA:" line.
   *            Missing CA means the message is not a valid pump result.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */
  const ca = matchGroup(/^CA:\s*(\S+)/m, trimmed, 1);
  if (!ca) return null;

  /**
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * SECTION 3: Parse the jumped-from / jumped-to market cap values.
   *            Format: "Jumped from 40.94K to now 1.42M"
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */
  const jumpMatch = trimmed.match(
    /^Jumped from\s+([\d.]+[KMBkmb]?)\s+to\s+now\s+([\d.]+[KMBkmb]?)/m,
  );
  /** Extract the raw "from" value (may use abbreviated notation like "40.94K") */
  const jumpedFrom = jumpMatch?.[1];
  /** Extract the raw "to" value (may use abbreviated notation like "1.42M") */
  const jumpedToVal = jumpMatch?.[2];
  /** Expand abbreviated values to full numbers; fall back to 0 if absent */
  const jumpedFromK = jumpedFrom ? parseAbbreviated(jumpedFrom) : 0;
  const jumpedToK = jumpedToVal ? parseAbbreviated(jumpedToVal) : 0;

  /**
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * SECTION 4: Validate parsed values before returning.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */
  /** Multiplier must be a positive finite number (> 0) to be valid */
  if (
    typeof multiplier !== "number" ||
    !Number.isFinite(multiplier) ||
    multiplier <= 0
  )
    return null;
  /** Contract address must be at least 10 characters to be realistic */
  if (!ca || ca.length < 10) return null;

  /**
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   * SECTION 5: Assemble and return the final parsed pump result object.
   * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
   */
  return {
    type: "ave_monitor_pump",
    tokenName,
    contractAddress: ca,
    /** Use contract address as the LP address (the bot does not emit a separate LP field) */
    lpAddress: ca,
    multiplier,
    jumpedFromK,
    jumpedToK,
    /** Preserve the trimmed raw text for downstream debugging */
    raw: trimmed,
  };
}

/**
 * Dispatch parser: detect message type by its leading emoji and delegate
 * to the appropriate specialised parser.
 *
 * - 🪙 (gem)  →  buy signal (parseSignalMonitorSignal)
 * - 🚀 (rocket)  →  pump result (parseSignalMonitorPump)
 * - Anything else  →  returns null (unrecognised message type)
 *
 * @param text - The raw Telegram message text.
 * @returns A parsed signal or pump message, or null if unrecognised.
 */
export function parseSignalMonitorMessage(
  text: string,
): AveSignalMonitorMessage | null {
  /** Trim surrounding whitespace before checking the prefix emoji */
  const trimmed = text.trim();

  /** 🪙 indicates a buy signal message */
  if (trimmed.startsWith("\u{1FA99}")) {
    return parseSignalMonitorSignal(trimmed);
  }
  /** 🚀 indicates a pump result message */
  if (trimmed.startsWith("\u{1F680}")) {
    return parseSignalMonitorPump(trimmed);
  }
  /** No recognised prefix — cannot determine message type */
  return null;
}
