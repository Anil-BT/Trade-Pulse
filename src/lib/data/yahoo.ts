/**
 * Free Yahoo Finance chart API for NSE equities (SYMBOL.NS).
 *
 * INTENDED FOR: Market Watch local/dev scanner only.
 * NOT licensed realtime exchange data — often delayed, incomplete, or blocked.
 * Do not use for live trading / paper option fills.
 */
import type { Candle, Interval } from "../types";
import { addCalendarDays } from "./dates";
import { todayIst } from "../paper/market-hours";

const INTERVAL_MAP: Record<
  Interval,
  { interval: string; range: string } | null
> = {
  "1m": { interval: "1m", range: "5d" },
  "2m": { interval: "2m", range: "5d" },
  "5m": { interval: "5m", range: "5d" },
  "15m": { interval: "15m", range: "1mo" },
  "30m": { interval: "30m", range: "1mo" },
  "60m": { interval: "60m", range: "1mo" },
  "1d": { interval: "1d", range: "6mo" },
  "1wk": { interval: "1wk", range: "2y" },
  "1mo": { interval: "1mo", range: "5y" },
};

export function toYahooSymbol(symbol: string): string {
  let s = String(symbol || "")
    .trim()
    .toUpperCase()
    .replace(/\.NS$/i, "")
    .replace(/\.BO$/i, "");
  // Common index aliases (Yahoo uses different tickers)
  if (s === "NIFTY" || s === "NIFTY50" || s === "NIFTY 50") return "^NSEI";
  if (s === "BANKNIFTY" || s === "NIFTY BANK") return "^NSEBANK";
  return `${s}.NS`;
}

/**
 * Fetch OHLCV candles from Yahoo chart v8 (no API key).
 */
export async function fetchYahooCandles(opts: {
  symbol: string;
  interval: Interval;
  /** Extra calendar days of history for indicators (approximate via range) */
  lookbackDays?: number;
}): Promise<Candle[]> {
  const map = INTERVAL_MAP[opts.interval];
  if (!map) {
    throw new Error(`Yahoo does not support interval ${opts.interval}`);
  }

  const yahooSym = toYahooSymbol(opts.symbol);
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}` +
    `?interval=${map.interval}&range=${map.range}&includePrePost=false&events=div%2Csplits`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (compatible; TradePulseMarketWatch/1.0; +local-dev)",
      },
      cache: "no-store",
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = e instanceof Error ? e.message : String(e);
    if (/abort/i.test(msg)) {
      throw new Error(`Yahoo timeout for ${yahooSym}`);
    }
    throw new Error(`Yahoo network error for ${yahooSym}: ${msg}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 429) {
      throw new Error(`Yahoo rate limit (429) for ${yahooSym}`);
    }
    throw new Error(
      `Yahoo error ${res.status} for ${yahooSym}: ${text.slice(0, 120)}`
    );
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
      error?: { description?: string } | null;
    };
  };

  const result = json?.chart?.result?.[0];
  if (!result?.timestamp?.length) {
    const err = json?.chart?.error?.description;
    throw new Error(
      err || `Yahoo returned no candles for ${yahooSym}`
    );
  }

  const q = result.indicators?.quote?.[0];
  const times = result.timestamp;
  const out: Candle[] = [];

  for (let i = 0; i < times.length; i++) {
    const close = q?.close?.[i];
    if (close == null || !Number.isFinite(close)) continue;
    const open = q?.open?.[i];
    const high = q?.high?.[i];
    const low = q?.low?.[i];
    const volume = q?.volume?.[i];
    const t = times[i] * 1000;
    if (!Number.isFinite(t)) continue;
    out.push({
      time: t,
      open: Number(open ?? close),
      high: Number(high ?? close),
      low: Number(low ?? close),
      close: Number(close),
      volume: Number(volume ?? 0),
    });
  }

  out.sort((a, b) => a.time - b.time);

  // Optionally trim very old bars when lookback is set (intraday)
  if (opts.lookbackDays != null && opts.lookbackDays > 0) {
    const today = todayIst();
    const from = addCalendarDays(today, -opts.lookbackDays);
    const startMs = Date.parse(`${from}T00:00:00+05:30`);
    if (Number.isFinite(startMs)) {
      return out.filter((c) => c.time >= startMs);
    }
  }

  return out;
}

/** Static short F&O equity list for Yahoo-only mode when Upstox master is unavailable. */
export const YAHOO_FNO_SAMPLE: string[] = [
  "RELIANCE",
  "TCS",
  "INFY",
  "HDFCBANK",
  "ICICIBANK",
  "SBIN",
  "BHARTIARTL",
  "ITC",
  "LT",
  "AXISBANK",
  "KOTAKBANK",
  "BAJFINANCE",
  "MARUTI",
  "SUNPHARMA",
  "TITAN",
  "HINDUNILVR",
  "ASIANPAINT",
  "WIPRO",
  "ULTRACEMCO",
  "NTPC",
  "POWERGRID",
  "TATAMOTORS",
  "TATASTEEL",
  "JSWSTEEL",
  "ADANIENT",
  "ADANIPORTS",
  "ONGC",
  "COALINDIA",
  "TECHM",
  "HCLTECH",
  "NESTLEIND",
  "INDUSINDBK",
  "BAJAJFINSV",
  "M&M",
  "DRREDDY",
  "CIPLA",
  "DIVISLAB",
  "EICHERMOT",
  "HEROMOTOCO",
  "GRASIM",
  "HINDALCO",
  "BPCL",
  "BRITANNIA",
  "APOLLOHOSP",
  "SBILIFE",
  "HDFCLIFE",
  "TATACONSUM",
  "PIDILITIND",
  "DIXON",
  "CHOLAFIN",
  "FORTIS",
  "TRENT",
  "BEL",
  "HAL",
  "POLYCAB",
  "PERSISTENT",
  "COFORGE",
  "LTIM",
  "MPHASIS",
  "ZOMATO",
];
