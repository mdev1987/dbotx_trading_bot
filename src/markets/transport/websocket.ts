import { BehaviorSubject, Subject, interval } from "rxjs";

import { filter, shareReplay, switchMap } from "rxjs/operators";

export interface WebSocketTransportOptions {
  url: string;

  apiKey: string;

  reconnectDelay: number;

  heartbeatInterval: number;
}

export class WebSocketTransport {
  readonly socket$ = new BehaviorSubject<WebSocket | null>(null);

  readonly connected$ = new BehaviorSubject(false);

  readonly message$ = new Subject<unknown>();

  readonly error$ = new Subject<Error>();

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: WebSocketTransportOptions) {
    this.connected$
      .pipe(
        filter(Boolean),
        switchMap(() => interval(options.heartbeatInterval)),
      )
      .subscribe(() => {
        const ws = this.socket$.value;

        if (!ws || ws.readyState !== WebSocket.OPEN) {
          return;
        }

        try {
          ws.ping();
        } catch {}
      });
  }

  connect(): void {
    if (this.connected$.value) return;

    this.socket$.value?.close();

    const ws = new WebSocket(this.options.url, {
      headers: {
        "x-api-key": this.options.apiKey,
      },
    });

    ws.onopen = () => {
      this.socket$.next(ws);

      this.connected$.next(true);

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);

        this.reconnectTimer = null;
      }
    };

    ws.onmessage = ({ data }) => {
      try {
        if (typeof data !== "string") return;

        this.message$.next(JSON.parse(data));
      } catch (err) {
        this.error$.next(
          err instanceof Error ? err : new Error("Invalid JSON."),
        );
      }
    };

    ws.onerror = () => {
      this.error$.next(new Error("WebSocket error."));
    };

    ws.onclose = () => {
      this.socket$.next(null);

      this.connected$.next(false);

      this.scheduleReconnect();
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);

      this.reconnectTimer = null;
    }

    this.socket$.value?.close();

    this.socket$.next(null);

    this.connected$.next(false);
  }

  send(payload: unknown): boolean {
    const ws = this.socket$.value;

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    ws.send(JSON.stringify(payload));

    return true;
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      this.connect();
    }, this.options.reconnectDelay);
  }
}
