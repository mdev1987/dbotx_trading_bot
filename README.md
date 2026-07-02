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

- **signals\_stream** — TTL/FIFO signal dedup, `acceptedSignal$` output.
- **position\_manager** — scan-based store, TP/SL polling, trailing stop, expiry.
- **fast\_buy\_sell** — `simFastBuy` / `simFastSell` wrappers with retry.
- **telegram\_bot\_reporter** — grammY bot, real-time open/close alerts, periodic PnL report.
- **analytics** — SQLite (Bun), trade persistence, win rate / PnL reports.

## Key Features

| Feature | Detail |
|---|---|
| Partial TP ladder | Configurable tiers, backstop TP |
| Trailing stop | Client-side via WS price feed |
| Daily loss limit | Skips signals after threshold (DAILY\_LOSS\_LIMIT\_USD) |
| Startup recovery | Rebuilds open positions from API on boot |
| Pending-buy dedup | 60s TTL set prevents double-buy on timeout-retry |
| Exponential backoff | fetchWithRetry: 30s timeout, 4 retries (1→2→4→8→16s) |

## Configuration

All settings in `.env`. Key variables:

| Var | Default | Description |
|---|---|---|
| `POSITION_SIZE_SOL` | `0.10` | SOL per trade |
| `MAX_POSITIONS` | `5` | Max concurrent open positions |
| `TTL_POSITION_SECONDS` | `600` | Auto-close position after N seconds |
| `PARTIAL_TP_TIERS` | — | e.g. `30@20,40@50` |
| `PAPER_STOP_LOSS_PERCENT` | `-15` | Stop loss trigger |
| `PAPER_TRAILING_ACTIVATION_PERCENT` | `25` | Gain % before trail engages |
| `PAPER_TRAILING_STOP_PERCENT` | `5` | Trail distance from peak |
| `DAILY_LOSS_LIMIT_USD` | `0` | Daily max loss (0 = disabled) |

## Development

```bash
npx tsc --noEmit   # type-check
bun test           # run tests
```
