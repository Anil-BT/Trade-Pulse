/**
 * Market Watch matcher: evaluate strategy entry conditions on the latest bar
 * (scanner-style — “which F&O names match right now”).
 */
import { computeIndicator, indicatorKey } from "../indicators";
import type {
  Candle,
  CompareOperand,
  Comparator,
  Condition,
  IndicatorType,
  StrategyConfig,
} from "../types";

export type WatchMatch = {
  symbol: string;
  strategyName: string;
  /** Last bar close (spot) */
  price: number;
  /** Last bar time (ms) */
  barTime: number;
  /** Entry conditions true on last bar */
  entryMatch: boolean;
  /** Exit conditions true on last bar (context only) */
  exitMatch: boolean;
  changePct?: number;
  /**
   * Realized volatility (annualized %), close-to-close over ~20 bars.
   * e.g. 22.5 means ~22.5% annualized.
   */
  rvol?: number;
  message?: string;
};

/** Price / day-change for every F&O name (sector graph — no strategy filter). */
export type WatchQuote = {
  symbol: string;
  price: number;
  barTime: number;
  /** Session day change % (last close vs first bar open of that IST day) */
  changePct?: number;
  /** Session turnover proxy Σ(close×volume) for weighted sector strength */
  turnover?: number;
};

function istDayKey(ms: number): string {
  const d = new Date(ms + 5.5 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * Quote snapshot from candles — used for sector strength on the full F&O universe.
 * Does not evaluate any strategy conditions.
 */
export function quoteFromCandles(
  candles: Candle[]
): Omit<WatchQuote, "symbol"> | null {
  if (candles.length < 2) return null;
  const last = candles[candles.length - 1];
  const day = istDayKey(last.time);
  // First bar of the last session day (open ≈ session open when series starts early enough)
  let first = last;
  let turnover = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (istDayKey(candles[i].time) !== day) break;
    first = candles[i];
    const c = candles[i];
    const vol = Number.isFinite(c.volume) && c.volume > 0 ? c.volume : 0;
    if (vol > 0 && c.close > 0) turnover += c.close * vol;
  }
  const open = first.open;
  const changePct =
    open > 0 ? ((last.close - open) / open) * 100 : undefined;
  return {
    price: last.close,
    barTime: last.time,
    changePct: Number.isFinite(changePct) ? changePct : undefined,
    turnover: turnover > 0 ? turnover : undefined,
  };
}

/** Close-to-close realized vol, annualized as percent (e.g. 18.4). */
function realizedVolPct(candles: Candle[], lookback = 20): number | undefined {
  if (candles.length < lookback + 2) return undefined;
  const closes = candles.map((c) => c.close);
  const rets: number[] = [];
  const start = closes.length - lookback;
  for (let i = start; i < closes.length; i++) {
    const a = closes[i - 1];
    const b = closes[i];
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  if (rets.length < 5) return undefined;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  let v = 0;
  for (const r of rets) v += (r - mean) * (r - mean);
  v = Math.sqrt(v / Math.max(rets.length - 1, 1));
  // ~75 five-min bars per session (approx for intraday)
  const annual = v * Math.sqrt(252 * 75) * 100;
  if (!Number.isFinite(annual)) return undefined;
  return Math.round(Math.min(Math.max(annual, 1), 200) * 10) / 10;
}

function defaultPeriod(type: IndicatorType): number {
  if (type === "RSI" || type === "ADX") return 14;
  if (type === "VWAP" || type === "OBV") return 1;
  if (type === "VOL_RATIO") return 20;
  if (type === "OPENING_RANGE_HIGH" || type === "OPENING_RANGE_LOW") return 15;
  if (type === "BREAKOUT_HIGH" || type === "BREAKOUT_LOW") return 15;
  if (type.startsWith("FIB_PIVOT")) return 1;
  if (type === "PREV_DAY_HIGH" || type === "PREV_DAY_LOW") return 1;
  return 9;
}

function collectOperand(
  op: CompareOperand,
  needed: Map<string, { type: IndicatorType; period: number }>
) {
  if (typeof op === "string") return;
  const period = op.period ?? defaultPeriod(op.indicator);
  needed.set(indicatorKey(op.indicator, period), {
    type: op.indicator,
    period,
  });
}

function buildSeriesMap(
  candles: Candle[],
  conditions: Condition[]
): Map<string, (number | null)[]> {
  const map = new Map<string, (number | null)[]>();
  map.set(
    "close",
    candles.map((c) => c.close)
  );
  map.set(
    "open",
    candles.map((c) => c.open)
  );
  map.set(
    "high",
    candles.map((c) => c.high)
  );
  map.set(
    "low",
    candles.map((c) => c.low)
  );
  map.set(
    "volume",
    candles.map((c) => c.volume)
  );

  const needed = new Map<string, { type: IndicatorType; period: number }>();
  for (const cond of conditions) {
    collectOperand(cond.left, needed);
    if (typeof cond.right !== "number") collectOperand(cond.right, needed);
  }
  for (const [key, { type, period }] of needed) {
    if (!map.has(key)) map.set(key, computeIndicator(candles, type, period));
  }
  return map;
}

function resolveValue(
  operand: CompareOperand | number,
  i: number,
  seriesMap: Map<string, (number | null)[]>
): number | null {
  if (typeof operand === "number") return operand;
  if (typeof operand === "string") return seriesMap.get(operand)?.[i] ?? null;
  const period = operand.period ?? defaultPeriod(operand.indicator);
  const key = indicatorKey(operand.indicator, period);
  return seriesMap.get(key)?.[i] ?? null;
}

function evalCondition(
  cond: Condition,
  i: number,
  seriesMap: Map<string, (number | null)[]>
): boolean {
  const op: Comparator = cond.op;

  if (op === "rising" || op === "falling") {
    if (i === 0) return false;
    const left = resolveValue(cond.left, i, seriesMap);
    const leftPrev = resolveValue(cond.left, i - 1, seriesMap);
    if (left == null || leftPrev == null) return false;
    return op === "rising" ? left > leftPrev : left < leftPrev;
  }

  const left = resolveValue(cond.left, i, seriesMap);
  const right = resolveValue(cond.right, i, seriesMap);
  if (left == null || right == null) return false;

  if (op === "gt") return left > right;
  if (op === "gte") return left >= right;
  if (op === "lt") return left < right;
  if (op === "lte") return left <= right;

  if (i === 0) return false;
  const leftPrev = resolveValue(cond.left, i - 1, seriesMap);
  const rightPrev = resolveValue(cond.right, i - 1, seriesMap);
  if (leftPrev == null || rightPrev == null) return false;
  if (op === "cross_above") return leftPrev <= rightPrev && left > right;
  if (op === "cross_below") return leftPrev >= rightPrev && left < right;
  return false;
}

function evalConditions(
  conditions: Condition[],
  logic: "and" | "or",
  i: number,
  seriesMap: Map<string, (number | null)[]>
): boolean {
  if (!conditions.length) return false;
  const results = conditions.map((c) => evalCondition(c, i, seriesMap));
  return logic === "and" ? results.every(Boolean) : results.some(Boolean);
}

export type MatchScanMode = "last" | "session";

/** Index of first bar of the last IST session day in `candles`. */
function sessionDayStartIndex(candles: Candle[]): number {
  if (!candles.length) return 0;
  const lastDay = istDayKey(candles[candles.length - 1].time);
  for (let i = candles.length - 1; i >= 0; i--) {
    if (istDayKey(candles[i].time) !== lastDay) return i + 1;
  }
  return 0;
}

/**
 * Match strategy entry conditions on candles.
 *
 * - `session` (default): walk **today’s bars from the open** and return the
 *   first bar where entry is true (screener “fired today”).
 * - `last`: only the latest bar (live tick style).
 *
 * Price / day % always from the latest bar; `barTime` is the signal bar.
 */
export function matchStrategyOnCandles(
  candles: Candle[],
  strategy: StrategyConfig,
  opts?: { mode?: MatchScanMode }
): Omit<WatchMatch, "symbol" | "strategyName"> | null {
  if (candles.length < 5) return null;
  const mode: MatchScanMode = opts?.mode ?? "session";
  const lastI = candles.length - 1;
  const last = candles[lastI];
  const entryLogic = strategy.entryLogic ?? "and";
  const exitLogic = strategy.exitLogic ?? "and";
  const map = buildSeriesMap(candles, [
    ...strategy.entry,
    ...strategy.exit,
  ]);

  let signalI: number | null = null;
  if (mode === "last") {
    if (evalConditions(strategy.entry, entryLogic, lastI, map)) {
      signalI = lastI;
    }
  } else {
    const dayStart = sessionDayStartIndex(candles);
    // Need i>=1 for cross_above / cross_below
    const from = Math.max(dayStart, 1);
    for (let i = from; i <= lastI; i++) {
      if (evalConditions(strategy.entry, entryLogic, i, map)) {
        signalI = i;
        break;
      }
    }
  }
  if (signalI == null) return null;

  const signal = candles[signalI];
  const exitMatch = strategy.exit.length
    ? evalConditions(strategy.exit, exitLogic, lastI, map)
    : false;

  // Session day % (open → last close) for screener tables
  const dayStart = sessionDayStartIndex(candles);
  const dayOpen = candles[dayStart]?.open ?? last.open;
  const changePct =
    dayOpen > 0 ? ((last.close - dayOpen) / dayOpen) * 100 : undefined;
  const rvol = realizedVolPct(candles, 20);

  const onLast = signalI === lastI;
  let message: string;
  if (onLast && exitMatch) {
    message = "Entry true on last bar (exit also true)";
  } else if (onLast) {
    message = "Entry true on last bar";
  } else {
    message = `Entry matched earlier today (signal bar)`;
  }

  return {
    price: last.close,
    barTime: signal.time,
    entryMatch: true,
    exitMatch,
    changePct: Number.isFinite(changePct) ? changePct : undefined,
    rvol,
    message,
  };
}
