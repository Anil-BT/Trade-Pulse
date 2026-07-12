import type { Candle, Interval } from "../types";
import { asciiHeaders, sanitizeToken, safeErrorMessage } from "../http";
import {
  addCalendarDays,
  chunkCalendarRange,
  dayBoundsUnix,
  filterCandlesByRange,
  parseMarketTime,
} from "./dates";
import {
  isUpstoxRateLimitError,
  noteUpstoxRateLimited,
  noteUpstoxSuccess,
  parseRetryAfterMs,
  rateLimitBackoffMs,
  waitForUpstoxSlot,
} from "./upstox-throttle";

/**
 * Upstox Historical Candle V3
 * Docs: https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/
 */

interface UpstoxUnitInterval {
  unit: "minutes" | "hours" | "days" | "weeks" | "months";
  interval: number;
}

const INTERVAL_MAP: Record<Interval, UpstoxUnitInterval> = {
  "1m": { unit: "minutes", interval: 1 },
  "2m": { unit: "minutes", interval: 2 },
  "5m": { unit: "minutes", interval: 5 },
  "15m": { unit: "minutes", interval: 15 },
  "30m": { unit: "minutes", interval: 30 },
  "60m": { unit: "hours", interval: 1 },
  "1d": { unit: "days", interval: 1 },
  "1wk": { unit: "weeks", interval: 1 },
  "1mo": { unit: "months", interval: 1 },
};

export async function fetchUpstoxCandles(opts: {
  instrumentKey: string;
  interval: Interval;
  from: string;
  to: string;
  accessToken: string;
  /**
   * Extra calendar days before `from` so EMA / OR / pivots warm up.
   * Entries outside the user range are blocked in the backtest engine.
   */
  lookbackDays?: number;
}): Promise<Candle[]> {
  const { instrumentKey, interval, from, to } = opts;
  const accessToken = sanitizeToken(opts.accessToken);
  if (!accessToken) {
    throw new Error(
      "Upstox access token is required. Paste it in Market data, or set UPSTOX_ACCESS_TOKEN on the server."
    );
  }
  if (!instrumentKey?.trim()) {
    throw new Error(
      "Upstox instrument key is required (e.g. NSE_EQ|INE002A01018)"
    );
  }

  const map = INTERVAL_MAP[interval];
  const lookback =
    opts.lookbackDays ??
    (map.unit === "minutes" || map.unit === "hours" ? 10 : 30);
  const fetchFrom = addCalendarDays(from, -lookback);

  // Upstox 1-15m limited to ~1 month per request
  const maxDays = map.unit === "minutes" && map.interval <= 15 ? 28 : 90;
  const chunks = chunkCalendarRange(fetchFrom, to, maxDays);
  const all: Candle[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const part = await fetchUpstoxChunkWithRetry({
      instrumentKey: instrumentKey.trim(),
      unit: map.unit,
      interval: map.interval,
      from: chunk.from,
      to: chunk.to,
      accessToken,
    });
    all.push(...part);
    // Pace multi-chunk historical pulls
    if (i < chunks.length - 1) {
      await sleep(350);
    }
  }

  const byTime = new Map<number, Candle>();
  for (const c of all) {
    if (Number.isFinite(c.time) && Number.isFinite(c.close)) {
      byTime.set(c.time, c);
    }
  }
  let sorted = Array.from(byTime.values()).sort((a, b) => a.time - b.time);

  const { startMs, endMs } = dayBoundsUnix(fetchFrom, to, instrumentKey);
  sorted = filterCandlesByRange(sorted, startMs, endMs);

  return sorted;
}

async function fetchUpstoxChunkWithRetry(opts: {
  instrumentKey: string;
  unit: string;
  interval: number;
  from: string;
  to: string;
  accessToken: string;
}): Promise<Candle[]> {
  let lastError = "Upstox request failed";
  // More attempts for 429; auth failures fail fast
  const maxAttempts = 6;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const candles = await fetchUpstoxChunk(opts);
      noteUpstoxSuccess();
      return candles;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);

      if (/401|403|auth failed|Invalid Instrument|UDAPI100011/i.test(lastError)) {
        throw e instanceof Error ? e : new Error(lastError);
      }

      if (isUpstoxRateLimitError(lastError)) {
        noteUpstoxRateLimited();
        const wait = rateLimitBackoffMs(attempt);
        // Surface wait in error path for client logs
        await sleep(wait);
        continue;
      }

      // Transient network
      if (/timeout|fetch|network|ECONN|503|502|500/i.test(lastError)) {
        await sleep(800 * (attempt + 1));
        continue;
      }

      throw e instanceof Error ? e : new Error(lastError);
    }
  }
  throw new Error(
    safeErrorMessage(
      `${lastError} (gave up after ${maxAttempts} tries — wait 1–2 min and re-run; cached days will be skipped.)`
    )
  );
}

async function fetchUpstoxChunk(opts: {
  instrumentKey: string;
  unit: string;
  interval: number;
  from: string;
  to: string;
  accessToken: string;
}): Promise<Candle[]> {
  await waitForUpstoxSlot();

  const encoded = encodeURIComponent(opts.instrumentKey);
  const url = `https://api.upstox.com/v3/historical-candle/${encoded}/${opts.unit}/${opts.interval}/${opts.to}/${opts.from}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 35_000);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: asciiHeaders({
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${sanitizeToken(opts.accessToken)}`,
        "Api-Version": "2.0",
      }),
      cache: "no-store",
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = e instanceof Error ? e.message : String(e);
    if (/abort/i.test(msg)) {
      throw new Error("Upstox request timed out. Try a shorter date range.");
    }
    throw new Error(`Upstox network error: ${msg}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    const text = await res.text();
    const snippet = text.slice(0, 200).replace(/[^\x20-\x7E]/g, " ");
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Upstox auth failed (${res.status}). Token may be expired — generate a fresh access token and paste it again.`
      );
    }
    if (res.status === 429 || /1015|rate.limit/i.test(text)) {
      const retryMs = parseRetryAfterMs(res);
      if (retryMs != null && retryMs > 0) {
        noteUpstoxRateLimited();
        await sleep(retryMs);
      }
      throw new Error(
        `Upstox rate limit (429). Will auto-retry with longer waits. ${snippet.slice(0, 80)}`
      );
    }
    throw new Error(safeErrorMessage(`Upstox error ${res.status}: ${snippet}`));
  }

  const json = await res.json();
  const raw: unknown[][] = json?.data?.candles || [];

  return raw
    .map((row) => {
      const time = parseMarketTime(row[0] as string | number);
      return {
        time,
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5] ?? 0),
      } satisfies Candle;
    })
    .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
