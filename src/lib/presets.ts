import type { StrategyConfig } from "./types";

export const PRESET_OPENING_RANGE_EMA: StrategyConfig = {
  name: "Opening Range + EMA9",
  entryLogic: "and",
  exitLogic: "and",
  entry: [
    {
      id: "e1",
      left: "close",
      op: "gt",
      right: { indicator: "OPENING_RANGE_HIGH", period: 15 },
    },
    {
      id: "e2",
      left: "close",
      op: "gt",
      right: { indicator: "EMA", period: 9 },
    },
  ],
  exit: [
    {
      id: "x1",
      left: "close",
      op: "lt",
      right: { indicator: "EMA", period: 9 },
    },
  ],
};

export const PRESET_EMA_CROSS: StrategyConfig = {
  name: "EMA 9/21 Cross",
  entryLogic: "and",
  exitLogic: "and",
  entry: [
    {
      id: "e1",
      left: { indicator: "EMA", period: 9 },
      op: "cross_above",
      right: { indicator: "EMA", period: 21 },
    },
  ],
  exit: [
    {
      id: "x1",
      left: { indicator: "EMA", period: 9 },
      op: "cross_below",
      right: { indicator: "EMA", period: 21 },
    },
  ],
};

export const PRESET_RSI_MEAN_REVERSION: StrategyConfig = {
  name: "RSI Mean Reversion",
  entryLogic: "and",
  exitLogic: "and",
  entry: [
    {
      id: "e1",
      left: { indicator: "RSI", period: 14 },
      op: "lt",
      right: 30,
    },
  ],
  exit: [
    {
      id: "x1",
      left: { indicator: "RSI", period: 14 },
      op: "gt",
      right: 50,
    },
  ],
};

/**
 * Entry: close above 15m OR (09:15–09:30) candle high AND above EMA20 AND above Fib pivot R3
 * Exit:  close below EMA20
 * (Use on a 5-minute chart; Opening Range period = 1 = first bar of the session.)
 */
export const PRESET_OR_EMA20_FIB_R3: StrategyConfig = {
  name: "OR + EMA20 + Fib R3",
  entryLogic: "and",
  exitLogic: "and",
  entry: [
    {
      id: "e1",
      left: "close",
      op: "gt",
      right: { indicator: "OPENING_RANGE_HIGH", period: 15 },
    },
    {
      id: "e2",
      left: "close",
      op: "gt",
      right: { indicator: "EMA", period: 20 },
    },
    {
      id: "e3",
      left: "close",
      op: "gt",
      right: { indicator: "FIB_PIVOT_R3", period: 1 },
    },
  ],
  exit: [
    {
      id: "x1",
      left: "close",
      op: "lt",
      right: { indicator: "EMA", period: 20 },
    },
  ],
};

/**
 * Entry (breakout):
 *  1) Trend filter: close > EMA20
 *  2) Structure filters: close > OR high, Fib R3, and PDH (all three levels cleared)
 *  3) Trigger: close **crosses above** breakout high = max(OR high, Fib R3, PDH)
 *     → only the breakout bar, not every bar while already above
 * Exit: close < EMA20
 * Use on 5m; OR = 15 min (09:15–09:30 IST).
 */
export const PRESET_OR_EMA20_FIB_R3_PDH: StrategyConfig = {
  name: "OR + EMA20 + Fib R3 + PDH (bullish)",
  entryLogic: "and",
  exitLogic: "and",
  entry: [
    {
      id: "e1",
      left: "close",
      op: "gt",
      right: { indicator: "EMA", period: 20 },
    },
    {
      id: "e2",
      left: "close",
      op: "gt",
      right: { indicator: "OPENING_RANGE_HIGH", period: 15 },
    },
    {
      id: "e3",
      left: "close",
      op: "gt",
      right: { indicator: "FIB_PIVOT_R3", period: 1 },
    },
    {
      id: "e4",
      left: "close",
      op: "gt",
      right: { indicator: "PREV_DAY_HIGH", period: 1 },
    },
    {
      id: "e5",
      left: "close",
      op: "cross_above",
      right: { indicator: "BREAKOUT_HIGH", period: 15 },
    },
  ],
  exit: [
    {
      id: "x1",
      left: "close",
      op: "lt",
      right: { indicator: "EMA", period: 20 },
    },
  ],
};

/**
 * Bearish mirror of OR + EMA20 + Fib R3 + PDH:
 *  1) Trend filter: close < EMA20
 *  2) Structure: close < 15m OR (09:15–09:30) candle low, Fib S3, and PDL (all three broken)
 *  3) Trigger: close **crosses below** breakdown low = min(15m OR (09:15–09:30) low, Fib S3, PDL)
 * Exit: close > EMA20
 * Use on **5m** interval; OR period = 1 → first 5-minute candle only.
 * Pair with PE / short-biased options if trading options.
 */
export const PRESET_OR_EMA20_FIB_S3_PDL: StrategyConfig = {
  name: "OR + EMA20 + Fib S3 + PDL (bearish)",
  entryLogic: "and",
  exitLogic: "and",
  entry: [
    {
      id: "e1",
      left: "close",
      op: "lt",
      right: { indicator: "EMA", period: 20 },
    },
    {
      // 1st 5-minute candle low (period 1 on 5m chart)
      id: "e2",
      left: "close",
      op: "lt",
      right: { indicator: "OPENING_RANGE_LOW", period: 15 },
    },
    {
      id: "e3",
      left: "close",
      op: "lt",
      right: { indicator: "FIB_PIVOT_S3", period: 1 },
    },
    {
      id: "e4",
      left: "close",
      op: "lt",
      right: { indicator: "PREV_DAY_LOW", period: 1 },
    },
    {
      id: "e5",
      left: "close",
      op: "cross_below",
      right: { indicator: "BREAKOUT_LOW", period: 15 },
    },
  ],
  exit: [
    {
      id: "x1",
      left: "close",
      op: "gt",
      right: { indicator: "EMA", period: 20 },
    },
  ],
};

/**
 * VWAP Bull — trend-following long bias
 * Entry: EMA9 > EMA21, close > VWAP, RSI 50–70, close > SMA20, ADX > 20
 * Exit:  close < EMA21
 * Trail: move SL to cost when unrealized profit ≥ 20% of capital
 */
export const PRESET_VWAP_BULL: StrategyConfig = {
  name: "VWAP Bull",
  entryLogic: "and",
  exitLogic: "and",
  trailStopToCost: { enabled: true, profitPctOfCapital: 20 },
  entry: [
    {
      id: "e1",
      left: { indicator: "EMA", period: 9 },
      op: "gt",
      right: { indicator: "EMA", period: 21 },
    },
    {
      id: "e2",
      left: "close",
      op: "gt",
      right: { indicator: "VWAP", period: 1 },
    },
    {
      id: "e3",
      left: { indicator: "RSI", period: 14 },
      op: "gt",
      right: 50,
    },
    {
      id: "e4",
      left: { indicator: "RSI", period: 14 },
      op: "lt",
      right: 70,
    },
    {
      id: "e5",
      left: "close",
      op: "gt",
      right: { indicator: "SMA", period: 20 },
    },
    {
      id: "e6",
      left: { indicator: "ADX", period: 14 },
      op: "gt",
      right: 20,
    },
  ],
  exit: [
    {
      id: "x1",
      left: "close",
      op: "lt",
      right: { indicator: "EMA", period: 21 },
    },
  ],
};

/**
 * VWAP Bear — short-bias conditions (use PE in options mode)
 * Entry: EMA9 < EMA21, close < VWAP, RSI 30–50, close > SMA20, ADX < 20
 * Exit:  close > EMA21
 * Trail: move SL to cost when unrealized profit ≥ 20% of capital
 */
export const PRESET_VWAP_BEAR: StrategyConfig = {
  name: "VWAP Bear",
  entryLogic: "and",
  exitLogic: "and",
  trailStopToCost: { enabled: true, profitPctOfCapital: 20 },
  entry: [
    {
      id: "e1",
      left: { indicator: "EMA", period: 9 },
      op: "lt",
      right: { indicator: "EMA", period: 21 },
    },
    {
      id: "e2",
      left: "close",
      op: "lt",
      right: { indicator: "VWAP", period: 1 },
    },
    {
      id: "e3",
      left: { indicator: "RSI", period: 14 },
      op: "lt",
      right: 50,
    },
    {
      id: "e4",
      left: { indicator: "RSI", period: 14 },
      op: "gt",
      right: 30,
    },
    {
      id: "e5",
      left: "close",
      op: "gt",
      right: { indicator: "SMA", period: 20 },
    },
    {
      id: "e6",
      left: { indicator: "ADX", period: 14 },
      op: "lt",
      right: 20,
    },
  ],
  exit: [
    {
      id: "x1",
      left: "close",
      op: "gt",
      right: { indicator: "EMA", period: 21 },
    },
  ],
};

/**
 * Bullish sector-trend entry (use with Sector Trend F&O scan).
 * Light conditions so sector-picked stocks can still enter after the ranking window.
 * Entry: close ≥ OR high AND close ≥ VWAP. Exit: under EMA20 or VWAP.
 */
export const PRESET_SECTOR_OR_EMA20_VWAP_FIB_BULL: StrategyConfig = {
  name: "Sector OR + VWAP (bull)",
  entryLogic: "and",
  exitLogic: "or",
  entry: [
    {
      id: "e1",
      left: "close",
      op: "gte",
      right: { indicator: "OPENING_RANGE_HIGH", period: 15 },
    },
    {
      id: "e2",
      left: "close",
      op: "gte",
      right: { indicator: "VWAP", period: 1 },
    },
  ],
  exit: [
    {
      id: "x1",
      left: "close",
      op: "lt",
      right: { indicator: "EMA", period: 20 },
    },
    {
      id: "x2",
      left: "close",
      op: "lt",
      right: { indicator: "VWAP", period: 1 },
    },
  ],
};

/**
 * Bearish mirror — PE in options mode.
 * Entry: close ≤ OR low AND close ≤ VWAP.
 */
export const PRESET_SECTOR_OR_EMA20_VWAP_FIB_BEAR: StrategyConfig = {
  name: "Sector OR + VWAP (bear)",
  entryLogic: "and",
  exitLogic: "or",
  entry: [
    {
      id: "e1",
      left: "close",
      op: "lte",
      right: { indicator: "OPENING_RANGE_LOW", period: 15 },
    },
    {
      id: "e2",
      left: "close",
      op: "lte",
      right: { indicator: "VWAP", period: 1 },
    },
  ],
  exit: [
    {
      id: "x1",
      left: "close",
      op: "gt",
      right: { indicator: "EMA", period: 20 },
    },
    {
      id: "x2",
      left: "close",
      op: "gt",
      right: { indicator: "VWAP", period: 1 },
    },
  ],
};

export const STRATEGY_PRESETS: StrategyConfig[] = [
  PRESET_OPENING_RANGE_EMA,
  PRESET_OR_EMA20_FIB_R3,
  PRESET_OR_EMA20_FIB_R3_PDH,
  PRESET_OR_EMA20_FIB_S3_PDL,
  PRESET_EMA_CROSS,
  PRESET_RSI_MEAN_REVERSION,
  PRESET_VWAP_BULL,
  PRESET_VWAP_BEAR,
  PRESET_SECTOR_OR_EMA20_VWAP_FIB_BULL,
  PRESET_SECTOR_OR_EMA20_VWAP_FIB_BEAR,
];

