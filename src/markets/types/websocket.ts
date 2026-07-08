export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

export interface AckMessage {
  status: "ack";

  method: string;

  result: {
    subscribed?: string[];

    message: string;

    t: number;
  };
}

export interface ErrorMessage {
  status: "error";

  message: string;
}

export type WsMessage = AckMessage | ErrorMessage;
