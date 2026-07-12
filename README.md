# DBotX Trade Bot

Telegram-signal-driven Solana trading bot using DBotX API (simulator or live). Listens to Ave Solana Token Scanner signals, prices via PumpAPI/DexScreener/DBotX WS, executes trades with TP/SL/trailing/partial exits, and reports to Telegram.

## Prerequisites

- [Bun](https://bun.sh) >= 1.1
- DBotX API key + Telegram API credentials ([my.telegram.org](https://my.telegram.org))

## Setup

```bash
cp .env.example .env
# Fill in your .env (see below for required vars)
bun install
```

Minimal `.env` (unencrypted):

```
DBOTX_API_KEY=your_key
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
TELEGRAM_API_ID=123
TELEGRAM_API_HASH=your_hash
TELEGRAM_CHANNEL_USERNAME=AveSolanaTokenScanner
POSITION_SIZE_SOL=0.01
```

Encrypt (optional):

```bash
bun run encrypt   # creates .env.enc, removes .env
bun run decrypt   # prompts password, creates .env
```

## Run

```bash
bun start                 # production
LOG_LEVEL=debug bun dev   # verbose
```

On first run, enter Telegram phone + code for MTProto auth (session cached in `telegram_session/`).

## Key Config

| Variable | Default | Description |
|---|---|---|
| `LIVE_MODE` | `false` | `true` = live trades, `false` = simulator |
| `POSITION_SIZE_SOL` | `0.10` | SOL per position |
| `STOP_LOSS_PERCENT` | `-15` | Stop loss trigger |
| `TRAILING_ACTIVATION_PERCENT` | `15` | % gain to activate trailing |
| `TRAILING_STOP_PERCENT` | `8` | Trail distance from peak |
| `PARTIAL_TP_TIERS` | `25@30,...` | Tiered take-profit |
| `BASE_TTL_SECS` | `90` | Position expiry |

## Build

```bash
bun run build   # single binary → ./dbotx_bot
```
