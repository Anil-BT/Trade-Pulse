import { addCalendarDays } from "./data/dates";

/** List every calendar day from `from` to `to` inclusive (YYYY-MM-DD). */
export function listCalendarDays(from: string, to: string): string[] {
  if (!from || !to || from > to) return [];
  const out: string[] = [];
  let cur = from;
  while (cur <= to) {
    out.push(cur);
    cur = addCalendarDays(cur, 1);
  }
  return out;
}

/** Mon–Fri only (NSE session calendar; still includes holidays). */
export function listWeekdays(from: string, to: string): string[] {
  return listCalendarDays(from, to).filter((ymd) => {
    const [y, m, d] = ymd.split("-").map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return dow !== 0 && dow !== 6;
  });
}

/**
 * Split a date range into chunks of at most `chunkDays` calendar days.
 * Used to pace Upstox/broker calls and reduce rate-limit hits.
 */
export function chunkDateRange(
  from: string,
  to: string,
  chunkDays = 3
): { from: string; to: string }[] {
  const days = listCalendarDays(from, to);
  if (!days.length) return [];
  const chunks: { from: string; to: string }[] = [];
  for (let i = 0; i < days.length; i += chunkDays) {
    const slice = days.slice(i, i + chunkDays);
    chunks.push({ from: slice[0], to: slice[slice.length - 1] });
  }
  return chunks;
}

/** Group sorted day keys into consecutive runs of max `maxLen`. */
export function chunkDayList(days: string[], maxLen = 3): string[][] {
  if (!days.length) return [];
  const sorted = [...days].sort();
  const out: string[][] = [];
  let cur: string[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const next = sorted[i];
    const prevNext = addCalendarDays(prev, 1);
    if (next === prevNext && cur.length < maxLen) {
      cur.push(next);
    } else {
      out.push(cur);
      cur = [next];
    }
  }
  out.push(cur);
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
