import { execFile } from "child_process";
import { promisify } from "util";
import https from "https";
import type { Candle, Interval } from "../types";
import { readCache, readCacheCovering, writeCache } from "./cache";
import { dayBoundsUnix, filterCandlesByRange } from "./dates";
import { safeErrorMessage } from "../http";

const execFileAsync = promisify(execFile);

const INTERVAL_MAP: Record<Interval, string> = {
  "1m": "1m",
  "2m": "2m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "60m": "60m",
  "1d": "1d",
  "1wk": "1wk",
  "1mo": "1mo",
};

const HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];

/**
 * Yahoo Finance free chart API.
 * NSE: RELIANCE.NS · BSE: RELIANCE.BO · US: AAPL
 *
 * Single-day ranges work by:
 * 1) slicing any wider local cache that covers the day
 * 2) fetching a slightly wider window and filtering to the calendar day (IST for .NS/.BO)
 */
export async function fetchYahooCandles(
  symbol: string,
  interval: Interval,
  from: string,
  to: string
): Promise<Candle[]> {
  let ticker = symbol.trim().toUpperCase();
  // Allow bare NSE names (RELIANCE) as well as RELIANCE.NS
  if (ticker && !ticker.includes(".") && !ticker.includes("=")) {
    ticker = `${ticker}.NS`;
  }
  const { period1, period2, startMs, endMs } = dayBoundsUnix(from, to, ticker);

  const cacheKey = `yahoo_${ticker}_${interval}_${from}_${to}`;

  // Exact cache hit
  const exact = readCache(cacheKey);
  if (exact?.length) {
    return filterCandlesByRange(exact, startMs, endMs);
  }

  // Wider cache covering this window (e.g. month cached, user picks one day)
  const covered = readCacheCovering({
    source: "yahoo",
    symbol: ticker,
    interval,
    startMs,
    endMs,
  });
  if (covered?.length) {
    writeCache(cacheKey, covered);
    return covered;
  }

  const yfInterval = INTERVAL_MAP[interval];
  // For short ranges, prefer a wider Yahoo range= fetch then filter.
  // period1/period2 single-day queries are flakier and hit rate limits more.
  const rangeParam = suggestRange(period1, period2, interval);
  const urls: string[] = [];
  for (const host of HOSTS) {
    urls.push(
      `https://${host}/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${yfInterval}&range=${rangeParam}&includePrePost=false`
    );
    urls.push(
      `https://${host}/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${yfInterval}&period1=${period1}&period2=${period2}&includePrePost=false&events=div%2Csplits`
    );
  }

  let lastError = "Unknown Yahoo Finance error";

  for (const url of urls) {
    try {
      const body = await curlGet(url);
      const all = parseChartBody(body);
      const candles = filterCandlesByRange(all, startMs, endMs);
      if (candles.length) {
        // Cache both the full series (for future day slices) and the exact range
        if (all.length > candles.length) {
          const broadKey = `yahoo_${ticker}_${interval}_broad_${rangeParam}`;
          writeCache(broadKey, all);
        }
        writeCache(cacheKey, candles);
        return candles;
      }
      lastError = emptyRangeMessage(from, to, interval, all.length);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  // Node https fallback
  for (const url of urls) {
    try {
      const u = new URL(url);
      const { status, body } = await httpsGet(u.hostname, u.pathname + u.search);
      if (status === 429) {
        lastError = "Yahoo Finance error 429: Too Many Requests";
        continue;
      }
      if (status !== 200) {
        lastError = `Yahoo Finance error ${status}: ${body.slice(0, 180)}`;
        continue;
      }
      const all = parseChartBody(body);
      const candles = filterCandlesByRange(all, startMs, endMs);
      if (candles.length) {
        writeCache(cacheKey, candles);
        return candles;
      }
      lastError = emptyRangeMessage(from, to, interval, all.length);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  throw new Error(
    safeErrorMessage(
      `${lastError} Tips: pick a trading day (Mon-Fri), widen the date range, wait if rate-limited, or use Sample/Upstox.`
    )
  );
}

function emptyRangeMessage(
  from: string,
  to: string,
  interval: Interval,
  fetched: number
): string {
  if (fetched > 0) {
    return `Yahoo returned ${fetched} bars but none fell on ${from}${from !== to ? `-${to}` : ""}. Check the dates (weekends/holidays have no NSE session).`;
  }
  return `No candles in range for ${interval} ${from}${from !== to ? ` to ${to}` : ""}.`;
}

async function curlGet(url: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "curl",
      [
        "-sS",
        "-L",
        "--max-time",
        "25",
        "-A",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "-H",
        "Accept: application/json,text/plain,*/*",
        url,
      ],
      { maxBuffer: 20 * 1024 * 1024 }
    );
    if (!stdout?.trim()) {
      throw new Error(stderr || "Empty response from Yahoo");
    }
    if (stdout.includes("Too Many Requests")) {
      throw new Error("Yahoo Finance error 429: Too Many Requests");
    }
    return stdout;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("ENOENT")) {
      throw new Error("curl not found; install curl or use Upstox data source");
    }
    throw e;
  }
}

function httpsGet(
  host: string,
  path: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host,
        path,
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          Accept: "application/json,text/plain,*/*",
          "Accept-Language": "en-US,en;q=0.9",
          Connection: "close",
        } as Record<string, string>,
        timeout: 20000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Yahoo Finance request timed out"));
    });
    req.end();
  });
}

function parseChartBody(body: string): Candle[] {
  let json: {
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
      error?: { description?: string };
    };
  };

  try {
    json = JSON.parse(body);
  } catch {
    throw new Error("Yahoo Finance returned invalid JSON");
  }

  const result = json?.chart?.result?.[0];
  if (!result) {
    throw new Error(json?.chart?.error?.description || "No data returned for symbol");
  }

  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const opens = quote.open || [];
  const highs = quote.high || [];
  const lows = quote.low || [];
  const closes = quote.close || [];
  const volumes = quote.volume || [];

  const candles: Candle[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = opens[i];
    const h = highs[i];
    const l = lows[i];
    const c = closes[i];
    if (o == null || h == null || l == null || c == null) continue;
    candles.push({
      time: timestamps[i] * 1000,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: volumes[i] ?? 0,
    });
  }
  return candles;
}

function suggestRange(period1: number, period2: number, interval: Interval): string {
  const days = Math.max(1, Math.ceil((period2 - period1) / 86400));
  // Always pull a bit extra so single-day filters have data even near market holidays
  if (interval === "1m" || interval === "2m") {
    if (days <= 1) return "5d";
    if (days <= 5) return "5d";
    return "7d";
  }
  if (["5m", "15m", "30m", "60m"].includes(interval)) {
    if (days <= 5) return "5d";
    if (days <= 30) return "1mo";
    if (days <= 60) return "60d";
    return "3mo";
  }
  if (days <= 30) return "1mo";
  if (days <= 90) return "3mo";
  if (days <= 180) return "6mo";
  if (days <= 365) return "1y";
  if (days <= 730) return "2y";
  return "5y";
}
