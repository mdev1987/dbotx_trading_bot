import { describe, expect, test } from "bun:test";
import {
  expandCompressedDecimal,
  parseAbbreviatedUsd,
  parseAveScannerSignal,
} from "./ave_scanner_parser";

// ============================================================
// Helper: expandCompressedDecimal
// ============================================================

describe("expandCompressedDecimal", () => {
  test("plain number — no compression", () => {
    expect(expandCompressedDecimal("0.02236")).toBe(0.02236);
  });

  test("plain integer without decimal", () => {
    expect(expandCompressedDecimal("123")).toBe(123);
  });

  test("compressed 0.0{4}8121", () => {
    expect(expandCompressedDecimal("0.0{4}8121")).toBe(0.00008121);
  });

  test("compressed 0.0{5}2342", () => {
    expect(expandCompressedDecimal("0.0{5}2342")).toBe(0.000002342);
  });

  test("compressed 0.0{5}822", () => {
    expect(expandCompressedDecimal("0.0{5}822")).toBe(0.00000822);
  });

  test("compressed 0.0{5}2525", () => {
    expect(expandCompressedDecimal("0.0{5}2525")).toBe(0.000002525);
  });

  test("strips dollar sign and whitespace", () => {
    expect(expandCompressedDecimal("$ 0.0{4}1234")).toBe(0.00001234);
  });

  test("strips percentage sign", () => {
    expect(expandCompressedDecimal("98.6775%")).toBe(98.6775);
  });

  test("strips comma", () => {
    expect(expandCompressedDecimal("1,234.56")).toBe(1234.56);
  });
});

// ============================================================
// Helper: parseAbbreviatedUsd
// ============================================================

describe("parseAbbreviatedUsd", () => {
  test("K suffix — 81.10K", () => {
    expect(parseAbbreviatedUsd("81.10K")).toBe(81100);
  });

  test("M suffix — 9.99M", () => {
    expect(parseAbbreviatedUsd("9.99M")).toBe(9_990_000);
  });

  test("B suffix — 1.5B", () => {
    expect(parseAbbreviatedUsd("1.5B")).toBe(1_500_000_000);
  });

  test("plain number — no suffix", () => {
    expect(parseAbbreviatedUsd("7.11")).toBe(7.11);
  });

  test("strips dollar sign", () => {
    expect(parseAbbreviatedUsd("$81.10K")).toBe(81100);
  });

  test("strips commas and spaces", () => {
    expect(parseAbbreviatedUsd("$ 1,234.56K")).toBe(1_234_560);
  });

  test("lowercase suffix", () => {
    expect(parseAbbreviatedUsd("81.10k")).toBe(81100);
  });

  test("rounds to integer for K suffix", () => {
    expect(parseAbbreviatedUsd("13.22K")).toBe(13220);
  });

  test("rounds to integer for M suffix", () => {
    expect(parseAbbreviatedUsd("2.07M")).toBe(2_070_000);
  });
});

// ============================================================
// Signal test messages (9 unique real signals, 10 total including duplicate)
// ============================================================

const FREEDOM_SIGNAL = `💠 New Solana Pool Launched 💠

Token: FREEDOM (https://solscan.io/token/43zZbtUcK6adgsLDzb774RDNKyBWgmrfHHWkjfnuTesg)
CA: 43zZbtUcK6adgsLDzb774RDNKyBWgmrfHHWkjfnuTesg
LP: DUvzBmVH5KPSPJp79v4ZAPcZ8o2d8VbzESssgs4JcKNb

Init Price: $0.0{4}8121
MCap: $81.10K
Pair: 9.99M FREEDOM / 9.97 SOL
Dex: Meteoradammv2
Liquidity: $1.62K
Insiders: 0(Holdings 0%)
SNIPES: 1  RUSHERS: 0
Token Holders: 10 🐸🐸
    |_2LMYfG5PgPy1iD3gzMo1CpYwnDTeVxj7GdYPoU4ktmzc (https://solscan.io/account/2LMYfG5PgPy1iD3gzMo1CpYwnDTeVxj7GdYPoU4ktmzc) 98.6775%
    |_HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC (https://solscan.io/account/HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC) 0.999%
    |_FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM (https://solscan.io/account/FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM) 0.2495%
    |_TVYFekmzdo3aFWQfUrvzxLEVX595CPpQrVMGjEe2Ca4 (https://solscan.io/account/TVYFekmzdo3aFWQfUrvzxLEVX595CPpQrVMGjEe2Ca4) 0.0222%
    |_63wDyoJ84rGY1bP9vpHYPxr1B4ahFLHCckVTR1nYZ8gY (https://solscan.io/account/63wDyoJ84rGY1bP9vpHYPxr1B4ahFLHCckVTR1nYZ8gY) 0.008853%
Security: Score: 0(🟢Low Risk)    
|_LP Burned: 100%|Ownership Renounced:❌|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅

Check (https://ave.ai/check/43zZbtUcK6adgsLDzb774RDNKyBWgmrfHHWkjfnuTesg-solana?type=token) | Website (https://ave.ai/) | App (https://ave.ai/download) | Community (https://t.me/aveai_english) | Twitter (https://x.com/aveaiofficial)`;

const TURHOD_SIGNAL = `💠 New Solana Pool Launched 💠

Token: TURHOD (https://solscan.io/token/GEH927gg6MDuukRGrFVzekFaLBdwmDvKzQhGd3pasdLq)
CA: GEH927gg6MDuukRGrFVzekFaLBdwmDvKzQhGd3pasdLq
LP: 5ZJRb9AQshV8oMNdbgpb7b7jHv3GS7Q9SanTD8Gi7K7J

Init Price: $0.0{5}2342
MCap: $4.78K
Pair: 981.73M TURHOD / 0.52 SOL
Dex: Pump
Liquidity: $2.38K
Insiders: 0(Holdings 0%)
SNIPES: 1  RUSHERS: 0
Token Holders: 4 🐸
    |_BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s (https://solscan.io/account/BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s) 50.4424%
    |_5ZJRb9AQshV8oMNdbgpb7b7jHv3GS7Q9SanTD8Gi7K7J (https://solscan.io/account/5ZJRb9AQshV8oMNdbgpb7b7jHv3GS7Q9SanTD8Gi7K7J) 49.4918%
    |_8obQkw6VVAiDmitLSmcBppi6b8e9mcPJSAq9sJTDvk2U (https://solscan.io/account/8obQkw6VVAiDmitLSmcBppi6b8e9mcPJSAq9sJTDvk2U) 0.06581%
    |_6QRjmgpxn41ABXbmuJA2BMMUzL6hJiE5Yu63XA6G98mL (https://solscan.io/account/6QRjmgpxn41ABXbmuJA2BMMUzL6hJiE5Yu63XA6G98mL) 0%
Security: Score: 0(🟢Low Risk)    
|_Ownership Renounced:❌|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅

Check (https://ave.ai/check/GEH927gg6MDuukRGrFVzekFaLBdwmDvKzQhGd3pasdLq-solana?type=token) | Website (https://ave.ai/) | App (https://ave.ai/download) | Community (https://t.me/aveai_english) | Twitter (https://x.com/aveaiofficial) | Pump.fun (https://pump.fun/)`;

// TURHOD #2 — identical CA/LP but different SNIPES count (tests dedup proof)
const TURHOD_SIGNAL_2 = `💠 New Solana Pool Launched 💠

Token: TURHOD (https://solscan.io/token/GEH927gg6MDuukRGrFVzekFaLBdwmDvKzQhGd3pasdLq)
CA: GEH927gg6MDuukRGrFVzekFaLBdwmDvKzQhGd3pasdLq
LP: 5ZJRb9AQshV8oMNdbgpb7b7jHv3GS7Q9SanTD8Gi7K7J

Init Price: $0.0{5}2342
MCap: $4.78K
Pair: 981.73M TURHOD / 0.52 SOL
Dex: Pump
Liquidity: $2.38K
Insiders: 0(Holdings 0%)
SNIPES: 2  RUSHERS: 0
Token Holders: 4 🐸
    |_BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s (https://solscan.io/account/BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s) 50.4424%
    |_5ZJRb9AQshV8oMNdbgpb7b7jHv3GS7Q9SanTD8Gi7K7J (https://solscan.io/account/5ZJRb9AQshV8oMNdbgpb7b7jHv3GS7Q9SanTD8Gi7K7J) 49.4918%
    |_8obQkw6VVAiDmitLSmcBppi6b8e9mcPJSAq9sJTDvk2U (https://solscan.io/account/8obQkw6VVAiDmitLSmcBppi6b8e9mcPJSAq9sJTDvk2U) 0.06581%
    |_6QRjmgpxn41ABXbmuJA2BMMUzL6hJiE5Yu63XA6G98mL (https://solscan.io/account/6QRjmgpxn41ABXbmuJA2BMMUzL6hJiE5Yu63XA6G98mL) 0%
Security: Score: 0(🟢Low Risk)    
|_Ownership Renounced:❌|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅

Check (https://ave.ai/check/GEH927gg6MDuukRGrFVzekFaLBdwmDvKzQhGd3pasdLq-solana?type=token) | Website (https://ave.ai/) | App (https://ave.ai/download) | Community (https://t.me/aveai_english) | Twitter (https://x.com/aveaiofficial) | Pump.fun (https://pump.fun/)`;

const THREE301_SIGNAL = `💠 New Solana Pool Launched 💠

Token: 3301 (https://solscan.io/token/9b6mdTtYMr19KNMfLqhCboxnfaJqq5EmDNXDpaKoVwhX)
CA: 9b6mdTtYMr19KNMfLqhCboxnfaJqq5EmDNXDpaKoVwhX
LP: re42KQiVewDvJ8NdNoCeogG1zMa1cAzLcRmqNNbocNn

Init Price: $0.0{4}4216
MCap: $42.16K
Pair: 23.14M 3301 / 11.03 SOL
Dex: Meteora
Liquidity: $1.87K
Insiders: 0(Holdings 0%)
SNIPES: 1  RUSHERS: 0
Token Holders: 88 🐸🐸🐸🐸🐸🐸🐸🐸🐸
    |_FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM (https://solscan.io/account/FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM) 95.0039%
    |_EntDfNszv9Bbq1SiuFpUYYtKWTjDj8SVo97TFs2ZxXqz (https://solscan.io/account/EntDfNszv9Bbq1SiuFpUYYtKWTjDj8SVo97TFs2ZxXqz) 2.3141%
    |_Hy4uDbUJGV8EcvDNErQiJyjPuiWQsvzHpuTp979awDU5 (https://solscan.io/account/Hy4uDbUJGV8EcvDNErQiJyjPuiWQsvzHpuTp979awDU5) 0.2103%
    |_Cz9E89v6bHqvXZ3edmwwZy8T6H9kxQmbEtrr69PYgHqL (https://solscan.io/account/Cz9E89v6bHqvXZ3edmwwZy8T6H9kxQmbEtrr69PYgHqL) 0.1421%
    |_92y5nduNVfyzz6UeA5UaE9zriP4Cq6DZXJngcd9PutHc (https://solscan.io/account/92y5nduNVfyzz6UeA5UaE9zriP4Cq6DZXJngcd9PutHc) 0.1186%
Security: Score: 0(🟢Low Risk)    
|_Ownership Renounced:❌|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅

Check (https://ave.ai/check/9b6mdTtYMr19KNMfLqhCboxnfaJqq5EmDNXDpaKoVwhX-solana?type=token) | Website (https://ave.ai/) | App (https://ave.ai/download) | Community (https://t.me/aveai_english) | Twitter (https://x.com/aveaiofficial)`;

const REPEAT_SIGNAL = `💠 New Solana Pool Launched 💠

Token: repeat (https://solscan.io/token/7mjgFhFCEApWzipKVLqBEwH9W612UF55SDPVGbo8x9p8)
CA: 7mjgFhFCEApWzipKVLqBEwH9W612UF55SDPVGbo8x9p8
LP: ofbworWmUjKydcT2CYesKM8wkGYEMsb1FFe64gnKe9f

Init Price: $0.0{4}8113
MCap: $81.19K
Pair: 9.98M repeat / 9.98 SOL
Dex: Meteoradammv2
Liquidity: $1.61K
Insiders: 1(Holdings 0%)
SNIPES: 2  RUSHERS: 0
Token Holders: 12 🐸🐸
    |_6MHjZncpMK5sPw1Nb1iL7kP4N2HakYfdGaqRAESdsjKS (https://solscan.io/account/6MHjZncpMK5sPw1Nb1iL7kP4N2HakYfdGaqRAESdsjKS) 98.6775%
    |_HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC (https://solscan.io/account/HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC) 0.9967%
    |_FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM (https://solscan.io/account/FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM) 0.2495%
    |_5VpTB7a4ZWYU3xg72ey9GYCYmdKRdC54VeEqsTiVdazj (https://solscan.io/account/5VpTB7a4ZWYU3xg72ey9GYCYmdKRdC54VeEqsTiVdazj) 0.02023%
    |_Hcow5HoNHAGdrbrXEZ3gCLHn5rEfgPNJcf4t11cgWaP3 (https://solscan.io/account/Hcow5HoNHAGdrbrXEZ3gCLHn5rEfgPNJcf4t11cgWaP3) 0.01689%
Security: Score: 0(🟢Low Risk)    
|_Ownership Renounced:❌|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅

Check (https://ave.ai/check/7mjgFhFCEApWzipKVLqBEwH9W612UF55SDPVGbo8x9p8-solana?type=token) | Website (https://ave.ai/) | App (https://ave.ai/download) | Community (https://t.me/aveai_english) | Twitter (https://x.com/aveaiofficial)`;

const FROGCOIN_SIGNAL = `💠 New Solana Pool Launched 💠

Token: FROGCOIN (https://solscan.io/token/BVi5CgmASpMyksezCx5dgPv9JLhTAMv845QYtdaqpump)
CA: BVi5CgmASpMyksezCx5dgPv9JLhTAMv845QYtdaqpump
LP: Gqf4YDqMKs5A2tckJPtHam5jZDDeMEuURANbwbG2GNxY

Init Price: $0.0{5}2525
MCap: $3.59K
Pair: 850.94M FROGCOIN / 4.84 SOL
Dex: Pump
Liquidity: $3.00K
Insiders: 0(Holdings 0%)
SNIPES: 10  RUSHERS: 0
Token Holders: 10 🐸🐸
    |_Gqf4YDqMKs5A2tckJPtHam5jZDDeMEuURANbwbG2GNxY (https://solscan.io/account/Gqf4YDqMKs5A2tckJPtHam5jZDDeMEuURANbwbG2GNxY) 59.69%
    |_niggerd597QYedtvjQDVHZTCCGyJrwHNm2i49dkm5zS (https://solscan.io/account/niggerd597QYedtvjQDVHZTCCGyJrwHNm2i49dkm5zS) 6.6786%
    |_Bi4rd5FH5bYEN8scZ7wevxNZyNmKHdaBcvewdPFxYdLt (https://solscan.io/account/Bi4rd5FH5bYEN8scZ7wevxNZyNmKHdaBcvewdPFxYdLt) 5.9028%
    |_A1Jy9SccXYdVjeYFuf32pKxWWUiyyXgqkZANMxQxcRXA (https://solscan.io/account/A1Jy9SccXYdVjeYFuf32pKxWWUiyyXgqkZANMxQxcRXA) 5.6512%
    |_B4JXfczBjeSeSHdNCyJjcy6cnEhveLbvfhdKwwWEUSKy (https://solscan.io/account/B4JXfczBjeSeSHdNCyJjcy6cnEhveLbvfhdKwwWEUSKy) 4.726%
Security: Score: 0(🟢Low Risk)    
|_Ownership Renounced:❌|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅

Check (https://ave.ai/check/BVi5CgmASpMyksezCx5dgPv9JLhTAMv845QYtdaqpump-solana?type=token) | Website (https://ave.ai/) | App (https://ave.ai/download) | Community (https://t.me/aveai_english) | Twitter (https://x.com/aveaiofficial) | Pump.fun (https://pump.fun/)`;

const MONIKA_SIGNAL = `💠 New Solana Pool Launched 💠

Token: MONIKA (https://solscan.io/token/tJT1cMW2EQnaS7yv373AomvCM2SPbtqH8xX7G6Upump)
CA: tJT1cMW2EQnaS7yv373AomvCM2SPbtqH8xX7G6Upump
LP: AnfWAnjeGTiThn8T2s1xfsuCeVeJYb31zTdxK2woyfKL

Init Price: $0.0{5}2301
MCap: $4.04K
Pair: 997.64M MONIKA / 0.07 SOL
Dex: Pump
Liquidity: $2.31K
Insiders: 0(Holdings 0%)
SNIPES: 2  RUSHERS: 0
Token Holders: 4 🐸
    |_BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s (https://solscan.io/account/BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s) 49.9955%
    |_AnfWAnjeGTiThn8T2s1xfsuCeVeJYb31zTdxK2woyfKL (https://solscan.io/account/AnfWAnjeGTiThn8T2s1xfsuCeVeJYb31zTdxK2woyfKL) 49.8649%
    |_3JxEWK4PUqGkzXhQR5MzwT3ocSoXLLfVEVHeiHH33yGL (https://solscan.io/account/3JxEWK4PUqGkzXhQR5MzwT3ocSoXLLfVEVHeiHH33yGL) 0.08941%
    |_8obQkw6VVAiDmitLSmcBppi6b8e9mcPJSAq9sJTDvk2U (https://solscan.io/account/8obQkw6VVAiDmitLSmcBppi6b8e9mcPJSAq9sJTDvk2U) 0.05016%
Security: Score: 0(🟢Low Risk)    
|_Ownership Renounced:❌|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅

Check (https://ave.ai/check/tJT1cMW2EQnaS7yv373AomvCM2SPbtqH8xX7G6Upump-solana?type=token) | Website (https://ave.ai/) | App (https://ave.ai/download) | Community (https://t.me/aveai_english) | Twitter (https://x.com/aveaiofficial) | Pump.fun (https://pump.fun/)`;

const PEACE_SIGNAL = `💠 New Solana Pool Launched 💠

Token: PEACE (https://solscan.io/token/J3rYaFXfJDLx8M2A9RU1m4RGLjHufqpMXufVMad4nSG3)
CA: J3rYaFXfJDLx8M2A9RU1m4RGLjHufqpMXufVMad4nSG3
LP: 5SkiM1QQ3ZGQut16vPSwKfiC3WJrtFgJoQ5T8DxFVA3o

Init Price: $0.0{5}822
MCap: $7.11
Pair: 1000.00M PEACE / 99.00 SOL
Dex: Pumpfunamm
Liquidity: $13.10K
Insiders: 1(Holdings 0%)
SNIPES: 1  RUSHERS: 0
Token Holders: 10 🐸🐸
    |_5SkiM1QQ3ZGQut16vPSwKfiC3WJrtFgJoQ5T8DxFVA3o (https://solscan.io/account/5SkiM1QQ3ZGQut16vPSwKfiC3WJrtFgJoQ5T8DxFVA3o) 98.0511%
    |_8CJb3xxgwiHo6wPQeNU6QuWAfdziRopCkwsoKh1Nw5aJ (https://solscan.io/account/8CJb3xxgwiHo6wPQeNU6QuWAfdziRopCkwsoKh1Nw5aJ) 1.9475%
    |_G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP (https://solscan.io/account/G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP) 0.0004883%
    |_A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW (https://solscan.io/account/A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW) 0.0004883%
    |_GjP2f5MM2sRKTvu8CpNxbgNWuKfS88xdevKRz32nne5s (https://solscan.io/account/GjP2f5MM2sRKTvu8CpNxbgNWuKfS88xdevKRz32nne5s) 0.0004876%
Security: Score: 0(🟢Low Risk)    
|_Ownership Renounced:❌|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅

Check (https://ave.ai/check/J3rYaFXfJDLx8M2A9RU1m4RGLjHufqpMXufVMad4nSG3-solana?type=token) | Website (https://ave.ai/) | App (https://ave.ai/download) | Community (https://t.me/aveai_english) | Twitter (https://x.com/aveaiofficial)`;

const BREDOG_SIGNAL = `💠 New Solana Pool Launched 💠

Token: BREDOG (https://solscan.io/token/GK6UVoog9s7B9V5bY7ys5yWpBZcgFvJeCa4bs5C4mwnj)
CA: GK6UVoog9s7B9V5bY7ys5yWpBZcgFvJeCa4bs5C4mwnj
LP: F2bZ3B93mfiUzqL4oRCo2QxuoAzFKCSFtHQmUdM7aB9c

Init Price: $0.0{5}2334
MCap: $4.76K
Pair: 982.41M BREDOG / 0.50 SOL
Dex: Pump
Liquidity: $2.33K
Insiders: 0(Holdings 0%)
SNIPES: 1  RUSHERS: 0
Token Holders: 3 🐸
    |_BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s (https://solscan.io/account/BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s) 50.2529%
    |_F2bZ3B93mfiUzqL4oRCo2QxuoAzFKCSFtHQmUdM7aB9c (https://solscan.io/account/F2bZ3B93mfiUzqL4oRCo2QxuoAzFKCSFtHQmUdM7aB9c) 48.8676%
    |_6QRjmgpxn41ABXbmuJA2BMMUzL6hJiE5Yu63XA6G98mL (https://solscan.io/account/6QRjmgpxn41ABXbmuJA2BMMUzL6hJiE5Yu63XA6G98mL) 0.8795%
Security: Score: 0(🟢Low Risk)    
|_Ownership Renounced:❌|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅

Check (https://ave.ai/check/GK6UVoog9s7B9V5bY7ys5yWpBZcgFvJeCa4bs5C4mwnj-solana?type=token) | Website (https://ave.ai/) | App (https://ave.ai/download) | Community (https://t.me/aveai_english) | Twitter (https://x.com/aveaiofficial) | Pump.fun (https://pump.fun/)`;

const EBAIDS_SIGNAL = `💠 New Solana Pool Launched 💠

Token: EBAIDS (https://solscan.io/token/DA5auNe9kpQWirSSULuE2oTh6jRefmTRKhqsCxchpump)
CA: DA5auNe9kpQWirSSULuE2oTh6jRefmTRKhqsCxchpump
LP: 8JTwaL3tyneyA4maszRsqJaiv3vYYBwp9Rgea4VixAhM

Init Price: $0.02236
MCap: $21.36K
Pair: 747.91K EBAIDS / 229.73 SOL
Dex: Pumpfunamm
Liquidity: $37.17K
Insiders: 1(Holdings 0%)
SNIPES: 3  RUSHERS: 0
Token Holders: 10 🐸🐸
    |_8JTwaL3tyneyA4maszRsqJaiv3vYYBwp9Rgea4VixAhM (https://solscan.io/account/8JTwaL3tyneyA4maszRsqJaiv3vYYBwp9Rgea4VixAhM) 83.2315%
    |_EPXV8yp4wmWYa63xWg4UEev2sFz4ipTtRAJSfJHYUvC2 (https://solscan.io/account/EPXV8yp4wmWYa63xWg4UEev2sFz4ipTtRAJSfJHYUvC2) 2.7582%
    |_5vLitQtq8CvFd3nztZNHXJh9uadGRWqkAYtjos6cG1Tq (https://solscan.io/account/5vLitQtq8CvFd3nztZNHXJh9uadGRWqkAYtjos6cG1Tq) 2.3504%
    |_4WSxc284PKGiS7br5RkgZe3fHDkp2sWtJ5Hoc1zf6fWb (https://solscan.io/account/4WSxc284PKGiS7br5RkgZe3fHDkp2sWtJ5Hoc1zf6fWb) 2.3229%
    |_J1ssdnk72fGZuXkBAw6PMEnwWfnbb3Udqz5JcFuZ66wj (https://solscan.io/account/J1ssdnk72fGZuXkBAw6PMEnwWfnbb3Udqz5JcFuZ66wj) 2.2774%
Security: Score: 0(🟢Low Risk)    
|_Ownership Renounced:❌|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅

Check (https://ave.ai/check/DA5auNe9kpQWirSSULuE2oTh6jRefmTRKhqsCxchpump-solana?type=token) | Website (https://ave.ai/) | App (https://ave.ai/download) | Community (https://t.me/aveai_english) | Twitter (https://x.com/aveaiofficial)`;

// ============================================================
// Signal parser tests — FREEDOM
// ============================================================

describe("parseAveScannerSignal — FREEDOM", () => {
  const r = parseAveScannerSignal(FREEDOM_SIGNAL);

  test("type and identity", () => {
    expect(r.type).toBe("ave_scanner");
    expect(r.tokenName).toBe("FREEDOM");
    expect(r.tokenAddress).toBe("43zZbtUcK6adgsLDzb774RDNKyBWgmrfHHWkjfnuTesg");
    expect(r.tokenUrl).toBe(
      "https://solscan.io/token/43zZbtUcK6adgsLDzb774RDNKyBWgmrfHHWkjfnuTesg",
    );
  });

  test("contract and LP addresses", () => {
    expect(r.contractAddress).toBe(
      "43zZbtUcK6adgsLDzb774RDNKyBWgmrfHHWkjfnuTesg",
    );
    expect(r.lpAddress).toBe("DUvzBmVH5KPSPJp79v4ZAPcZ8o2d8VbzESssgs4JcKNb");
  });

  test("price fields", () => {
    expect(r.initPriceRaw).toBe("0.0{4}8121");
    expect(r.initPrice).toBe(0.00008121);
    expect(r.marketCapRaw).toBe("$81.10K");
    expect(r.marketCapUsd).toBe(81100);
  });

  test("pair info", () => {
    expect(r.pairTokenAmount).toBe(9_990_000);
    expect(r.pairTokenSymbol).toBe("FREEDOM");
    expect(r.pairSolAmount).toBe(9.97);
  });

  test("DEX and liquidity", () => {
    expect(r.dex).toBe("Meteoradammv2");
    expect(r.liquidityRaw).toBe("$1.62K");
    expect(r.liquidityUsd).toBe(1620);
  });

  test("insider / sniper stats", () => {
    expect(r.insiders).toBe(0);
    expect(r.insiderHoldingsPercent).toBe(0);
    expect(r.snipes).toBe(1);
    expect(r.rushers).toBe(0);
  });

  test("holders", () => {
    expect(r.holderCount).toBe(10);
    expect(r.holders).toHaveLength(5);
    expect(r.holders![0]!.address).toBe(
      "2LMYfG5PgPy1iD3gzMo1CpYwnDTeVxj7GdYPoU4ktmzc",
    );
    expect(r.holders![0]!.percentage).toBeCloseTo(98.6775);
    expect(r.holders![4]!.percentage).toBeCloseTo(0.008853);
  });

  test("security", () => {
    expect(r.security!.score).toBe(0);
    expect(r.security!.risk).toBe("Low Risk");
    expect(r.security!.flags.ownershipRenounced).toBe(false);
    expect(r.security!.flags.top10HoldingsUnder30).toBe(true);
    expect(r.security!.flags.stopMint).toBe(true);
    expect(r.security!.flags.noBlacklist).toBe(true);
  });

  test("links", () => {
    expect(r.links!.check).toBe(
      "https://ave.ai/check/43zZbtUcK6adgsLDzb774RDNKyBWgmrfHHWkjfnuTesg-solana?type=token",
    );
    expect(r.links!.website).toBe("https://ave.ai/");
    expect(r.links!.app).toBe("https://ave.ai/download");
    expect(r.links!.community).toBe("https://t.me/aveai_english");
    expect(r.links!.twitter).toBe("https://x.com/aveaiofficial");
  });

  test("raw text preserved", () => {
    expect(r.raw).toBe(FREEDOM_SIGNAL);
  });
});

// ============================================================
// Signal parser tests — TURHOD (Pump DEX, 4 holders)
// ============================================================

describe("parseAveScannerSignal — TURHOD", () => {
  const r = parseAveScannerSignal(TURHOD_SIGNAL);

  test("identity", () => {
    expect(r.tokenName).toBe("TURHOD");
    expect(r.contractAddress).toBe(
      "GEH927gg6MDuukRGrFVzekFaLBdwmDvKzQhGd3pasdLq",
    );
    expect(r.lpAddress).toBe("5ZJRb9AQshV8oMNdbgpb7b7jHv3GS7Q9SanTD8Gi7K7J");
  });

  test("compressed price with 5 zeros", () => {
    expect(r.initPrice).toBe(0.000002342);
    expect(r.marketCapUsd).toBe(4780);
  });

  test("pair with M supply", () => {
    expect(r.pairTokenAmount).toBe(981_730_000);
    expect(r.pairTokenSymbol).toBe("TURHOD");
    expect(r.pairSolAmount).toBeCloseTo(0.52);
  });

  test("DEX = Pump", () => {
    expect(r.dex).toBe("Pump");
    expect(r.liquidityUsd).toBe(2380);
  });

  test("4 holders, no insiders", () => {
    expect(r.holderCount).toBe(4);
    expect(r.holders).toHaveLength(4);
    expect(r.insiders).toBe(0);
    expect(r.snipes).toBe(1);
  });

  test("holder with 0%", () => {
    const lastHolder = r.holders![3]!;
    expect(lastHolder.percentage).toBe(0);
    expect(lastHolder.address).toBe(
      "6QRjmgpxn41ABXbmuJA2BMMUzL6hJiE5Yu63XA6G98mL",
    );
  });

  test("links include only standard five fields (no pumpfun)", () => {
    // The parser extracts exactly 5 link types: check, website, app, community, twitter.
    // Pump.fun link in the raw message is NOT captured as its own field.
    expect(r.links!.check).toBe(
      "https://ave.ai/check/GEH927gg6MDuukRGrFVzekFaLBdwmDvKzQhGd3pasdLq-solana?type=token",
    );
    expect(r.links!.website).toBe("https://ave.ai/");
    expect(r.links!.app).toBe("https://ave.ai/download");
    expect(r.links!.community).toBe("https://t.me/aveai_english");
    expect(r.links!.twitter).toBe("https://x.com/aveaiofficial");
  });
});

// ============================================================
// TURHOD #2 — same CA/LP, different snipes (tests robustness)
// ============================================================

describe("parseAveScannerSignal — TURHOD (duplicate, snipes=2)", () => {
  const r = parseAveScannerSignal(TURHOD_SIGNAL_2);

  test("identical identity", () => {
    expect(r.contractAddress).toBe(
      "GEH927gg6MDuukRGrFVzekFaLBdwmDvKzQhGd3pasdLq",
    );
    expect(r.lpAddress).toBe("5ZJRb9AQshV8oMNdbgpb7b7jHv3GS7Q9SanTD8Gi7K7J");
  });

  test("snipes differ from first instance", () => {
    expect(r.snipes).toBe(2);
  });
});

// ============================================================
// Signal parser tests — 3301 (Meteora DEX, 88 holders, 5 shown)
// ============================================================

describe("parseAveScannerSignal — 3301", () => {
  const r = parseAveScannerSignal(THREE301_SIGNAL);

  test("identity", () => {
    expect(r.tokenName).toBe("3301");
    expect(r.contractAddress).toBe(
      "9b6mdTtYMr19KNMfLqhCboxnfaJqq5EmDNXDpaKoVwhX",
    );
    expect(r.lpAddress).toBe("re42KQiVewDvJ8NdNoCeogG1zMa1cAzLcRmqNNbocNn");
  });

  test("price", () => {
    expect(r.initPrice).toBe(0.00004216);
    expect(r.marketCapUsd).toBe(42160);
  });

  test("pair", () => {
    expect(r.pairTokenAmount).toBe(23_140_000);
    expect(r.pairSolAmount).toBe(11.03);
  });

  test("DEX = Meteora", () => {
    expect(r.dex).toBe("Meteora");
    expect(r.liquidityUsd).toBe(1870);
  });

  test("88 holders, 5 shown in message", () => {
    expect(r.holderCount).toBe(88);
    expect(r.holders).toHaveLength(5);
  });

  test("no Pump.fun link", () => {
    expect(r.links!.pumpfun).toBeUndefined();
  });
});

// ============================================================
// Signal parser tests — repeat (1 insider, Meteoradammv2)
// ============================================================

describe("parseAveScannerSignal — repeat", () => {
  const r = parseAveScannerSignal(REPEAT_SIGNAL);

  test("identity", () => {
    expect(r.tokenName).toBe("repeat");
    expect(r.contractAddress).toBe(
      "7mjgFhFCEApWzipKVLqBEwH9W612UF55SDPVGbo8x9p8",
    );
  });

  test("1 insider with 0% holdings", () => {
    expect(r.insiders).toBe(1);
    expect(r.insiderHoldingsPercent).toBe(0);
  });

  test("snipes = 2", () => {
    expect(r.snipes).toBe(2);
  });

  test("price", () => {
    expect(r.initPrice).toBe(0.00008113);
    expect(r.marketCapUsd).toBe(81190);
  });

  test("12 holders, 5 shown", () => {
    expect(r.holderCount).toBe(12);
    expect(r.holders).toHaveLength(5);
  });
});

// ============================================================
// Signal parser tests — FROGCOIN (Pump, 10 snipes, 5 holders shown)
// ============================================================

describe("parseAveScannerSignal — FROGCOIN", () => {
  const r = parseAveScannerSignal(FROGCOIN_SIGNAL);

  test("identity", () => {
    expect(r.tokenName).toBe("FROGCOIN");
    expect(r.contractAddress).toBe(
      "BVi5CgmASpMyksezCx5dgPv9JLhTAMv845QYtdaqpump",
    );
  });

  test("10 snipes, 0 rushers", () => {
    expect(r.snipes).toBe(10);
    expect(r.rushers).toBe(0);
  });

  test("price", () => {
    expect(r.initPrice).toBe(0.000002525);
    expect(r.marketCapUsd).toBe(3590);
  });

  test("holders with named addresses", () => {
    expect(r.holders).toHaveLength(5);
    expect(r.holders![0]!.percentage).toBeCloseTo(59.69);
    expect(r.holders![1]!.percentage).toBeCloseTo(6.6786);
  });

  test("links include only standard five fields", () => {
    expect(r.links!.check).toBe(
      "https://ave.ai/check/BVi5CgmASpMyksezCx5dgPv9JLhTAMv845QYtdaqpump-solana?type=token",
    );
    expect(r.links!.website).toBe("https://ave.ai/");
    expect(r.links!.app).toBe("https://ave.ai/download");
    expect(r.links!.community).toBe("https://t.me/aveai_english");
    expect(r.links!.twitter).toBe("https://x.com/aveaiofficial");
  });
});

// ============================================================
// Signal parser tests — MONIKA (Pump, 0.07 SOL, 4 holders)
// ============================================================

describe("parseAveScannerSignal — MONIKA", () => {
  const r = parseAveScannerSignal(MONIKA_SIGNAL);

  test("identity", () => {
    expect(r.tokenName).toBe("MONIKA");
    expect(r.lpAddress).toBe("AnfWAnjeGTiThn8T2s1xfsuCeVeJYb31zTdxK2woyfKL");
  });

  test("low SOL pair", () => {
    expect(r.pairSolAmount).toBeCloseTo(0.07);
    expect(r.pairTokenAmount).toBe(997_640_000);
  });

  test("price", () => {
    expect(r.initPrice).toBe(0.000002301);
    expect(r.marketCapUsd).toBe(4040);
  });
});

// ============================================================
// Signal parser tests — PEACE (Pumpfunamm, $7.11 mcap)
// ============================================================

describe("parseAveScannerSignal — PEACE", () => {
  const r = parseAveScannerSignal(PEACE_SIGNAL);

  test("identity", () => {
    expect(r.tokenName).toBe("PEACE");
    expect(r.dex).toBe("Pumpfunamm");
  });

  test("micro market cap — no suffix", () => {
    expect(r.marketCapUsd).toBeCloseTo(7.11);
  });

  test("init price with 5 zeros and short tail", () => {
    expect(r.initPrice).toBe(0.00000822);
  });

  test("1 insider", () => {
    expect(r.insiders).toBe(1);
    expect(r.snipes).toBe(1);
  });

  test("10 holders, 5 shown", () => {
    expect(r.holderCount).toBe(10);
    expect(r.holders).toHaveLength(5);
  });

  test("micro-holdings < 0.001%", () => {
    const tinyHolder = r.holders![2]!;
    expect(tinyHolder.percentage).toBeCloseTo(0.0004883, 7);
  });

  test("no Pump.fun link", () => {
    expect(r.links!.pumpfun).toBeUndefined();
  });
});

// ============================================================
// Signal parser tests — BREDOG (Pump, 3 holders only)
// ============================================================

describe("parseAveScannerSignal — BREDOG", () => {
  const r = parseAveScannerSignal(BREDOG_SIGNAL);

  test("identity", () => {
    expect(r.tokenName).toBe("BREDOG");
    expect(r.dex).toBe("Pump");
  });

  test("only 3 holders", () => {
    expect(r.holderCount).toBe(3);
    expect(r.holders).toHaveLength(3);
  });

  test("no insiders", () => {
    expect(r.insiders).toBe(0);
    expect(r.snipes).toBe(1);
  });

  test("price", () => {
    expect(r.initPrice).toBe(0.000002334);
    expect(r.marketCapUsd).toBe(4760);
  });
});

// ============================================================
// Signal parser tests — EBAIDS (Pumpfunamm, normal price $0.02236)
// ============================================================

describe("parseAveScannerSignal — EBAIDS", () => {
  const r = parseAveScannerSignal(EBAIDS_SIGNAL);

  test("identity", () => {
    expect(r.tokenName).toBe("EBAIDS");
    expect(r.dex).toBe("Pumpfunamm");
    expect(r.contractAddress).toBe(
      "DA5auNe9kpQWirSSULuE2oTh6jRefmTRKhqsCxchpump",
    );
  });

  test("plain init price (no compression)", () => {
    expect(r.initPriceRaw).toBe("0.02236");
    expect(r.initPrice).toBe(0.02236);
  });

  test("K-format market cap and pair amount", () => {
    expect(r.marketCapUsd).toBe(21360);
    expect(r.pairTokenAmount).toBe(747_910);
    expect(r.pairSolAmount).toBeCloseTo(229.73);
  });

  test("high liquidity", () => {
    expect(r.liquidityUsd).toBe(37170);
  });

  test("3 snipes, 1 insider", () => {
    expect(r.snipes).toBe(3);
    expect(r.insiders).toBe(1);
  });

  test("no Pump.fun link", () => {
    expect(r.links!.pumpfun).toBeUndefined();
  });
});

// ============================================================
// Edge case tests
// ============================================================

describe("parseAveScannerSignal — edge cases", () => {
  test("throws on non-signal text", () => {
    expect(() => parseAveScannerSignal("hello world")).toThrow(
      "Failed to parse Solana pool signal",
    );
  });

  test("throws on malformed input with missing CA", () => {
    expect(() =>
      parseAveScannerSignal("Token: TEST\nInit Price: $0.01"),
    ).toThrow("Failed to parse Solana pool signal");
  });

  test("throws on invalid market cap", () => {
    expect(() =>
      parseAveScannerSignal(
        "Token: TEST\nCA: abc\nLP: def\nInit Price: $0.01\nMCap: invalid",
      ),
    ).toThrow("Failed to parse Solana pool signal");
  });

  test("validates negative market cap", () => {
    expect(() =>
      parseAveScannerSignal(
        "Token: TEST (https://x.com)\nCA: abc\nLP: def\nInit Price: $0.01\nMCap: $-1.0\nPair: 1M TEST / 1 SOL\nDex: Pump\nLiquidity: $1K\nInsiders: 0(Holdings 0%)\nSNIPES: 0  RUSHERS: 0\nSecurity: Score: 0(Low Risk)\n|_Ownership Renounced:✅|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅",
      ),
    ).toThrow("Failed to parse Solana pool signal");
  });
});

// ============================================================
// maxPumpX is never set for AveScanner signals
// ============================================================

describe("parseAveScannerSignal — maxPumpX", () => {
  test("maxPumpX is undefined for AveScanner signals", () => {
    const r = parseAveScannerSignal(FREEDOM_SIGNAL);
    expect(r.maxPumpX).toBeUndefined();
  });
});
