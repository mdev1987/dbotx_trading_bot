import { describe, expect, test } from "bun:test";
import { parseAveScannerSignal } from "./ave_scanner_parser";

const BifgsySignal = `
💠 New Solana Pool Launched 💠

Token: Bifgsy (https://solscan.io/token/FP1GCRkntLdb3EhVSnRzJzqzbS4hyJEgxnnyh8v91Caz)
CA: FP1GCRkntLdb3EhVSnRzJzqzbS4hyJEgxnnyh8v91Caz
LP: 5wGEfoimBhyVb2XTVwxfpqyv5SynyAiNinsj7v6rigvh

Init Price: $0.01003
MCap: $1003.10M
Pair: 2.34M Bifgsy / 300.02 SOL
Dex: Pumpfunamm
Liquidity: $46.82K
Insiders: 5(Holdings 0%)
SNIPES: 5  RUSHERS: 0
Token Holders: 10 🐸🐸
    |_2JGSz7vnQwsNSKyuoyMUS9x4sn37T3fJDBtiXz6hLpWH (https://solscan.io/account/2JGSz7vnQwsNSKyuoyMUS9x4sn37T3fJDBtiXz6hLpWH) 49.9988%
    |_Axor5ojcru9asejG1zkjMybM8a3DkEwhh5bWiJXurENB (https://solscan.io/account/Axor5ojcru9asejG1zkjMybM8a3DkEwhh5bWiJXurENB) 12.4997%
    |_F2RDCvgE5rXNELHi8189kPEZ416vCnM7Y7XCNXvjcbeR (https://solscan.io/account/F2RDCvgE5rXNELHi8189kPEZ416vCnM7Y7XCNXvjcbeR) 12.4997%
    |_E4wotssND8acpgAxREm4a8onCrwY7eMwTrEHjPh8sena (https://solscan.io/account/E4wotssND8acpgAxREm4a8onCrwY7eMwTrEHjPh8sena) 12.4997%
    |_HLd87VTVF4zbVuzsNawusXYu8M3m1KL1M8zzS5Roe3mQ (https://solscan.io/account/HLd87VTVF4zbVuzsNawusXYu8M3m1KL1M8zzS5Roe3mQ) 12.4997%
Security: Score: 0(🟢Low Risk)    
|_Ownership Renounced:❌|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅

Check (https://ave.ai/check/FP1GCRkntLdb3EhVSnRzJzqzbS4hyJEgxnnyh8v91Caz-solana?type=token) | Website (https://ave.ai/) | App (https://ave.ai/download) | Community (https://t.me/aveai_english) | Twitter (https://x.com/aveaiofficial)
`;

const juhnSignal = `
💠 New Solana Pool Launched 💠

Token: juhn (https://solscan.io/token/F6wFGqvuVAgGmwowPs3fBn6vYzT4RTpb8NS5ToM1pump)
CA: F6wFGqvuVAgGmwowPs3fBn6vYzT4RTpb8NS5ToM1pump
LP: Hh7MjLkMxozhXABqi1BKur1SGXbjZB6Phf5rt3Mwhe1f

Init Price: $0.0{5}2497
MCap: $3.38K
Pair: 875.14M juhn / 3.95 SOL
Dex: Pump
Liquidity: $308.05
Insiders: 0(Holdings 0%)
SNIPES: 7  RUSHERS: 0
Token Holders: 10 🐸🐸
    |_Hh7MjLkMxozhXABqi1BKur1SGXbjZB6Phf5rt3Mwhe1f (https://solscan.io/account/Hh7MjLkMxozhXABqi1BKur1SGXbjZB6Phf5rt3Mwhe1f) 66.4187%
    |_HF2EGxkKXRhdR93ZN5fY925PpecZDwRfKwhag6mvFMLW (https://solscan.io/account/HF2EGxkKXRhdR93ZN5fY925PpecZDwRfKwhag6mvFMLW) 7.0233%
    |_AQ9pbufH9We9AbekyMH25zJkwrXxHSQW3FmE2CZ7uj36 (https://solscan.io/account/AQ9pbufH9We9AbekyMH25zJkwrXxHSQW3FmE2CZ7uj36) 3.3666%
    |_7BG2t1jUXMDFuXH72s7RLixscDqGBqzVTT8cN5QqfEUu (https://solscan.io/account/7BG2t1jUXMDFuXH72s7RLixscDqGBqzVTT8cN5QqfEUu) 3.2354%
    |_8TgaUXTQq9SnRs1L89uNZGjpSes4rqg59Ab892KbaGuL (https://solscan.io/account/8TgaUXTQq9SnRs1L89uNZGjpSes4rqg59Ab892KbaGuL) 3.1736%
Security: Score: 0(🟢Low Risk)    
|_Ownership Renounced:❌|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅

Check (https://ave.ai/check/F6wFGqvuVAgGmwowPs3fBn6vYzT4RTpb8NS5ToM1pump-solana?type=token) | Website (https://ave.ai/) | App (https://ave.ai/download) | Community (https://t.me/aveai_english) | Twitter (https://x.com/aveaiofficial) | Pump.fun (https://pump.fun/)
`;

const CHADLYSignal = `
💠 New Solana Pool Launched 💠

Token: CHADLY
CA: Eg6x4vJi2EMfEbxKaeiTzWNE5CA2JtBjMR9o8EoFpump
LP: Fn6gCmx7SdTwUPVmaVAysLHLZ318FDVpXGssdYUhQGLy

Init Price: $0.0002882
MCap: $267.81K
Pair: 4.14M CHADLY / 14.43 SOL
Dex: Meteoradammv2
Liquidity: $2.24K
Insiders: 133(Holdings 0%)
SNIPES: 3  RUSHERS: 0
Token Holders: 10 🐸🐸
    |_FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM 99.0023%
    |_HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC 0.4198%
    |_3hFsjrJidsAKxAbm8z5hUcmQUUJ2jkWqf6pDqbuN2uVk 0.01459%
    |_8QPDf6ZXzZUAcjYsjkKzDqo3SPdaJv3ogms3cGcnGLEv 0.009031%
    |_6sp7NRCM3Eotx1QvBwbgT3EMEzP2kzNw3erxb78Q3hrc 0.008973%
Security: Score: 0(🟢Low Risk)    
|_Ownership Renounced:❌|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅

Check | Website | App | Community | Twitter
`;

describe("Ave Scanner Parser", () => {
  test("should parse a complete Ave Scanner Bifgsy signal", () => {
    const result = parseAveScannerSignal(BifgsySignal);
    console.dir(result);
    expect(result).not.toBeNull();

    // ----------------------------------------------------
    // Basic
    // ----------------------------------------------------

    expect(result?.Token).toBe("Bifgsy");

    expect(result?.CA).toBe("FP1GCRkntLdb3EhVSnRzJzqzbS4hyJEgxnnyh8v91Caz");

    expect(result?.LP).toBe("5wGEfoimBhyVb2XTVwxfpqyv5SynyAiNinsj7v6rigvh");

    // ----------------------------------------------------
    // Market
    // ----------------------------------------------------

    expect(Number(result?.initPriceUSD)).toBeCloseTo(0.01003);

    expect(Number(result?.marketCapUSD)).toBeCloseTo(1_003_100_000);

    expect(result?.LiquidityUSD).toBeCloseTo(46_820);

    expect(result?.dex).toBe("Pumpfunamm");

    // ----------------------------------------------------
    // Pair
    // ----------------------------------------------------

    expect(result?.pairTokenAmount).toBeCloseTo(2_340_000);

    expect(result?.pairTokenSymbol).toBe("Bifgsy");

    expect(result?.pairSolAmount).toBeCloseTo(300.02);

    // ----------------------------------------------------
    // Statistics
    // ----------------------------------------------------

    expect(result?.Insiders).toBe(5);

    expect(result?.snipes).toBe(5);

    expect(result?.rushers).toBe(0);

    expect(result?.tokenHoldersCount).toBe(10);

    // ----------------------------------------------------
    // Holders
    // ----------------------------------------------------

    expect(result?.tokenHolders).toHaveLength(5);

    expect(result?.tokenHolders?.[0]?.address).toBe(
      "2JGSz7vnQwsNSKyuoyMUS9x4sn37T3fJDBtiXz6hLpWH",
    );

    expect(result?.tokenHolders?.[0]?.percentage).toBeCloseTo(49.9988, 4);

    expect(result?.tokenHolders?.[4]?.address).toBe(
      "HLd87VTVF4zbVuzsNawusXYu8M3m1KL1M8zzS5Roe3mQ",
    );

    expect(result?.tokenHolders?.[4]?.percentage).toBeCloseTo(12.4997, 4);

    // ----------------------------------------------------
    // Security
    // ----------------------------------------------------

    expect(result?.security).toBeDefined();

    expect(result?.security?.score).toBe(0);

    expect(result?.security?.riskLevel).toBe("Low Risk");

    expect(result?.security?.ownershipRenounced).toBe(false);

    expect(result?.security?.top10HoldingsBelow30Pct).toBe(true);

    expect(result?.security?.stopMint).toBe(true);

    expect(result?.security?.noBlacklist).toBe(true);
  });

  test("should parse a complete Ave Scanner juhn signal", () => {
    const result = parseAveScannerSignal(juhnSignal);
    console.dir(result);
    expect(result).not.toBeNull();

    // ----------------------------------------------------
    // Basic
    // ----------------------------------------------------

    expect(result?.Token).toBe("juhn");
    expect(result?.CA).toBe("F6wFGqvuVAgGmwowPs3fBn6vYzT4RTpb8NS5ToM1pump");

    expect(result?.LP).toBe("Hh7MjLkMxozhXABqi1BKur1SGXbjZB6Phf5rt3Mwhe1f");

    // ----------------------------------------------------
    // Market
    // ----------------------------------------------------

    expect(Number(result?.initPriceUSD)).toBeCloseTo(0.000002497);

    expect(Number(result?.marketCapUSD)).toBeCloseTo(3_380);

    expect(result?.LiquidityUSD).toBeCloseTo(308.05);

    expect(result?.dex).toBe("Pump");

    // ----------------------------------------------------
    // Pair
    // ----------------------------------------------------

    expect(result?.pairTokenAmount).toBeCloseTo(875_140_000);

    expect(result?.pairTokenSymbol).toBe("juhn");

    expect(result?.pairSolAmount).toBeCloseTo(3.95);

    // ----------------------------------------------------
    // Statistics
    // ----------------------------------------------------

    expect(result?.Insiders).toBe(0);

    expect(result?.snipes).toBe(7);

    expect(result?.rushers).toBe(0);

    expect(result?.tokenHoldersCount).toBe(10);

    // ----------------------------------------------------
    // Holders
    // ----------------------------------------------------

    expect(result?.tokenHolders).toHaveLength(5);

    expect(result?.tokenHolders?.[0]?.address).toBe(
      "Hh7MjLkMxozhXABqi1BKur1SGXbjZB6Phf5rt3Mwhe1f",
    );

    expect(result?.tokenHolders?.[0]?.percentage).toBeCloseTo(66.4187, 4);

    expect(result?.tokenHolders?.[4]?.address).toBe(
      "8TgaUXTQq9SnRs1L89uNZGjpSes4rqg59Ab892KbaGuL",
    );

    expect(result?.tokenHolders?.[4]?.percentage).toBeCloseTo(3.1736, 4);

    // ----------------------------------------------------
    // Security
    // ----------------------------------------------------

    expect(result?.security).toBeDefined();

    expect(result?.security?.score).toBe(0);

    expect(result?.security?.riskLevel).toBe("Low Risk");

    expect(result?.security?.ownershipRenounced).toBe(false);

    expect(result?.security?.top10HoldingsBelow30Pct).toBe(true);

    expect(result?.security?.stopMint).toBe(true);

    expect(result?.security?.noBlacklist).toBe(true);
  });

  test("CHADLY signal parsing", () => {
    const result = parseAveScannerSignal(CHADLYSignal);
    console.dir(result, { depth: null, color: true });
    expect(result).not.toBeNull();

    // ----------------------------------------------------
    // Basic
    // ----------------------------------------------------

    expect(result?.Token).toBe("CHADLY");
    expect(result?.CA).toBe("Eg6x4vJi2EMfEbxKaeiTzWNE5CA2JtBjMR9o8EoFpump");

    expect(result?.LP).toBe("Fn6gCmx7SdTwUPVmaVAysLHLZ318FDVpXGssdYUhQGLy");

    // ----------------------------------------------------
    // Market
    // ----------------------------------------------------

    expect(Number(result?.initPriceUSD)).toBeCloseTo(0.0002882);

    expect(Number(result?.marketCapUSD)).toBeCloseTo(267_810);

    expect(result?.LiquidityUSD).toBeCloseTo(2240);

    expect(result?.dex).toBe("Meteoradammv2");

    // ----------------------------------------------------
    // Pair
    // ----------------------------------------------------

    expect(result?.pairTokenAmount).toBeCloseTo(4_140_000);

    expect(result?.pairTokenSymbol).toBe("CHADLY");

    expect(result?.pairSolAmount).toBeCloseTo(14.43);

    // ----------------------------------------------------
    // Statistics
    // ----------------------------------------------------

    expect(result?.Insiders).toBe(133);

    expect(result?.snipes).toBe(3);

    expect(result?.rushers).toBe(0);

    expect(result?.tokenHoldersCount).toBe(10);

    // ----------------------------------------------------
    // Holders
    // ----------------------------------------------------

    expect(result?.tokenHolders).toHaveLength(5);

    expect(result?.tokenHolders?.[0]?.address).toBe(
      "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM",
    );

    expect(result?.tokenHolders?.[0]?.percentage).toBeCloseTo(99.0023, 4);
    expect(result?.tokenHolders?.[4]?.address).toBe(
      "6sp7NRCM3Eotx1QvBwbgT3EMEzP2kzNw3erxb78Q3hrc",
    );
    expect(result?.tokenHolders?.[4]?.percentage).toBeCloseTo(0.008973, 4);

    // ----------------------------------------------------
    // Security
    // ----------------------------------------------------

    expect(result?.security).toBeDefined();

    expect(result?.security?.score).toBe(0);

    expect(result?.security?.riskLevel).toBe("Low Risk");

    expect(result?.security?.ownershipRenounced).toBe(false);

    expect(result?.security?.top10HoldingsBelow30Pct).toBe(true);

    expect(result?.security?.stopMint).toBe(true);

    expect(result?.security?.noBlacklist).toBe(true);
  });

  // ─── Edge cases ───────────────────────────────────────────────────────

  test("should return null for empty input", () => {
    expect(parseAveScannerSignal("")).toBeNull();
  });

  test("should return null for missing CA and LP", () => {
    const text = `Token: TestToken\nInit Price: $0.01\nMCap: $1K\n`;
    expect(parseAveScannerSignal(text)).toBeNull();
  });

  test("should return null for missing LP", () => {
    const text = `Token: TestToken\nCA: FP1GCRkntLdb3EhVSnRzJzqzbS4hyJEgxnnyh8v91Caz\n`;
    expect(parseAveScannerSignal(text)).toBeNull();
  });

  test("should parse signal with no holders listed", () => {
    const text = `Token: TestToken (https://solscan.io/token/FP1GCRkntLdb3EhVSnRzJzqzbS4hyJEgxnnyh8v91Caz)
CA: FP1GCRkntLdb3EhVSnRzJzqzbS4hyJEgxnnyh8v91Caz
LP: 5wGEfoimBhyVb2XTVwxfpqyv5SynyAiNinsj7v6rigvh
Init Price: $0.01003
MCap: $1K
Dex: Pump
Token Holders: 0`;
    const result = parseAveScannerSignal(text);
    expect(result).not.toBeNull();
    expect(result?.tokenHolders).toHaveLength(0);
  });

  test("should parse market cap with K suffix", () => {
    const text = `Token: TestToken (https://solscan.io/token/FP1GCRkntLdb3EhVSnRzJzqzbS4hyJEgxnnyh8v91Caz)
CA: FP1GCRkntLdb3EhVSnRzJzqzbS4hyJEgxnnyh8v91Caz
LP: 5wGEfoimBhyVb2XTVwxfpqyv5SynyAiNinsj7v6rigvh
Init Price: $0.01
MCap: $500K
Dex: Pump`;
    const result = parseAveScannerSignal(text);
    expect(result?.marketCapUSD).toBe(500_000);
  });

  test("should parse market cap with B suffix", () => {
    const text = `Token: TestToken (https://solscan.io/token/FP1GCRkntLdb3EhVSnRzJzqzbS4hyJEgxnnyh8v91Caz)
CA: FP1GCRkntLdb3EhVSnRzJzqzbS4hyJEgxnnyh8v91Caz
LP: 5wGEfoimBhyVb2XTVwxfpqyv5SynyAiNinsj7v6rigvh
Init Price: $0.01
MCap: $1.5B
Dex: Pump`;
    const result = parseAveScannerSignal(text);
    expect(result?.marketCapUSD).toBe(1_500_000_000);
  });

  test("should handle signal without security section", () => {
    const text = `Token: TestToken
CA: FP1GCRkntLdb3EhVSnRzJzqzbS4hyJEgxnnyh8v91Caz
LP: 5wGEfoimBhyVb2XTVwxfpqyv5SynyAiNinsj7v6rigvh
Init Price: $0.01
MCap: $1K
Dex: Pump`;
    const result = parseAveScannerSignal(text);
    expect(result).not.toBeNull();
    expect(result?.CA).toBe("FP1GCRkntLdb3EhVSnRzJzqzbS4hyJEgxnnyh8v91Caz");
  });
});
