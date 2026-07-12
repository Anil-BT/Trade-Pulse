/**
 * Calendar-day bounds for market data.
 * Indian equities (.NS / .BO) use Asia/Kolkata so "July 10" means the full NSE session day,
 * not a UTC midnight window that can drop bars.
 */
export function dayBoundsUnix(
  from: string,
  to: string,
  symbol?: string
): { period1: number; period2: number; startMs: number; endMs: number } {
  const indian = isIndianSymbol(symbol);
  const offset = indian ? "+05:30" : localOffsetString();

  const startMs = Date.parse(`${from}T00:00:00${offset}`);
  const endMs = Date.parse(`${to}T23:59:59.999${offset}`);

  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    throw new Error("Invalid date range");
  }
  if (endMs < startMs) {
    throw new Error("End date must be on or after start date");
  }

  return {
    period1: Math.floor(startMs / 1000),
    period2: Math.floor(endMs / 1000),
    startMs,
    endMs,
  };
}

export function isIndianSymbol(symbol?: string): boolean {
  if (!symbol) return true; // default IST for this app
  const s = symbol.toUpperCase();
  return (
    s.endsWith(".NS") ||
    s.endsWith(".BO") ||
    s.startsWith("NSE_") ||
    s.startsWith("BSE_") ||
    s.includes("|")
  );
}

function localOffsetString(): string {
  const offsetMin = -new Date().getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

export function filterCandlesByRange<T extends { time: number }>(
  candles: T[],
  startMs: number,
  endMs: number
): T[] {
  return candles.filter((c) => c.time >= startMs && c.time <= endMs);
}

/**
 * Calendar-day helpers that do NOT depend on server timezone.
 * (Vercel = UTC, local India = IST — Date#toISOString used to shift days.)
 */
export function addCalendarDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function calendarDaysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}

/** Chunk inclusive calendar range into pieces of at most maxDays days. */
export function chunkCalendarRange(
  from: string,
  to: string,
  maxDays: number
): { from: string; to: string }[] {
  if (from > to) throw new Error("End date must be on or after start date");
  const out: { from: string; to: string }[] = [];
  let cur = from;
  while (cur <= to) {
    const span = calendarDaysBetween(cur, to);
    const take = Math.min(maxDays, span);
    const end = addCalendarDays(cur, take - 1);
    out.push({ from: cur, to: end });
    cur = addCalendarDays(end, 1);
  }
  return out.length ? out : [{ from, to }];
}

/**
 * Parse broker candle timestamps for Indian markets.
 * Bare "YYYY-MM-DDTHH:mm:ss" (no zone) is treated as Asia/Kolkata,
 * so Vercel (UTC) and local (IST) behave the same.
 */
export function parseMarketTime(ts: string | number): number {
  if (typeof ts === "number") {
    if (!Number.isFinite(ts)) return NaN;
    return ts < 1e12 ? ts * 1000 : ts;
  }
  const s = String(ts).trim();
  if (!s) return NaN;

  // Already has Z or ±offset
  if (/[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) {
    return Date.parse(s);
  }

  // "2026-07-01 09:15:00" or "2026-07-01T09:15:00"
  const normalized = s.includes("T") ? s : s.replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(normalized)) {
    // Upstox sometimes returns +0530 without colon
    return Date.parse(
      /[+-]\d{2}:?\d{2}$|[zZ]$/.test(normalized)
        ? normalized
        : `${normalized}+05:30`
    );
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return Date.parse(`${s}T00:00:00+05:30`);
  }

  return Date.parse(s);
}
