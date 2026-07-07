# DBotX Trade TS — Paper-Trading & Live Trading Bot

RxJS-based bot that listens to Telegram channels for trading signals (`@AveSolanaTokenScanner` or `@AveSignalMonitor`), opens simulated or live positions via the DBotX API, manages exits with partial TP / trailing stop / trailing TP / stop loss / TTL expiry, and reports results to Telegram. Use `LIVE_MODE=true` for real-money trading.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  src/entry.ts  (bootstrap)                                          │
│    Checks for .env.encrypted, prompts password, decrypts             │
│    entire .env into process.env, then imports src/main.ts            │
└──────────────────────┬───────────────────────────────────────────────┘
                       │
                       ▼
Telegram (MTProto) ──► main.ts ──► telegram_listener.ts ──► signals_stream.ts
                            │                         │
                            ├─ ave_scanner_parser.ts   ├── (LIVE_MODE=false) ──► simulator/position_manager ──► DBotX servAPI
                            └─ ave_signal_monitor_parser.ts                   │
                                     │                                       ├── (LIVE_MODE=true)  ──► live/position_manager ──► DBotX bot REST/WS
                                     ▼                                       │
                               signalMonitorPump$                              │
                                     │                                        │
                                     ▼                                        │
                               position_manager.ts ◄──────────────────────────┘
                               (closes matching position)
```

### Module Map

| Layer | File | Role |
|-------|------|------|
| **Bootstrap** | `entry.ts` | Decrypt `.env.encrypted` at startup, load all vars into `process.env` before any module reads them |
| **Crypto** | `crypto/crypto.ts` | AES-256-GCM encrypt/decrypt via `@notifycode/hash-it`, password prompt via `@inquirer/prompts`, env file loader |
| **Encrypt CLI** | `crypto/cli_encrypt.ts` | `bun run encrypt` — encrypt full `.env` → `.env.encrypted` with password |
| **Decrypt CLI** | `crypto/cli_decrypt.ts` | `bun run decrypt` — decrypt `.env.encrypted` to stdout |
| **Telegram client** | `telegram_listener.ts` | MTProto connection, message stream, parser routing |
| **AVE Scanner parser** | `ave_scanner_parser.ts` | Parses `@Ave_Scanner_Bot` pool-launch format |
| **Signal Monitor parser** | `ave_signal_monitor_parser.ts` | Parses `@AveSignalMonitor` buy signals + pump proofs |
| **Signal dedup** | `signals_stream.ts` | Deduplicates by LP address with TTL-based cache cleanup |
| **Simulator position core** | `simulator/position_core.ts` | Simulated position store, TP/SL polling, trade pair polling, entry capture, signal queue |
| **Simulator account** | `simulator/account.ts` | Simulated balance + PnL via RxJS streams |
| **Live config** | `live/config.ts` | Live-only env var parsing (Jito, WS, fees, TTL, etc.) |
| **Live HTTP** | `live/http.ts` | `fetchWithRetry` (standalone, no simulator deps) |
| **Live wallet** | `live/wallet.ts` | Wallet info + SOL balance via REST + RxJS stream |
| **Live account** | `live/account.ts` | Position sizing with min/max/risk cap |
| **Live fast buy/sell** | `live/fast_buy_sell.ts` | `POST /automation/swap_order` + polling |
| **Live WS** | `live/trade_results_ws.ts` | Trade result WS (10 event types), heartbeat, auto-reconnect |
| **Live position core** | `live/position_core.ts` | In-memory position store, WS-driven lifecycle, TTL, recovery, pending-buy dedup |
| **Live trailing stop/TP** | `live/trailing_stop.ts` | Client-side trailing stop-loss + trailing take-profit via WS price feed |
| **Live default strategy** | `live/position_default_strategy.ts` | Max positions cap + FIFO queue, dequeue-on-close |
| **Live monitor strategy** | `live/position_signal_monitor_strategy.ts` | No cap, pump-result closes oldest |
| **Live position manager** | `live/position_manager.ts` | Bootstrap: wallet verify → WS connect → subscriptions → strategy load |
| **Trailing stop/TP** | `trailing_stop.ts` | Client-side trailing stop-loss + trailing take-profit via WebSocket price feed (simulator) |
| **Account** | `account.ts` | Simulator balance stream (manual + auto-poll) |
| **HTTP** | `http.ts` | `fetchWithRetry` with timeout + exponential backoff |
| **WebSocket** | `dbotx_data_ws.ts` | Live pair price feed with auto-reconnect + pair re-subscription |
| **Reporter** | `telegram_bot_reporter.ts` | GrammY messages for opened/closed/periodic report |
| **Analytics** | `reports.ts`, `trades_repository.ts` | SQLite persistence + performance queries |
| **Logger** | `logger.ts` | Level-gated logging (debug/info/warn/error) |
| **Entry point** | `main.ts` | Startup, shutdown, crash notifications |

## Signal Source Modes

The bot auto-detects its channel from `TELEGRAM_CHANNEL_USERNAME`:

| Mode | Channel | Behaviour |
|------|---------|-----------|
| `monitor` | `AveSignalMonitor` | No position limit, no TTL. TP derived from signal's `Max Pump` field. Closes on 🚀 pump proof. |
| `ave` | `AveSolanaTokenScanner` | Max positions cap (`MAX_POSITIONS`), TTL expiry/renewal, signal queue (TTL + dedup + overflow eviction). TP from config `PARTIAL_TP_TIERS`. |

## Env File Encryption

The bot supports AES-256-GCM encrypting the entire `.env` file via `@notifycode/hash-it`:

```bash
# 1. Start with a plaintext .env file
# 2. Encrypt it (prompts for password twice):
bun run encrypt

# Encrypted output written to .env.encrypted (self-contained JSON blob)
# You may now delete .env in production — entry.ts reads .env.encrypted at startup

# 3. On next startup, bot prompts for the decryption password:
bun start

# 4. To view the decrypted content (e.g., for debugging):
bun run decrypt
```

- The sealed blob is a self-contained JSON: `{"ciphertext":"...","iv":"...","tag":"...","algorithm":"aes-256-gcm"}`
- Wrong password or tampered data is detected via GCM auth tag
- The password prompt uses `@inquirer/prompts` with masked input (cross-platform)
- In non-TTY environments (e.g., Docker), the plaintext `.env` file can be used directly instead

## Live Mode (`LIVE_MODE=true`)

When `LIVE_MODE=true`, the bot uses `src/live/` modules instead of `src/simulator/`:
- **TP/SL is server-managed** — configured at buy time via `stopEarnGroup`/`stopLossGroup` in the swap order. WS events notify of completion. No client-side TP/SL task polling.
- **Client-only trailing stop/TP** and **TTL expiry** — triggered via market sell through `POST /automation/swap_order`.
- **Jito anti-MEV enabled by default** — auto-allocated unless `LIVE_CUSTOM_FEE_AND_TIP=true`.
- **WS-driven lifecycle** — `tradeResultNotify` events (10 types) update position state. 30s fallback poll if WS event never arrives.
- **Recovery on restart** — best-effort via WS re-sync after reconnect.
- **No simulator imports** — live module is entirely standalone.

### Live Exit Strategies

| Strategy | Server/Client | Config | Description |
|----------|--------------|--------|-------------|
| **Partial TP** | Server | `PARTIAL_TP_TIERS`, `PAPER_BACKSTOP_TP_PERCENT` | Tiers configured in buy order; executed server-side |
| **Stop Loss** | Server | `PAPER_STOP_LOSS_PERCENT` | Fixed SL in buy order; server triggers at threshold |
| **Trailing Stop** | Client | `PAPER_TRAILING_ACTIVATION_PERCENT`, `PAPER_TRAILING_STOP_PERCENT` | RxJS monitor on WS price feed; triggers market sell |
| **Trailing TP** | Client | `PAPER_TRAILING_TP_PERCENT` | Always-active monitor; locks profit on peak reversal |
| **TTL expiry** | Client | `BASE_TTL_SECS` / `MAX_TTL_SECS` | Periodic timer; close via market sell when TTL exceeded |

### Live Config

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LIVE_MODE` | No | `false` | Master switch for live trading |
| `LIVE_WALLET_ID` | Yes | — | Wallet ID from DBotX Wallet Info |
| `LIVE_WALLET_ADDRESS` | Yes | — | On-chain wallet public address |
| `LIVE_JITO_ENABLED` | No | `true` | Jito anti-MEV |
| `LIVE_JITO_TIP` | No | `0.0001` | Jito bribery tip (SOL) |
| `LIVE_CUSTOM_FEE_AND_TIP` | No | `false` | Manual fee/tip override |
| `LIVE_PRIORITY_FEE` | No | `""` | Priority fee (auto if empty) |
| `LIVE_MAX_SLIPPAGE` | No | `0.1` | Max slippage (0.00–1.00) |
| `LIVE_CONCURRENT_NODES` | No | `2` | Parallel nodes (1–3) |
| `LIVE_RETRIES` | No | `1` | Swap order retries (0–10) |
| `LIVE_MIGRATE_SELL_PERCENT` | No | `1` | Pump→Raydium migration sell ratio |
| `LIVE_MIN_DEV_SELL_PERCENT` | No | `0.5` | Dev sell trigger threshold |
| `LIVE_DEV_SELL_PERCENT` | No | `0` | Dev sell amount ratio |
| `LIVE_RECOVERY_ON_START` | No | `true` | Scan open orders on boot |
| `LIVE_PNL_ORDER_EXPIRE_DELTA_MS` | No | `43200000` | TP/SL task expiry (max 5d) |
| `LIVE_PNL_ORDER_EXPIRE_EXECUTE` | No | `true` | Market sell on expiry |
| `LIVE_SWAP_ORDER_POLL_MS` | No | `2000` | Order status poll interval |
| `LIVE_MAX_SWAP_ORDER_POLL_ATTEMPTS` | No | `30` | Max poll attempts |
| `LIVE_TRADE_WS_URL` | No | `wss://api-bot-v1.dbotx.com/trade/ws/` | Trade results WS URL |

## Exit Strategies

All exit strategies run concurrently on every open position:

| Strategy | Config | Description |
|----------|--------|-------------|
| **Partial TP** | `PARTIAL_TP_TIERS` + `PAPER_BACKSTOP_TP_PERCENT` | Sells configurable percentages at configurable profit levels via simulator API. |
| **Stop Loss** | `PAPER_STOP_LOSS_PERCENT` | Sells entire position when price drops below entry by the configured percentage. Client-side guard also checks via trade-pair poll. |
| **Trailing Stop Loss** | `PAPER_TRAILING_ACTIVATION_PERCENT` + `PAPER_TRAILING_STOP_PERCENT` | Activates after a gain, then trails a stop below the peak price. |
| **Trailing TP** | `PAPER_TRAILING_TP_PERCENT` | Always active from entry — locks in profit by selling when price reverses from the peak. |
| **TTL expiry** | `BASE_TTL_SECS` / `MAX_TTL_SECS` | Hard fallback — closes after TTL expires. Extended when profit ≥ threshold. |

### Trailing Stop vs Trailing TP

- **Trailing Stop Loss**: Has an activation threshold (`trailingActivationPct`). Once price rises that much above entry, a stop is placed `trailingDistancePct` below the peak. Protects against large drawdowns.
- **Trailing Take-Profit**: Always active from entry with no activation threshold. When price drops `trailingTpDistancePct` below the peak, it takes profit. Useful for locking in gains on volatile tokens that might not hit fixed TP tiers.

Both share the same WebSocket price feed and peak-tracker. Set their respective config to `0` to disable.

## Signal Queue (ave mode only)

When `MAX_POSITIONS` is reached, incoming signals are enqueued for deferred processing:

| Feature | Config | Behaviour |
|---------|--------|-----------|
| **Max queue depth** | `SIGNAL_QUEUE_SIZE` | Drops oldest entry when limit exceeded (after expired eviction). |
| **Queue TTL** | `SIGNAL_QUEUE_TTL_SECS` | Entries older than the TTL are removed on the next enqueue/dequeue cycle. |
| **Deduplication** | — | Map keyed by LP address — newer signal overwrites older for the same pair. |
| **Overflow eviction** | — | Expired entries evicted first; if still over limit, oldest non-expired is dropped. |

## Risk Management

| Control | Config | Behaviour |
|---------|--------|-----------|
| **Position size cap** | `MAX_RISK_PCT` | Caps each position to N% of current account balance |
| **Signal-scored sizing** | `MIN_POSITION_SOL` / `MAX_POSITION_SOL` | Scales 0.03–0.10 SOL by signal quality (wallets × 0.4 + volume × 0.3 + maxPump × 0.3) |
| **Daily loss limit** | `DAILY_LOSS_LIMIT_USD` | Stops opening new trades when daily realised PnL exceeds the threshold |
| **Consecutive loss cooldown** | Hard-coded (3 losses) | Pauses for 20 minutes after 3 consecutive losing trades |
| **Buy dedup guard** | `PENDING_BUY_TTL_MS` | Prevents duplicate buy orders for the same pair |
| **Signal dedup** | `SIGNAL_CACHE_TTL_SECONDS` | Ignores repeat signals for the same LP address within the window |

## Configuration

All settings via environment variables (see `.env.example`).

### DBotX API

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DBOTX_API_KEY` | Yes* | — | API key |
| `DBOTX_WS_URL` | Yes | — | WebSocket URL |
| `DBOTX_BASE_URL` | Yes | — | REST API base URL |
| `DBOTX_SERVAPI_BASE_URL` | Yes | — | Service API base URL |

\* `DBOTX_API_KEY` must be set either in plaintext `.env` or encrypted via `.env.encrypted`. When `.env.encrypted` exists, the bot prompts for the decryption password at startup and loads all env vars into `process.env` before any module reads them.

### Position Sizing & Limits

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `POSITION_SIZE_SOL` | No | `0.1` | Base position size (SOL) |
| `MIN_POSITION_SOL` | No | `0.03` | Smallest allowed position (SOL) |
| `MAX_POSITION_SOL` | No | `0.1` | Largest allowed position (SOL) |
| `MAX_RISK_PCT` | No | `1.0` | Max % of balance per trade |
| `MAX_POSITIONS` | No | `5` | Max concurrent positions (ave mode) |
| `SIGNAL_QUEUE_SIZE` | No | `30` | Max queued signals (ave mode) |
| `SIGNAL_QUEUE_TTL_SECS` | No | `600` | TTL for queued signals (seconds) |

### Position TTL

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BASE_TTL_SECS` | No | `90` | Initial holding time before expiry evaluation |
| `MIN_PROFIT_FOR_TTL_EXTENSION_PCT` | No | `0` | Profit % to reset TTL clock (0 = disabled) |
| `MAX_TTL_SECS` | No | `600` | Hard cap on position lifetime |

### Exit Settings

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PARTIAL_TP_ENABLED` | No | `false` | Enable partial take-profit tiers |
| `PARTIAL_TP_TIERS` | No | — | Partial TP: `pct%@at%` comma-separated (e.g. `25@30,25@60,25@100`) |
| `PAPER_BACKSTOP_TP_PERCENT` | No | `0` | Backstop TP for remainder (0 = disabled) |
| `PAPER_STOP_LOSS_PERCENT` | Yes | — | Stop loss % (negative, e.g. `-15`) |
| `PAPER_TRAILING_ACTIVATION_PERCENT` | No | `0` | Gain % before trailing stop arms (0 = disabled) |
| `PAPER_TRAILING_STOP_PERCENT` | No | `0` | Trail distance % from peak (0 = disabled) |
| `PAPER_TRAILING_TP_PERCENT` | No | `0` | Trailing TP distance % from peak (0 = disabled) |
| `PAPER_MAX_SLIPPAGE_EXIT_PERCENT` | No | `80` | Max allowed exit slippage |

### Risk Controls

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DAILY_LOSS_LIMIT_USD` | No | `0` | Daily loss limit (0 = disabled) |

### Data & Analytics

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SQLITE_PATH` | No | `./data/paper_trading.sqlite` | Analytics database path |
| `CLEAR_ANALYTICS_ON_START` | No | `false` | Drop all data on startup |

### Telegram

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | No | — | GrammY bot token (for reporting) |
| `TELEGRAM_CHAT_ID` | No | — | Chat ID for reports |
| `TELEGRAM_REPORT_INTERVAL_MINUTES` | No | `5` | Periodic report interval (minutes) |
| `TELEGRAM_API_ID` | Yes | — | MTProto API ID |
| `TELEGRAM_API_HASH` | Yes | — | MTProto API hash |
| `TELEGRAM_CHANNEL_USERNAME` | Yes | — | Signal source channel |
| `TELEGRAM_CHANNEL_ID` | No | — | Numeric channel ID |

### Polling & Timing

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PNL_TASK_POLL_MS` | No | `5000` | TP/SL task poll interval |
| `TRADE_PAIR_POLL_MS` | No | `30000` | Trade pair PnL poll interval |
| `ENTRY_PRICE_POLL_DELAY_MS` | No | `1000` | Entry price retry delay |
| `MAX_ENTRY_PRICE_ATTEMPTS` | No | `10` | Entry price max retries |
| `PENDING_BUY_TTL_MS` | No | `60000` | Buy dedup guard TTL |
| `POSITION_EXPIRY_CHECK_MS` | No | `15000` | TTL expiry check interval |
| `ACCOUNT_POLL_INTERVAL_MS` | No | `60000` | Account balance poll interval |

### WebSocket

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WS_HEARTBEAT_INTERVAL_MS` | No | `30000` | Ping interval |
| `WS_DISCONNECT_LOG_THROTTLE_MS` | No | `30000` | Reconnect log throttle |
| `WS_RECONNECT_DELAY_MS` | No | `5000` | Reconnect delay |

### Signal Dedup

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SIGNAL_CACHE_TTL_SECONDS` | No | `3600` | Signal dedup TTL |
| `SIGNAL_CLEANUP_INTERVAL_MS` | No | `5000` | Cleanup tick interval |

### HTTP Client

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HTTP_MAX_RETRIES` | No | `4` | Max retry attempts |
| `HTTP_BASE_DELAY_MS` | No | `1000` | Backoff base delay |
| `HTTP_TIMEOUT_MS` | No | `30000` | Request timeout |

### Telegram Connection

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TG_CONNECTION_RETRIES` | No | `5` | MTProto connect retries |
| `TG_RETRY_DELAY_MS` | No | `5000` | MTProto retry delay |
| `TG_AUTH_TIMEOUT_MS` | No | `300000` | Auth input timeout |

### Simulator Execution

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DEFAULT_SLIPPAGE` | No | `0.1` | Default slippage (10%) |
| `DEFAULT_GAS_FEE_DELTA` | No | `5` | Gas fee delta |
| `DEFAULT_MAX_FEE_PER_GAS` | No | `100` | Max fee per gas |

### Observability

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LOG_LEVEL` | No | `info` | Log verbosity (`info` / `debug`) |

## Running

```bash
# Copy and edit config
cp .env.example .env

# Install dependencies
bun install

# Encrypt .env to .env.encrypted (optional, recommended for production)
bun run encrypt

# Run (info level)
bun start

# Run with verbose debug tracing + log file
bun run dev   # LOG_LEVEL=DEBUG bun run ./src/entry.ts | tee bot.log

# Build standalone binary
bun run build   # produces ./dbotx_bot

# Decrypt .env.encrypted to stdout (debugging)
bun run decrypt
```

On first run the Telegram client prompts for:
1. Phone number (international format)
2. Verification code
3. 2FA password (if enabled)

The session is persisted to `telegram_session` for subsequent runs.

## Position Lifecycle

### Simulator Mode

```
Signal ──► acceptedSignal$ ──► strategy ──► openPosition()
                                              │
                                              ├─ scoreSignal() → computePositionSize()
                                              ├─ simFastBuy() → orderId
                                              ├─ captureEntryPrice() (polls /trades)
                                              ├─ WS subscribe pairInfo (live price)
                                              └─ refreshAccount$

Open ──► Polling loops (5-30s) + Trailing monitors + TTL checks
              │                                         │
              ├─ TP/SL tasks polling                     ├─ Trailing stop (pairUpdate$)
              ├─ Trade pair PnL                          ├─ Trailing TP (pairUpdate$)
              └─ Client-side SL guard                    └─ TTL expiry (every 15s)

Close ──► closePositionById()
              │
              ├─ simFastSell()
              ├─ fetchFinalPnLData()
              ├─ emitEvent("closed") → analytics + reporter
              ├─ refreshAccount$
              ├─ trackConsecutiveLosses() → cooldown
              └─ tryDequeue() (ave mode)
```

### Live Mode

```
Signal ──► acceptedSignal$ ──► strategy ──► openPosition()
                                              │
                                              ├─ computePositionSize()
                                              ├─ liveFastBuy() (POST /automation/swap_order)
                                              ├─ addPosition() → in-memory Map
                                              ├─ captureEntryPrice() (poll WS/order until done)
                                              └─ WS trade event handler updates state

Open ──► WS-driven + Client monitors
              │                         │
              ├─ buySuccessEvent$        ├─ Trailing stop (pairUpdate$)
              ├─ sellSuccessEvent$       ├─ Trailing TP (pairUpdate$)
              ├─ takeProfitSuccessEvent$ └─ TTL expiry (every 15s)
              ├─ stopLossSuccessEvent$
              ├─ trailingStopSuccessEvent$
              └─ tradeFailEvent$

Close ──► closePositionById()
              │
              ├─ liveFastSell()
              ├─ WS sell event → markPositionClosed()
              ├─ 30s fallback poll if WS event missed
              ├─ emitEvent("closed") → analytics + reporter
              └─ tryDequeue() (ave mode, on positionClosed$)
```

## Development

```bash
# Run all tests (93 total)
bun test

# Type check
bun run tsc --noEmit

# Watch mode
bun --watch run src/entry.ts

# Live mode
LIVE_MODE=true bun run src/entry.ts

# Debug mode (verbose logs + file output)
bun run dev
```
