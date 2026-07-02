# dbotx\_trade — Simulate Mode

RxJS-streaming paper-trading bot for Solana tokens, driven by AVE Scanner Telegram signals and the DBotX simulator API.

## Quick Start

```bash
cp .env.example .env   # edit credentials
bun install
bun run src/main.ts
```

## Architecture

```
Telegram (AVE) ──→ signals_stream ──→ position_manager ──→ DBotX Sim API
                       │                    │
                       ↓                    ↓
                 SQLite (analytics)    Telegram reporter
```

- **signals\_stream** — Signal dedup with 1h cleanup TTL, `acceptedSignal$` output, `latestSignalState` snapshot for WS re-subscribe.
- **position\_manager** — scan-based reactive store, signal queue (FIFO, configurable size), TP/SL task polling, trade pair polling, trailing stop monitor, TTL expiry with profit-based renewal.
- **fast\_buy\_sell** — `simFastBuy` / `simFastSell` wrappers with exponential-backoff retry.
- **http** — `fetchWithRetry`: 30s timeout, 4 retries (1→2→4→8→16s backoff), retries on 429/5xx.
- **telegram\_bot\_reporter** — grammY bot: real-time open/close alerts, periodic PnL report, start/stop/crash notifications.
- **telegram\_listener** — teleproto MTProto client with auto-reconnect; listens to AVE Scanner channel.
- **analytics** — SQLite (Bun), trade persistence, win-rate / PnL reports, daily loss limit query.
- **market/dbotx\_data\_ws** — Reactive WebSocket client with auto-reconnect, heartbeat ping, active-pair re-subscription on reconnect.

## Key Features

| Feature | Detail |
|---|---|
| Partial TP ladder | Configurable tiers + backstop TP for remainder |
| Trailing stop | Client-side via WS price feed; configurable activation/dist |
| TTL expiry | Auto-close positions after N seconds |
| TTL renewal | Resets clock if profit exceeds threshold |
| Signal queue | FIFO queue for signals arriving at max positions; dequeued on close |
| Daily loss limit | Skips signals after USD loss threshold (0 = disabled) |
| Startup recovery | Rebuilds open positions from API on boot |
| Pending-buy dedup | 60s guard prevents double-buy on timeout-retry |
| Exponential backoff | `fetchWithRetry`: 30s timeout, 4 retries |
| Reconnection | WS auto-reconnect + re-subscribe; Telegram auto-reconnect |

## Telegram Messages

- **\u{1F680} Bot Started** — Config summary on boot (TTL, exit settings, queue size)
- **\u{1F7E2} Position Opened / Closed** — Per-position alerts with PnL, reason, duration, open count (X/Y)
- **\u{1F4CA} Performance Report** — Periodic summary (every `TELEGRAM_REPORT_INTERVAL_MINUTES`) with win rate, PnL, close reasons
- **\u{1F6D1} Bot Stopped / \u{1F4A5} Bot Crashed** — Shutdown summary with full report

## Configuration

All settings in `.env`:

| Var | Default | Description |
|---|---|---|
| `POSITION_SIZE_SOL` | `0.10` | SOL per trade |
| `MAX_POSITIONS` | `5` | Max concurrent open positions |
| `TTL_POSITION_SECONDS` | `120` | Auto-close position after N seconds |
| `TTL_RENEWAL_PROFIT_PERCENT` | `3` | Profit threshold (%) to reset TTL clock |
| `SIGNAL_QUEUE_SIZE` | `20` | Max queued signals when at max positions |
| `PARTIAL_TP_TIERS` | — | e.g. `30@20,40@50` (sell 30% at +20%, 40% at +50%) |
| `PAPER_STOP_LOSS_PERCENT` | `-15` | Stop loss trigger |
| `PAPER_BACKSTOP_TP_PERCENT` | `500` | TP for remaining position after partial tiers |
| `PAPER_TRAILING_ACTIVATION_PERCENT` | `25` | Gain % before trail engages |
| `PAPER_TRAILING_STOP_PERCENT` | `5` | Trail distance from peak |
| `PAPER_MAX_SLIPPAGE_EXIT_PERCENT` | `80` | Max loss per trade before panic exit |
| `DAILY_LOSS_LIMIT_USD` | `0` | Daily max loss before skipping signals (0 = disabled) |
| `TELEGRAM_REPORT_INTERVAL_MINUTES` | `5` | Periodic report interval |
| `SQLITE_PATH` | `./data/paper_trading.sqlite` | Analytics database path |
| `LOG_LEVEL` | `info` | Console log verbosity |

## Development

```bash
npx tsc --noEmit   # type-check
bun test           # run tests
```
