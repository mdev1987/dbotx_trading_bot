import { Subscription, timer } from "rxjs";

import { unifiedPriceUpdate$ } from "../data_stream/price_engine";

import { updatePositionPrice } from "./positions_store";

import { scanPositions } from "./positions_strategy";

let priceSub: Subscription | null = null;
let scanSub: Subscription | null = null;

export function initPositionEngine(): void {
  if (priceSub) {
    return;
  }

  priceSub = unifiedPriceUpdate$.subscribe(updatePositionPrice);

  scanSub = timer(1000, 1000).subscribe(scanPositions);

  console.log("[PositionEngine] Started");
}

export function stopPositionEngine(): void {
  priceSub?.unsubscribe();
  scanSub?.unsubscribe();

  priceSub = null;
  scanSub = null;

  console.log("[PositionEngine] Stopped");
}
