# DBotX Paper Trader (Research Edition)

A research-grade paper trading bot for Solana memecoins via DBotX WebSocket API.
Every new token gets bought automatically with a fixed position size — no filtering,
no selection bias. The result is a clean dataset for discovering what on-chain signals
actually predict profitable outcomes.

## Architecture

```
src/
├── config.ts          – All env vars, parsed on startup
├── db.ts              – SQLite schema + all queries (wallet, tokens, trades, snapshots, raw_events, partial_fills)
├── models.ts          – TypeScript types for wire protocol + internal rows
├── dbotx_client.ts    – WebSocket client: subscribes newPairInfo globally, pairInfo per token
├── paper_wallet.ts    – Paper trade execution (open, update, close)
├── recorder.ts        – Raw event log + normalised snapshot storage
├── ttl_engine.ts      – Exit logic: partial TP → trailing stop → backstop TP → TTL → SL
├── reporter.ts        – Periodic Telegram report (grammy) — PnL, exit counts, best/worst signal profiles
├── analytics.ts       – Offline research queries (Sharpe, drawdown, bucket analysis)
└── main.ts            – Orchestrator
```

## Setup

```bash
# 1. Install dependencies
bun install

# 2. Copy and configure environment
cp .env .env.local   # edit with your DBotX API key and Telegram token

# Required:
#   DBOTX_API_KEY=your_key
#   DBOTX_WS_URL=wss://api-data-v1.dbotx.com/data/ws/
#
# Optional (Telegram reporting):
#   TELEGRAM_BOT_TOKEN=your_bot_token
#   TELEGRAM_CHAT_ID=your_chat_id

# 3. Run
bun run src/main.ts
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `DBOTX_API_KEY` | — | DBotX API key |
| `DBOTX_WS_URL` | `wss://api-data-v1.dbotx.com/data/ws/` | WebSocket endpoint |
| `PAPER_STARTING_BALANCE_SOL` | `1000` | Initial paper wallet balance |
| `PAPER_POSITION_SIZE_SOL` | `0.10` | SOL per trade |
| `PAPER_MAX_OPEN_TRADES` | `1000` | Concurrency limit |
| `PAPER_TTL_SECONDS` | `600` | Max hold time per trade |
| `PARTIAL_TP_TIERS` | `30@20,40@50` | Sell 30% at +20%, 40% at +50% |
| `PAPER_BACKSTOP_TP_PERCENT` | `500` | Full-position TP (rarely hit) |
| `PAPER_STOP_LOSS_PERCENT` | `-15` | Hard stop loss |
| `PAPER_TRAILING_ACTIVATION_PERCENT` | `25` | Gain needed to activate trailing |
| `PAPER_TRAILING_STOP_PERCENT` | `5` | Trailing distance from peak |
| `PAPER_MAX_SLIPPAGE_EXIT_PERCENT` | `80` | Panic exit at extreme drawdown |
| `SQLITE_PATH` | `./data/paper_trading.sqlite` | Database location |
| `SAVE_RAW_JSON` | `true` | Store every WS payload verbatim |
| `TELEGRAM_BOT_TOKEN` | — | Grammy bot token (opt-in) |
| `TELEGRAM_CHAT_ID` | — | Target chat ID (opt-in) |
| `TELEGRAM_REPORT_INTERVAL_MINUTES` | `5` | Report frequency |

## Exit Logic (evaluation order)

1. **Slippage exit** — if unrealised PnL ≤ `-80%`, panic close remaining
2. **Partial TP** — for each unfilled tier, sell the configured % of original position when the PnL target is reached
3. **Trailing stop** — activates after gain ≥ 25%; if price drops 5% from peak, close remaining
4. **Backstop TP** — close remaining at +500% (rarely reached)
5. **TTL** — close remaining after 600s
6. **Stop loss** — close remaining at -15%

## Data Philosophy

```
Store raw websocket JSON forever. Normalise later.
```

Every `pairInfo` and `newPairInfo` payload is written to `raw_events` as-is before any
processing. The `snapshots` table preserves normalised columns alongside the original
`raw_json`. If DBotX adds new fields tomorrow, your historical dataset remains usable.

## Analytics

After collecting trades, run queries interactively:

```bash
bun repl
```

```ts
import { summary, ttlAnalysis, holderAnalysis, sharpeRatio } from "./src/analytics";

console.log(await summary());
console.log(await ttlAnalysis());
console.log(await sharpeRatio());
```

## Telegram Report

If `TELEGRAM_BOT_TOKEN` is set, a periodic summary is sent to the configured chat:

```
🤖 Paper Trader Report
2026-06-30T12:00:00.000Z

🟢 PnL: +2.3450 SOL (+3.45%)
💰 Balance: 950.0000 SOL

✅ Wins: 45  ❌ Losses: 32  WR: 58.4%
🏆 Best: +85.00%  🪤 Worst: -92.00%
📈 Won: +12.5 SOL  📉 Lost: -8.2 SOL

📊 Tx: 100  🟢 Open: 23  🔵 Closed: 77
⏱ TTL: 30  🎯 TP: 12  🛑 SL: 28  🔁 Trail: 5  💥 Slip: 2
📦 Partial TP fills: 15

🏆 Best signal profile
   📊 avg PnL: +12.34%  (n=25)
   Holders: 142  MCap: $45k  Liq: 12.5 SOL
   Top10: 15.0%  Dev: 2.1%  Δ1m: +8.5%

🪤 Worst signal profile
   📊 avg PnL: -18.56%  (n=25)
   Holders: 12  MCap: $3k  Liq: 0.5 SOL
   Top10: 65.0%  Dev: 18.0%  Δ1m: -5.2%
```
