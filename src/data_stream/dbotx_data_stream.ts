// LP Addresses
const PAIRS = [
  "GguaWVjZRWjaaHFigNtqNVC6kSrF78FGPKKUe3KuvkDb",
  "DP6UmDBuZyQPGt9TUtpyV3cp7XF173QJhUN74tcH9FeT",
];

// dbotx_price_feed.ts
// Bun + TypeScript
//
// Real-time DBotX trade feed.
// - Multi-pair support
// - Auto reconnect
// - Heartbeat
// - In-memory pair cache
// - Calculates execution price from every swap
// - No RxJS
// - No EventEmitter
//
// Run:
// bun run dbotx_price_feed.ts

const HEARTBEAT_MS = 30_000;
const MAX_RECONNECT_MS = 30_000;

interface Tx {
  p: string; // pair
  tt: "buy" | "sell";
  s: number; // SOL amount
  u: number; // USD amount
  q: number; // token amount
  t: number;
  tx: string;
}

interface PairState {
  pair: string;

  priceUsd: number;
  priceSol: number;

  previousPriceUsd: number;
  previousPriceSol: number;

  lastSide: "buy" | "sell";

  lastTradeUsd: number;
  lastTradeSol: number;

  lastTokenAmount: number;

  lastTradeTime: number;

  tx: string;
}

const states = new Map<string, PairState>();

let ws: WebSocket | null = null;

let heartbeat: Timer | null = null;
let reconnect: Timer | null = null;

let reconnectDelay = 1000;

const subscribePacket = JSON.stringify({
  method: "subscribe",
  type: "tx",
  args: {
    pair: PAIRS,
  },
});

connect();

function connect() {
  if (ws) {
    ws.close();
    ws = null;
  }

  console.log("Connecting...");

  ws = new WebSocket(WS_URL, {
    headers: {
      "x-api-key": API_KEY,
    },
  });

  ws.addEventListener("open", onOpen);
  ws.addEventListener("message", onMessage);
  ws.addEventListener("close", onClose);
  ws.addEventListener("error", onError);
}

function onOpen() {
  console.log("Connected");

  reconnectDelay = 1000;

  ws!.send(subscribePacket);

  if (heartbeat) clearInterval(heartbeat);

  heartbeat = setInterval(() => {
    ws?.ping();
  }, HEARTBEAT_MS);
}

function onClose() {
  console.log("Disconnected");

  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }

  if (reconnect) return;

  console.log(`Reconnect in ${reconnectDelay / 1000}s`);

  reconnect = setTimeout(() => {
    reconnect = null;

    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);

    connect();
  }, reconnectDelay);
}

function onError(error: Event) {
  console.error(error);
}

function onMessage(event: MessageEvent) {
  const raw = event.data.toString();

  // Ignore ACK packets
  if (raw.includes('"status":"ack"')) return;

  let packet: any;

  try {
    packet = JSON.parse(raw);
  } catch {
    return;
  }

  if (packet.type !== "tx") return;

  const trades: Tx[] = packet.result;

  if (!Array.isArray(trades)) return;

  for (const trade of trades) {
    processTrade(trade);
  }
}

function processTrade(trade: Tx) {
  if (!trade.q) return;

  const inv = 1 / trade.q;

  const priceUsd = trade.u * inv;
  const priceSol = trade.s * inv;

  let state = states.get(trade.p);

  if (!state) {
    state = {
      pair: trade.p,

      priceUsd,
      priceSol,

      previousPriceUsd: priceUsd,
      previousPriceSol: priceSol,

      lastSide: trade.tt,

      lastTradeUsd: trade.u,
      lastTradeSol: trade.s,

      lastTokenAmount: trade.q,

      lastTradeTime: trade.t,

      tx: trade.tx,
    };

    states.set(trade.p, state);

    print(state, true);

    return;
  }

  state.previousPriceUsd = state.priceUsd;
  state.previousPriceSol = state.priceSol;

  state.priceUsd = priceUsd;
  state.priceSol = priceSol;

  state.lastSide = trade.tt;

  state.lastTradeUsd = trade.u;
  state.lastTradeSol = trade.s;

  state.lastTokenAmount = trade.q;

  state.lastTradeTime = trade.t;

  state.tx = trade.tx;

  print(state, false);

  // -------------------------------------------------------
  // Trading Strategy
  //
  // if (state.priceUsd > ...)
  //      BUY
  //
  // if (state.priceUsd < ...)
  //      SELL
  //
  // -------------------------------------------------------
}

function print(state: PairState, first: boolean) {
  const pct =
    state.previousPriceUsd === 0
      ? 0
      : ((state.priceUsd - state.previousPriceUsd) / state.previousPriceUsd) *
        100;

  const arrow = first ? "•" : pct > 0 ? "▲" : pct < 0 ? "▼" : "=";

  console.log(
    [
      new Date(state.lastTradeTime * 1000).toLocaleTimeString(),

      arrow,

      state.lastSide.toUpperCase().padEnd(4),

      state.pair.slice(0, 8),

      `$${state.priceUsd.toFixed(10)}`,

      `${pct >= 0 ? "+" : ""}${pct.toFixed(4)}%`,

      `Vol:$${state.lastTradeUsd.toFixed(2)}`,

      `${state.lastTokenAmount.toFixed(2)} tokens`,
    ].join(" | "),
  );
}
