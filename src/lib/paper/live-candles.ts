/**
 * Build / update interval candles from live LTP ticks (IST bars).
 */
import type { Candle, Interval } from "../types";

const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "2m": 120_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "60m": 3_600_000,
};

/** Floor timestamp to interval start (use IST-aligned wall clock via raw ms — NSE bars usually UTC aligned to IST open). */
export function barStartMs(timeMs: number, interval: Interval): number {
  const step = INTERVAL_MS[interval] || 300_000;
  // Align to IST: shift +5:30, floor, shift back
  const ist = timeMs + 5.5 * 3600_000;
  const floored = Math.floor(ist / step) * step;
  return floored - 5.5 * 3600_000;
}

/**
 * Apply LTP to candle series. Returns true if a new bar was opened (previous bar closed).
 */
export function applyTickToCandles(
  candles: Candle[],
  tick: { ltp: number; ltt: number },
  interval: Interval
): { candles: Candle[]; barClosed: boolean } {
  if (!(tick.ltp > 0)) return { candles, barClosed: false };
  const t = tick.ltt > 0 ? tick.ltt : Date.now();
  const start = barStartMs(t, interval);
  const last = candles[candles.length - 1];

  if (!last || last.time < start) {
    // New bar
    const next = [
      ...candles,
      {
        time: start,
        open: tick.ltp,
        high: tick.ltp,
        low: tick.ltp,
        close: tick.ltp,
        volume: 0,
      },
    ];
    // Cap history for memory
    const capped = next.length > 800 ? next.slice(-800) : next;
    return { candles: capped, barClosed: Boolean(last) };
  }

  // Update forming bar
  const updated = {
    ...last,
    high: Math.max(last.high, tick.ltp),
    low: Math.min(last.low, tick.ltp),
    close: tick.ltp,
  };
  const copy = candles.slice(0, -1);
  copy.push(updated);
  return { candles: copy, barClosed: false };
}
