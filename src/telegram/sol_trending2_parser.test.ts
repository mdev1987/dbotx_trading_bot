import { describe, expect, test } from "bun:test";
import { parseTrendingssolSignal } from "./sol_trending2_parser";

const PurplePepeSignal = `
SOL TRENDING: Purple Pepe (https://t.me/Purpe_SOL) Buy!
🟪🟪🟪🟪🟪🟪🟪🟪🟪🟪🟪

🔀 0.686 SOL ($53)
🔀 5 089 079.5 PURPE
👤 6U91aK...2tbB (https://solscan.io/address/6U91aKa8pmMxkJwBCfPTmUEfZi6dHe7DcFq2ALvB2tbB) | Txn (https://solscan.io/tx/4jGWjxN3w8hhJkg9swXaQ1yY4QMzDpPA1H3QPMmXkQpxtC6HPDjhqGARNoyhkNbfCwRzoqPraHiBzzaCHDpXfM1B)
⬆️ Position: >1000% Up!
💸 Market Cap $4 385 730

📈 Chart (https://dexscreener.com/solana/HBoNJ5v8g71s2boRivrHnfSB5MVPLDHHyVjruPfhGkvL)   ⏫ Trending (https://t.me/trendingssol)   ✳️ Events (https://t.me/trendingsevents)

🟣 | SOL TRENDING #11 (https://t.me/trendingssol/6935507)
`;

const TungTungSignal = `
SOL TRENDING: Tung Tung Tung Sahur (https://t.me/TripleTCommunity) Buy!
🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵

🔀 8.3 SOL ($641.95)
🔀 30 454.941 TripleT
👤 H1pYtE...yZ2r (https://solscan.io/address/H1pYtEBenia2JGy1vykoA7hs4tob7ym6d6VUUCXVyZ2r) | Txn (https://solscan.io/tx/5fBoiGCTNVDgxygzwMkj1UvpxqwBrUo6p9SH8vxKGfAMGwJ5Hfvy7aTCbL6jimPFjHK525UuEhYKhVdcaXH4WQEa)
⬆️ New Holder!
💸 Market Cap $21 077 382

📈 Chart (https://dexscreener.com/solana/J8PSdNP3QewKq2Z1JJJFDMaqF7KcaiJhR7gbr5KZpump)   ⏫ Trending (https://t.me/trendingssol)   ✳️ Events (https://t.me/trendingsevents)

🟣 | SOL TRENDING #1 (https://t.me/trendingssol/6935507)
`;

const JotchuaSignal = `
SOL TRENDING: Jotchua (https://t.me/Jotchua_USDC) Buy!
🟢

🔀 98.6 USDC ($98.6)
🔀 26 396.201 Jotchua
👤 GfocQ4...EqsA (https://solscan.io/address/GfocQ4pJgTHrWdZeiEmbqsJqHfpsfVQKs8sfBEYTEqsA) | Txn (https://solscan.io/tx/64V3M59DEvy59sFx5mJmZHYzbvXAQaZGM7mKUbsh1wk552BjvEjYgQrjeQTvAAR9B2W1F6XxT4LtBL5LkWRMzbwQ)
⬆️ Position: 3% Up!
💸 Market Cap $3 734 738

📈 Chart (https://dexscreener.com/solana/BcHEaaTCvycPwwsJ9yQTXdHP9X2gCLkznDbZ8VySpump)   ⏫ Trending (https://t.me/trendingssol)   ✳️ Events (https://t.me/trendingsevents)

🟣 | SOL TRENDING #2 (https://t.me/trendingssol/6935507)
`;

const ShibwifhatSignal = `
SOL TRENDING: shibwifhat (https://t.me/Shibwifhat_Dogwifhatkiller) Buy!
🐂🐂🐂🐂🐂🐂🐂🐂🐂🐂🐂🐂🐂🐂🐂🐂🐂🐂🐂🐂🐂🐂🐂🐂🐂🐂🐂🐂🐂🐂🐂🐂🐂🐂🐂🐂

🔀 2.2 SOL ($168.28)
🔀 199 644.381 SHIB
👤 H4AnVH...aCkg (https://solscan.io/address/H4AnVHn5ZjUQ7paoDkWSSD4T5Bqfb4AbKoXQxfCPaCkg) | Txn (https://solscan.io/tx/5fDBZHKgKg3i3JyfYvtmNpPwwSrdzEZp82QR1vvK9wcjGi2X1BFejdER4NzJSPRUbcd16MmdLdt3yAWZ5kV4Qzkw)
⬆️ Position: 71% Up!
💲 SHIB Price: $0.0008429
💸 Market Cap $826 019

📈 Chart (https://dexscreener.com/solana/F6qoefQq4iCBLoNZ34RjEqHjHkD8vtmoRSdw9Nd55J1k)   ⏫ Trending (https://t.me/trendingssol)   ✳️ Events (https://t.me/trendingsevents)

🟣 | SOL TRENDING #16 (https://t.me/trendingssol/6935507)
`;

describe("Trendingssol Parser", () => {
  test("should parse a signal with spaces in market cap", () => {
    const result = parseTrendingssolSignal(PurplePepeSignal);
    expect(result).not.toBeNull();

    expect(result?.Token).toBe("Purple Pepe");
    expect(result?.CA).toBe("HBoNJ5v8g71s2boRivrHnfSB5MVPLDHHyVjruPfhGkvL");
    expect(result?.LP).toBe("HBoNJ5v8g71s2boRivrHnfSB5MVPLDHHyVjruPfhGkvL");
    expect(result?.marketCapUSD).toBe(4_385_730);
    expect(result?.dex).toBe("Unknown");
  });

  test("should parse a signal with pump pair and large market cap", () => {
    const result = parseTrendingssolSignal(TungTungSignal);
    expect(result).not.toBeNull();

    expect(result?.Token).toBe("Tung Tung Tung Sahur");
    expect(result?.CA).toBe("J8PSdNP3QewKq2Z1JJJFDMaqF7KcaiJhR7gbr5KZpump");
    expect(result?.LP).toBe("J8PSdNP3QewKq2Z1JJJFDMaqF7KcaiJhR7gbr5KZpump");
    expect(result?.marketCapUSD).toBe(21_077_382);
    expect(result?.dex).toBe("Pump");
  });

  test("should parse a USDC buy signal", () => {
    const result = parseTrendingssolSignal(JotchuaSignal);
    expect(result).not.toBeNull();

    expect(result?.Token).toBe("Jotchua");
    expect(result?.CA).toBe("BcHEaaTCvycPwwsJ9yQTXdHP9X2gCLkznDbZ8VySpump");
    expect(result?.marketCapUSD).toBe(3_734_738);
    expect(result?.dex).toBe("Pump");
  });

  test("should parse a signal with price line and small market cap", () => {
    const result = parseTrendingssolSignal(ShibwifhatSignal);
    expect(result).not.toBeNull();

    expect(result?.Token).toBe("shibwifhat");
    expect(result?.CA).toBe("F6qoefQq4iCBLoNZ34RjEqHjHkD8vtmoRSdw9Nd55J1k");
    expect(result?.marketCapUSD).toBe(826_019);
    expect(result?.initPriceUSD).toBeCloseTo(0.0008429, 10);
  });

  test("should return null for non-trendingssol message", () => {
    const result = parseTrendingssolSignal("Some random message");
    expect(result).toBeNull();
  });

  test("should return null for message without Chart link", () => {
    const result = parseTrendingssolSignal(`
SOL TRENDING: Test (https://t.me/xxx) Buy!
🟢

⬆️ New Holder!
💸 Market Cap $100 000
    `);
    expect(result).toBeNull();
  });
});
