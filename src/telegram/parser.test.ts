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
});

test("parse abbreviated values", () => {
  expect(parseAbbreviatedUsd("$6.44K")).toBe(6440);

  expect(parseAbbreviatedUsd("846.71M")).toBe(846710000);

  expect(parseAbbreviatedUsd("$376.63")).toBe(376.63);
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
