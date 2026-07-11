import type { Candle, Interval } from "../types";
import { dayBoundsUnix } from "./dates";

/**
 * Deterministic synthetic OHLC for offline demos when live APIs are rate-limited.
 * Simulates Indian cash session (09:15–15:30 IST) for intraday intervals.
 */
export function generateSampleCandles(
  symbol: string,
  interval: Interval,
  from: string,
  to: string
): Candle[] {
  const { startMs, endMs } = dayBoundsUnix(from, to, symbol);
  const stepMs = intervalMs(interval);
  const seed = hash(symbol + interval + from + to);
  let price = 1000 + (seed % 1500);
  const candles: Candle[] = [];

  const cursor = new Date(from + "T12:00:00+05:30");
  const last = new Date(to + "T12:00:00+05:30");

  for (; cursor <= last; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const y = cursor.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const weekday = new Date(y + "T12:00:00+05:30").getDay();
    if (weekday === 0 || weekday === 6) continue;

    const dayStart = Date.parse(y + "T00:00:00+05:30");

    if (stepMs >= 24 * 60 * 60 * 1000) {
      const t = dayStart + 10 * 60 * 60 * 1000;
      if (t < startMs || t > endMs) continue;
      const move = pseudo(seed, candles.length) * 20 - 9;
      const open = price;
      const close = Math.max(10, open + move);
      const high = Math.max(open, close) + Math.abs(pseudo(seed + 1, candles.length) * 6);
      const low = Math.min(open, close) - Math.abs(pseudo(seed + 2, candles.length) * 6);
      candles.push({
        time: t,
        open: round(open),
        high: round(high),
        low: round(low),
        close: round(close),
        volume: Math.floor(100000 + pseudo(seed + 3, candles.length) * 900000),
      });
      price = close;
      continue;
    }

    const sessionOpen = dayStart + (9 * 60 + 15) * 60 * 1000;
    const sessionClose = dayStart + (15 * 60 + 30) * 60 * 1000;

    for (let t = sessionOpen; t < sessionClose; t += stepMs) {
      if (t < startMs || t > endMs) continue;
      const n = candles.length;
      const wave = Math.sin(n / 8) * 3 + Math.sin(n / 23) * 5;
      const noise = (pseudo(seed, n) - 0.5) * 4;
      const open = price;
      const close = Math.max(10, open + wave * 0.15 + noise);
      const high = Math.max(open, close) + Math.abs(pseudo(seed + 7, n) * 1.5);
      const low = Math.min(open, close) - Math.abs(pseudo(seed + 9, n) * 1.5);
      candles.push({
        time: t,
        open: round(open),
        high: round(high),
        low: round(low),
        close: round(close),
        volume: Math.floor(5000 + pseudo(seed + 11, n) * 80000),
      });
      price = close;
    }
  }

  if (!candles.length) {
    throw new Error(
      `Sample generator produced no candles for ${from}–${to}. Use a weekday (Mon–Fri).`
    );
  }
  return candles;
}

function intervalMs(interval: Interval): number {
  const map: Record<Interval, number> = {
    "1m": 60_000,
    "2m": 120_000,
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "60m": 3_600_000,
    "1d": 86_400_000,
    "1wk": 7 * 86_400_000,
    "1mo": 30 * 86_400_000,
  };
  return map[interval];
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pseudo(seed: number, i: number): number {
  const x = Math.sin(seed * 0.001 + i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}
