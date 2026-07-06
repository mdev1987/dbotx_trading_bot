# DBotX Trade TS Documentation

## Overview
RxJS-based trading simulator bot that integrates with Telegram for signal detection, manages simulated positions via DBotX API, and automates exits using trailing stops/TP, stop loss, and TTL expiry mechanisms. This documentation guides users to set up, configure, and understand the system architecture.

## Getting Started
1. Clone repository
2. Set environment variables in `.env` (see [Configuration](#configuration))
3. Run `npm start` to launch the bot

## Key Components
- [Architecture](architecture.md)
- [Modules](modules.md)
- [Signal Handling](signals.md)
- [Exit Strategies](exits.md)
- [Risk Management](risk.md)
- [Configuration](config.md)

## Why This Matters
The bot automates high-frequency trading decisions while enforcing risk controls. Its modular design allows customization of signal sources and exit rules while maintaining thread safety via RxJS operators.

## Quick First Run Command
`npm start -- --channel-username AveSignalMonitor`