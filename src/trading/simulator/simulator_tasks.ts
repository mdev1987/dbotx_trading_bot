import { Subject } from "rxjs";
import { CONFIG } from "../../config";
import { http } from "./simulator_http";
import { SimulatorOrderStatus } from "./simulator_orders";

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

type SwapOrderState = "init" | "processing" | "done" | "fail" | "expired";

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

interface SwapOrderInfo {
  id: string;

  state: SwapOrderState;

  chain: string;

  tradeType: "buy" | "sell";

  txPriceUsd?: number;

  swapHash?: string;

  errorCode?: string;

  errorMessage?: string;
}

interface SwapOrdersResponse {
  err: boolean;

  res: SwapOrderInfo[];
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

function toSimulatorOrderStatus(state: SwapOrderState): SimulatorOrderStatus {
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
export async function getTask(orderId: string): Promise<SimulatorTask> {
  const response = await http.get<SwapOrdersResponse>(
    `/automation/swap_orders?ids=${orderId}`,
  );

  if (response.err) {
    throw new Error("Simulator returned an error.");
  }

  const info = response.res[0];

  if (!info) {
    throw new Error("Simulator task not found.");
  }

  return {
    id: info.id,
    status: toSimulatorOrderStatus(info.state),
    pair: "",
    type: info.tradeType,
    priceUsd: info.txPriceUsd,
    txHash: info.swapHash,

    error: info.errorMessage || info.errorCode,

    amountSol: undefined,
    amountToken: undefined,
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
): Promise<SimulatorTask> {
  const timeout = CONFIG.simulatorTaskTimeoutSecs * 1000;

  const started = Date.now();

  while (true) {
    const task = await getTask(orderId);

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
