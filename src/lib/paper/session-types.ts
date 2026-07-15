import type {
  EntryTimeWindow,
  Interval,
  OpenPosition,
  OptionsTradeSettings,
  ScanReport,
  StrategyConfig,
  TradeInstrument,
} from "../types";

export type PaperSessionStatus = "running" | "stopped" | "ended";

export type PaperSessionConfig = {
  /** Primary strategy (always set) */
  strategy: StrategyConfig;
  /**
   * Optional second strategy — same market data (no extra Upstox candle fetch).
   * Both evaluated each worker tick.
   */
  strategy2?: StrategyConfig;
  /** Optional options override for strategy 2 (e.g. PE while primary is CE) */
  options2?: OptionsTradeSettings;
  interval: Interval;
  initialCapital: number;
  positionSizePct: number;
  oneTradePerDay: boolean;
  entryTimeWindows?: EntryTimeWindow[];
  maxRiskPerTrade?: {
    enabled: boolean;
    mode: "pct" | "amount";
    pct?: number;
    amount?: number;
  };
  tradeInstrument: TradeInstrument;
  options?: OptionsTradeSettings;
  maxSymbols: number;
  scanAll: boolean;
};

export type StrategyPaperResult = {
  strategyName: string;
  slot: 1 | 2;
  report: ScanReport;
  openPositions: OpenPosition[];
};

export type PaperSessionDoc = {
  id: string;
  userId: string;
  status: PaperSessionStatus;
  /** Upstox token for unattended market data (server-only field) */
  upstoxAccessToken: string;
  config: PaperSessionConfig;
  /** IST session day this run belongs to */
  sessionDay: string;
  startedAt: number;
  updatedAt: number;
  /** Auto-stop after market close (ms) */
  endsAt: number;
  lastWorkerAt?: number;
  lastError?: string;
  workerNote?: string;
  tickCount?: number;
  /**
   * Index into the sorted F&O universe for the next batch (rotating window).
   * Each tick processes batchSize symbols starting at this offset, then advances.
   */
  rotationOffset?: number;
  /** Last batch info for UI */
  lastBatch?: {
    fromIndex: number;
    toIndex: number;
    universeSize: number;
    symbols: string[];
    rateLimited?: number;
    errors?: number;
  };
  /** Primary strategy report (compat) */
  report?: ScanReport | null;
  openPositions?: OpenPosition[];
  /** Per-strategy results when dual mode is on */
  strategyResults?: StrategyPaperResult[];
  eventLog?: string[];
};

/** Strategies to run this session (1 or 2). */
export function strategiesForConfig(cfg: PaperSessionConfig): {
  strategy: StrategyConfig;
  options?: OptionsTradeSettings;
  slot: 1 | 2;
}[] {
  const list: {
    strategy: StrategyConfig;
    options?: OptionsTradeSettings;
    slot: 1 | 2;
  }[] = [{ strategy: cfg.strategy, options: cfg.options, slot: 1 }];
  // Strategy 2: entry required; exit optional (empty exit = hold until day end)
  if (cfg.strategy2?.entry?.length) {
    list.push({
      strategy: {
        ...cfg.strategy2,
        exit: cfg.strategy2.exit?.length ? cfg.strategy2.exit : [],
      },
      options: cfg.options2 ?? cfg.options,
      slot: 2,
    });
  }
  return list;
}
