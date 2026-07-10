const TOKEN_MINT = "4xUCFcSE3Jys1yHFR8vK84cCtoY6Bmq3rzAovZgCVZ4K";
const WS_URL = "wss://stream.pumpapi.io/";

function connect() {
  const ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("Connected");
  };

  ws.onmessage = ({ data }) => {
    const event = JSON.parse(data as string);
    if (event.mint !== TOKEN_MINT) return;
    if (event.action !== "buy" && event.action !== "sell") return;

    console.log(`${event.action} ${event.price}`);
  };

  ws.onerror = console.error;

  ws.onclose = () => {
    console.log("Reconnecting in 1 second...");
    setTimeout(connect, 1000);
  };
}

connect();
