/**
 * Zerodha Kite Connect historical candles.
 * Docs: https://kite.trade/docs/connect/v3/historical/
 *
 * Auth header: Authorization: token {api_key}:{access_token}
 */
import type { Candle, Interval } from "../types";
import { sanitizeToken, safeErrorMessage, asciiHeaders } from "../http";
import { resolveKiteInstrumentToken } from "./kite-instruments";
import { readCache, writeCache } from "./cache";
import { filterCandlesByRange, dayBoundsUnix } from "./dates";

function kiteInterval(interval: Interval): string {
  switch (interval) {
    case "1m":
      return "minute";
    case "2m":
      throw new Error("Kite does not support 2m. Use 1m or 3minute via 1m.");
    case "5m":
      return "5minute";
    case "15m":
      return "15minute";
    case "30m":
      return "30minute";
    case "60m":
      return "60minute";
    case "1d":
      return "day";
    case "1wk":
    case "1mo":
      throw new Error("Kite weekly/monthly not used here. Use 1d.");
    default:
      return "5minute";
  }
}

export async function fetchKiteCandles(opts: {
  symbol: string;
  interval: Interval;
  from: string;
  to: string;
  apiKey: string;
  accessToken: string;
}): Promise<Candle[]> {
  const apiKey = sanitizeToken(opts.apiKey);
  const accessToken = sanitizeToken(opts.accessToken);
  if (!apiKey || !accessToken) {
    throw new Error(
      "Kite requires API key and access token (developers.kite.trade)."
    );
  }

  const inst = await resolveKiteInstrumentToken(opts.symbol);
  const intervalKey = kiteInterval(opts.interval);
  const { startMs, endMs } = dayBoundsUnix(
    opts.from,
    opts.to,
    `${inst.tradingSymbol}.NS`
  );

  const cacheKey = `kite_${inst.instrumentToken}_${opts.interval}_${opts.from}_${opts.to}`;
  const cached = readCache(cacheKey);
  if (cached?.length) {
    return filterCandlesByRange(cached, startMs, endMs);
  }

  // Chunk long ranges: minute data ~60 days max recommended
  const maxDays =
    intervalKey === "day" ? 2000 : intervalKey === "minute" ? 30 : 90;
  const chunks = chunkDays(opts.from, opts.to, maxDays);
  const all: Candle[] = [];

  for (const chunk of chunks) {
    const fromQ = encodeURIComponent(`${chunk.from} 09:15:00`);
    const toQ = encodeURIComponent(`${chunk.to} 15:30:00`);
    const url = `https://api.kite.trade/instruments/historical/${inst.instrumentToken}/${intervalKey}?from=${fromQ}&to=${toQ}`;

    const res = await fetch(url, {
      headers: asciiHeaders({
        "X-Kite-Version": "3",
        Authorization: `token ${apiKey}:${accessToken}`,
        Accept: "application/json",
      }),
      cache: "no-store",
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        safeErrorMessage(
          `Kite historical error ${res.status}: ${text.slice(0, 220)}`
        )
      );
    }
    all.push(...parseKiteCandles(text));
  }

  const byTime = new Map<number, Candle>();
  for (const c of all) byTime.set(c.time, c);
  const sorted = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  const filtered = filterCandlesByRange(sorted, startMs, endMs);
  if (filtered.length) writeCache(cacheKey, filtered);
  return filtered;
}

function parseKiteCandles(text: string): Candle[] {
  let json: {
    status?: string;
    message?: string;
    data?: { candles?: (string | number)[][] };
    error_type?: string;
  };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Kite returned invalid JSON");
  }

  if (json.status === "error" || json.error_type) {
    throw new Error(
      safeErrorMessage(json.message || json.error_type || "Kite request failed")
    );
  }

  const rows = json.data?.candles || [];
  const candles: Candle[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const ts = String(row[0]);
    // "2017-12-15T09:15:00+0530"
    const time = Date.parse(ts.replace(/(\+\d{2})(\d{2})$/, "$1:$2"));
    if (!Number.isFinite(time)) continue;
    candles.push({
      time,
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5] ?? 0),
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
