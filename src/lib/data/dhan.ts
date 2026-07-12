/**
 * DhanHQ v2 historical candles.
 * Docs: https://dhanhq.co/docs/v2/historical-data/
 */
import type { Candle, Interval } from "../types";
import { sanitizeToken, safeErrorMessage, asciiHeaders } from "../http";
import { resolveDhanSecurityId } from "./dhan-instruments";
import { readCache, writeCache } from "./cache";
import { filterCandlesByRange, dayBoundsUnix } from "./dates";

const INTRADAY_URL = "https://api.dhan.co/v2/charts/intraday";
const DAILY_URL = "https://api.dhan.co/v2/charts/historical";

/** Dhan intraday intervals: 1, 5, 15, 25, 60 */
function dhanInterval(interval: Interval): { kind: "intraday" | "daily"; value: string } {
  switch (interval) {
    case "1m":
      return { kind: "intraday", value: "1" };
    case "2m":
      throw new Error(
        "Dhan does not support 2m candles. Use 1m or 5m."
      );
    case "5m":
      return { kind: "intraday", value: "5" };
    case "15m":
      return { kind: "intraday", value: "15" };
    case "30m":
      throw new Error(
        "Dhan does not support 30m candles. Use 15m or 60m."
      );
    case "60m":
      return { kind: "intraday", value: "60" };
    case "1d":
      return { kind: "daily", value: "1" };
    case "1wk":
    case "1mo":
      throw new Error(
        "Dhan weekly/monthly not supported here. Use daily (1d)."
      );
    default:
      return { kind: "intraday", value: "5" };
  }
}

export async function fetchDhanCandles(opts: {
  symbol: string;
  interval: Interval;
  from: string;
  to: string;
  accessToken: string;
  clientId?: string;
}): Promise<Candle[]> {
  const accessToken = sanitizeToken(opts.accessToken);
  if (!accessToken) {
    throw new Error(
      "Dhan access token is required (from web.dhan.co → DhanHQ APIs)."
    );
  }

  const inst = await resolveDhanSecurityId(opts.symbol);
  const { startMs, endMs } = dayBoundsUnix(opts.from, opts.to, `${inst.tradingSymbol}.NS`);
  const cacheKey = `dhan_${inst.securityId}_${opts.interval}_${opts.from}_${opts.to}`;
  const cached = readCache(cacheKey);
  if (cached?.length) {
    return filterCandlesByRange(cached, startMs, endMs);
  }

  const map = dhanInterval(opts.interval);
  const headers = asciiHeaders({
    "Content-Type": "application/json",
    Accept: "application/json",
    "access-token": accessToken,
    ...(opts.clientId
      ? { "client-id": sanitizeToken(opts.clientId) }
      : {}),
  });

  let candles: Candle[];

  if (map.kind === "daily") {
    candles = await fetchDaily(inst, opts.from, opts.to, headers);
  } else {
    // Max ~90 days per request — chunk
    candles = [];
    for (const chunk of chunkDays(opts.from, opts.to, 85)) {
      const part = await fetchIntraday(
        inst,
        map.value,
        chunk.from,
        chunk.to,
        headers
      );
      candles.push(...part);
    }
  }

  const byTime = new Map<number, Candle>();
  for (const c of candles) byTime.set(c.time, c);
  const sorted = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  const filtered = filterCandlesByRange(sorted, startMs, endMs);
  if (filtered.length) writeCache(cacheKey, filtered);
  return filtered;
}

async function fetchIntraday(
  inst: { securityId: string; exchangeSegment: string; instrument: string },
  interval: string,
  from: string,
  to: string,
  headers: Record<string, string>
): Promise<Candle[]> {
  const body = {
    securityId: inst.securityId,
    exchangeSegment: inst.exchangeSegment,
    instrument: inst.instrument,
    interval,
    oi: false,
    fromDate: `${from} 09:15:00`,
    toDate: `${to} 15:30:00`,
  };

  const res = await fetch(INTRADAY_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      safeErrorMessage(
        `Dhan intraday error ${res.status}: ${text.slice(0, 200)}`
      )
    );
  }
  return parseDhanOhlc(text);
}

async function fetchDaily(
  inst: { securityId: string; exchangeSegment: string; instrument: string },
  from: string,
  to: string,
  headers: Record<string, string>
): Promise<Candle[]> {
  const body = {
    securityId: inst.securityId,
    exchangeSegment: inst.exchangeSegment,
    instrument: inst.instrument,
    expiryCode: 0,
    oi: false,
    fromDate: from,
    toDate: to,
  };

  const res = await fetch(DAILY_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      safeErrorMessage(
        `Dhan daily error ${res.status}: ${text.slice(0, 200)}`
      )
    );
  }
  return parseDhanOhlc(text);
}

function parseDhanOhlc(text: string): Candle[] {
  let json: {
    open?: number[];
    high?: number[];
    low?: number[];
    close?: number[];
    volume?: number[];
    timestamp?: number[];
    data?: {
      open?: number[];
      high?: number[];
      low?: number[];
      close?: number[];
      volume?: number[];
      timestamp?: number[];
    };
    errorMessage?: string;
    errorCode?: string;
  };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Dhan returned invalid JSON");
  }

  if (json.errorMessage || json.errorCode) {
    throw new Error(
      safeErrorMessage(
        `Dhan: ${json.errorMessage || json.errorCode || "request failed"}`
      )
    );
  }

  const root = json.data || json;
  const ts = root.timestamp || [];
  const opens = root.open || [];
  const highs = root.high || [];
  const lows = root.low || [];
  const closes = root.close || [];
  const volumes = root.volume || [];

  const candles: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = opens[i];
    const h = highs[i];
    const l = lows[i];
    const c = closes[i];
    if (o == null || h == null || l == null || c == null) continue;
    // Dhan timestamps are epoch seconds
    let t = Number(ts[i]);
    if (t < 1e12) t *= 1000;
    candles.push({
      time: t,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: volumes[i] ?? 0,
    });
  }
  return candles;
}

function chunkDays(
  from: string,
  to: string,
  maxDays: number
): { from: string; to: string }[] {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return [{ from, to }];
  }
  const out: { from: string; to: string }[] = [];
  let cur = new Date(start);
  while (cur <= end) {
    const chunkEnd = new Date(cur);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + maxDays - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    out.push({
      from: cur.toISOString().slice(0, 10),
      to: chunkEnd.toISOString().slice(0, 10),
    });
    cur = new Date(chunkEnd);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out.length ? out : [{ from, to }];
}
