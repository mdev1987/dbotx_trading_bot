import type { Observable } from "rxjs";
import { Subscription, timer } from "rxjs";

import type { PriceInfo } from "../data_stream/types";

type PriceUpdateFn = (update: PriceInfo) => void;
type ScannerFn = (now: number) => void;

export class PositionEngine {
  private priceSub: Subscription | null = null;
  private scanSub: Subscription | null = null;

  constructor(
    private readonly priceUpdate$: Observable<PriceInfo>,
    private readonly onPriceUpdate: PriceUpdateFn,
    private readonly onScan: ScannerFn,
    private readonly scanIntervalMs = 1000,
  ) {}

  start(): void {
    if (this.priceSub) {
      return;
    }

    this.priceSub = this.priceUpdate$.subscribe(this.onPriceUpdate);

    this.scanSub = timer(this.scanIntervalMs, this.scanIntervalMs).subscribe(
      this.onScan,
    );

    console.log("[PositionEngine] Started");
  }

  stop(): void {
    this.priceSub?.unsubscribe();
    this.scanSub?.unsubscribe();

    this.priceSub = null;
    this.scanSub = null;

    console.log("[PositionEngine] Stopped");
  }
}
