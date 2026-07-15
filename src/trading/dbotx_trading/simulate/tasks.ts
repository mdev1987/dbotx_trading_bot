import { Subject } from "rxjs";
import { CONFIG } from "../../../config";
import { botHttp as http } from "../../http";
import { SimulatorOrderStatus } from "./orders";

type PnLOrderState = "done" | "fail" | "expired" | "init" | "processing";

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

interface PnLOrderItem {
  _id: string;
  state: PnLOrderState;
  pair: string;
  tradeType: "buy" | "sell";
  sourceId: string;
  basePriceUsd: number;
  currencyAmountUI: number;
  errorCode?: string;
  errorMessage?: string;
}

interface PnLOrdersResponse {
  err: boolean;
  res: PnLOrderItem[];
}

export const simulatorTaskCompleted$ = new Subject<SimulatorTask>();

function toSimulatorOrderStatus(state: PnLOrderState): SimulatorOrderStatus {
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

export async function getTask(
  orderId: string,
  pair: string,
): Promise<SimulatorTask> {
  const response = await http.get<PnLOrdersResponse>(
    `/simulator/pnl_orders_from_swap_order?page=0&size=20&chain=solana&state=&groupId=&token=&sourceId=${orderId}&sortBy=&sort=-1`,
  );

  if (response.err) {
    throw new Error("Simulator returned an error.");
  }

  const orders = response.res.filter((t) => t.sourceId === orderId);

  if (orders.length === 0) {
    throw new Error("Simulator task not found.");
  }

  const allExpired = orders.every((o) => o.state === "expired");
  if (allExpired) {
    return {
      id: orderId,
      status: SimulatorOrderStatus.Cancelled,
      pair: orders[0]!.pair,
      type: orders[0]!.tradeType,
      error: "All PnL orders expired",
      updatedAt: Date.now(),
    };
  }

  const info =
    orders.find((o) => o.state !== "expired") ??
    orders.find((o) => o.state === "done") ??
    orders[0]!;

  return {
    id: info.sourceId,
    status: toSimulatorOrderStatus(info.state),
    pair: info.pair,
    type: info.tradeType,
    priceUsd: info.basePriceUsd,
    amountSol: info.currencyAmountUI,
    amountToken: undefined,
    error: info.errorMessage || info.errorCode,
    updatedAt: Date.now(),
  };
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
