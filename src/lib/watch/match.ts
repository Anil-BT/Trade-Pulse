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
  message?: string;
};

function defaultPeriod(type: IndicatorType): number {
  if (type === "RSI" || type === "ADX") return 14;
  if (type === "VWAP") return 1;
  if (type === "OPENING_RANGE_HIGH" || type === "OPENING_RANGE_LOW") return 1;
  if (type === "BREAKOUT_HIGH" || type === "BREAKOUT_LOW") return 1;
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
  const left = resolveValue(cond.left, i, seriesMap);
  const right = resolveValue(cond.right, i, seriesMap);
  if (left == null || right == null) return false;

  const op: Comparator = cond.op;
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

/**
 * Returns true if entry conditions hold on the last candle.
 */
export function matchStrategyOnCandles(
  candles: Candle[],
  strategy: StrategyConfig
): Omit<WatchMatch, "symbol" | "strategyName"> | null {
  if (candles.length < 5) return null;
  const i = candles.length - 1;
  const c = candles[i];
  const entryLogic = strategy.entryLogic ?? "and";
  const exitLogic = strategy.exitLogic ?? "and";
  const map = buildSeriesMap(candles, [
    ...strategy.entry,
    ...strategy.exit,
  ]);
  const entryMatch = evalConditions(strategy.entry, entryLogic, i, map);
  if (!entryMatch) return null;

  const exitMatch = strategy.exit.length
    ? evalConditions(strategy.exit, exitLogic, i, map)
    : false;

  const prev = candles.length > 1 ? candles[i - 1].close : c.close;
  const changePct =
    prev > 0 ? ((c.close - prev) / prev) * 100 : undefined;

  return {
    price: c.close,
    barTime: c.time,
    entryMatch: true,
    exitMatch,
    changePct,
    message: exitMatch
      ? "Entry true (exit also true on last bar)"
      : "Entry conditions matched",
  };
}
