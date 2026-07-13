import { Subject } from "rxjs";
import { CONFIG } from "../../config";
import { botHttp as http } from "../http";
import { SimulatorOrderStatus } from "./orders";

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

type SwapTradeState = "done" | "fail" | "expired" | "init" | "processing";

export interface SimulatorTask {
  id: string;

  status: SimulatorOrderStatus;

  pair: string;

  type: "buy" | "sell";

  priceUsd?: number;

  amountSol?: number;

  amountToken?: number;

  txHash?: string;

  error?: string;

  updatedAt: number;
}

interface SwapTradeItem {
  _id: string;

  state: SwapTradeState;

  chain: string;

  pair: string;

  type: "buy" | "sell";

  send: { amount: string };

  receive: { amount: string };

  errorCode?: string;

  errorMessage?: string;
}

interface SwapTradesResponse {
  err: boolean;

  res: SwapTradeItem[];
}

/* -------------------------------------------------------------------------- */
/*                                   Events                                   */
/* -------------------------------------------------------------------------- */

/**
 * Emitted whenever a task reaches a terminal state.
 */
export const simulatorTaskCompleted$ = new Subject<SimulatorTask>();

/* -------------------------------------------------------------------------- */
/*                              State Mapping                                 */
/* -------------------------------------------------------------------------- */

function toSimulatorOrderStatus(state: SwapTradeState): SimulatorOrderStatus {
  switch (state) {
    case "done":
      return SimulatorOrderStatus.Executed;
    case "fail":
      return SimulatorOrderStatus.Failed;
    case "expired":
      return SimulatorOrderStatus.Cancelled;
    default:
      return SimulatorOrderStatus.Pending;
  }
}

/* -------------------------------------------------------------------------- */
/*                                Get Task                                    */
/* -------------------------------------------------------------------------- */

/**
 * Downloads the latest task information.
 */
export async function getTask(
  orderId: string,
  pair: string,
): Promise<SimulatorTask> {
  const response = await http.get<SwapTradesResponse>(
    `/simulator/swap_trades?chain=solana&page=0&size=20&wallet=&token=${pair}`,
  );

  if (response.err) {
    throw new Error("Simulator returned an error.");
  }

  const info = response.res.find((t) => t._id === orderId);

  if (!info) {
    throw new Error("Simulator task not found.");
  }

  return {
    id: info._id,
    status: toSimulatorOrderStatus(info.state),
    pair: info.pair,
    type: info.type,
    amountSol: Number(info.send.amount) / 1e9,
    amountToken: Number(info.receive.amount),
    error: info.errorMessage || info.errorCode,
    updatedAt: Date.now(),
  };
}

/* -------------------------------------------------------------------------- */
/*                               Wait For Task                                */
/* -------------------------------------------------------------------------- */

/**
 * Polls until the order reaches a terminal state.
 */
export async function waitForTaskConfirmed(
  orderId: string,
  pair: string,
): Promise<SimulatorTask> {
  const timeout = CONFIG.simulatorTaskTimeoutSecs * 1000;

  const started = Date.now();

  while (true) {
    const task = await getTask(orderId, pair);

    switch (task.status) {
      case SimulatorOrderStatus.Executed:
        simulatorTaskCompleted$.next(task);
        return task;

      case SimulatorOrderStatus.Failed:
      case SimulatorOrderStatus.Cancelled:
        throw new Error(task.error ?? task.status);
    }

    if (Date.now() - started >= timeout) {
      throw new Error("Simulator task timed out.");
    }

    await sleep(CONFIG.simulatorTaskPollIntervalMs);
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Helper                                   */
/* -------------------------------------------------------------------------- */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
