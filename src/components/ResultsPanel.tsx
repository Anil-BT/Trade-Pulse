"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { parseApiJson, safeErrorMessage } from "@/lib/http";

type FoResultRow = {
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
};

type ApiResponse = {
  generatedAt?: string;
  fromDate?: string;
  toDate?: string;
  rows?: FoResultRow[];
  note?: string;
  cached?: boolean;
  error?: string;
};

type SortKey = "symbol" | "resultDate" | "bucket" | "dayMovePct";

function formatInDate(ymd: string | undefined): string {
  if (!ymd) return "—";
  try {
    const [y, m, d] = ymd.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return ymd;
  }
}

function bucketLabel(b: FoResultRow["bucket"]): string {
  if (b === "past") return "Past";
  if (b === "today") return "Today";
  return "Upcoming";
}

function bucketClass(b: FoResultRow["bucket"]): string {
  if (b === "past") return "bg-neutral-100 text-neutral-600";
  if (b === "today") return "bg-amber-100 text-amber-900";
  return "bg-sky-50 text-sky-900";
}

export function ResultsPanel() {
  const [rows, setRows] = useState<FoResultRow[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [windowLabel, setWindowLabel] = useState<string | null>(null);
  const [cached, setCached] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [filterBucket, setFilterBucket] = useState<
    "all" | "past" | "today" | "upcoming"
  >("all");
  const [sortKey, setSortKey] = useState<SortKey>("resultDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/results/calendar", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const data = await parseApiJson<ApiResponse>(res);
      if (!res.ok) throw new Error(data.error || `Load failed (${res.status})`);
      setRows(data.rows || []);
      setNote(data.note || null);
      setGeneratedAt(data.generatedAt || null);
      setCached(Boolean(data.cached));
      if (data.fromDate && data.toDate) {
        setWindowLabel(
          `${formatInDate(data.fromDate)} → ${formatInDate(data.toDate)}`
        );
      }
    } catch (e) {
      setError(safeErrorMessage(e) || "Failed to load results");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(
        key === "symbol" || key === "bucket"
          ? "asc"
          : key === "dayMovePct"
            ? "desc"
            : "asc"
      );
    }
  }

  const counts = useMemo(() => {
    let past = 0;
    let today = 0;
    let upcoming = 0;
    for (const r of rows) {
      if (r.bucket === "past") past += 1;
      else if (r.bucket === "today") today += 1;
      else upcoming += 1;
    }
    return { past, today, upcoming };
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toUpperCase();
    let list = rows;
    if (filterBucket !== "all") {
      list = list.filter((r) => r.bucket === filterBucket);
    }
    if (needle) {
      list = list.filter(
        (r) =>
          r.symbol.includes(needle) ||
          (r.company || "").toUpperCase().includes(needle)
      );
    }
    const dir = sortDir === "asc" ? 1 : -1;
    const bucketOrder = { past: 0, today: 1, upcoming: 2 };
    return [...list].sort((a, b) => {
      if (sortKey === "symbol") {
        return dir * a.symbol.localeCompare(b.symbol);
      }
      if (sortKey === "bucket") {
        const c = bucketOrder[a.bucket] - bucketOrder[b.bucket];
        if (c !== 0) return dir * c;
        return a.resultDate.localeCompare(b.resultDate);
      }
      if (sortKey === "dayMovePct") {
        const av = a.dayMovePct;
        const bv = b.dayMovePct;
        const aOk = av != null && Number.isFinite(av);
        const bOk = bv != null && Number.isFinite(bv);
        if (!aOk && !bOk) return a.symbol.localeCompare(b.symbol);
        if (!aOk) return 1;
        if (!bOk) return -1;
        if (av !== bv) return dir * ((av as number) - (bv as number));
        return a.symbol.localeCompare(b.symbol);
      }
      const c = a.resultDate.localeCompare(b.resultDate);
      if (c !== 0) return dir * c;
      return a.symbol.localeCompare(b.symbol);
    });
  }, [rows, q, filterBucket, sortKey, sortDir]);

  return (
    <section className="mt-14">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium tracking-[0.2em] text-neutral-500 uppercase">
            Results
          </p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-black">
            F&amp;O earnings calendar
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-neutral-600">
            Financial results for equity F&amp;O names —{" "}
            <strong>last 30 days</strong> (filed) and{" "}
            <strong>next 30 days</strong> (board calendar), with day move %.
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void load()}
          className="rounded-full border border-neutral-300 px-4 py-2 text-sm font-medium hover:border-black disabled:opacity-50"
        >
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(
          [
            { id: "all" as const, label: `All (${rows.length})` },
            { id: "past" as const, label: `Past 30d (${counts.past})` },
            { id: "today" as const, label: `Today (${counts.today})` },
            {
              id: "upcoming" as const,
              label: `Next 30d (${counts.upcoming})`,
            },
          ] as const
        ).map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilterBucket(f.id)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium ${
              filterBucket === f.id
                ? "bg-black text-white"
                : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter symbol or company"
          className="field-input max-w-xs text-sm"
        />
        <p className="text-xs text-neutral-500">
          Showing {filtered.length}
          {windowLabel ? ` · ${windowLabel}` : ""}
          {cached ? " · cached" : ""}
          {generatedAt
            ? ` · updated ${new Date(generatedAt).toLocaleString("en-IN")}`
            : ""}
        </p>
      </div>

      {error && (
        <p className="mb-4 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-800">
          {error}
        </p>
      )}

      <div className="overflow-x-auto rounded-3xl border border-neutral-200 bg-white">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-neutral-200 text-left text-xs text-neutral-500 uppercase">
              {(
                [
                  { key: "symbol" as const, label: "Stock", align: "left" },
                  {
                    key: "resultDate" as const,
                    label: "Result date",
                    align: "left",
                  },
                  { key: "bucket" as const, label: "When", align: "left" },
                  {
                    key: "dayMovePct" as const,
                    label: "Day move",
                    align: "right",
                  },
                ] as const
              ).map((col) => {
                const active = sortKey === col.key;
                return (
                  <th
                    key={col.key}
                    className={`px-4 py-3 font-medium ${
                      col.align === "right" ? "text-right" : "text-left"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(col.key)}
                      className={`inline-flex items-center gap-1 hover:text-black ${
                        active ? "text-black" : ""
                      } ${col.align === "right" ? "ml-auto" : ""}`}
                    >
                      {col.label}
                      <span className="text-[10px] text-neutral-400">
                        {active ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </button>
                  </th>
                );
              })}
              <th className="px-4 py-3 text-left font-medium">Purpose</th>
            </tr>
          </thead>
          <tbody>
            {busy && !rows.length ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-12 text-center text-sm text-neutral-400"
                >
                  Loading F&amp;O results (±30 days)…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-12 text-center text-sm text-neutral-400"
                >
                  No F&amp;O financial results in this window.
                </td>
              </tr>
            ) : (
              filtered.map((r) => {
                const mv = r.dayMovePct;
                const mvCls =
                  mv == null
                    ? "text-neutral-500"
                    : mv >= 0
                      ? "text-emerald-700"
                      : "text-rose-600";
                const moveHint =
                  r.bucket === "upcoming" && r.dayMoveDate
                    ? `Prev results ${formatInDate(r.dayMoveDate)}`
                    : r.dayMoveDate && r.dayMoveDate !== r.resultDate
                      ? `Bar ${formatInDate(r.dayMoveDate)}`
                      : undefined;
                return (
                  <tr
                    key={`${r.symbol}-${r.resultDate}-${r.bucket}`}
                    className="border-b border-neutral-100 hover:bg-neutral-50/80"
                  >
                    <td className="px-4 py-3">
                      <div className="font-semibold text-black">{r.symbol}</div>
                      <div className="max-w-[200px] truncate text-[11px] text-neutral-500">
                        {r.company}
                      </div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-neutral-800">
                      {formatInDate(r.resultDate)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${bucketClass(r.bucket)}`}
                      >
                        {bucketLabel(r.bucket)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div
                        className={`tabular-nums font-medium ${mvCls}`}
                      >
                        {mv != null
                          ? `${mv >= 0 ? "+" : ""}${mv.toFixed(2)}%`
                          : "—"}
                      </div>
                      {moveHint && (
                        <div className="text-[10px] text-neutral-400">
                          {moveHint}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-neutral-500">
                      <div
                        className="max-w-[280px] truncate"
                        title={r.description || r.purpose}
                      >
                        {r.purpose}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {note && (
        <p className="mt-3 text-[11px] text-neutral-400">{note}</p>
      )}
      <p className="mt-1 text-[11px] text-neutral-400">
        <strong>Past / Today:</strong> day move on that result date.{" "}
        <strong>Upcoming:</strong> day move on the previous filing date (if
        available).
      </p>
    </section>
  );
}
