# DBotX Trade TS — Paper-Trading Simulator Bot

RxJS-based bot that listens to Telegram channels for trading signals, opens simulated positions via the DBotX API, manages exits with partial TP / trailing stop / trailing TP / stop loss, and reports results to Telegram.

## Architecture

```
Telegram (MTProto) ──► telegram_listener.ts ──► signals_stream.ts ──► position_manager.ts ──► DBotX API
                           │                                                 │
                           ├─ ave_scanner_parser.ts                          ├─ simFastBuy / simFastSell
                           └─ ave_signal_monitor_parser.ts                   ├─ TP/SL task polling
                                    │                                        ├─ Trade pair polling
                                    ▼                                        ├─ Trailing stop monitor
                              signalMonitorPump$                             ├─ Trailing TP monitor
                                    │                                        ├─ TTL expiry
                                    ▼                                        └─ Pump result consumer
                              position_manager.ts (closes matching position)
```

### Module Map

| Layer | File | Role |
|-------|------|------|
| **Telegram client** | `telegram_listener.ts` | MTProto connection, message stream, parser routing |
| **AVE Scanner parser** | `ave_scanner_parser.ts` | Parses `@Ave_Scanner_Bot` pool-launch format |
| **Signal Monitor parser** | `ave_signal_monitor_parser.ts` | Parses `@AveSignalMonitor` buy signals + pump proofs |
| **Signal dedup** | `signals_stream.ts` | Deduplicates by LP address with TTL-based cache cleanup |
| **Position core** | `position_core.ts` | Position store (RxJS scan), event bus, TP/SL polling, trade pair polling, entry capture, open/close lifecycle |
| **Position manager** | `position_manager.ts` | Entry point — wires trailing monitors + channel strategy |
| **Default strategy** | `position_default_strategy.ts` | Max positions, signal queue, TTL expiry/renewal |
| **Monitor strategy** | `position_signal_monitor_strategy.ts` | No caps, pump-result close consumer |
| **Trailing stop/TP** | `trailing_stop.ts` | Client-side trailing stop-loss + trailing take-profit via WebSocket price feed |
| **Account** | `account.ts` | Simulator balance stream (manual + auto-poll) |
| **HTTP** | `http.ts` | `fetchWithRetry` with timeout + exponential backoff |
| **WebSocket** | `dbotx_data_ws.ts` | Live pair price feed with auto-reconnect |
| **Reporter** | `telegram_bot_reporter.ts` | GrammY messages for opened/closed/periodic report |
| **Analytics** | `reports.ts`, `trades_repository.ts` | SQLite persistence + performance queries |
| **Entry point** | `main.ts` | Startup, shutdown, crash notifications |

## Signal Source Modes

The bot auto-detects its channel from `TELEGRAM_CHANNEL_USERNAME`:

| Mode | Channel | Behaviour |
|------|---------|-----------|
| `monitor` | `AveSignalMonitor` | No position limit, no TTL. TP derived from signal's `Max Pump` field. Closes on 🚀 pump proof. |
| `ave` | `AveSolanaTokenScanner` | Max positions cap (`MAX_POSITIONS`), TTL expiry/renewal, signal queue. TP from config `PARTIAL_TP_TIERS`. |

## Exit Strategies

All four exit strategies run concurrently on every open position:

| Strategy | Config | Description |
|----------|--------|-------------|
| **Partial TP** | `PARTIAL_TP_TIERS` + `PAPER_BACKSTOP_TP_PERCENT` | Sells configurable percentages at configurable profit levels via simulator API. |
| **Stop Loss** | `PAPER_STOP_LOSS_PERCENT` | Sells entire position when price drops below entry by the configured percentage. |
| **Trailing Stop Loss** | `PAPER_TRAILING_ACTIVATION_PERCENT` + `PAPER_TRAILING_STOP_PERCENT` | Activates after a gain, then trails a stop below the peak price. |
| **Trailing TP** | `PAPER_TRAILING_TP_PERCENT` | Always active from entry — locks in profit by selling when price reverses from the peak. |

### Trailing Stop vs Trailing TP

- **Trailing Stop Loss**: Has an activation threshold (`trailingActivationPct`). Once price rises that much above entry, a stop is placed `trailingDistancePct` below the peak. Protects against large drawdowns.
- **Trailing Take-Profit**: Always active from entry with no activation threshold. When price drops `trailingTpDistancePct` below the peak, it takes profit. Useful for locking in gains on volatile tokens that might not hit fixed TP tiers.

Both share the same WebSocket price feed and peak-tracker. Set their respective config to `0` to disable.

## Risk Management

| Control | Config | Behaviour |
|---------|--------|-----------|
| **Position size cap** | `MAX_RISK_PCT` | Caps each position to N% of current account balance |
| **Min/max size bounds** | `MIN_POSITION_SOL` / `MAX_POSITION_SOL` | Clamps position size |
| **Daily loss limit** | `DAILY_LOSS_LIMIT_USD` | Stops opening new trades when daily realised PnL exceeds the threshold |
| **Buy dedup guard** | `PENDING_BUY_TTL_MS` | Prevents duplicate buy orders for the same pair |
| **Signal dedup** | `SIGNAL_CACHE_TTL_SECONDS` | Ignores repeat signals for the same LP address within the window |

## Configuration

All settings via environment variables (see `.env.example`).

### DBotX API

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DBOTX_API_KEY` | Yes | — | API key |
| `DBOTX_WS_URL` | Yes | — | WebSocket URL |
| `DBOTX_BASE_URL` | Yes | — | REST API base URL |
| `DBOTX_SERVAPI_BASE_URL` | Yes | — | Service API base URL |

### Position Sizing & Limits

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `POSITION_SIZE_SOL` | No | `0.1` | Base position size (SOL) |
| `MIN_POSITION_SOL` | No | `0.03` | Smallest allowed position |
| `MAX_POSITION_SOL` | No | `0.1` | Largest allowed position |
| `MAX_RISK_PCT` | No | `1.0` | Max % of balance per trade |
| `MAX_POSITIONS` | No | `5` | Max concurrent positions (ave mode) |
| `SIGNAL_QUEUE_SIZE` | No | `20` | Max queued signals (ave mode) |

### TTL (ave mode only)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BASE_TTL_SECS` | No | `90` | Initial holding time before expiry evaluation |
| `MIN_PROFIT_FOR_TTL_EXTENSION_PCT` | No | `3.0` | Profit % to reset TTL clock |
| `MAX_TTL_SECS` | No | `600` | Hard cap on position lifetime |

### Exit Settings

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PARTIAL_TP_TIERS` | No | `20@30,30@50` | Partial TP: `pct%@pct%` pairs |
| `PAPER_BACKSTOP_TP_PERCENT` | No | `200` | Backstop TP for remainder |
| `PAPER_STOP_LOSS_PERCENT` | No | `-15` | Stop loss % (negative, 0 = disabled) |
| `PAPER_TRAILING_ACTIVATION_PERCENT` | No | `15` | Gain % before trailing stop arms |
| `PAPER_TRAILING_STOP_PERCENT` | No | `8` | Trail distance % from peak (0 = disabled) |
| `PAPER_TRAILING_TP_PERCENT` | No | `12` | Trailing TP distance % from peak (0 = disabled) |
| `PAPER_MAX_SLIPPAGE_EXIT_PERCENT` | No | `80` | Max allowed exit slippage |

### Risk Controls

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DAILY_LOSS_LIMIT_USD` | No | `0` | Daily loss limit (0 = disabled) |

### Telegram

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | No | — | GrammY bot token (for reporting) |
| `TELEGRAM_CHAT_ID` | No | — | Chat ID for reports |
| `TELEGRAM_REPORT_INTERVAL_MINUTES` | No | `5` | Periodic report interval (min) |
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
| `SQLITE_PATH` | No | `./data/paper_trading.sqlite` | Analytics database path |
| `CLEAR_ANALYTICS_ON_START` | No | `false` | Drop all data on startup |
| `LOG_LEVEL` | No | `info` | Log verbosity |

## Running

```bash
# Copy and edit config
cp .env.example .env

# Install dependencies
bun install

# Run
bun run src/main.ts
```

On first run the Telegram client prompts for:
1. Phone number (international format)
2. Verification code
3. 2FA password (if enabled)

The session is persisted to `telegram_session` for subsequent runs.

## Position Lifecycle

```
Signal ──► acceptedSignal$ ──► openPosition()
                                    │
                                    ├─ simFastBuy() → orderId
                                    ├─ captureEntryPrice() (polls /trades)
                                    ├─ WS subscribe pairInfo
                                    └─ refreshAccount$

Open ──► Polling loops (every 5-30s)
             │
             ├─ TP/SL tasks (pnl_orders_from_swap_order)
             │   └─ all tasks done ──► closePosition(reason)
             │
             ├─ Trade pair PnL (trade_pairs)
             │   └─ balance ≤ 0 ──► closePosition("take_profit")
             │
             ├─ Trailing stop monitor (pairUpdate$)
             │   └─ price ≤ peak × (1 - trailPct) ──► closePosition("trailing_stop")
             │
             └─ Trailing TP monitor (pairUpdate$)
                 └─ price ≤ peak × (1 - tpTrailPct) ──► closePosition("take_profit")

Close ──► closePosition()
              │
              ├─ simFastSell() (for stop_loss / trailing / expired)
              ├─ emitEvent("closed") → analytics + reporter
              ├─ refreshAccount$
              ├─ processQueuedSignal() (ave mode)
              └─ Pump result consumer (monitor mode)
```

## Development

```bash
# Run tests (43 tests across signal monitor parser)
bun test

# Type check
bun run tsc --noEmit

# Watch mode
bun --watch run src/main.ts
```
