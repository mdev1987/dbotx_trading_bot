# DBotX Trade Bot

Telegram-signal-driven Solana trading bot. Listens to Ave Solana Token Scanner signals, executes trades via **PumpAPI** (default, 0.25% fee) or **DBotX** (0.6% fee), manages exits with TP/SL/trailing/partial/TTL, and reports to Telegram.

## Quick Start

```bash
cp .env.example .env    # fill in PUMPAPI_PRIVATE_KEY (or DBOTX_API_KEY)
bun install
bun start
```

## Engine Selection

| `TRADING_ENGINE` | Live | Paper/Sim |
|---|---|---|
| `pumpapi` (default) | Lightning API — 0.25% fee, no WS/polling | Local paper (2 SOL virtual) |
| `dbotx` | Swap-order API + trade WS + recovery | DBotX simulator (USD-based) |

Exit strategies run client-side for all engines; DBotX live additionally sends TP/SL to server.

## Key Config

| Variable | Default | Description |
|---|---|---|
| `TRADING_ENGINE` | `pumpapi` | Engine: `pumpapi` or `dbotx` |
| `PUMPAPI_PRIVATE_KEY` | — | Base58 key for PumpAPI lightning |
| `LIVE_MODE` | `false` | Live trades vs paper/simulator |
| `POSITION_SIZE_SOL` | `0.01` | SOL per position |
| `STOP_LOSS_PERCENT` | `-15` | Stop loss trigger |
| `PARTIAL_TP_TIERS` | `25@30,25@60,25@100` | Tiered take-profit |
| `BASE_TTL_SECS` | `90` | Position expiry |
| `MAX_OPEN_POSITIONS` | `3` | Concurrent positions |

## Structure

```
src/trading/
  types.ts              # TradingApi interface
  handler.ts            # Signal → buy → exit orchestration
  http.ts               # HTTP clients (botHttp, pumpapiHttp, …)
  dbotx_trading/        # DBotX engine
    live/               # swap-order API, trade WS, store, recovery
    simulate/           # remote simulator
    exit-config.ts      # shared TP/SL helpers
  pumpapi_trading/      # PumpAPI engine
    live/               # lightning API (POST api.pumpapi.io)
    paper/              # local virtual SOL balance
```

## Build

```bash
bun run build   # single binary → ./dbotx_bot
```
