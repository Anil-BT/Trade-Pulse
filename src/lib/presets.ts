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
      right: { indicator: "OPENING_RANGE_HIGH", period: 1 },
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
 * Entry: close above 1st 5m candle high AND above EMA20 AND above Fib pivot R3
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
      right: { indicator: "OPENING_RANGE_HIGH", period: 1 },
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
 * Use on 5m; OR period = 1 = first session bar.
 */
export const PRESET_OR_EMA20_FIB_R3_PDH: StrategyConfig = {
  name: "OR + EMA20 + Fib R3 + PDH",
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
      right: { indicator: "OPENING_RANGE_HIGH", period: 1 },
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
      right: { indicator: "BREAKOUT_HIGH", period: 1 },
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

export const STRATEGY_PRESETS: StrategyConfig[] = [
  PRESET_OPENING_RANGE_EMA,
  PRESET_OR_EMA20_FIB_R3,
  PRESET_OR_EMA20_FIB_R3_PDH,
  PRESET_EMA_CROSS,
  PRESET_RSI_MEAN_REVERSION,
];
