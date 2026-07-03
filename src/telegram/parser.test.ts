import removeMarkdown from "remove-markdown";

import {
  parseSolanaPoolSignal,
  expandCompressedDecimal,
  parseAbbreviatedUsd,
} from "./ave_scanner_parser";
import { expect, test } from "bun:test";

const bullhouseMessage = `
💠 New Solana Pool Launched 💠

Token: BULLHOUSE
CA: 5Uk9DnPUywXsJathCkc8UhyJMbzzeRK2yLmhqNtpisyP
LP: qnQKLan1ZbEtejcujr4wH3xe5UNnMtVyuNt2Xqeqce7

Init Price: $0.0{5}6438
MCap: $6.44K
Pair: 1000.00M BULLHOUSE / 84.99 SOL
Dex: Pumpfunamm
Liquidity: $6.41K
Insiders: 1(Holdings 0%)
SNIPES: 3  RUSHERS: 0
Token Holders: 8 🐸
    |_qnQKLan1ZbEtejcujr4wH3xe5UNnMtVyuNt2Xqeqce7 (https://solscan.io/account/qnQKLan1ZbEtejcujr4wH3xe5UNnMtVyuNt2Xqeqce7) 99.9999%
    |_3KcPSJ8ouE7H1feoWHmhDwXhLnXhpxP6R6713uytFmBM (https://solscan.io/account/3KcPSJ8ouE7H1feoWHmhDwXhLnXhpxP6R6713uytFmBM) 0.0{4}3519%
    |_27HFmP7ccLadGswvQfvea4o3juLw75cPF4V6jWpHM3MX (https://solscan.io/account/27HFmP7ccLadGswvQfvea4o3juLw75cPF4V6jWpHM3MX) 0.0{4}2346%
    |_kiwiC4pg5mC4N5AhpXc4Av3V6oV7Sn2p3CqB7NeHbJJ (https://solscan.io/account/kiwiC4pg5mC4N5AhpXc4Av3V6oV7Sn2p3CqB7NeHbJJ) 0.0{4}1759%
    |_7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ (https://solscan.io/account/7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ) 0.0{7}1912%
Security: Score: 0(🟢Low Risk)
|_Ownership Renounced:❌|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅

Check | Website | App | Community | Twitter
`;

const clickMessage = `
💠 New Solana Pool Launched 💠

Token: CLICK
CA: 8ArxVYybeUBrfDKFpZ3QkECHVUnSmG85XQo7hobkpump
LP: 38zcGrP9VwcqriESUNBwNcGwzJAZrGPSFWsXZ3mgNwDK

Init Price: $0.0{5}2487
MCap: $4.60K
Pair: 846.71M CLICK / 5.00 SOL
Dex: Pump
Liquidity: $376.63
Insiders: 0(Holdings 0%)
SNIPES: 12  RUSHERS: 0
Token Holders: 10 🐸🐸
    |_38zcGrP9VwcqriESUNBwNcGwzJAZrGPSFWsXZ3mgNwDK (https://solscan.io/account/38zcGrP9VwcqriESUNBwNcGwzJAZrGPSFWsXZ3mgNwDK) 63.2768%
    |_7LbP2dG7q5hex6skVTPmMMVYgq6MysfDsQuad47Ld5pq (https://solscan.io/account/7LbP2dG7q5hex6skVTPmMMVYgq6MysfDsQuad47Ld5pq) 10.2701%
    |_GfgE5AMUnKuS7GMMRZ5gLknPBKd1YrtZ3wz3uzrDetW3 (https://solscan.io/account/GfgE5AMUnKuS7GMMRZ5gLknPBKd1YrtZ3wz3uzrDetW3) 3.088%
    |_BoncsY5mBXqL2p1TMyRJYxPGgibnfritfb6oHUZFCony (https://solscan.io/account/BoncsY5mBXqL2p1TMyRJYxPGgibnfritfb6oHUZFCony) 3.0827%
    |_7hZkEvGwphtNWhawtMzab5FWMs4EsjQrZ43LNNT5k6kX (https://solscan.io/account/7hZkEvGwphtNWhawtMzab5FWMs4EsjQrZ43LNNT5k6kX) 3.0488%
Security: Score: 0(🟢Low Risk)    
|_Ownership Renounced:❌|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅

Check | Website | App | Community | Twitter
  `;

test("parse BULLHOUSE signal", () => {
  const result = parseSolanaPoolSignal(bullhouseMessage);
  console.dir(result);

  expect(result.tokenName).toBe("BULLHOUSE");

  expect(result.marketCapUsd).toBe(6440);

  expect(result.liquidityUsd).toBe(6410);

  expect(result.pairTokenAmount).toBe(1_000_000_000);

  expect(result.pairSolAmount).toBe(84.99);

  expect(result.dex).toBe("Pumpfunamm");

  expect(result.snipes).toBe(3);

  expect(result.holders.length).toBe(5);
});

test("parse CLICK signal", () => {
  const result = parseSolanaPoolSignal(clickMessage);
  console.dir(result);

  expect(result.tokenName).toBe("CLICK");

  expect(result.marketCapUsd).toBe(4600);

  expect(result.liquidityUsd).toBe(376.63);

  expect(result.pairTokenAmount).toBe(846_710_000);

  expect(result.pairSolAmount).toBe(5);

  expect(result.dex).toBe("Pump");

  expect(result.snipes).toBe(12);

  expect(result.holders.length).toBe(5);
});

test("expand compressed decimals", () => {
  expect(expandCompressedDecimal("0.0{5}6438")).toBe(0.000006438);

  expect(expandCompressedDecimal("0.0{4}3519")).toBe(0.00003519);

  expect(expandCompressedDecimal("0.0{5}232")).toBe(0.00000232);

  expect(expandCompressedDecimal("0.0{5}6883")).toBe(0.000006883);

  expect(expandCompressedDecimal("0.0{5}9712")).toBe(0.000009712);

  expect(expandCompressedDecimal("0.0{5}692")).toBe(0.00000692);

  expect(expandCompressedDecimal("0.0{4}7038")).toBe(0.00007038);

  expect(expandCompressedDecimal("0.0{4}529")).toBe(0.0000529);

  expect(expandCompressedDecimal("0.0{4}3369")).toBe(0.00003369);

  expect(expandCompressedDecimal("0.0{4}3219")).toBe(0.00003219);

  expect(expandCompressedDecimal("0.0001812")).toBe(0.0001812);

  expect(expandCompressedDecimal("0.002921")).toBe(0.002921);

  expect(expandCompressedDecimal("0.004037")).toBe(0.004037);
});

test("parse abbreviated values", () => {
  expect(parseAbbreviatedUsd("$6.44K")).toBe(6440);

  expect(parseAbbreviatedUsd("846.71M")).toBe(846710000);

  expect(parseAbbreviatedUsd("$376.63")).toBe(376.63);

  expect(parseAbbreviatedUsd("$55.09K")).toBe(55090);

  expect(parseAbbreviatedUsd("$18.14M")).toBe(18140000);

  expect(parseAbbreviatedUsd("$9.84K")).toBe(9840);

  expect(parseAbbreviatedUsd("$0.00")).toBe(0);

  expect(parseAbbreviatedUsd("$43.20K")).toBe(43200);

  expect(parseAbbreviatedUsd("$4.04M")).toBe(4040000);

  expect(parseAbbreviatedUsd("$2.32K")).toBe(2320);

  expect(parseAbbreviatedUsd("$7.04K")).toBe(7040);

  expect(parseAbbreviatedUsd("$28.16K")).toBe(28160);

  expect(parseAbbreviatedUsd("329.34K")).toBe(329340);
});

const signal_message = `
💠 **New Solana Pool Launched** 💠

**Token**: The Knight
**CA**: \`yKBC2MWsSWjfiJs4bYKC2e2oebrE7VXtyYDwo1nXA6F\`
**LP**: \`BtGRnwtb7J8AVjjbULrfFXfTBxhdjLhFFbF2AXi62Y4e\`

**Init Price**: $0.0{4}1003
**MCap**: $0.00
**Pair**: 2211.67M **The Knight** / 300.00 **SOL**
**Dex**: Pumpfunamm
**Liquidity**: $22.12K
**Insiders**: 5(Holdings 0%)
**SNIPES**: 3  **RUSHERS**: 0
**Token Holders**: 10 🐸🐸
    |_EPdvSqoeZkFaSm5ESHUxadw7QNmXN4pSXPHVP7RaZdbH 48.8942%
    |_2jUmLbTAdaCY4LV2xzb6nh8pAdMZJbbDcZk7Cw1AEVKf 12.2235%
    |_AoB1ZSMc9236xiFLUjJS7bMtYUAXfbQij6Cs35Qjurpm 12.2235%
    |_8BhjmAohJWvCjxrENMxBCr1Rh5mphdSD6YWdRB2SDMnA 12.2235%
    |_GM1ZG15TA1h858naoiLQjw7wycJv8cXfBWbkoZm4F7C4 12.2235%
**Security**: Score: 55(🟢Low Risk)    
|_Ownership Renounced:❌|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅

Check | Website | App | Community | Twitter
`;

const removed_markdown_signal = `
💠 New Solana Pool Launched 💠

Token: The Knight
CA: yKBC2MWsSWjfiJs4bYKC2e2oebrE7VXtyYDwo1nXA6F
LP: BtGRnwtb7J8AVjjbULrfFXfTBxhdjLhFFbF2AXi62Y4e

Init Price: $0.0{4}1003
MCap: $0.00
Pair: 2211.67M The Knight / 300.00 SOL
Dex: Pumpfunamm
Liquidity: $22.12K
Insiders: 5(Holdings 0%)
SNIPES: 3  RUSHERS: 0
Token Holders: 10 🐸🐸
    |_EPdvSqoeZkFaSm5ESHUxadw7QNmXN4pSXPHVP7RaZdbH 48.8942%
    |_2jUmLbTAdaCY4LV2xzb6nh8pAdMZJbbDcZk7Cw1AEVKf 12.2235%
    |_AoB1ZSMc9236xiFLUjJS7bMtYUAXfbQij6Cs35Qjurpm 12.2235%
    |_8BhjmAohJWvCjxrENMxBCr1Rh5mphdSD6YWdRB2SDMnA 12.2235%
    |_GM1ZG15TA1h858naoiLQjw7wycJv8cXfBWbkoZm4F7C4 12.2235%
Security: Score: 55(🟢Low Risk)    
|_Ownership Renounced:❌|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅

Check | Website | App | Community | Twitter
`;
test("Parse Markdown", () => {
  const telegramMarkdown2 = removeMarkdown(signal_message);
  expect(telegramMarkdown2).toBe(removed_markdown_signal);
});

/* ------------------------------------------------------------------ */
/*  Real AVE messages from 2026-07-03                                  */
/* ------------------------------------------------------------------ */

const cjMessage = `
💠 New Solana Pool Launched 💠

Token: CJ (https://solscan.io/token/7XsrVVXftKDpbocq5SX3wQ9QhwiPcqinJ5L1dNHyJvHB)
CA: 7XsrVVXftKDpbocq5SX3wQ9QhwiPcqinJ5L1dNHyJvHB
LP: 9DaysXWoE2vJkENc9d6vrw8nMubxSPFag6EBU772ufTY

Init Price: $0.0{4}529
MCap: $55.09K
Pair: 972.33M CJ / 662.38 SOL
Dex: Pumpfunamm
Liquidity: $107.19K
Insiders: 1(Holdings 0%)
SNIPES: 10  RUSHERS: 0
Token Holders: 10 🐸🐸
    |_9DaysXWoE2vJkENc9d6vrw8nMubxSPFag6EBU772ufTY (https://solscan.io/account/9DaysXWoE2vJkENc9d6vrw8nMubxSPFag6EBU772ufTY) 95.9489%
    |_7KqBEzjJXgxE2a4tu1f34eU8kCBEVnQ1WrafiR8eaFn (https://solscan.io/account/7KqBEzjJXgxE2a4tu1f34eU8kCBEVnQ1WrafiR8eaFn) 2.7231%
    |_4JpdJokjBspd6fgQrFH1n9BRhcTKt15LGVurZqJbyYrU (https://solscan.io/account/4JpdJokjBspd6fgQrFH1n9BRhcTKt15LGVurZqJbyYrU) 1.2907%
    |_5BQh792aCyadgX8qepYuiu79AC97jUkCHJgHrsbDtdVd (https://solscan.io/account/5BQh792aCyadgX8qepYuiu79AC97jUkCHJgHrsbDtdVd) 0.0217%
    |_DfZ1F9h8u5ckyGmydR1CSFXwbtLWk62mxazR9HakbZSF (https://solscan.io/account/DfZ1F9h8u5ckyGmydR1CSFXwbtLWk62mxazR9HakbZSF) 0.002523%
Security: Score: 0(🟢Low Risk)    
|_Ownership Renounced:❌|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅

Check (https://ave.ai/check/7XsrVVXftKDpbocq5SX3wQ9QhwiPcqinJ5L1dNHyJvHB-solana?type=token) | Website (https://ave.ai/) | App (https://ave.ai/download) | Community (https://t.me/aveai_english) | Twitter (https://x.com/aveaiofficial)
`;

const belmarMessage = `
💠 New Solana Pool Launched 💠

Token: Belmar coin (https://solscan.io/token/yEAi5ddRKv43jMAS5hYJi9CWb5VqJRHEPBFaxJcWsTY)
CA: yEAi5ddRKv43jMAS5hYJi9CWb5VqJRHEPBFaxJcWsTY
LP: 67KrS8bg7E3JjDu4Zu8t1mHnLUVq1XXeXQQHqd7PA9JH

Init Price: $0.0001812
MCap: $18.14M
Pair: 133.98M Belmar coin / 300.00 SOL
Dex: Pumpfunamm
Liquidity: $24.23K
Insiders: 5(Holdings 0%)
SNIPES: 2  RUSHERS: 0
Token Holders: 10 🐸🐸
    |_4ncCtyQxPj1k61ZkPrrus8J7vaQY7wZwyfZnYdTH7M3W (https://solscan.io/account/4ncCtyQxPj1k61ZkPrrus8J7vaQY7wZwyfZnYdTH7M3W) 49.933%
    |_9szvHgP9nVXdLJDVJbfBo1TFEv5E4JTTnG1pqYu3k1Zk (https://solscan.io/account/9szvHgP9nVXdLJDVJbfBo1TFEv5E4JTTnG1pqYu3k1Zk) 12.4833%
    |_BquSgBMxLBJwRnoJryuL4WYWivcHuwcbMQ6FBtANYikS (https://solscan.io/account/BquSgBMxLBJwRnoJryuL4WYWivcHuwcbMQ6FBtANYikS) 12.4833%
    |_HXba385rzJKQXwCFVeTcrUUgPERJyXqe3A42cAc6Rohv (https://solscan.io/account/HXba385rzJKQXwCFVeTcrUUgPERJyXqe3A42cAc6Rohv) 12.4833%
    |_2dzQDUkzraWkAEJv3BJkemLZ7iJx5MU7RTRJ1BjUxX3t (https://solscan.io/account/2dzQDUkzraWkAEJv3BJkemLZ7iJx5MU7RTRJ1BjUxX3t) 12.4833%
Security: Score: 0(🟢Low Risk)    
|_Ownership Renounced:❌|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅

Check (https://ave.ai/check/yEAi5ddRKv43jMAS5hYJi9CWb5VqJRHEPBFaxJcWsTY-solana?type=token) | Website (https://ave.ai/) | App (https://ave.ai/download) | Community (https://t.me/aveai_english) | Twitter (https://x.com/aveaiofficial)
`;

const catchuaMessage = `
💠 New Solana Pool Launched 💠

Token: Catchua (https://solscan.io/token/4kbWbbzDZv9KmzKw8Tfo4fo2pN5MQAhUkVVWmCTs16tg)
CA: 4kbWbbzDZv9KmzKw8Tfo4fo2pN5MQAhUkVVWmCTs16tg
LP: 2TEs7gmwwypZCEbamf6Kd9LKJQFNgF7PpGXwK7XP2cqm

Init Price: $0.0{5}9712
MCap: $9.84K
Pair: 999.90M Catchua / 118.00 SOL
Dex: Pumpfunamm
Liquidity: $59.05K
Insiders: 3(Holdings 0%)
SNIPES: 2  RUSHERS: 0
Token Holders: 10 🐸🐸
    |_2TEs7gmwwypZCEbamf6Kd9LKJQFNgF7PpGXwK7XP2cqm (https://solscan.io/account/2TEs7gmwwypZCEbamf6Kd9LKJQFNgF7PpGXwK7XP2cqm) 96.6747%
    |_27keD98NMGCGgTvtD271LPDeLG7hNA5C3byqRydVn8AF (https://solscan.io/account/27keD98NMGCGgTvtD271LPDeLG7hNA5C3byqRydVn8AF) 1.6615%
    |_9F6gWKEf6NB67Fqoh6xkMWrwEYkf12cSKK7MxVhSM9gy (https://solscan.io/account/9F6gWKEf6NB67Fqoh6xkMWrwEYkf12cSKK7MxVhSM9gy) 1.6071%
    |_FURrDAcbpHQVW3x4wzzNNKaJuQPqYN6aKHzbb211Dnzn (https://solscan.io/account/FURrDAcbpHQVW3x4wzzNNKaJuQPqYN6aKHzbb211Dnzn) 0.009156%
    |_8dhdJ7dHKznjoUhk7m4gPNkjVLTtcr4H5cYHHjgVZRJ9 (https://solscan.io/account/8dhdJ7dHKznjoUhk7m4gPNkjVLTtcr4H5cYHHjgVZRJ9) 0.00711%
Security: Score: 0(🟢Low Risk)    
|_Ownership Renounced:❌|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅

Check (https://ave.ai/check/4kbWbbzDZv9KmzKw8Tfo4fo2pN5MQAhUkVVWmCTs16tg-solana?type=token) | Website (https://ave.ai/) | App (https://ave.ai/download) | Community (https://t.me/aveai_english) | Twitter (https://x.com/aveaiofficial)
`;

const otkenMessage = `
💠 New Solana Pool Launched 💠

Token: OTKEN (https://solscan.io/token/zE4MNPTMS9uLJntHMx7t81ogw4wAwWbZHyL3uWW1TYs)
CA: zE4MNPTMS9uLJntHMx7t81ogw4wAwWbZHyL3uWW1TYs
LP: 83D72o9zAVFcrY2k6DeY9TsRbrZvBUutL37gzM2ckDRd

Init Price: $0.002921
MCap: $0.00
Pair: 8.31M OTKEN / 300.00 SOL
Dex: Pumpfunamm
Liquidity: $24.21K
Insiders: 5(Holdings 0%)
SNIPES: 1  RUSHERS: 0
Token Holders: 10 🐸🐸
    |_8CT9EpqMkekRbXSdjXDEd3x59t7rDKUZ7HHzmucaJFwq (https://solscan.io/account/8CT9EpqMkekRbXSdjXDEd3x59t7rDKUZ7HHzmucaJFwq) 49.9958%
    |_uC928up6iBG4UmmfrBzcLF5tadDwN977VL7rfFSkq4s (https://solscan.io/account/uC928up6iBG4UmmfrBzcLF5tadDwN977VL7rfFSkq4s) 12.499%
    |_AtQVWdkCZGTy2JvehZqcPWa7EyJ9LQUji4oqkNaeC16W (https://solscan.io/account/AtQVWdkCZGTy2JvehZqcPWa7EyJ9LQUji4oqkNaeC16W) 12.499%
    |_A1Z7EsWnG5YiakZEiVeK4kDNPQu4gBqkD8xJ9DnWvgKa (https://solscan.io/account/A1Z7EsWnG5YiakZEiVeK4kDNPQu4gBqkD8xJ9DnWvgKa) 12.499%
    |_3wLuWsQ68ZbYtEm5B6oeAYAZU4Cy1Ntq5JNEnJAKWqdp (https://solscan.io/account/3wLuWsQ68ZbYtEm5B6oeAYAZU4Cy1Ntq5JNEnJAKWqdp) 12.499%
Security: Score: 0(🟢Low Risk)    
|_Ownership Renounced:❌|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅

Check (https://ave.ai/check/zE4MNPTMS9uLJntHMx7t81ogw4wAwWbZHyL3uWW1TYs-solana?type=token) | Website (https://ave.ai/) | App (https://ave.ai/download) | Community (https://t.me/aveai_english) | Twitter (https://x.com/aveaiofficial)
`;

const bwullMessage = `
💠 New Solana Pool Launched 💠

Token: Bwull (https://solscan.io/token/FTjS9S2V9aXaiLngjNRYffmh7kfFWUzWVVqk1hH4pump)
CA: FTjS9S2V9aXaiLngjNRYffmh7kfFWUzWVVqk1hH4pump
LP: FEDRVUjgrciTaB8oXeewjsM8gS7uSa7jiwp4yMxbNWfh

Init Price: $0.0{4}3369
MCap: $43.20K
Pair: 179.70M Bwull / 97.94 SOL
Dex: Pumpfunamm
Liquidity: $15.82K
Insiders: 1(Holdings 0%)
SNIPES: 1  RUSHERS: 0
Token Holders: 10 🐸🐸
    |_34jE9QjyQfTbKYh7TVsRzKh1Tt9KKoSd68NWiEEQKU1y (https://solscan.io/account/34jE9QjyQfTbKYh7TVsRzKh1Tt9KKoSd68NWiEEQKU1y) 40.203%
    |_FEDRVUjgrciTaB8oXeewjsM8gS7uSa7jiwp4yMxbNWfh (https://solscan.io/account/FEDRVUjgrciTaB8oXeewjsM8gS7uSa7jiwp4yMxbNWfh) 18.4908%
    |_GEMMJVdPnsDJa9Y36VvQ7c5F4j1AciFdYV26fmB9N5Sv (https://solscan.io/account/GEMMJVdPnsDJa9Y36VvQ7c5F4j1AciFdYV26fmB9N5Sv) 2.9241%
    |_D5CY5ZZv41s2cGBdMEjKg7WfdgTf7f5kw86RhWbLQEC1 (https://solscan.io/account/D5CY5ZZv41s2cGBdMEjKg7WfdgTf7f5kw86RhWbLQEC1) 2.7899%
    |_JTbhe78ua7BFS3jm9oGK5nNEoTcaj58WvnKfHS3oGaB (https://solscan.io/account/JTbhe78ua7BFS3jm9oGK5nNEoTcaj58WvnKfHS3oGaB) 2.6292%
Security: Score: 55(🟢Low Risk)    
|_Ownership Renounced:❌|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅

Check (https://ave.ai/check/FTjS9S2V9aXaiLngjNRYffmh7kfFWUzWVVqk1hH4pump-solana?type=token) | Website (https://ave.ai/) | App (https://ave.ai/download) | Community (https://t.me/aveai_english) | Twitter (https://x.com/aveaiofficial)
`;

const ansemMessage = `
💠 New Solana Pool Launched 💠

Token: ANSEM (https://solscan.io/token/FY3jpX1SspRtCa83e6qLqGTZer5HZ6AeuzpqPiqEUEPv)
CA: FY3jpX1SspRtCa83e6qLqGTZer5HZ6AeuzpqPiqEUEPv
LP: CDKTXkmUGtM6tZuFP1Dq7CHSoaa4q8qN4BHSXiHE9KV1

Init Price: $0.004037
MCap: $4.04M
Pair: 329.34K ANSEM / 16.47 SOL
Dex: Meteoradammv2
Liquidity: $2.66K
Insiders: 101(Holdings 0%)
SNIPES: 1  RUSHERS: 0
Token Holders: 138 🐸🐸🐸🐸🐸🐸🐸🐸🐸🐸🐸🐸🐸🐸
    |_FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM (https://solscan.io/account/FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM) 90.025%
    |_FFqhWGJCUiWta7Ek9me2wgMnm9FCDUhPpkP6CexME9VG (https://solscan.io/account/FFqhWGJCUiWta7Ek9me2wgMnm9FCDUhPpkP6CexME9VG) 2.1449%
    |_rk4jdi7srE6VKtxPeCKnqpEe7uJdZLLdpv1qAPK8LRd (https://solscan.io/account/rk4jdi7srE6VKtxPeCKnqpEe7uJdZLLdpv1qAPK8LRd) 0.07788%
    |_jdB3qwWuvuzZhyRj3xZtjNLqkekCUSoL7jDwr1CRzaG (https://solscan.io/account/jdB3qwWuvuzZhyRj3xZtjNLqkekCUSoL7jDwr1CRzaG) 0.07788%
    |_e4LGCcSEQzM4bkYZYSeKHy4AiThmd9TRMr3LmehosnL (https://solscan.io/account/e4LGCcSEQzM4bkYZYSeKHy4AiThmd9TRMr3LmehosnL) 0.07788%
Security: Score: 0(🟢Low Risk)    
|_Ownership Renounced:❌|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅

Check (https://ave.ai/check/FY3jpX1SspRtCa83e6qLqGTZer5HZ6AeuzpqPiqEUEPv-solana?type=token) | Website (https://ave.ai/) | App (https://ave.ai/download) | Community (https://t.me/aveai_english) | Twitter (https://x.com/aveaiofficial)
`;

const womanMessage = `
💠 New Solana Pool Launched 💠

Token: Woman (https://solscan.io/token/Ei6xfWXbQWj1KGQjw1RN8T4aTWPab5U7MMzM92evpump)
CA: Ei6xfWXbQWj1KGQjw1RN8T4aTWPab5U7MMzM92evpump
LP: 8AznXz1wMj1PdCjM7ipZBbHpKCUSw218bJGouQ1mRnRa

Init Price: $0.0{5}232
MCap: $2.32K
Pair: 983.81M Woman / 0.46 SOL
Dex: Pump
Liquidity: $2.32K
Insiders: 0(Holdings 0%)
SNIPES: 1  RUSHERS: 0
Token Holders: 2 🐸
    |_8AznXz1wMj1PdCjM7ipZBbHpKCUSw218bJGouQ1mRnRa (https://solscan.io/account/8AznXz1wMj1PdCjM7ipZBbHpKCUSw218bJGouQ1mRnRa) 98.3811%
    |_Dk9Dr1JVeodbi5MiUbyb4YrAKKcycFJvcdeTTU7y9D2o (https://solscan.io/account/Dk9Dr1JVeodbi5MiUbyb4YrAKKcycFJvcdeTTU7y9D2o) 1.6189%
Security: Score: 0(🟢Low Risk)    
|_Ownership Renounced:❌|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅

Check (https://ave.ai/check/Ei6xfWXbQWj1KGQjw1RN8T4aTWPab5U7MMzM92evpump-solana?type=token) | Website (https://ave.ai/) | App (https://ave.ai/download) | Community (https://t.me/aveai_english) | Twitter (https://x.com/aveaiofficial) | Pump.fun (https://pump.fun/)
`;

const dataMessage = `
💠 New Solana Pool Launched 💠

Token: DATA (https://solscan.io/token/CdK6Cpi3LTcEKN3jD8RXLPLJyD72xZ3Q5HY1exCq3mHf)
CA: CdK6Cpi3LTcEKN3jD8RXLPLJyD72xZ3Q5HY1exCq3mHf
LP: GGNnVkbg2iJ28pNDitHjwUpEASwTbGJnXyUhBywizqrm

Init Price: $0.0{5}692
MCap: $7.04K
Pair: 993.43M DATA / 85.55 SOL
Dex: Pumpfunamm
Liquidity: $13.82K
Insiders: 1(Holdings 0%)
SNIPES: 3  RUSHERS: 0
Token Holders: 10 🐸🐸
    |_GGNnVkbg2iJ28pNDitHjwUpEASwTbGJnXyUhBywizqrm (https://solscan.io/account/GGNnVkbg2iJ28pNDitHjwUpEASwTbGJnXyUhBywizqrm) 97.8399%
    |_8kyZw9Ki8BLGnsHkq6FgNa8NbuAznyWccjyramBGGS56 (https://solscan.io/account/8kyZw9Ki8BLGnsHkq6FgNa8NbuAznyWccjyramBGGS56) 0.6602%
    |_FwgmBv3Xy1bfHbsd7DUrwLgf7GUTibaccNe6ct5VDgBi (https://solscan.io/account/FwgmBv3Xy1bfHbsd7DUrwLgf7GUTibaccNe6ct5VDgBi) 0.6564%
    |_7vT2kQpUDjkNhvCENnNiA2xbCc1xVaa1joyW2fHieurE (https://solscan.io/account/7vT2kQpUDjkNhvCENnNiA2xbCc1xVaa1joyW2fHieurE) 0.4995%
    |_3wcoJrVV3RuQyqM68Xo7uya4VGbtthevQCpS7rABcq2b (https://solscan.io/account/3wcoJrVV3RuQyqM68Xo7uya4VGbtthevQCpS7rABcq2b) 0.3426%
Security: Score: 0(🟢Low Risk)    
|_Ownership Renounced:❌|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅

Check (https://ave.ai/check/CdK6Cpi3LTcEKN3jD8RXLPLJyD72xZ3Q5HY1exCq3mHf-solana?type=token) | Website (https://ave.ai/) | App (https://ave.ai/download) | Community (https://t.me/aveai_english) | Twitter (https://x.com/aveaiofficial)
`;

const dreamMessage = `
💠 New Solana Pool Launched 💠

Token: Dream (https://solscan.io/token/Dr9Tt3FG1TgNpgCLRxc4Ff3dpp5fGwpfWcmrTJG9Zc9N)
CA: Dr9Tt3FG1TgNpgCLRxc4Ff3dpp5fGwpfWcmrTJG9Zc9N
LP: 3tzvmX2FSXcCuo37U7oRcFP15s3pGFo86ubnehZfHpfF

Init Price: $0.0{5}6883
MCap: $0.00
Pair: 1000.00M Dream / 84.99 SOL
Dex: Pumpfunamm
Liquidity: $6.86K
Insiders: 1(Holdings 0%)
SNIPES: 1  RUSHERS: 0
Token Holders: 9 🐸
    |_3tzvmX2FSXcCuo37U7oRcFP15s3pGFo86ubnehZfHpfF (https://solscan.io/account/3tzvmX2FSXcCuo37U7oRcFP15s3pGFo86ubnehZfHpfF) 99.9999%
    |_3KcPSJ8ouE7H1feoWHmhDwXhLnXhpxP6R6713uytFmBM (https://solscan.io/account/3KcPSJ8ouE7H1feoWHmhDwXhLnXhpxP6R6713uytFmBM) 0.0{4}7038%
    |_27HFmP7ccLadGswvQfvea4o3juLw75cPF4V6jWpHM3MX (https://solscan.io/account/27HFmP7ccLadGswvQfvea4o3juLw75cPF4V6jWpHM3MX) 0.0{4}2346%
    |_kiwiC4pg5mC4N5AhpXc4Av3V6oV7Sn2p3CqB7NeHbJJ (https://solscan.io/account/kiwiC4pg5mC4N5AhpXc4Av3V6oV7Sn2p3CqB7NeHbJJ) 0.0{4}1759%
    |_Fs9RN3wAsuJKPbTmtX5eek1bhW5krNH8RkQxkFAtgNfR (https://solscan.io/account/Fs9RN3wAsuJKPbTmtX5eek1bhW5krNH8RkQxkFAtgNfR) 0.0{4}1173%
Security: Score: 0(🟢Low Risk)    
|_Ownership Renounced:❌|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅

Check (https://ave.ai/check/Dr9Tt3FG1TgNpgCLRxc4Ff3dpp5fGwpfWcmrTJG9Zc9N-solana?type=token) | Website (https://ave.ai/) | App (https://ave.ai/download) | Community (https://t.me/aveai_english) | Twitter (https://x.com/aveaiofficial)
`;

const spamMessage = `
💠 New Solana Pool Launched 💠

Token: SPAM (https://solscan.io/token/6UH3ErgmGruNxemPbxrqeRvD8YmSu2hsTeWLk9tCrQ22)
CA: 6UH3ErgmGruNxemPbxrqeRvD8YmSu2hsTeWLk9tCrQ22
LP: B7Suq7YpvoYAWopM7n85uNwCG4DEoqE13wMRkUT1kgnt

Init Price: $0.0{4}3219
MCap: $28.16K
Pair: 206.90M SPAM / 84.99 SOL
Dex: Pumpfunamm
Liquidity: $13.73K
Insiders: 8(Holdings 0%)
SNIPES: 14  RUSHERS: 0
Token Holders: 10 🐸🐸
    |_B7Suq7YpvoYAWopM7n85uNwCG4DEoqE13wMRkUT1kgnt (https://solscan.io/account/B7Suq7YpvoYAWopM7n85uNwCG4DEoqE13wMRkUT1kgnt) 27.3649%
    |_bwamJzztZsepfkteWRChggmXuiiCQvpLqPietdNfSXa (https://solscan.io/account/bwamJzztZsepfkteWRChggmXuiiCQvpLqPietdNfSXa) 15.1657%
    |_2BzwH4h3PH5iBnMHmLeXciEzwtXjR5zQazsuZzQz9wyn (https://solscan.io/account/2BzwH4h3PH5iBnMHmLeXciEzwtXjR5zQazsuZzQz9wyn) 6.2404%
    |_GSCSm1PRiSUewqR3fbDFN5f9Y6bHmsEgX1RezskiXiee (https://solscan.io/account/GSCSm1PRiSUewqR3fbDFN5f9Y6bHmsEgX1RezskiXiee) 4.6917%
    |_CEUA7zVoDRqRYoeHTP58UHU6TR8yvtVbeLrX1dppqoXJ (https://solscan.io/account/CEUA7zVoDRqRYoeHTP58UHU6TR8yvtVbeLrX1dppqoXJ) 4.0253%
Security: Score: 55(🟢Low Risk)    
|_Ownership Renounced:❌|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅

Check (https://ave.ai/check/6UH3ErgmGruNxemPbxrqeRvD8YmSu2hsTeWLk9tCrQ22-solana?type=token) | Website (https://ave.ai/) | App (https://ave.ai/download) | Community (https://t.me/aveai_english) | Twitter (https://x.com/aveaiofficial)
`;

test("parse CJ signal", () => {
  const r = parseSolanaPoolSignal(cjMessage);
  expect(r.tokenName).toBe("CJ");
  expect(r.contractAddress).toBe("7XsrVVXftKDpbocq5SX3wQ9QhwiPcqinJ5L1dNHyJvHB");
  expect(r.initPrice).toBe(0.0000529);
  expect(r.marketCapUsd).toBe(55090);
  expect(r.pairTokenAmount).toBe(972330000);
  expect(r.pairSolAmount).toBe(662.38);
  expect(r.liquidityUsd).toBe(107190);
  expect(r.insiders).toBe(1);
  expect(r.snipes).toBe(10);
  expect(r.holders!.length).toBe(5);
  expect(r.security.score).toBe(0);
  expect(r.dex).toBe("Pumpfunamm");
});

test("parse Belmar coin signal", () => {
  const r = parseSolanaPoolSignal(belmarMessage);
  expect(r.tokenName).toBe("Belmar coin");
  expect(r.initPrice).toBe(0.0001812);
  expect(r.marketCapUsd).toBe(18140000);
  expect(r.liquidityUsd).toBe(24230);
  expect(r.insiders).toBe(5);
  expect(r.holders!.length).toBe(5);
});

test("parse Catchua signal", () => {
  const r = parseSolanaPoolSignal(catchuaMessage);
  expect(r.tokenName).toBe("Catchua");
  expect(r.initPrice).toBe(0.000009712);
  expect(r.pairSolAmount).toBe(118);
  expect(r.liquidityUsd).toBe(59050);
  expect(r.insiders).toBe(3);
});

test("parse OTKEN signal (MCap $0.00)", () => {
  const r = parseSolanaPoolSignal(otkenMessage);
  expect(r.tokenName).toBe("OTKEN");
  expect(r.marketCapUsd).toBe(0);
  expect(r.initPrice).toBe(0.002921);
  expect(r.pairTokenAmount).toBe(8310000);
  expect(r.pairSolAmount).toBe(300);
});

test("parse Bwull signal (Score 55)", () => {
  const r = parseSolanaPoolSignal(bwullMessage);
  expect(r.tokenName).toBe("Bwull");
  expect(r.security.score).toBe(55);
  expect(r.security.risk).toBe("Low Risk");
  expect(r.initPrice).toBe(0.00003369);
  expect(r.marketCapUsd).toBe(43200);
});

test("parse ANSEM signal (K pair, Meteoradammv2)", () => {
  const r = parseSolanaPoolSignal(ansemMessage);
  expect(r.tokenName).toBe("ANSEM");
  expect(r.dex).toBe("Meteoradammv2");
  expect(r.pairTokenAmount).toBe(329340);
  expect(r.pairSolAmount).toBe(16.47);
  expect(r.marketCapUsd).toBe(4040000);
  expect(r.insiders).toBe(101);
  expect(r.holderCount).toBe(138);
  expect(r.holders!.length).toBe(5);
});

test("parse Woman signal (2 holders, Pump.fun link)", () => {
  const r = parseSolanaPoolSignal(womanMessage);
  expect(r.tokenName).toBe("Woman");
  expect(r.dex).toBe("Pump");
  expect(r.initPrice).toBe(0.00000232);
  expect(r.holderCount).toBe(2);
  expect(r.holders!.length).toBe(2);
  expect(r.links?.twitter).toBe("https://x.com/aveaiofficial");
  expect(r.links?.website).toBe("https://ave.ai/");
});

test("parse DATA signal", () => {
  const r = parseSolanaPoolSignal(dataMessage);
  expect(r.tokenName).toBe("DATA");
  expect(r.initPrice).toBe(0.00000692);
  expect(r.marketCapUsd).toBe(7040);
  expect(r.holders!.length).toBe(5);
});

test("parse Dream signal (0.0{5}6883 + 0.0{4}7038 holder%)", () => {
  const r = parseSolanaPoolSignal(dreamMessage);
  expect(r.tokenName).toBe("Dream");
  expect(r.initPrice).toBe(0.000006883);
  expect(r.marketCapUsd).toBe(0);
  expect(r.holderCount).toBe(9);
  expect(r.holders!.length).toBe(5);
  expect(r.holders![1]!.percentage).toBe(0.00007038);
  expect(r.holders![2]!.percentage).toBe(0.00002346);
});

test("parse SPAM signal (Score 55, 14 snipes)", () => {
  const r = parseSolanaPoolSignal(spamMessage);
  expect(r.tokenName).toBe("SPAM");
  expect(r.security.score).toBe(55);
  expect(r.snipes).toBe(14);
  expect(r.insiders).toBe(8);
  expect(r.initPrice).toBe(0.00003219);
});

/* ------------------------------------------------------------------ */
/*  Edge case: signal with no "Token Holders" line                     */
/* ------------------------------------------------------------------ */

const usa250Message = `
💠 New Solana Pool Launched 💠

Token: USA250 (https://solscan.io/token/D49tCt3GB8Q8HYYK35ojTq3f6y1XaS6FgjJ8j3zNDwf1)
CA: D49tCt3GB8Q8HYYK35ojTq3f6y1XaS6FgjJ8j3zNDwf1
LP: 4hUVL83mUEziZJgwDZbFrctandUWEqtap6DvFmHYDWkw

Init Price: $0.02112
MCap: $0.00
Pair: 22.77K USA250 / 996.02 SOL
Dex: Meteoradammv2
Liquidity: $176.18K
Insiders: 1(Holdings 0%)
SNIPES: 3  RUSHERS: 0
Security: Score: 0(🟢Low Risk)    
|_Ownership Renounced:❌|Top10 holdings<30%: ✅|Stop mint:✅|No Blacklist:✅

Check (https://ave.ai/check/D49tCt3GB8Q8HYYK35ojTq3f6y1XaS6FgjJ8j3zNDwf1-solana?type=token) | Website (https://ave.ai/) | App (https://ave.ai/download) | Community (https://t.me/aveai_english) | Twitter (https://x.com/aveaiofficial)
`;

test("parse USA250 signal (no Token Holders line)", () => {
  const r = parseSolanaPoolSignal(usa250Message);
  expect(r.tokenName).toBe("USA250");
  expect(r.contractAddress).toBe("D49tCt3GB8Q8HYYK35ojTq3f6y1XaS6FgjJ8j3zNDwf1");
  expect(r.initPrice).toBe(0.02112);
  expect(r.marketCapUsd).toBe(0);
  expect(r.pairTokenAmount).toBe(22770);
  expect(r.pairSolAmount).toBe(996.02);
  expect(r.dex).toBe("Meteoradammv2");
  expect(r.liquidityUsd).toBe(176180);
  expect(r.insiders).toBe(1);
  expect(r.snipes).toBe(3);
  expect(r.holderCount).toBeUndefined();
  expect(r.holders).toEqual([]);
  expect(r.security.score).toBe(0);
});
