import type { Candle, IndicatorType } from "./types";

/** Simple moving average */
export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average */
export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length === 0) return out;
  const k = 2 / (period + 1);
  let prev: number | null = null;
  let seed = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period) {
      seed += values[i];
      if (i === period - 1) {
        prev = seed / period;
        out[i] = prev;
      }
      continue;
    }
    prev = values[i] * k + (prev as number) * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Relative Strength Index (Wilder) */
export function rsi(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period + 1) return out;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * Opening range high/low for each bar of the session.
 * For equity markets we treat a new calendar day (IST-friendly UTC+5:30)
 * as a new session. The first N bars of each session form the range.
 *
 * With period = 1 on a 5m chart → 1st 5-minute candle high/low (09:15–09:20).
 * Levels are only available on bars AFTER the range bar(s) complete — not on
 * the forming OR candle itself.
 */
export function openingRange(
  candles: Candle[],
  barsInRange = 1
): { high: (number | null)[]; low: (number | null)[] } {
  const high: (number | null)[] = new Array(candles.length).fill(null);
  const low: (number | null)[] = new Array(candles.length).fill(null);

  let sessionKey = "";
  let sessionStart = 0;
  let rangeHigh = -Infinity;
  let rangeLow = Infinity;
  let rangeReady = false;

  for (let i = 0; i < candles.length; i++) {
    const key = sessionDayKey(candles[i].time);
    if (key !== sessionKey) {
      sessionKey = key;
      sessionStart = i;
      rangeHigh = -Infinity;
      rangeLow = Infinity;
      rangeReady = false;
    }

    const offset = i - sessionStart;
    if (offset < barsInRange) {
      // Still forming the opening range (e.g. 1st 5m candle)
      rangeHigh = Math.max(rangeHigh, candles[i].high);
      rangeLow = Math.min(rangeLow, candles[i].low);
      if (offset === barsInRange - 1) rangeReady = true;
      // Do not publish levels on OR bars — wait until range is complete
      continue;
    }

    if (rangeReady) {
      high[i] = rangeHigh;
      low[i] = rangeLow;
    }
  }

  return { high, low };
}

/** IST-ish day key so Indian sessions group correctly even if timestamps are IST-offset. */
function sessionDayKey(timeMs: number): string {
  // Shift by +5:30 so midnight IST starts a new day
  const d = new Date(timeMs + 5.5 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

export type FibPivotLevel = "P" | "R1" | "R2" | "R3" | "S1" | "S2" | "S3";

/**
 * Classic Fibonacci pivot points from the previous session's High / Low / Close:
 *   P  = (H + L + C) / 3
 *   R1 = P + 0.382 × (H − L)
 *   R2 = P + 0.618 × (H − L)
 *   R3 = P + 1.000 × (H − L)
 *   S1 = P − 0.382 × (H − L)
 *   S2 = P − 0.618 × (H − L)
 *   S3 = P − 1.000 × (H − L)
 *
 * Levels are flat for every bar of the current session (until next day).
 */
export function fibonacciPivots(
  candles: Candle[],
  level: FibPivotLevel
): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (!candles.length) return out;

  // Aggregate each session
  type DayOHLC = { high: number; low: number; close: number; lastIdx: number };
  const days: { key: string; ohlc: DayOHLC }[] = [];
  let curKey = "";
  let cur: DayOHLC | null = null;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const key = sessionDayKey(c.time);
    if (key !== curKey) {
      if (cur && curKey) days.push({ key: curKey, ohlc: cur });
      curKey = key;
      cur = { high: c.high, low: c.low, close: c.close, lastIdx: i };
    } else if (cur) {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.lastIdx = i;
    }
  }
  if (cur && curKey) days.push({ key: curKey, ohlc: cur });

  // Map session key → previous session fib levels
  const levelByDay = new Map<string, number>();
  for (let d = 1; d < days.length; d++) {
    const prev = days[d - 1].ohlc;
    const levels = calcFibLevels(prev.high, prev.low, prev.close);
    levelByDay.set(days[d].key, levels[level]);
  }

  for (let i = 0; i < candles.length; i++) {
    const key = sessionDayKey(candles[i].time);
    const v = levelByDay.get(key);
    if (v != null) out[i] = v;
  }

  return out;
}

function calcFibLevels(H: number, L: number, C: number) {
  const range = H - L;
  const P = (H + L + C) / 3;
  return {
    P,
    R1: P + 0.382 * range,
    R2: P + 0.618 * range,
    R3: P + 1.0 * range,
    S1: P - 0.382 * range,
    S2: P - 0.618 * range,
    S3: P - 1.0 * range,
  } as const;
}

/**
 * Session VWAP — resets each IST trading day.
 * Typical price = (H + L + C) / 3; VWAP = Σ(TP × V) / Σ(V).
 * Period is ignored (always session-based).
 */
export function sessionVwap(candles: Candle[]): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (!candles.length) return out;

  let sessionKey = "";
  let cumPV = 0;
  let cumV = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const key = sessionDayKey(c.time);
    if (key !== sessionKey) {
      sessionKey = key;
      cumPV = 0;
      cumV = 0;
    }
    const tp = (c.high + c.low + c.close) / 3;
    const vol = Number.isFinite(c.volume) && c.volume > 0 ? c.volume : 0;
    // If volume is missing, still advance using unit volume so VWAP tracks price
    const v = vol > 0 ? vol : 1;
    cumPV += tp * v;
    cumV += v;
    out[i] = cumV > 0 ? cumPV / cumV : null;
  }
  return out;
}

/**
 * Previous session high or low, held constant for every bar of the current session.
 * Use e.g. close > PREV_DAY_HIGH for breakout above yesterday's high.
 */
export function previousDayLevel(
  candles: Candle[],
  field: "high" | "low"
): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (!candles.length) return out;

  type DayAgg = { high: number; low: number };
  const days: { key: string; agg: DayAgg }[] = [];
  let curKey = "";
  let cur: DayAgg | null = null;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const key = sessionDayKey(c.time);
    if (key !== curKey) {
      if (cur && curKey) days.push({ key: curKey, agg: cur });
      curKey = key;
      cur = { high: c.high, low: c.low };
    } else if (cur) {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
    }
  }
  if (cur && curKey) days.push({ key: curKey, agg: cur });

  const levelByDay = new Map<string, number>();
  for (let d = 1; d < days.length; d++) {
    levelByDay.set(days[d].key, days[d - 1].agg[field]);
  }

  for (let i = 0; i < candles.length; i++) {
    const v = levelByDay.get(sessionDayKey(candles[i].time));
    if (v != null) out[i] = v;
  }
  return out;
}

export function computeIndicator(
  candles: Candle[],
  type: IndicatorType,
  period = 9
): (number | null)[] {
  const closes = candles.map((c) => c.close);
  switch (type) {
    case "EMA":
      return ema(closes, period);
    case "SMA":
      return sma(closes, period);
    case "RSI":
      return rsi(closes, period);
    case "VWAP":
      return sessionVwap(candles);
    case "OPENING_RANGE_HIGH": {
      // period = number of bars that form the opening range (default 1 for first 5m bar)
      return openingRange(candles, period || 1).high;
    }
    case "OPENING_RANGE_LOW":
      return openingRange(candles, period || 1).low;
    case "FIB_PIVOT":
      return fibonacciPivots(candles, "P");
    case "FIB_PIVOT_R1":
      return fibonacciPivots(candles, "R1");
    case "FIB_PIVOT_R2":
      return fibonacciPivots(candles, "R2");
    case "FIB_PIVOT_R3":
      return fibonacciPivots(candles, "R3");
    case "FIB_PIVOT_S1":
      return fibonacciPivots(candles, "S1");
    case "FIB_PIVOT_S2":
      return fibonacciPivots(candles, "S2");
    case "FIB_PIVOT_S3":
      return fibonacciPivots(candles, "S3");
    case "PREV_DAY_HIGH":
      return previousDayLevel(candles, "high");
    case "PREV_DAY_LOW":
      return previousDayLevel(candles, "low");
    case "BREAKOUT_HIGH":
      // period = opening-range bars (default 1 = first 5m candle)
      return breakoutHigh(candles, period || 1);
    case "BREAKOUT_LOW":
      return breakoutLow(candles, period || 1);
    default:
      return new Array(candles.length).fill(null);
  }
}

/**
 * Session breakout level = max(1st N-bar OR high, Fib pivot R3, previous day high).
 * With orBars=1 on 5m → max(1st 5m high, Fib R3, PDH).
 * Null until all components are available (after OR bar completes).
 */
export function breakoutHigh(
  candles: Candle[],
  orBars = 1
): (number | null)[] {
  const orh = openingRange(candles, orBars).high;
  const r3 = fibonacciPivots(candles, "R3");
  const pdh = previousDayLevel(candles, "high");
  const out: (number | null)[] = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    const a = orh[i];
    const b = r3[i];
    const c = pdh[i];
    if (a == null || b == null || c == null) continue;
    out[i] = Math.max(a, b, c);
  }
  return out;
}

/**
 * Session breakdown level = min(1st N-bar OR low, Fib pivot S3, previous day low).
 * With orBars=1 on 5m → min(1st 5m candle low, Fib S3, PDL).
 * Null until all components are available (after OR bar completes).
 */
export function breakoutLow(
  candles: Candle[],
  orBars = 1
): (number | null)[] {
  const orl = openingRange(candles, orBars).low;
  const s3 = fibonacciPivots(candles, "S3");
  const pdl = previousDayLevel(candles, "low");
  const out: (number | null)[] = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    const a = orl[i];
    const b = s3[i];
    const c = pdl[i];
    if (a == null || b == null || c == null) continue;
    out[i] = Math.min(a, b, c);
  }
  return out;
}

export function indicatorKey(type: IndicatorType, period?: number): string {
  if (type === "OPENING_RANGE_HIGH") return `ORH_${period ?? 1}`;
  if (type === "OPENING_RANGE_LOW") return `ORL_${period ?? 1}`;
  if (type === "BREAKOUT_HIGH") return `BOH_${period ?? 1}`;
  if (type === "BREAKOUT_LOW") return `BOL_${period ?? 1}`;
  if (type === "VWAP") return "VWAP";
  if (type.startsWith("FIB_PIVOT")) return type;
  if (type === "PREV_DAY_HIGH" || type === "PREV_DAY_LOW") return type;
  return `${type}_${period ?? 9}`;
}
