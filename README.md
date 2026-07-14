# DBotX Trade Bot

Telegram-signal-driven Solana trading bot. Listens to Ave Solana Token Scanner / @SOLTRENDING signals, executes trades via DBotX API (simulator or live), manages exits with TP/SL/trailing/partial/TTL, and reports to Telegram.

## Quick Start

```bash
cp .env.example .env    # fill in your keys
bun install
bun start               # production
LOG_LEVEL=debug bun dev # verbose
```

First run requires Telegram phone + code for MTProto auth (cached in `telegram_session/`).

## Key Config

| Variable | Default | Description |
|---|---|---|
| `LIVE_MODE` | `false` | `true` = live trades, `false` = simulator |
| `POSITION_SIZE_SOL` | `0.10` | SOL per position |
| `STOP_LOSS_PERCENT` | `-15` | Stop loss trigger |
| `TRAILING_ACTIVATION_PERCENT` | `15` | % gain to activate trailing |
| `TRAILING_STOP_PERCENT` | `8` | Trail distance from peak |
| `PARTIAL_TP_TIERS` | `25@30,25@60,25@100` | Tiered take-profit |
| `BASE_TTL_SECS` | `90` | Position expiry |
| `MAX_POSITIONS` | `5` | Concurrent positions |
| `LIVE_WALLET_ID` | — | Required for live mode |
| `LIVE_WALLET_ADDRESS` | — | Required for live mode |
| `LIVE_MODE` | `false` | `true` = live trades via DBotX automated API |
| `RECOVERY_FETCH_PAGE_SIZE` | `20` | Trades per page during startup recovery |
| `LIVE_DB_PATH` | `./data/live_trading.json` | JSON store for order/position metadata |

## Live Module

`src/trading/live/` — JSON-persisted order store (`store.ts`), SOL balance polling (`account.ts`), swap-order submission with task polling (`trading.ts`), trade-result WebSocket consumer with Telegram notifications (`trade-ws.ts`), and startup recovery from store or API (`recovery.ts`).

Tests: `bun test src/trading/live/`

## Build

```bash
bun run build   # single binary → ./dbotx_bot
```
