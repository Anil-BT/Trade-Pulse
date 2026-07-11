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
