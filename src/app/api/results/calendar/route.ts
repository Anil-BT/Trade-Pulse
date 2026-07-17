/**
 * F&O results board: ±30 day IST window.
 *
 * Past / today  → NSE corporate announcements (actual FR outcomes)
 * Upcoming      → NSE board meetings (Financial Results) + event calendar
 * Day move      → Yahoo daily close vs prior session
 */
import { NextResponse } from "next/server";
import { listFnoEquitySymbols } from "@/lib/data/fno-meta";
import {
  fetchNseBoardMeetings,
  fetchNseCorporateAnnouncements,
  fetchNseEventCalendar,
  isFinancialResultsPurpose,
  parseNseDate,
} from "@/lib/data/nse-results";
import { dayMoveOnDate } from "@/lib/data/result-day-move";
import { ensureCacheDir, getCacheDir } from "@/lib/data/cache-dir";
import { safeErrorMessage } from "@/lib/http";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export type FoResultRow = {
  symbol: string;
  company: string;
  resultDate: string;
  resultDateRaw?: string;
  bucket: "past" | "today" | "upcoming";
  purpose: string;
  description?: string;
  dayMovePct?: number | null;
  dayMoveDate?: string;
  dayOpen?: number;
  dayClose?: number;
  moveSource?: string;
  source?: string;
};

type CachePayload = {
  savedAt: number;
  generatedAt: string;
  fromDate: string;
  toDate: string;
  rows: FoResultRow[];
  note?: string;
};

const CACHE_NAME = "fo_results_board_v3.json";
const CACHE_TTL_MS = 2 * 3600_000;
const WINDOW_DAYS = 30;

function istTodayYmd(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

function addDaysYmd(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + delta * 86400_000;
  const x = new Date(t);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}-${String(x.getUTCDate()).padStart(2, "0")}`;
}

function readBoardCache(): CachePayload | null {
  try {
    const p = path.join(getCacheDir(), CACHE_NAME);
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as CachePayload;
    if (!raw?.rows || Date.now() - (raw.savedAt || 0) > CACHE_TTL_MS) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

function writeBoardCache(payload: CachePayload) {
  try {
    ensureCacheDir();
    fs.writeFileSync(
      path.join(getCacheDir(), CACHE_NAME),
      JSON.stringify(payload)
    );
  } catch {
    /* ignore */
  }
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, i: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(concurrency, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

function bucketFor(ymd: string, today: string): "past" | "today" | "upcoming" {
  if (ymd < today) return "past";
  if (ymd > today) return "upcoming";
  return "today";
}

export async function GET() {
  try {
    const cached = readBoardCache();
    if (cached) {
      return NextResponse.json({
        ...cached,
        cached: true,
      });
    }

    const todayYmd = istTodayYmd();
    const fromYmd = addDaysYmd(todayYmd, -WINDOW_DAYS);
    const toYmd = addDaysYmd(todayYmd, WINDOW_DAYS);

    const [foList, boardMeetings, announcements, events] = await Promise.all([
      listFnoEquitySymbols().catch(() => [] as { symbol: string }[]),
      fetchNseBoardMeetings(fromYmd, toYmd).catch((e) => {
        console.warn("[results] board meetings failed:", e);
        return [] as Awaited<ReturnType<typeof fetchNseBoardMeetings>>;
      }),
      // Announcements only need past → today for actual filings
      fetchNseCorporateAnnouncements(fromYmd, todayYmd).catch((e) => {
        console.warn("[results] announcements failed:", e);
        return [] as Awaited<ReturnType<typeof fetchNseCorporateAnnouncements>>;
      }),
      fetchNseEventCalendar().catch(() => [] as Awaited<ReturnType<typeof fetchNseEventCalendar>>),
    ]);

    const foSet = new Set(
      foList.map((x) =>
        String(x.symbol || "")
          .toUpperCase()
          .replace(/\.NS$/i, "")
          .trim()
      )
    );

    /** key = symbol|resultDate */
    const byKey = new Map<string, FoResultRow>();

    const put = (row: FoResultRow, prefer = false) => {
      if (foSet.size > 0 && !foSet.has(row.symbol)) return;
      if (row.resultDate < fromYmd || row.resultDate > toYmd) return;
      const key = `${row.symbol}|${row.resultDate}`;
      const ex = byKey.get(key);
      if (!ex) {
        byKey.set(key, row);
        return;
      }
      if (prefer) {
        byKey.set(key, {
          ...ex,
          ...row,
          // keep move if already filled
          dayMovePct: row.dayMovePct ?? ex.dayMovePct,
          dayMoveDate: row.dayMoveDate ?? ex.dayMoveDate,
          dayOpen: row.dayOpen ?? ex.dayOpen,
          dayClose: row.dayClose ?? ex.dayClose,
        });
      }
    };

    // 1) Actual result outcomes (past / today) — best source for "result day"
    for (const a of announcements) {
      put(
        {
          symbol: a.symbol,
          company: a.company,
          resultDate: a.date,
          resultDateRaw: a.dateRaw,
          bucket: bucketFor(a.date, todayYmd),
          purpose: a.desc || "Financial Results",
          description: a.text?.slice(0, 200),
          dayMovePct: null,
          dayMoveDate: a.date,
          source: "announcement",
        },
        true
      );
    }

    // 2) Board meetings in window (scheduled FR) — past + today + upcoming
    for (const b of boardMeetings) {
      const key = `${b.symbol}|${b.date}`;
      const exists = byKey.has(key);
      // Don't overwrite announcement outcome with mere intimation on same day
      if (exists && byKey.get(key)!.source === "announcement") {
        continue;
      }
      put({
        symbol: b.symbol,
        company: b.company,
        resultDate: b.date,
        resultDateRaw: b.dateRaw,
        bucket: bucketFor(b.date, todayYmd),
        purpose: b.purpose,
        description: b.description?.slice(0, 200),
        dayMovePct: null,
        dayMoveDate: b.date, // move on BM date; for upcoming still compute when day arrives
        source: "board_meeting",
      });
    }

    // 3) Event calendar backup (mostly upcoming)
    for (const e of events) {
      if (!isFinancialResultsPurpose(e.purpose)) continue;
      const ymd = parseNseDate(e.date);
      if (!ymd) continue;
      put({
        symbol: e.symbol.toUpperCase(),
        company: e.company || e.symbol,
        resultDate: ymd,
        resultDateRaw: e.date,
        bucket: bucketFor(ymd, todayYmd),
        purpose: e.purpose,
        description: e.bm_desc?.slice(0, 200),
        dayMovePct: null,
        dayMoveDate: ymd <= todayYmd ? ymd : undefined,
        source: "event_calendar",
      });
    }

    // For pure upcoming rows, attach previous result day for move:
    // latest announcement date for same symbol before this resultDate
    const annBySym = new Map<string, string[]>();
    for (const a of announcements) {
      const list = annBySym.get(a.symbol) || [];
      list.push(a.date);
      annBySym.set(a.symbol, list);
    }
    for (const [, dates] of annBySym) dates.sort();

    for (const r of byKey.values()) {
      if (r.bucket !== "upcoming") {
        if (!r.dayMoveDate) r.dayMoveDate = r.resultDate;
        continue;
      }
      const hist = annBySym.get(r.symbol) || [];
      let prev: string | undefined;
      for (const d of hist) {
        if (d < r.resultDate) prev = d;
      }
      // also check board meeting past dates for same symbol in our map
      if (!prev) {
        for (const o of byKey.values()) {
          if (o.symbol !== r.symbol) continue;
          if (o.resultDate >= r.resultDate) continue;
          if (o.bucket === "past" || o.bucket === "today") {
            if (!prev || o.resultDate > prev) prev = o.resultDate;
          }
        }
      }
      r.dayMoveDate = prev; // may be undefined
    }

    let rows = [...byKey.values()].sort((a, b) => {
      const c = a.resultDate.localeCompare(b.resultDate);
      if (c !== 0) return c;
      return a.symbol.localeCompare(b.symbol);
    });

    // Yahoo day moves
    type MoveJob = { symbol: string; date: string; rowKeys: string[] };
    const jobs = new Map<string, MoveJob>();
    for (const r of rows) {
      const d = r.dayMoveDate;
      if (!d) continue;
      const jk = `${r.symbol}|${d}`;
      const rowKey = `${r.symbol}|${r.resultDate}`;
      const job = jobs.get(jk);
      if (job) job.rowKeys.push(rowKey);
      else jobs.set(jk, { symbol: r.symbol, date: d, rowKeys: [rowKey] });
    }

    const jobList = [...jobs.values()].slice(0, 150);
    const moveResults = await mapPool(jobList, 5, async (job) => {
      const move = await dayMoveOnDate(job.symbol, job.date);
      await new Promise((res) => setTimeout(res, 80));
      return { job, move };
    });

    const rowMap = new Map(rows.map((r) => [`${r.symbol}|${r.resultDate}`, r]));
    for (const { job, move } of moveResults) {
      if (!move) continue;
      for (const rk of job.rowKeys) {
        const r = rowMap.get(rk);
        if (!r) continue;
        r.dayMovePct = Math.round(move.movePct * 100) / 100;
        r.dayOpen = move.open;
        r.dayClose = move.close;
        r.moveSource = move.source;
        r.dayMoveDate = move.date;
      }
    }

    rows = [...rowMap.values()].sort((a, b) => {
      const c = a.resultDate.localeCompare(b.resultDate);
      if (c !== 0) return c;
      return a.symbol.localeCompare(b.symbol);
    });

    const pastN = rows.filter((r) => r.bucket === "past").length;
    const todayN = rows.filter((r) => r.bucket === "today").length;
    const upN = rows.filter((r) => r.bucket === "upcoming").length;

    const payload: CachePayload = {
      savedAt: Date.now(),
      generatedAt: new Date().toISOString(),
      fromDate: fromYmd,
      toDate: toYmd,
      rows,
      note: `F&O results ${fromYmd} → ${toYmd} (IST ±${WINDOW_DAYS}d). Past/today from NSE announcements + board meetings; upcoming from board meetings. Day move = Yahoo close vs prior session. Past ${pastN} · Today ${todayN} · Upcoming ${upN}. Cached ~2h.`,
    };
    writeBoardCache(payload);

    return NextResponse.json({ ...payload, cached: false });
  } catch (e) {
    console.error("[results-calendar]", e);
    return NextResponse.json(
      { error: safeErrorMessage(e) || "Failed to load results calendar" },
      { status: 500 }
    );
  }
}
