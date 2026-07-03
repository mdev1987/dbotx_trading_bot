# DBotX Trade TS — Simulator Bot

RxJS-based paper-trading bot for the DBotX simulator. Listens to Telegram channels for token signals, opens simulated positions, manages TP/SL via the DBotX API, and reports results to a Telegram chat.

## Architecture

```
Telegram (MTProto)  ──►  telegram_listener.ts  ──►  signals_stream.ts  ──►  position_manager.ts  ──►  DBotX API
                           │                                                    │
                           ├─ AVE Scanner parser                                ├─ simFastBuy / simFastSell
                           └─ Signal Monitor parser                             ├─ TP/SL task polling
                                    │                                           ├─ Trade pair polling
                                    ▼                                           ├─ Trailing stop monitor
                              signalMonitorPump$                                ├─ TTL expiry
                                    │                                           └─ Pump result consumer
                                    ▼
                              position_manager.ts  (closes matching position)
```

| Layer | File | Role |
|-------|------|------|
| **Telegram client** | `telegram_listener.ts` | MTProto connection, message stream, parser routing |
| **AVE Scanner parser** | `ave_scanner_parser.ts` | Parses `@Ave_Scanner_Bot` signal format |
| **Signal Monitor parser** | `ave_signal_monitor_parser.ts` | Parses `@AveSignalMonitor` signals + pump proofs |
| **Signal dedup** | `signals_stream.ts` | Deduplicates by LP address, 1-hour cleanup |
| **Position lifecycle** | `position_manager.ts` | Buy/sell, TP/SL polling, trailing stop, TTL, pump closes |
| **Account** | `account.ts` | Simulator balance stream, manual + auto-poll |
| **HTTP** | `http.ts` | fetchWithRetry with timeout + exponential backoff |
| **WebSocket** | `dbotx_data_ws.ts` | Live pair price feed with auto-reconnect |
| **Reporter** | `telegram_bot_reporter.ts` | GrammY messages for opened/closed/report |
| **Analytics** | `reports.ts`, `trades_repository.ts` | SQLite persistence + performance queries |
| **Entry point** | `main.ts` | Startup, shutdown, crash notifications |

## Signal Source Modes

Controlled by `SIGNAL_SOURCE_MODE` in `.env`:

### `monitor` (default)
- **Channel**: `@AveSignalMonitor`
- **TTL**: Disabled (positions never auto-close from TTL)
- **Max positions**: No limit (accepts every signal)
- **Signal queue**: Disabled
- **Take profit**: From signal's `Max Pump: Xx` field → `(X - 1) * 0.7` as backstop TP
- **Pump close**: When a 🚀 pump-proof message arrives for an open position, closes it

### `ave`
- **Channel**: `@Ave_Scanner_Bot`
- **TTL**: Enabled (configurable via `BASE_TTL_SECS` / `MAX_TTL_SECS`)
- **Max positions**: Configurable cap (`MAX_POSITIONS`)
- **Signal queue**: FIFO queue (`SIGNAL_QUEUE_SIZE`)
- **Take profit**: From config (`PARTIAL_TP_TIERS` + `PAPER_BACKSTOP_TP_PERCENT`)
- **Pump close**: N/A

## Signal Formats

### Ave Signal Monitor — Signal (🪙)

```
🪙 $nitro (from pump.fun)
🔗 solana
CA: 9zZVV9wytrbCLK3iHyiszLht55fBKpAP6VQqxTzrpump

🔢 2nd Vibe Buy Signal
💹 Max Pump: 2x
💰 2 KOL Wallet Buy
🤑 Current MC: 40.94K
💸 Total Buy 10.0122 SOL

🛗 Inflow
🟢 OTTA 💰 Buy 9.876 SOL
```

### Ave Signal Monitor — Pump Proof (🚀)

```
🚀 x24 🚀 $Balloon 🆙 🆙 🆙

Jumped from 13.22K to now 127.26K

CA: 96X4zg5T4NFWzTVFXHsadvYbxbzFX2Rqt3GXUv92pump
```

### AVE Scanner (original)

```
Token: EXAMPLE (https://...)
CA: 0x...
LP: 0x...
Init Price: $0.0{5}1234
MCap: 12.34K
Pair: 1.23M EXAMPLE / 0.5 SOL
Dex: Pump.fun
Liquidity: 12.34K
...
```

## Configuration

All config via environment variables (see `.env.example`):

### DBotX API

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DBOTX_API_KEY` | Yes | — | API key |
| `DBOTX_WS_URL` | Yes | — | WebSocket URL |
| `DBOTX_BASE_URL` | Yes | — | REST base URL |
| `SERVAPI_BASE_URL` | No | `https://servapi.dbotx.com` | Service API base |

### Account & Position Sizing

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `POSITION_SIZE_SOL` | No | `0.1` | Base position size (SOL), clamped by min/max |
| `MIN_POSITION_SOL` | No | `0.03` | Smallest position allowed |
| `MAX_POSITION_SOL` | No | `0.1` | Largest position allowed |
| `MAX_RISK_PCT` | No | `1.0` | Max % of account balance risked per trade |
| `MAX_POSITIONS` | No | `5` | Max concurrent positions (ave mode only) |

### TTL (ave mode only)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BASE_TTL_SECS` | No | `90` | Initial holding time before evaluation |
| `MIN_PROFIT_FOR_TTL_EXTENSION_PCT` | No | `3.0` | Profit % required to reset TTL clock |
| `MAX_TTL_SECS` | No | `600` | Hard cap on position lifetime |

### Signal Queue (ave mode only)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SIGNAL_QUEUE_SIZE` | No | `20` | Max queued signals when at max positions |

### Exit Settings

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PARTIAL_TP_TIERS` | No | `30@20,40@50` | Partial TP tiers: `pct%@pct%` pairs (ave mode) |
| `PAPER_BACKSTOP_TP_PERCENT` | No | `500` | Backstop TP for remaining position (ave mode) |
| `PAPER_STOP_LOSS_PERCENT` | Yes | — | Stop loss percent (negative) |
| `PAPER_TRAILING_ACTIVATION_PERCENT` | Yes | — | Gain % before trailing engages |
| `PAPER_TRAILING_STOP_PERCENT` | Yes | — | Trail distance from peak |
| `PAPER_MAX_SLIPPAGE_EXIT_PERCENT` | Yes | — | Max loss before panic exit |
| `DAILY_LOSS_LIMIT_USD` | No | `0` | Daily loss limit in USD (0 = disabled) |

### Telegram

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | No | — | GrammY bot token (for reporting) |
| `TELEGRAM_CHAT_ID` | No | — | Chat ID for reports |
| `TELEGRAM_REPORT_INTERVAL_MINUTES` | No | `5` | Periodic report interval |
| `TELEGRAM_API_ID` | Yes | — | MTProto API ID (my.telegram.org) |
| `TELEGRAM_API_HASH` | Yes | — | MTProto API hash |
| `TELEGRAM_CHANNEL_USERNAME` | Yes | — | Channel to listen to |
| `TELEGRAM_CHANNEL_ID` | No | — | Numeric channel ID (resolved from username if unset) |
| `SIGNAL_SOURCE_MODE` | No | `monitor` | `monitor` or `ave` |

### Storage

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SQLITE_PATH` | Yes | — | Path to SQLite database file |

### Logging

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LOG_LEVEL` | No | `info` | Log level |

## Running

```bash
# Copy and edit config
cp .env.example .env

# Install dependencies
bun install

# Run
bun run src/main.ts
```

On first run, the Telegram client will prompt for:
1. Phone number (international format)
2. Verification code (sent to Telegram)
3. 2FA password (if enabled)

The session is persisted to `telegram_session` for subsequent runs.

## Position Lifecycle

```
Signal received ──► acceptedSignal$ ──► openPosition()
                                             │
                                             ├─ simFastBuy() → orderId
                                             ├─ captureEntryPrice() (polls /trades)
                                             ├─ WS subscribe pairInfo
                                             └─ refreshAccount$

Position open ──► Polling loops (every 5-30s)
                     │
                     ├─ TP/SL tasks (pnl_orders_from_swap_order)
                     │   └─ all tasks done → closePosition()
                     │
                     ├─ Trade pair PnL (trade_pairs)
                     │   └─ balance ≤ 0 → closePosition()
                     │
                     └─ Trailing stop monitor (pairUpdate$)
                         └─ price ≤ peak * (1 - trailPct) → closePosition()

Position close ──► closePosition()
                      │
                      ├─ simFastSell() (for stop_loss / trailing / expired)
                      ├─ emitEvent("closed") → analytics + reporter
                      ├─ refreshAccount$
                      ├─ processQueuedSignal() (ave mode)
                      └─ Pump result consumer (monitor mode)
```

## Development

```bash
# Run tests (43 tests across 2 parser suites)
bun test

# Type-check only
npx tsc --noEmit

# Watch mode
bun --watch run src/main.ts
```
