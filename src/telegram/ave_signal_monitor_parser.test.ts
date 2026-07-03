import { describe, expect, test } from "bun:test";
import {
  parseSignalMonitorSignal,
  parseSignalMonitorPump,
  parseSignalMonitorMessage,
} from "./ave_signal_monitor_parser";
import type {
  AveSignalMonitorSignal,
  AveSignalMonitorPump,
} from "./ave_signal_monitor_parser";

/* ============================================================
 * Signal test cases  (🏙 prefix)
 * ============================================================
 */

const NITRO_SIGNAL = `🪙 $nitro (from pump.fun)
🔗 solana
CA: 9zZVV9wytrbCLK3iHyiszLht55fBKpAP6VQqxTzrpump
Link: https://pro.ave.ai/token/9zZVV9wytrbCLK3iHyiszLht55fBKpAP6VQqxTzrpump-solana

🔢 2nd Vibe Buy Signal
💹 Max Pump: 2x
💰 2 KOL Wallet Buy
🤑 Current MC: 40.94K
💸 Total Buy 10.0122 SOL

🛗 Inflow
🟢 OTTA 💰 Buy 9.876 SOL
🟢 Dex Buy 0.134 SOL`;

const INDY_SIGNAL = `🪙 $Indy (from pump.fun)
🔗 solana
CA: 6LoUYezdr8ukLRXBFqpsXddJda3qNs6vwGT3ph4Qpump
Link: https://pro.ave.ai/token/6LoUYezdr8ukLRXBFqpsXddJda3qNs6vwGT3ph4Qpump-solana

🔢 2nd Vibe Buy Signal
💹 Max Pump: 5x
💰 2 Smart Wallet Buy
🤑 Current MC: 18.74K
💸 Total Buy 0.660 SOL

🛗 Inflow
🟢 *nbmK Buy 0.495 SOL
🟢 *yNAf Buy 0.163 SOL`;

const BITCAT_SIGNAL = `🪙 $BITCAT (from pump.fun)
🔗 solana
CA: EyCvEEKkrU24jQmcPsB53Aq8NFVM8MX3eRP3s1RJpump
Link: https://pro.ave.ai/token/EyCvEEKkrU24jQmcPsB53Aq8NFVM8MX3eRP3s1RJpump-solana

🔢 2nd Vibe Buy Signal
💹 Max Pump: 4x
💰 2 Smart Wallet Buy
🤑 Current MC: 23.55K
💸 Total Buy 3.560 SOL

🛗 Inflow
🟢 *kn3Q Buy 0.597 SOL
🟢 *WVgz Buy 2.963 SOL`;

const POW_SIGNAL = `🪙 $POW (from pump.fun)
🔗 solana
CA: D83LZYX3q8x43qGiGPWmEEWEdosid6UAAoYRusXtpump
Link: https://pro.ave.ai/token/D83LZYX3q8x43qGiGPWmEEWEdosid6UAAoYRusXtpump-solana

🔢 2nd Vibe Buy Signal
💹 Max Pump: 6x
💰 2 KOL Wallet Buy
🤑 Current MC: 36.65K
💸 Total Buy 3.537 SOL

🛗 Inflow
🟢 Sohrab.eth | 215.eth Buy 3.292 SOL
🟢 Daumen Buy 0.244 SOL`;

const DEVXT_SIGNAL = `🪙 $DevXT (from pump.fun)
🔗 solana
CA: GfQw9B9UJY7NuB5aYGG83ttgeU8YksDyEAsFq6Djpump
Link: https://pro.ave.ai/token/GfQw9B9UJY7NuB5aYGG83ttgeU8YksDyEAsFq6Djpump-solana

🔢 2nd Vibe Buy Signal
💹 Max Pump: 4x
💰 2 KOL Wallet Buy
🤑 Current MC: 15.99K
💸 Total Buy 2.868 SOL

🛗 Inflow
🟢 wealth/一凡🧲 Buy 1.955 SOL
🟢 dv Buy 0.910 SOL`;

const TIGGIEN_SIGNAL = `🪙 $TIGGIEN (from pump.fun)
🔗 solana
CA: 7g4yS89GpKq52oRwypc9NGRSHh37xkRyRJYAFrekpump
Link: https://pro.ave.ai/token/7g4yS89GpKq52oRwypc9NGRSHh37xkRyRJYAFrekpump-solana

🔢 2nd Vibe Buy Signal
💹 Max Pump: 2x
💰 2 Smart Wallet Buy
🤑 Current MC: 12.19K
💸 Total Buy 1.493 SOL

🛗 Inflow
🟢 *VCYZ Buy 1 SOL
🟢 *kgcF Buy 0.493 SOL`;

const FM_SIGNAL = `🪙 $FM (from pump.fun)
🔗 solana
CA: 5s4peTyKrR8QSfGcz4Wy1e5TLAA2xrrkoH43gzGgpump
Link: https://pro.ave.ai/token/5s4peTyKrR8QSfGcz4Wy1e5TLAA2xrrkoH43gzGgpump-solana

🔢 2nd Vibe Buy Signal
💹 Max Pump: 3x
💰 2 KOL Wallet Buy
🤑 Current MC: 45.29K
💸 Total Buy 5.205 SOL

🛗 Inflow
🟢 OTTA 💰 Buy 4.950 SOL
🟢 Raj Buy 0.247 SOL`;

const TMB_SIGNAL = `🪙 $TMB (from pump.fun)
🔗 solana
CA: MtJEwiCNkPyNFB3bfz78P6rfhzrHaTgEojqsJNJpump
Link: https://pro.ave.ai/token/MtJEwiCNkPyNFB3bfz78P6rfhzrHaTgEojqsJNJpump-solana

🔢 2nd Vibe Buy Signal
💹 Max Pump: < 1x
💰 2 Smart Wallet Buy
🤑 Current MC: 2.07M
💸 Total Buy 1.0281 SOL

🛗 Inflow
🟢 *Xc5J Buy 0.133 SOL
🟢 *xhZy Buy 0.894 SOL`;

const PISS_SIGNAL = `🪙 $piss (from pump.fun)
🔗 solana
CA: DXXcq4tY5e4PbXybyBMnxZjHVmzv1GVrAXoW5TcC5kbu
Link: https://pro.ave.ai/token/DXXcq4tY5e4PbXybyBMnxZjHVmzv1GVrAXoW5TcC5kbu-solana

🔢 35th Vibe Buy Signal
💹 Max Pump: 54x
💰 3 Smart Wallet Buy
🤑 Current MC: 108.31K
💸 Total Buy 4.729 SOL

🛗 Inflow
🟢 *xvGH Buy 174.901 USDC
🟢 *rXLE Buy 49.456 USDC
🟢 *Mgwc Buy 161.365 USDC`;

const FATCOIN_SIGNAL = `🪙 $Fatcoin (from pump.fun)
🔗 solana
CA: 98uHBngN8bXyEpuUxkiBVsasPXMHYyfqymeYAuHTpump
Link: https://pro.ave.ai/token/98uHBngN8bXyEpuUxkiBVsasPXMHYyfqymeYAuHTpump-solana

🔢 2nd Vibe Buy Signal
💹 Max Pump: 8x
💰 6 Smart Wallet Buy
🤑 Current MC: 88.42K
💸 Total Buy 21.391 SOL

🛗 Inflow
🟢 *cNZy Buy 1.955 SOL
🟢 *AgfH Buy 1.980 SOL
🟢 *3bYP Buy 0.980 SOL
🟢 *UpsW Buy 3.420 SOL
🟢 *8W9s Buy 3.123 SOL
🟢 DNF小号 Buy 9.901 SOL`;

const SHITCOIN_SIGNAL = `🪙 $SHITCOIN (from )
🔗 eth
CA: 0xe0f33e756a22481fec40923ad3a5a8779d759293
Link: https://pro.ave.ai/token/0xe0f33e756a22481fec40923ad3a5a8779d759293-eth

🔢 2nd Vibe Buy Signal
💹 Max Pump: < 1x
💰 5 Smart Wallet Buy
🤑 Current MC: 43.07K
💸 Total Buy 1.848 ETH

🛗 Inflow
🟢 *72ef Buy 0.4 WETH
🟢 *9aee Buy 0.45 WETH
🟢 *b65d Buy 0.3 WETH
🟢 *2966 Buy 0.3 WETH
🟢 *bac0 Buy 0.4 WETH`;

const DEVXT2_SIGNAL = `🪙 $DevXT (from pump.fun)
🔗 solana
CA: 2ePoF216vi22YgBn21SaeBffAhZkBaw2yP5fk5Nepump
Link: https://pro.ave.ai/token/2ePoF216vi22YgBn21SaeBffAhZkBaw2yP5fk5Nepump-solana

🔢 2nd Vibe Buy Signal
💹 Max Pump: 2x
💰 2 KOL Wallet Buy
🤑 Current MC: 13.60K
💸 Total Buy 1.709 SOL

🛗 Inflow
🟢 eq Buy 1.483 SOL
🟢 Cupsey Buy 0.224 SOL`;

/* ============================================================
 * Pump result test cases  (🚀 prefix)
 * ============================================================
 */

const BALLOON_X24_PUMP = `🚀 x24 🚀 $Balloon 🆙 🆙 🆙

Jumped from 13.22K to now 127.26K

CA: 96X4zg5T4NFWzTVFXHsadvYbxbzFX2Rqt3GXUv92pump

Powered by @AveSignalMonitor 🤑`;

const INTRANSIT_X14_PUMP = `🚀 x14 🚀 $INTRANSIT 🆙 🆙 🆙

Jumped from 11.00K to now 48.67K

CA: 2aryj2oLb13KF6ifHD6qXbd6ExaAdf3Pd4hf8QzUpump

Powered by @AveSignalMonitor 🤑`;

const BALLOON_X30_PUMP = `🚀 x30 🚀 $Balloon 🆙 🆙 🆙

Jumped from 13.22K to now 216.67K

CA: 96X4zg5T4NFWzTVFXHsadvYbxbzFX2Rqt3GXUv92pump

Powered by @AveSignalMonitor 🤑`;

const BALLOON_X41_PUMP = `🚀 x41 🚀 $Balloon 🆙 🆙 🆙

Jumped from 13.22K to now 187.45K

CA: 96X4zg5T4NFWzTVFXHsadvYbxbzFX2Rqt3GXUv92pump

Powered by @AveSignalMonitor 🤑`;

const NITRO_X5_PUMP = `🚀 x5 🚀 $nitro 🆙 🆙 🆙

Jumped from 15.43K to now 64.67K

CA: 9zZVV9wytrbCLK3iHyiszLht55fBKpAP6VQqxTzrpump

Powered by @AveSignalMonitor 🤑`;

const NAARMGROID_X12_PUMP = `🚀 x12 🚀 $NAARMGROID 🆙 🆙 🆙

Jumped from 31.92K to now 59.67K

CA: F6irzkr8Pe7CkvbMx7xQcya2sqe8fhWu4dCXfAW9pump

Powered by @AveSignalMonitor 🤑`;

const DEVXT_X7_PUMP = `🚀 x7 🚀 $DevXT 🆙 🆙 🆙

Jumped from 10.20K to now 18.32K

CA: GfQw9B9UJY7NuB5aYGG83ttgeU8YksDyEAsFq6Djpump

Powered by @AveSignalMonitor 🤑`;

const DEVXT_X10_PUMP = `🚀 x10 🚀 $DevXT 🆙 🆙 🆙

Jumped from 10.20K to now 34.32K

CA: GfQw9B9UJY7NuB5aYGG83ttgeU8YksDyEAsFq6Djpump

Powered by @AveSignalMonitor 🤑`;

/* ============================================================
 * Signal tests
 * ============================================================
 */

describe("parseSignalMonitorSignal", () => {
  test("nitro — 2x pump, KOL wallets", () => {
    const r = parseSignalMonitorSignal(NITRO_SIGNAL)!;
    expect(r.type).toBe("signal");
    expect(r.tokenName).toBe("nitro");
    expect(r.contractAddress).toBe("9zZVV9wytrbCLK3iHyiszLht55fBKpAP6VQqxTzrpump");
    expect(r.chain).toBe("solana");
    expect(r.maxPumpX).toBe(2);
    expect(r.marketCapUsd).toBe(40940);
    expect(r.walletBuyCount).toBe(2);
    expect(r.totalBuySol).toBeCloseTo(10.0122, 4);
  });

  test("Indy — 5x pump, Smart Wallet", () => {
    const r = parseSignalMonitorSignal(INDY_SIGNAL)!;
    expect(r.tokenName).toBe("Indy");
    expect(r.contractAddress).toBe("6LoUYezdr8ukLRXBFqpsXddJda3qNs6vwGT3ph4Qpump");
    expect(r.maxPumpX).toBe(5);
    expect(r.marketCapUsd).toBe(18740);
    expect(r.walletBuyCount).toBe(2);
    expect(r.totalBuySol).toBeCloseTo(0.660, 3);
  });

  test("BITCAT — 4x pump", () => {
    const r = parseSignalMonitorSignal(BITCAT_SIGNAL)!;
    expect(r.tokenName).toBe("BITCAT");
    expect(r.contractAddress).toBe("EyCvEEKkrU24jQmcPsB53Aq8NFVM8MX3eRP3s1RJpump");
    expect(r.maxPumpX).toBe(4);
    expect(r.marketCapUsd).toBe(23550);
    expect(r.totalBuySol).toBeCloseTo(3.560, 3);
  });

  test("POW — 6x pump, KOL wallets", () => {
    const r = parseSignalMonitorSignal(POW_SIGNAL)!;
    expect(r.tokenName).toBe("POW");
    expect(r.contractAddress).toBe("D83LZYX3q8x43qGiGPWmEEWEdosid6UAAoYRusXtpump");
    expect(r.maxPumpX).toBe(6);
    expect(r.marketCapUsd).toBe(36650);
    expect(r.totalBuySol).toBeCloseTo(3.537, 3);
  });

  test("DevXT — 4x pump, KOL wallets", () => {
    const r = parseSignalMonitorSignal(DEVXT_SIGNAL)!;
    expect(r.tokenName).toBe("DevXT");
    expect(r.contractAddress).toBe("GfQw9B9UJY7NuB5aYGG83ttgeU8YksDyEAsFq6Djpump");
    expect(r.maxPumpX).toBe(4);
    expect(r.marketCapUsd).toBe(15990);
    expect(r.totalBuySol).toBeCloseTo(2.868, 3);
  });

  test("TIGGIEN — 2x pump, Smart Wallet", () => {
    const r = parseSignalMonitorSignal(TIGGIEN_SIGNAL)!;
    expect(r.tokenName).toBe("TIGGIEN");
    expect(r.maxPumpX).toBe(2);
    expect(r.marketCapUsd).toBe(12190);
    expect(r.totalBuySol).toBeCloseTo(1.493, 3);
  });

  test("FM — 3x pump", () => {
    const r = parseSignalMonitorSignal(FM_SIGNAL)!;
    expect(r.tokenName).toBe("FM");
    expect(r.maxPumpX).toBe(3);
    expect(r.marketCapUsd).toBe(45290);
  });

  test("TMB — < 1x pump, M cap", () => {
    const r = parseSignalMonitorSignal(TMB_SIGNAL)!;
    expect(r.tokenName).toBe("TMB");
    expect(r.maxPumpX).toBe(0);
    expect(r.marketCapUsd).toBe(2_070_000);
    expect(r.totalBuySol).toBeCloseTo(1.0281, 4);
  });

  test("piss — 54x pump, 3 wallets, buy in SOL (inflow in USDC)", () => {
    const r = parseSignalMonitorSignal(PISS_SIGNAL)!;
    expect(r.tokenName).toBe("piss");
    expect(r.maxPumpX).toBe(54);
    expect(r.marketCapUsd).toBe(108310);
    expect(r.walletBuyCount).toBe(3);
    expect(r.totalBuySol).toBeCloseTo(4.729, 3);
  });

  test("Fatcoin — 8x pump, 6 wallets", () => {
    const r = parseSignalMonitorSignal(FATCOIN_SIGNAL)!;
    expect(r.tokenName).toBe("Fatcoin");
    expect(r.maxPumpX).toBe(8);
    expect(r.marketCapUsd).toBe(88420);
    expect(r.walletBuyCount).toBe(6);
    expect(r.totalBuySol).toBeCloseTo(21.391, 3);
  });

  test("SHITCOIN — eth chain, < 1x, non-SOL buy", () => {
    const r = parseSignalMonitorSignal(SHITCOIN_SIGNAL)!;
    expect(r.tokenName).toBe("SHITCOIN");
    expect(r.chain).toBe("eth");
    expect(r.maxPumpX).toBe(0);
    expect(r.marketCapUsd).toBe(43070);
    expect(r.walletBuyCount).toBe(5);
    expect(r.totalBuySol).toBe(0); // buy is ETH, not SOL
  });

  test("DevXT #2 — same name, different CA", () => {
    const r = parseSignalMonitorSignal(DEVXT2_SIGNAL)!;
    expect(r.tokenName).toBe("DevXT");
    expect(r.contractAddress).toBe("2ePoF216vi22YgBn21SaeBffAhZkBaw2yP5fk5Nepump");
    expect(r.maxPumpX).toBe(2);
    expect(r.marketCapUsd).toBe(13600);
  });

  test("returns null for non-signal text", () => {
    expect(parseSignalMonitorSignal("hello world")).toBeNull();
  });

  test("returns null for pump message", () => {
    expect(parseSignalMonitorSignal(BALLOON_X24_PUMP)).toBeNull();
  });
});

/* ============================================================
 * Pump result tests
 * ============================================================
 */

describe("parseSignalMonitorPump", () => {
  test("Balloon x24", () => {
    const r = parseSignalMonitorPump(BALLOON_X24_PUMP)!;
    expect(r.type).toBe("pump");
    expect(r.tokenName).toBe("Balloon");
    expect(r.contractAddress).toBe("96X4zg5T4NFWzTVFXHsadvYbxbzFX2Rqt3GXUv92pump");
    expect(r.multiplier).toBe(24);
    expect(r.jumpedFromK).toBe(13220);
    expect(r.jumpedToK).toBe(127260);
  });

  test("INTRANSIT x14", () => {
    const r = parseSignalMonitorPump(INTRANSIT_X14_PUMP)!;
    expect(r.tokenName).toBe("INTRANSIT");
    expect(r.multiplier).toBe(14);
    expect(r.jumpedFromK).toBe(11000);
    expect(r.jumpedToK).toBe(48670);
  });

  test("Balloon x30 — same token, new pump", () => {
    const r = parseSignalMonitorPump(BALLOON_X30_PUMP)!;
    expect(r.tokenName).toBe("Balloon");
    expect(r.multiplier).toBe(30);
    expect(r.jumpedFromK).toBe(13220);
    expect(r.jumpedToK).toBe(216670);
  });

  test("Balloon x41 — same token, third pump", () => {
    const r = parseSignalMonitorPump(BALLOON_X41_PUMP)!;
    expect(r.tokenName).toBe("Balloon");
    expect(r.multiplier).toBe(41);
    expect(r.jumpedFromK).toBe(13220);
    expect(r.jumpedToK).toBe(187450);
  });

  test("nitro x5", () => {
    const r = parseSignalMonitorPump(NITRO_X5_PUMP)!;
    expect(r.tokenName).toBe("nitro");
    expect(r.contractAddress).toBe("9zZVV9wytrbCLK3iHyiszLht55fBKpAP6VQqxTzrpump");
    expect(r.multiplier).toBe(5);
    expect(r.jumpedFromK).toBe(15430);
    expect(r.jumpedToK).toBe(64670);
  });

  test("NAARMGROID x12", () => {
    const r = parseSignalMonitorPump(NAARMGROID_X12_PUMP)!;
    expect(r.tokenName).toBe("NAARMGROID");
    expect(r.multiplier).toBe(12);
  });

  test("DevXT x7 — matches first DevXT CA", () => {
    const r = parseSignalMonitorPump(DEVXT_X7_PUMP)!;
    expect(r.tokenName).toBe("DevXT");
    expect(r.contractAddress).toBe("GfQw9B9UJY7NuB5aYGG83ttgeU8YksDyEAsFq6Djpump");
    expect(r.multiplier).toBe(7);
    expect(r.jumpedFromK).toBe(10200);
    expect(r.jumpedToK).toBe(18320);
  });

  test("DevXT x10 — same CA, higher pump", () => {
    const r = parseSignalMonitorPump(DEVXT_X10_PUMP)!;
    expect(r.tokenName).toBe("DevXT");
    expect(r.contractAddress).toBe("GfQw9B9UJY7NuB5aYGG83ttgeU8YksDyEAsFq6Djpump");
    expect(r.multiplier).toBe(10);
    expect(r.jumpedToK).toBe(34320);
  });

  test("returns null for non-pump text", () => {
    expect(parseSignalMonitorPump("hello world")).toBeNull();
  });

  test("returns null for signal message", () => {
    expect(parseSignalMonitorPump(NITRO_SIGNAL)).toBeNull();
  });
});

/* ============================================================
 * Dispatch tests
 * ============================================================
 */

describe("parseSignalMonitorMessage", () => {
  test("routes signal messages correctly", () => {
    const r = parseSignalMonitorMessage(NITRO_SIGNAL)!;
    expect(r.type).toBe("signal");
    if (r.type === "signal") {
      expect(r.tokenName).toBe("nitro");
    }
  });

  test("routes pump messages correctly", () => {
    const r = parseSignalMonitorMessage(BALLOON_X24_PUMP)!;
    expect(r.type).toBe("pump");
    if (r.type === "pump") {
      expect(r.tokenName).toBe("Balloon");
    }
  });

  test("returns null for unknown text", () => {
    expect(parseSignalMonitorMessage("hello world")).toBeNull();
  });
});
