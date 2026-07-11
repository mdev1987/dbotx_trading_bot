import { Subject } from "rxjs";
import { CONFIG } from "../../config";
import { http } from "./simulator_http";
import { SimulatorOrderStatus } from "./simulator_orders";
/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

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

/** Maximum wait for buy/sell completion. */
const simulatorTaskTimeoutSecs = 30;

/** Poll every 500ms. */
const simulatorTaskPollIntervalMs = 500;

/** HTTP request timeout. */
const simulatorHttpTimeoutMs = 10000;

/** HTTP retry count. */
const simulatorHttpRetries = 3;

/** Delay between HTTP retries. */
const simulatorHttpRetryDelayMs = 1000;

interface SimulatorTaskResponse {
  err: boolean;

  res: {
    id: string;

    status: SimulatorOrderStatus;

    pair: string;

    type: "buy" | "sell";

    priceUsd?: number;

    amountToken?: number;

    txHash?: string;

    error?: string;
  };
}

/* -------------------------------------------------------------------------- */
/*                                   Events                                   */
/* -------------------------------------------------------------------------- */

/**
 * Emitted whenever a task reaches a terminal state.
 */
export const simulatorTaskCompleted$ = new Subject<SimulatorTask>();

/* -------------------------------------------------------------------------- */
/*                                Get Task                                    */
/* -------------------------------------------------------------------------- */

/**
 * Downloads the latest task information.
 */
export async function getTask(orderId: string): Promise<SimulatorTask> {
  const response = await http.get<SimulatorTaskResponse>(
    `/simulator/task?id=${orderId}`,
  );

  if (response.err) {
    throw new Error("Simulator returned an error.");
  }

  return {
    ...response.res,

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
  const timeout = simulatorTaskTimeoutSecs * 1000;

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

    await sleep(simulatorTaskPollIntervalMs);
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Helper                                   */
/* -------------------------------------------------------------------------- */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
