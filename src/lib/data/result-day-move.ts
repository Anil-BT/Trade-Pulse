/**
 * Previous results-day price move via Yahoo daily chart (.NS).
 * Uses range=2y so prior-year result dates are reachable (default 1d is only 6mo).
 */
import { toYahooSymbol } from "./yahoo";
import type { Candle } from "../types";

export type DayMove = {
  date: string;
  open: number;
  close: number;
  prevClose?: number;
  /** (close - prevClose) / prevClose * 100 when available, else open→close */
  movePct: number;
  source: "prev_close" | "open_close";
};

function istYmd(ms: number): string {
  const d = new Date(ms + 5.5 * 3600_000);
  return d.toISOString().slice(0, 10);
}

async function fetchYahooDaily2y(symbol: string): Promise<Candle[]> {
  const yahooSym = toYahooSymbol(symbol);
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}` +
    `?interval=1d&range=2y&includePrePost=false`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (compatible; TradePulseResults/1.0; +local-dev)",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Yahoo ${res.status} for ${yahooSym}`);
  }
  const json = (await res.json()) as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators?: {
          quote?: Array<{
            open?: (number | null)[];
            high?: (number | null)[];
            low?: (number | null)[];
            close?: (number | null)[];
            volume?: (number | null)[];
          }>;
        };
      }>;
    };
  };
  const result = json?.chart?.result?.[0];
  const times = result?.timestamp || [];
  const q = result?.indicators?.quote?.[0];
  const out: Candle[] = [];
  for (let i = 0; i < times.length; i++) {
    const o = q?.open?.[i];
    const h = q?.high?.[i];
    const l = q?.low?.[i];
    const c = q?.close?.[i];
    const v = q?.volume?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    out.push({
      time: times[i] * 1000,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: v ?? 0,
    });
  }
  return out;
}

/**
 * % move on/near the given IST calendar day.
 * Prefer close vs previous session close; fallback open→close.
 */
export async function dayMoveOnDate(
  symbol: string,
  ymd: string
): Promise<DayMove | null> {
  try {
    const candles = await fetchYahooDaily2y(symbol);
    if (candles.length < 2) return null;

    // Find bar on that day, else first bar on/after that day within 3 sessions
    let idx = candles.findIndex((c) => istYmd(c.time) === ymd);
    if (idx < 0) {
      const target = Date.parse(`${ymd}T12:00:00+05:30`);
      idx = candles.findIndex((c) => c.time >= target - 12 * 3600_000);
      if (idx < 0) return null;
      // allow +3 trading days slip
      const barDay = istYmd(candles[idx].time);
      const t0 = Date.parse(`${ymd}T00:00:00+05:30`);
      const t1 = Date.parse(`${barDay}T00:00:00+05:30`);
      if (t1 - t0 > 5 * 86400_000) return null;
    }

    const c = candles[idx];
    const prev = idx > 0 ? candles[idx - 1] : null;
    if (prev && prev.close > 0) {
      const movePct = ((c.close - prev.close) / prev.close) * 100;
      return {
        date: istYmd(c.time),
        open: c.open,
        close: c.close,
        prevClose: prev.close,
        movePct,
        source: "prev_close",
      };
    }
    if (c.open > 0) {
      return {
        date: istYmd(c.time),
        open: c.open,
        close: c.close,
        movePct: ((c.close - c.open) / c.open) * 100,
        source: "open_close",
      };
    }
    return null;
  } catch {
    return null;
  }
}
