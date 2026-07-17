/**
 * NSE corporate data for F&O results board.
 *
 * Sources (public JSON; free):
 * - corporate-board-meetings (scheduled FR dates — past + future)
 * - corporate-announcements (actual FR outcomes — past/today)
 * - event-calendar (backup for upcoming)
 */
import fs from "fs";
import path from "path";
import { ensureCacheDir, getCacheDir } from "./cache-dir";

export type NseEventRow = {
  symbol: string;
  company: string;
  purpose: string;
  bm_desc?: string;
  date: string;
};

export type NseBoardMeeting = {
  symbol: string;
  company: string;
  purpose: string;
  description?: string;
  /** Board meeting date YYYY-MM-DD */
  date: string;
  dateRaw: string;
};

export type NseAnnouncement = {
  symbol: string;
  company: string;
  desc: string;
  text: string;
  /** Announcement datetime day YYYY-MM-DD */
  date: string;
  dateRaw: string;
};

export type NseFilingRow = {
  symbol: string;
  companyName?: string;
  filingDate?: string;
  broadCastDate?: string;
  toDate?: string;
  period?: string;
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const MONTHS: Record<string, number> = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  May: 5,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
};

/** Parse NSE date like 17-Jul-2026 or 25-Jun-2026 16:39:17 → YYYY-MM-DD */
export function parseNseDate(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(
    /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (!m) return null;
  const day = Number(m[1]);
  const mon = MONTHS[m[2]];
  const year = Number(m[3]);
  if (!mon || !day || !year) return null;
  return `${year}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** YYYY-MM-DD → dd-mm-yyyy for NSE query params */
export function ymdToNseParam(ymd: string): string {
  const [y, m, d] = ymd.split("-");
  return `${d}-${m}-${y}`;
}

function cachePath(name: string) {
  return path.join(getCacheDir(), name);
}

function readJsonCache<T>(name: string, maxAgeMs: number): T | null {
  try {
    const p = cachePath(name);
    if (!fs.existsSync(p)) return null;
    const st = fs.statSync(p);
    if (Date.now() - st.mtimeMs > maxAgeMs) return null;
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonCache(name: string, data: unknown) {
  try {
    ensureCacheDir();
    fs.writeFileSync(cachePath(name), JSON.stringify(data));
  } catch {
    /* ignore */
  }
}

let cookieJar = "";

async function warmNseCookies() {
  try {
    const home = await fetch("https://www.nseindia.com", {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
      },
      cache: "no-store",
      redirect: "follow",
    });
    const set = typeof home.headers.getSetCookie === "function"
      ? home.headers.getSetCookie()
      : [];
    if (set.length) {
      cookieJar = set.map((c) => c.split(";")[0]).join("; ");
    } else {
      const single = home.headers.get("set-cookie");
      if (single) {
        cookieJar = single
          .split(/,(?=[^;]+?=)/)
          .map((c) => c.split(";")[0].trim())
          .join("; ");
      }
    }
  } catch {
    /* continue */
  }
}

async function nseFetchJson(url: string): Promise<unknown> {
  if (!cookieJar) await warmNseCookies();

  const doFetch = async () =>
    fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json,text/plain,*/*",
        Referer: "https://www.nseindia.com/",
        ...(cookieJar ? { Cookie: cookieJar } : {}),
      },
      cache: "no-store",
    });

  let res = await doFetch();
  // retry warm once on soft block
  if (res.status === 401 || res.status === 403) {
    cookieJar = "";
    await warmNseCookies();
    res = await doFetch();
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`NSE ${res.status}: ${t.slice(0, 120)}`);
  }
  return res.json();
}

export function isFinancialResultsPurpose(purpose: string): boolean {
  return /financial\s*results/i.test(purpose || "");
}

export function isFinancialResultsText(text: string): boolean {
  return /financial\s*results|unaudited\s+financial|audited\s+financial|quarterly\s+results|earnings/i.test(
    text || ""
  );
}

/** Board meetings with date range (dd-mm-yyyy). Best for scheduled FR past+future. */
export async function fetchNseBoardMeetings(
  fromYmd: string,
  toYmd: string
): Promise<NseBoardMeeting[]> {
  const cacheKey = `nse_board_meetings_${fromYmd}_${toYmd}.json`;
  const cached = readJsonCache<NseBoardMeeting[]>(cacheKey, 2 * 3600_000);
  if (cached?.length) return cached;

  const url =
    `https://www.nseindia.com/api/corporate-board-meetings?index=equities` +
    `&from_date=${ymdToNseParam(fromYmd)}&to_date=${ymdToNseParam(toYmd)}`;
  const json = await nseFetchJson(url);
  const list = (Array.isArray(json) ? json : []) as Array<Record<string, unknown>>;

  const out: NseBoardMeeting[] = [];
  for (const r of list) {
    const purpose = String(r.bm_purpose || "");
    const desc = String(r.bm_desc || "");
    if (!isFinancialResultsPurpose(purpose) && !isFinancialResultsText(desc)) {
      continue;
    }
    const dateRaw = String(r.bm_date || "");
    const date = parseNseDate(dateRaw);
    const symbol = String(r.bm_symbol || "")
      .toUpperCase()
      .trim();
    if (!symbol || !date) continue;
    out.push({
      symbol,
      company: String(r.sm_name || symbol).trim(),
      purpose: purpose || "Financial Results",
      description: desc || undefined,
      date,
      dateRaw,
    });
  }
  writeJsonCache(cacheKey, out);
  return out;
}

/**
 * Corporate announcements (actual filings / BM outcomes) in date range.
 * Use for past/today result days (when results were actually submitted).
 */
export async function fetchNseCorporateAnnouncements(
  fromYmd: string,
  toYmd: string
): Promise<NseAnnouncement[]> {
  const cacheKey = `nse_announcements_${fromYmd}_${toYmd}.json`;
  const cached = readJsonCache<NseAnnouncement[]>(cacheKey, 2 * 3600_000);
  if (cached?.length) return cached;

  const url =
    `https://www.nseindia.com/api/corporate-announcements?index=equities` +
    `&from_date=${ymdToNseParam(fromYmd)}&to_date=${ymdToNseParam(toYmd)}`;
  const json = await nseFetchJson(url);
  const list = (Array.isArray(json) ? json : []) as Array<Record<string, unknown>>;

  const out: NseAnnouncement[] = [];
  for (const r of list) {
    const desc = String(r.desc || "");
    const text = String(r.attchmntText || "");
    const blob = `${desc} ${text}`;
    // Outcome of BM with FR, or explicit financial results submissions
    const isOutcome =
      /outcome of board meeting/i.test(desc) && isFinancialResultsText(blob);
    const isFr =
      /financial result/i.test(desc) ||
      (/submitted to the exchange,\s*the financial results/i.test(text) &&
        /outcome of board meeting|financial result/i.test(desc + text));
    if (!isOutcome && !isFr && !isFinancialResultsText(desc)) continue;
    // skip pure clarifications / replies without new results
    if (/^clarification|^reply to clarification/i.test(desc.trim())) continue;

    const dateRaw = String(r.an_dt || r.exchdisstime || "");
    const date = parseNseDate(dateRaw);
    const symbol = String(r.symbol || "")
      .toUpperCase()
      .trim();
    if (!symbol || !date) continue;
    out.push({
      symbol,
      company: String(r.sm_name || symbol).trim(),
      desc,
      text,
      date,
      dateRaw,
    });
  }
  writeJsonCache(cacheKey, out);
  return out;
}

/** Upcoming board meetings / financial results calendar (backup). */
export async function fetchNseEventCalendar(): Promise<NseEventRow[]> {
  const cached = readJsonCache<NseEventRow[]>("nse_event_calendar.json", 3 * 3600_000);
  if (cached?.length) return cached;

  const json = await nseFetchJson("https://www.nseindia.com/api/event-calendar");
  const list = (Array.isArray(json) ? json : []) as NseEventRow[];
  const clean = list
    .map((r) => ({
      symbol: String(r.symbol || "")
        .toUpperCase()
        .trim(),
      company: String(r.company || "").trim(),
      purpose: String(r.purpose || "").trim(),
      bm_desc: r.bm_desc ? String(r.bm_desc) : undefined,
      date: String(r.date || "").trim(),
    }))
    .filter((r) => r.symbol && r.date);
  writeJsonCache("nse_event_calendar.json", clean);
  return clean;
}

/** Recent financial result filings (legacy source; often stale). */
export async function fetchNseFinancialResults(): Promise<NseFilingRow[]> {
  const cached = readJsonCache<NseFilingRow[]>(
    "nse_financial_results.json",
    6 * 3600_000
  );
  if (cached?.length) return cached;

  const json = await nseFetchJson(
    "https://www.nseindia.com/api/corporates-financial-results?index=equities&period=Quarterly"
  );
  const list = (Array.isArray(json) ? json : []) as NseFilingRow[];
  const clean = list
    .map((r) => ({
      symbol: String(r.symbol || "")
        .toUpperCase()
        .trim(),
      companyName: r.companyName ? String(r.companyName) : undefined,
      filingDate: r.filingDate ? String(r.filingDate) : undefined,
      broadCastDate: r.broadCastDate ? String(r.broadCastDate) : undefined,
      toDate: r.toDate ? String(r.toDate) : undefined,
      period: r.period ? String(r.period) : undefined,
    }))
    .filter((r) => r.symbol);
  writeJsonCache("nse_financial_results.json", clean);
  return clean;
}

/** Latest filing date per symbol (YYYY-MM-DD). */
export function latestFilingBySymbol(
  filings: NseFilingRow[]
): Map<string, { date: string; raw: string }> {
  const map = new Map<string, { date: string; raw: string; ts: number }>();
  for (const f of filings) {
    const raw = f.broadCastDate || f.filingDate || "";
    const ymd = parseNseDate(raw);
    if (!ymd) continue;
    const ts = Date.parse(`${ymd}T12:00:00+05:30`);
    if (!Number.isFinite(ts)) continue;
    const prev = map.get(f.symbol);
    if (!prev || ts > prev.ts) {
      map.set(f.symbol, { date: ymd, raw, ts });
    }
  }
  const out = new Map<string, { date: string; raw: string }>();
  for (const [k, v] of map) out.set(k, { date: v.date, raw: v.raw });
  return out;
}
