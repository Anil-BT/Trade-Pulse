export type Interval =
  | "1m"
  | "2m"
  | "5m"
  | "15m"
  | "30m"
  | "60m"
  | "1d"
  | "1wk"
  | "1mo";

export type DataSource = "upstox" | "dhan" | "kite";

export type TradeInstrument = "equity" | "options_atm";

export interface Candle {
  time: number; // unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type IndicatorType =
  | "EMA"
  | "SMA"
  | "RSI"
  /** Average Directional Index (Wilder), default period 14 */
  | "ADX"
  /** Session VWAP (resets each IST trading day) */
  | "VWAP"
  /**
   * Opening range high from 09:15 IST for `period` minutes (default 15).
   * period 15 → 09:15–09:30, period 30 → 09:15–09:45.
   */
  | "OPENING_RANGE_HIGH"
  /**
   * Opening range low from 09:15 IST for `period` minutes (default 15).
   * period 15 → 09:15–09:30, period 30 → 09:15–09:45.
   */
  | "OPENING_RANGE_LOW"
  /** Previous session Fibonacci pivot levels (classic fib pivots) */
  | "FIB_PIVOT"
  | "FIB_PIVOT_R1"
  | "FIB_PIVOT_R2"
  | "FIB_PIVOT_R3"
  | "FIB_PIVOT_S1"
  | "FIB_PIVOT_S2"
  | "FIB_PIVOT_S3"
  /** Previous session high / low (flat for current day) */
  | "PREV_DAY_HIGH"
  | "PREV_DAY_LOW"
  /**
   * Breakout high = max(OR high 09:15–09:30, Fib R3, Prev Day High).
   * Use with cross_above for true breakout entries.
   */
  | "BREAKOUT_HIGH"
  /**
   * Breakdown low = min(OR low 09:15–09:30, Fib S3, Prev Day Low).
   * Use with cross_below for true breakdown entries.
   */
  | "BREAKOUT_LOW"
  /** On-Balance Volume (cumulative) */
  | "OBV"
  /**
   * Volume / SMA(volume, period). Use e.g. VOL_RATIO ≥ 1.5 for volume spike.
   */
  | "VOL_RATIO";

export type CompareOperand =
  | "close"
  | "open"
  | "high"
  | "low"
  | "volume"
  | { indicator: IndicatorType; period?: number };

export type Comparator =
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "cross_above"
  | "cross_below"
  /** Left series bar-to-bar rising (right ignored) */
  | "rising"
  /** Left series bar-to-bar falling (right ignored) */
  | "falling";

export interface Condition {
  id: string;
  left: CompareOperand;
  op: Comparator;
  right: CompareOperand | number;
}

export interface StrategyConfig {
  name: string;
  entry: Condition[];
  exit: Condition[];
  /** All entry conditions must be true (AND). Default true. */
  entryLogic?: "and" | "or";
  exitLogic?: "and" | "or";
  /**
   * Trail stop to entry (breakeven) once unrealized profit ≥ this % of initial capital.
   * Example: profitPctOfCapital = 20 → arm when uPnL ≥ 20% of capital, then exit at cost if price returns.
   */
  trailStopToCost?: {
    enabled: boolean;
    /** % of initial capital (default 20) */
    profitPctOfCapital?: number;
  };
  /**
   * Classic trailing stop: track high-water mark since entry, exit when price
   * falls `pct`% from that peak (long only). Used when lotRules is empty.
   */
  trailStop?: {
    enabled: boolean;
    /** Trail distance in % below peak (e.g. 1 = 1%) */
    pct: number;
  };
  /**
   * How many lots (F&O) or scale units to open per entry (1–5). Default 1.
   * With 2 lots, configure lotRules[0] and lotRules[1] independently.
   */
  positionLots?: number;
  /**
   * Per-lot exit / trail rules (lot 1 = index 0).
   * If omitted, trailStop / trailStopToCost apply to all lots together.
   */
  lotRules?: LotTrailRule[];
}

/** Exit / trailing behaviour for one lot of a multi-lot position. */
export interface LotTrailRule {
  /**
   * Take-profit: close this lot when mark is +this % above entry.
   * Example: 20 → exit lot when premium/price is ≥ entry × 1.20.
   * Typical: lot 1 books 20%, lot 2 trails at cost / trail SL.
   */
  takeProfitPct?: number;
  /** Trail % from peak for this lot; 0 or omitted = no % trail */
  trailPct?: number;
  /** Move this lot’s stop to cost (breakeven) after arming */
  trailToCost?: boolean;
  /**
   * Arm trail-to-cost when this lot’s unrealized profit ≥ this % of capital
   * (this lot’s share). Ignored if armToCostOnPartialTp handles it.
   */
  trailToCostProfitPctOfCapital?: number;
  /**
   * When another lot takes profit, arm trail-to-cost on this lot.
   * Default true if trailToCost is enabled.
   */
  armToCostOnPartialTp?: boolean;
  /**
   * Close this lot when strategy exit conditions fire.
   * Default true. Set false to hold this lot until trail / TP only.
   */
  exitOnSignal?: boolean;
}

export interface OptionsTradeSettings {
  /** CE (call) or PE (put) — ATM strike on entry. */
  side: "CE" | "PE";
  /**
   * NSE F&O lot size. 0 = auto-resolve from Upstox NSE FO master
   * (e.g. RELIANCE=500, TCS=225, INFY=400).
   */
  lotSize: number;
  /**
   * Number of lots to buy per entry (1–5). Default 1.
   * Prefer strategy.positionLots when set.
   */
  lots?: number;
  /** 0 = auto from FO chain / spot. */
  strikeStep: number;
  /** Annualized IV 0–1 (e.g. 0.25 = 25%). */
  iv: number;
  /** Assumed DTE at entry (days). */
  daysToExpiry: number;
  /** Listed strikes (from NSE FO) for true ATM selection. */
  listedStrikes?: number[];
}

/** Intraday window (IST) when new entries are allowed. */
export interface EntryTimeWindow {
  enabled: boolean;
  /** HH:mm IST, inclusive */
  start: string;
  /** HH:mm IST, inclusive */
  end: string;
}

export interface BacktestRequest {
  symbol: string;
  interval: Interval;
  from: string; // YYYY-MM-DD
  to: string;
  source: DataSource;
  strategy: StrategyConfig;
  initialCapital: number;
  positionSizePct: number; // 0-100, % of capital per trade
  /** Max 1 entry per session day. */
  oneTradePerDay?: boolean;
  /**
   * Up to two IST entry windows. If any window is enabled, entries only fire
   * when bar time falls inside at least one enabled window.
   * If none enabled (or omitted), entries allowed all session.
   */
  entryTimeWindows?: EntryTimeWindow[];
  /**
   * Hard stop: exit open trade if unrealized loss ≥ this amount.
   * - Equity: (entry − mark) × qty
   * - Options: (entry premium − mark premium) × units
   */
  maxRiskPerTrade?: {
    enabled: boolean;
    mode: "pct" | "amount";
    /** % of initial capital (e.g. 2 = 2%) when mode is pct */
    pct?: number;
    /** Absolute ₹ cap when mode is amount */
    amount?: number;
  };
  /** equity (default) or ATM options simulation. */
  tradeInstrument?: TradeInstrument;
  options?: OptionsTradeSettings;
  upstoxAccessToken?: string;
  upstoxInstrumentKey?: string;
  /** DhanHQ JWT access token */
  dhanAccessToken?: string;
  /** Optional Dhan client id (some APIs require client-id header) */
  dhanClientId?: string;
  /** Zerodha Kite Connect API key */
  kiteApiKey?: string;
  /** Zerodha Kite session access token */
  kiteAccessToken?: string;
  /**
   * Do not open new trades before this timestamp (ms).
   * Used after fetching warmup lookback candles for indicators.
   */
  entryNotBeforeMs?: number;
  /**
   * Paper trading: do not force-close open positions on last bar (no synthetic EOD).
   * Open leg is returned on result.openPosition.
   */
  leaveOpenPositions?: boolean;
  /**
   * When set, only open entries on these IST session days (YYYY-MM-DD).
   * Used by sector-trend scan (stock only tradeable on days it was a top pick).
   */
  allowedEntryDates?: string[];
  /**
   * Sector-filter mode: shortlist IS the entry signal.
   * On each allowedEntryDates day, enter on the first bar that passes
   * entryNotBefore + entryTimeWindows (strategy entry conditions ignored).
   * Strategy exit conditions still apply.
   */
  sectorPickEntry?: boolean;
}

export interface Trade {
  entryTime: number;
  exitTime: number;
  /** Equity fill price OR option premium per unit */
  entryPrice: number;
  exitPrice: number;
  qty: number;
  /** Cash locked at entry (premium×units or equity notional) */
  capitalUsed: number;
  pnl: number;
  pnlPct: number;
  barsHeld: number;
  /** Why the trade closed (strategy signal vs max-risk / trail / take-profit) */
  exitReason?:
    | "signal"
    | "max_risk"
    | "trail_cost"
    | "trail_sl"
    | "take_profit"
    | "eod";
  /** Equity underlying spot used for signals at entry/exit */
  underlyingEntry?: number;
  underlyingExit?: number;
  instrument?: TradeInstrument;
  optionSide?: "CE" | "PE";
  strike?: number;
  lots?: number;
  lotSize?: number;
  /** Premium × lotSize at entry/exit */
  lotCostEntry?: number;
  lotCostExit?: number;
  label?: string;
  /** market = real F&O OHLC; model = estimated */
  premiumSource?: "market" | "model";
  exitPremiumSource?: "market" | "model";
}

export interface EquityPoint {
  time: number;
  equity: number;
}

export interface BacktestMetrics {
  totalTrades: number;
  winners: number;
  losers: number;
  winRate: number;
  totalPnl: number;
  totalPnlPct: number;
  avgPnl: number;
  avgWin: number;
  /** Average loss as negative number */
  avgLoss: number;
  /** Sum of winning trade P&L */
  grossProfit: number;
  /** Sum of |losing trade P&L| (positive number) */
  grossLoss: number;
  /**
   * Reward:Risk = |avgWin| / |avgLoss|.
   * Infinity-like values capped at 999 when no losses.
   */
  riskRewardRatio: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  profitFactor: number;
  finalEquity: number;
  initialCapital: number;
  /** Sum of capital locked across all trades */
  totalCapitalUsed: number;
  /** Average capital per trade */
  avgCapitalUsed: number;
  /** Largest single-trade capital lock */
  maxCapitalUsed: number;
}

/** One trading day's aggregate (IST). */
export interface DaySummary {
  /** YYYY-MM-DD IST */
  date: string;
  trades: number;
  winners: number;
  losers: number;
  winRate: number;
  pnl: number;
  /** Gross profit (sum of winning trades) */
  grossProfit: number;
  /** Gross loss as positive number */
  grossLoss: number;
  avgPnl: number;
  avgWin: number;
  avgLoss: number;
  bestTrade: number;
  worstTrade: number;
  capitalUsed: number;
  maxRiskStops: number;
  signalExits: number;
  /** Cumulative P&L through this day (running total) */
  cumulativePnl: number;
}

/** Open paper/live leg (not yet exited). */
export interface OpenPosition {
  entryTime: number;
  /**
   * Fill unit price: equity stock ₹, or option premium ₹ per unit.
   * For options_atm this is premium, not the underlying stock price.
   */
  entryPrice: number;
  qty: number;
  capitalUsed: number;
  /** Underlying equity spot at entry (options mode) */
  underlyingEntry?: number;
  /** Underlying equity spot at last mark (options mode) */
  underlyingMark?: number;
  strike?: number;
  lots?: number;
  lotSize?: number;
  optionSide?: "CE" | "PE";
  /**
   * Mark unit price in same units as entryPrice (premium for options).
   */
  markPrice: number;
  /** Unrealized P&L = (markPrice − entryPrice) × qty  (₹) */
  unrealizedPnl: number;
  symbol?: string;
  label?: string;
  /** Option instrument key when market-priced */
  instrumentKey?: string;
  /** Entry premium source */
  premiumSource?: "market" | "model";
  /** Mark premium source */
  markSource?: "market" | "model" | "ltp";
}

export interface BacktestResult {
  candles: Candle[];
  trades: Trade[];
  equityCurve: EquityPoint[];
  metrics: BacktestMetrics;
  /** Present when backtest spans more than one session day */
  daySummaries?: DaySummary[];
  indicators: Record<string, (number | null)[]>;
  source: DataSource;
  symbol: string;
  interval: Interval;
  tradeInstrument?: TradeInstrument;
  oneTradePerDay?: boolean;
  /** Set when leaveOpenPositions and a leg is still open */
  openPosition?: OpenPosition;
  /** Resolved options params used for execution (signals stay on equity). */
  optionsMeta?: {
    side: "CE" | "PE";
    lotSize: number;
    strikeStep: number;
    iv: number;
    daysToExpiry: number;
    lotSource?: string;
    listedStrikesCount?: number;
    pricingMode?: "market" | "model" | "mixed";
    marketContractsUsed?: number;
    marketFills?: number;
    modelFills?: number;
  };
  /** Diagnostics when few/no trades. */
  diagnostics?: {
    equitySignals: number;
    entriesTaken: number;
    skippedInsufficientCapital: number;
    /** Signals skipped because market option premium was unavailable (strict mode) */
    skippedNoMarketPremium?: number;
    /** Trades closed because unrealized loss hit max risk */
    maxRiskStops?: number;
    /** Trades closed on trail-to-cost (breakeven) stop */
    trailCostStops?: number;
    /** Trades closed on % trailing stop from peak */
    trailSlStops?: number;
    minLotCost?: number;
    maxRiskCap?: number;
    /** ₹ profit level that arms trail-to-cost */
    trailProfitThreshold?: number;
    note?: string;
    /** Bars used for indicators / signals */
    candleCount?: number;
    firstBarTime?: number;
    lastBarTime?: number;
  };
}

/** Compact trade row for F&O scan subtables. */
export interface ScanTradeDetail {
  entryTime: number;
  exitTime: number;
  /** Equity spot or option premium at entry */
  entryPrice: number;
  exitPrice: number;
  capitalUsed?: number;
  /** Underlying equity spot (always set for options mode) */
  underlyingEntry?: number;
  underlyingExit?: number;
  strike?: number;
  optionSide?: "CE" | "PE";
  lots?: number;
  lotSize?: number;
  label?: string;
  pnl: number;
  pnlPct: number;
  barsHeld: number;
}

/** Named strategy saved by the user (browser storage for now). */
export interface SavedStrategy {
  id: string;
  name: string;
  strategy: StrategyConfig;
  updatedAt: number;
  createdAt: number;
}

/** One row in the multi-symbol F&O scan report. */
export interface ScanRow {
  symbol: string;
  lotSize?: number;
  trades: number;
  winRate: number;
  totalPnl: number;
  totalPnlPct: number;
  finalEquity: number;
  equitySignals?: number;
  error?: string;
  /** Human message: no trade / error detail */
  message?: string;
  status: "ok" | "error" | "no_trades";
  /** Entry/exit times & prices for this stock */
  tradeList?: ScanTradeDetail[];
}

/** One day's sector-trend pick (configurable morning ranking). */
export interface SectorTrendDayPick {
  date: string;
  /**
   * Day label: bullish / bearish if all picked sectors agree, else mixed.
   * Each sector also has its own direction.
   */
  direction: "bullish" | "bearish" | "mixed";
  /** Avg signed move of the picked top sectors */
  topSectorsAvgPct: number;
  sectors: {
    sector: string;
    /** Mean stock % in window (same metric as Market Watch bars) */
    avgChangePct: number;
    /** |avgChangePct| — bar length / trend strength */
    strength: number;
    /** Sign of sector bar: green bar → bullish, red → bearish */
    direction: "bullish" | "bearish";
    stocks: { symbol: string; changePct: number }[];
  }[];
}

export interface ScanReport {
  generatedAt: string;
  strategyName: string;
  from: string;
  to: string;
  interval: string;
  source: string;
  tradeInstrument: string;
  oneTradePerDay: boolean;
  universeSize: number;
  scanned: number;
  summary: {
    ok: number;
    errors: number;
    withTrades: number;
    totalTrades: number;
    totalPnl: number;
    avgPnl: number;
    winners: number;
    losers: number;
  };
  rows: ScanRow[];
  /** Present when scan used sector morning ranking → top sectors/stocks */
  sectorTrend?: {
    /** Requested mode (auto resolves per day) */
    mode: "auto" | "bullish" | "bearish";
    windowStart: string;
    windowEnd: string;
    windowLabel: string;
    topSectors: number;
    topStocksPerSector: number;
    biasThreshold: number;
    weightMode?: "turnover" | "equal";
    minStocks?: number;
    minBreadthPct?: number;
    bullDays: number;
    bearDays: number;
    dayPicks: SectorTrendDayPick[];
    note?: string;
  };
}
