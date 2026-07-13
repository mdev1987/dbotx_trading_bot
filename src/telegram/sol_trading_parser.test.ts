import { describe, expect, test } from "bun:test";
import { parseSolTrendingSignal } from "./sol_trading_parser";

const BisonSignal = `
⏺ | The Charging Bison / Bison (https://t.me/hhdksnsksbsixn_jhg)
🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢

🔀 $227.43 (2.962 SOL)
🔀 687,249 SOL
👤 Buyer (https://solscan.io/address/1aDerPKk87xJHCAqTY5bGxF5Xet2MG476y4Zmq2WJ8Y) / TX (https://solscan.io/tx/4BfA3xRqt9AuqgdVns3oiDDTD4T5Q6wLK45JyYNcrcbTBbZ2ZHPodyRuqi743AWKYP32avyMrDyTtYJc3AZPNV6H)
🪙 New Holder
💸 Market Cap $327,707

DexT (https://www.dextools.io/app/en/solana/pair-explorer/6TJuebvz9hqJaybCWpKm7ygmFqcxHxJ3Azi5BJhmHak) | Screener (https://dexscreener.com/solana/6TJuebvz9hqJaybCWpKm7ygmFqcxHxJ3Azi5BJhmHak) | Buy (https://jup.ag/swap/SOL-GwZvGvVzjWTL1mvpw55KQWztTQvWo3B6ew16N2aspump) | Trending (https://t.me/SOLTRENDING/18232821)
`;

const SunnyStreetSignal = `
🥈 | Sunny Street  / SUNNYS (https://t.me/oyashake_body)
🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢

🔀 $220.90 (2.877 SOL)
🔀 251,220 SOL
👤 Buyer (https://solscan.io/address/B75cQo69cENrwgkfxTHPmRWf4GyhXoqBTzNxvBEnAtS3) / TX (https://solscan.io/tx/2gFgBABuoGvBkqMsmVA5MdaZhopJk7sHPmtG5ffMubakVJtTcNUV21bE8LtD5SUSBVNKKUph1vS91A3tS7ynPkm)
🪙 Position +86%
💸 Market Cap $874,105

DexT (https://www.dextools.io/app/en/solana/pair-explorer/323MZ6ovqVfNhZUgFTPjzxXRovGZ6fdy4bCd5ZuUmjJS) | Screener (https://dexscreener.com/solana/323MZ6ovqVfNhZUgFTPjzxXRovGZ6fdy4bCd5ZuUmjJS) | Buy (https://jup.ag/swap/SOL-Ch1vdFT6dVmkVLbJkBXGBv8iyhWv9ik1C45cYNsFpump) | Trending (https://t.me/SOLTRENDING/18232821)
`;

const CupseySignal = `
⏺ | Cupsey / Cupsey (https://t.me/xixicat_erc)
🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢

🔀 $248.59 (3.237 SOL)
🔀 63,038 SOL
👤 Buyer (https://solscan.io/address/4MxcUVYN4CrgTr8fCqJpS2UdJRwPQAKHU2AYJkQu66o2) / TX (https://solscan.io/tx/2RkpcQiL855Nj7w2izro6smExRt55vzGJ1kBzAUeEHuG5oxbrwCw7ysTEEupBcWPLaZrs7tg47VjBdw9GCw8WC7b)
🪙 Position +16%
💸 Market Cap $3,934,291

DexT (https://www.dextools.io/app/en/solana/pair-explorer/DPzKoJVewaH1wpchD3gWKeeGm7G2mXkBW48uRniAgbVx) | Screener (https://dexscreener.com/solana/DPzKoJVewaH1wpchD3gWKeeGm7G2mXkBW48uRniAgbVx) | Buy (https://jup.ag/swap/SOL-6NwarBvDkXhByqVp2Qkq5i9XbtA2B3Bwe8SWGu9vpump) | Trending (https://t.me/SOLTRENDING/18232821)
`;

describe("SolTrading Parser", () => {
  test("should parse a complete new holder signal", () => {
    const result = parseSolTrendingSignal(BisonSignal);
    expect(result).not.toBeNull();

    expect(result?.Token).toBe("The Charging Bison");
    expect(result?.CA).toBe("GwZvGvVzjWTL1mvpw55KQWztTQvWo3B6ew16N2aspump");
    expect(result?.LP).toBe("6TJuebvz9hqJaybCWpKm7ygmFqcxHxJ3Azi5BJhmHak");
    expect(result?.initPriceUSD).toBe(227.43);
    expect(result?.marketCapUSD).toBe(327_707);
    expect(result?.dex).toBe("Pump");
  });

  test("should parse a signal with silver rank and position PnL", () => {
    const result = parseSolTrendingSignal(SunnyStreetSignal);
    expect(result).not.toBeNull();

    expect(result?.Token).toBe("Sunny Street");
    expect(result?.CA).toBe("Ch1vdFT6dVmkVLbJkBXGBv8iyhWv9ik1C45cYNsFpump");
    expect(result?.LP).toBe("323MZ6ovqVfNhZUgFTPjzxXRovGZ6fdy4bCd5ZuUmjJS");
    expect(result?.initPriceUSD).toBe(220.90);
    expect(result?.marketCapUSD).toBe(874_105);
    expect(result?.dex).toBe("Pump");
  });

  test("should parse a signal with same name and ticker", () => {
    const result = parseSolTrendingSignal(CupseySignal);
    expect(result).not.toBeNull();

    expect(result?.Token).toBe("Cupsey");
    expect(result?.CA).toBe("6NwarBvDkXhByqVp2Qkq5i9XbtA2B3Bwe8SWGu9vpump");
    expect(result?.LP).toBe("DPzKoJVewaH1wpchD3gWKeeGm7G2mXkBW48uRniAgbVx");
    expect(result?.initPriceUSD).toBe(248.59);
    expect(result?.marketCapUSD).toBe(3_934_291);
    expect(result?.dex).toBe("Pump");
  });

  test("should return null for non-SOLTRENDING message", () => {
    const result = parseSolTrendingSignal("Some random message");
    expect(result).toBeNull();
  });

  test("should return null for message without Buy link", () => {
    const result = parseSolTrendingSignal(`
⏺ | Test / TEST (https://t.me/xxx)
🟢🟢

🔀 $100.00 (1.0 SOL)
🔀 100 SOL
🪙 New Holder
💸 Market Cap $100,000
    `);
    expect(result).toBeNull();
  });

  test("should return null for empty string", () => {
    expect(parseSolTrendingSignal("")).toBeNull();
  });

  test("should return null for message without header match", () => {
    expect(parseSolTrendingSignal("Some random text without the expected format")).toBeNull();
  });

  test("should handle missing market cap line gracefully", () => {
    const signal = `
⏺ | TestCoin / TEST (https://t.me/test)
🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢

🔀 $100.00 (1.0 SOL)
👤 Buyer (https://solscan.io/address/abc) / TX (https://solscan.io/tx/abc)
🪙 New Holder

DexT (https://www.dextools.io/app/en/solana/pair-explorer/abc) | Screener (https://dexscreener.com/solana/abc) | Buy (https://jup.ag/swap/SOL-TestCoin123456789012345678901234567890123) | Trending (https://t.me/SOLTRENDING/123)
    `;
    const result = parseSolTrendingSignal(signal);
    expect(result).not.toBeNull();
    expect(result?.marketCapUSD).toBe(0);
  });

  test("should handle bronze rank emoji", () => {
    const signal = `
🥉 | BronzeCoin / BRONZE (https://t.me/bronze)
🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢

🔀 $50.00 (0.5 SOL)
🔀 100 SOL
👤 Buyer (https://solscan.io/address/abc) / TX (https://solscan.io/tx/abc)
🪙 New Holder
💸 Market Cap $50,000

DexT (https://www.dextools.io/app/en/solana/pair-explorer/abc) | Screener (https://dexscreener.com/solana/abc) | Buy (https://jup.ag/swap/SOL-BronzeCoin1234567890123456789012345678901) | Trending (https://t.me/SOLTRENDING/123)
    `;
    const result = parseSolTrendingSignal(signal);
    expect(result).not.toBeNull();
    expect(result?.Token).toBe("BronzeCoin");
  });

  test("should handle CA not ending in pump as Unknown dex", () => {
    const signal = `
⏺ | NonPump / NOPUMP (https://t.me/nopump)
🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢

🔀 $100.00 (1.0 SOL)
🔀 100 SOL
👤 Buyer (https://solscan.io/address/abc) / TX (https://solscan.io/tx/abc)
🪙 New Holder
💸 Market Cap $100,000

DexT (https://www.dextools.io/app/en/solana/pair-explorer/abc) | Screener (https://dexscreener.com/solana/abc) | Buy (https://jup.ag/swap/SOL-NonPumpTokenCA1234567890123456789012345678) | Trending (https://t.me/SOLTRENDING/123)
    `;
    const result = parseSolTrendingSignal(signal);
    expect(result).not.toBeNull();
    expect(result?.dex).toBe("Unknown");
  });
});
