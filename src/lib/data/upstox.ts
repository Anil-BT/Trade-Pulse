import type { Candle, Interval } from "../types";
import { asciiHeaders, sanitizeToken, safeErrorMessage } from "../http";

/**
 * Upstox Historical Candle V3
 * Docs: https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/
 *
 * Requires a valid access token from Upstox developer console.
 * instrument_key example: NSE_EQ|INE002A01018 (Reliance)
 *
 * Interval limits: 1–15 minute data max ~1 month per request.
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
}): Promise<Candle[]> {
  const { instrumentKey, interval, from, to } = opts;
  const accessToken = sanitizeToken(opts.accessToken);
  if (!accessToken) {
    throw new Error("Upstox access token is required");
  }
  if (!instrumentKey?.trim()) {
    throw new Error(
      "Upstox instrument key is required (e.g. NSE_EQ|INE002A01018)"
    );
  }

  const map = INTERVAL_MAP[interval];
  // Upstox 1-15m limited to ~1 month; chunk monthly when needed
  const chunks = chunkDateRange(
    from,
    to,
    map.unit === "minutes" && map.interval <= 15 ? 28 : 90
  );
  const all: Candle[] = [];

  for (const chunk of chunks) {
    const part = await fetchUpstoxChunk({
      instrumentKey: instrumentKey.trim(),
      unit: map.unit,
      interval: map.interval,
      from: chunk.from,
      to: chunk.to,
      accessToken,
    });
    all.push(...part);
  }

  // Dedupe by time and sort
  const byTime = new Map<number, Candle>();
  for (const c of all) byTime.set(c.time, c);
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

async function fetchUpstoxChunk(opts: {
  instrumentKey: string;
  unit: string;
  interval: number;
  from: string;
  to: string;
  accessToken: string;
}): Promise<Candle[]> {
  const encoded = encodeURIComponent(opts.instrumentKey);
  const url = `https://api.upstox.com/v3/historical-candle/${encoded}/${opts.unit}/${opts.interval}/${opts.to}/${opts.from}`;

  const res = await fetch(url, {
    headers: asciiHeaders({
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${sanitizeToken(opts.accessToken)}`,
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text();
    // Keep message ASCII - body may contain unicode that breaks some clients
    throw new Error(
      safeErrorMessage(
        `Upstox error ${res.status}: ${text.slice(0, 200).replace(/[^\x20-\x7E]/g, " ")}`
      )
    );
  }

  const json = await res.json();
  const raw: unknown[][] = json?.data?.candles || [];

  // candle: [timestamp, open, high, low, close, volume, oi]
  return raw
    .map((row) => {
      const ts = row[0];
      const time =
        typeof ts === "string" ? new Date(ts).getTime() : Number(ts) * (Number(ts) < 1e12 ? 1000 : 1);
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

function chunkDateRange(
  from: string,
  to: string,
  maxDays: number
): { from: string; to: string }[] {
  const start = new Date(from + "T00:00:00");
  const end = new Date(to + "T00:00:00");
  if (end < start) throw new Error("End date must be on or after start date");

  const chunks: { from: string; to: string }[] = [];
  let cursor = new Date(start);
  while (cursor <= end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + maxDays - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push({
      from: formatDate(cursor),
      to: formatDate(chunkEnd),
    });
    cursor = new Date(chunkEnd);
    cursor.setDate(cursor.getDate() + 1);
  }
  return chunks;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
