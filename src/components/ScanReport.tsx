"use client";

import { useMemo, useState } from "react";
import { formatMoney, formatTime } from "@/lib/format";
import type {
  ScanReport as ScanReportType,
  ScanRow,
  ScanTradeDetail,
  Trade,
} from "@/lib/types";
import { useAuth } from "@/lib/firebase/auth-context";
import {
  cleanScanRows,
  scanResultsAvailable,
  saveScanResult,
} from "@/lib/firebase/scan-results";
import {
  PerformanceCharts,
  tradeMatchesChartFilter,
  type ChartBarFilter,
} from "./PerformanceCharts";
import { DayResultCalendar } from "./DayResultCalendar";

export function ScanReportView({
  report,
  onClose,
  /** Fingerprint of strategy + scan settings (no single symbol) */
  cacheFingerprint,
  /** True when this report was loaded from Firestore (no broker this run) */
  fromCache = false,
  /** Hide cloud save (e.g. one leg of dual scan) */
  hideSave = false,
  /** Override section title badge */
  heading,
}: {
  report: ScanReportType;
  onClose?: () => void;
  cacheFingerprint?: string;
  fromCache?: boolean;
  hideSave?: boolean;
  heading?: string;
}) {
  const s = report.summary;
  const { user } = useAuth();
  const [filter, setFilter] = useState<"all" | "ok" | "no_trades" | "error">(
    "all"
  );
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [chartFilter, setChartFilter] = useState<ChartBarFilter | null>(null);
  /** IST YYYY-MM-DD — filters stock list + trades (like chart bar click) */
  const [dayFilter, setDayFilter] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const noTradeCount = report.rows.filter((r) => r.status === "no_trades").length;
  const cleanCount = cleanScanRows(report.rows).length;
  const errorCount = report.rows.filter((r) => r.status === "error").length;

  async function saveFnoResults() {
    if (!user) {
      setSaveMsg("Sign in (top-right) to save F&O scan results.");
      return;
    }
    if (!scanResultsAvailable()) {
      setSaveMsg("Firebase is not configured — cannot save to cloud.");
      return;
    }
    if (!cacheFingerprint) {
      setSaveMsg("Missing strategy fingerprint — re-run the scan, then save.");
      return;
    }
    setSaving(true);
    setSaveMsg(null);
    try {
      const { savedRows, skippedErrors } = await saveScanResult(
        user.uid,
        report,
        cacheFingerprint
      );
      setSaveMsg(
        `Saved ${savedRows} symbol(s) without errors` +
          (skippedErrors
            ? ` · skipped ${skippedErrors} with errors`
            : " · full clean set stored") +
          "."
      );
      setTimeout(() => setSaveMsg(null), 8000);
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  /** Flatten all F&O trades for combined charts */
  const combinedTrades = useMemo(() => {
    const list: Trade[] = [];
    for (const r of report.rows) {
      if (!r.tradeList?.length) continue;
      for (const t of r.tradeList) {
        list.push(scanTradeToTrade(t, r.symbol, report.tradeInstrument));
      }
    }
    // Sort by entry time for hold chart order
    list.sort((a, b) => a.entryTime - b.entryTime);
    return list;
  }, [report.rows, report.tradeInstrument]);

  /** Overall money totals across all stocks */
  const moneyTotals = useMemo(() => {
    let capitalUsed = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    for (const t of combinedTrades) {
      capitalUsed += t.capitalUsed ?? t.entryPrice * t.qty;
      if (t.pnl > 0) grossProfit += t.pnl;
      else grossLoss += Math.abs(t.pnl);
    }
    return {
      capitalUsed: Number(capitalUsed.toFixed(2)),
      grossProfit: Number(grossProfit.toFixed(2)),
      grossLoss: Number(grossLoss.toFixed(2)),
    };
  }, [combinedTrades]);

  /**
   * Per-day scan summary (same style as overall chips):
   * stocks that traded, win%, P&L, capital / profit / loss
   */
  const daySummaries = useMemo(() => {
    type DayAcc = {
      date: string;
      /** symbol -> pnl that day */
      stockPnl: Map<string, number>;
      totalTrades: number;
      capitalUsed: number;
      grossProfit: number;
      grossLoss: number;
      combinedPnl: number;
    };
    const byDay = new Map<string, DayAcc>();

    for (const r of report.rows) {
      if (!r.tradeList?.length) continue;
      for (const t of r.tradeList) {
        const date = istDayKey(t.entryTime);
        let row = byDay.get(date);
        if (!row) {
          row = {
            date,
            stockPnl: new Map(),
            totalTrades: 0,
            capitalUsed: 0,
            grossProfit: 0,
            grossLoss: 0,
            combinedPnl: 0,
          };
          byDay.set(date, row);
        }
        row.totalTrades += 1;
        row.combinedPnl += t.pnl;
        row.capitalUsed += t.capitalUsed ?? t.entryPrice * (t.lots || 1) * (t.lotSize || 1);
        if (t.pnl > 0) row.grossProfit += t.pnl;
        else row.grossLoss += Math.abs(t.pnl);
        row.stockPnl.set(r.symbol, (row.stockPnl.get(r.symbol) || 0) + t.pnl);
      }
    }

    const eligibleNoTradeBase = report.rows.filter(
      (r) => r.status === "ok" || r.status === "no_trades"
    ).length;

    return [...byDay.values()]
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((d) => {
        const withTrades = d.stockPnl.size;
        let winners = 0;
        let losers = 0;
        for (const pnl of d.stockPnl.values()) {
          if (pnl > 0) winners += 1;
          else losers += 1;
        }
        return {
          date: d.date,
          combinedPnl: Number(d.combinedPnl.toFixed(2)),
          withTrades,
          winners,
          losers,
          winPct: withTrades ? (winners / withTrades) * 100 : 0,
          noTrade: Math.max(0, eligibleNoTradeBase - withTrades),
          errors: s.errors,
          totalTrades: d.totalTrades,
          capitalUsed: Number(d.capitalUsed.toFixed(2)),
          grossProfit: Number(d.grossProfit.toFixed(2)),
          grossLoss: Number(d.grossLoss.toFixed(2)),
        };
      });
  }, [report.rows, s.errors]);

  const rows = useMemo(() => {
    let base =
      filter === "all"
        ? report.rows
        : report.rows.filter((r) => r.status === filter);

    if (!chartFilter && !dayFilter) return base;

    // Only rows that have trades matching chart bar and/or calendar day
    return base
      .map((r) => {
        if (!r.tradeList?.length) return null;
        let matched = r.tradeList;
        if (dayFilter) {
          matched = matched.filter((t) => istDayKey(t.entryTime) === dayFilter);
        }
        if (chartFilter) {
          matched = matched.filter((t) =>
            tradeMatchesChartFilter(
              scanTradeToTrade(t, r.symbol, report.tradeInstrument),
              chartFilter
            )
          );
        }
        if (!matched.length) return null;
        const totalPnl = matched.reduce((s, t) => s + t.pnl, 0);
        const wins = matched.filter((t) => t.pnl > 0).length;
        return {
          ...r,
          tradeList: matched,
          trades: matched.length,
          totalPnl,
          winRate: matched.length ? (wins / matched.length) * 100 : 0,
        } as ScanRow;
      })
      .filter(Boolean) as ScanRow[];
  }, [report.rows, report.tradeInstrument, filter, chartFilter, dayFilter]);

  // Auto-expand symbols when a chart/day filter is active
  const effectiveExpanded = useMemo(() => {
    if (!chartFilter && !dayFilter) return expanded;
    const next: Record<string, boolean> = { ...expanded };
    for (const r of rows) {
      if (r.tradeList?.length) next[r.symbol] = true;
    }
    return next;
  }, [chartFilter, dayFilter, rows, expanded]);

  function selectDay(date: string) {
    setDayFilter((cur) => (cur === date ? null : date));
    // Prefer one visual filter at a time for clarity
    setChartFilter(null);
  }

  function toggle(symbol: string) {
    setExpanded((prev) => ({ ...prev, [symbol]: !prev[symbol] }));
  }

  function downloadCsv() {
    const lines: string[] = [
      [
        "symbol",
        "status",
        "message",
        "lotSize",
        "trades",
        "winRate",
        "totalPnl",
        "trade_n",
        "entryTime",
        "exitTime",
        "entryPrice",
        "exitPrice",
        "underlyingEntry",
        "underlyingExit",
        "strike",
        "side",
        "tradePnl",
        "error",
      ].join(","),
    ];

    for (const r of report.rows) {
      if (r.tradeList?.length) {
        r.tradeList.forEach((t, i) => {
          lines.push(
            [
              r.symbol,
              r.status,
              csvEscape(r.message || ""),
              r.lotSize ?? "",
              r.trades,
              r.winRate.toFixed(2),
              r.totalPnl.toFixed(2),
              i + 1,
              iso(t.entryTime),
              iso(t.exitTime),
              t.entryPrice.toFixed(2),
              t.exitPrice.toFixed(2),
              t.underlyingEntry?.toFixed(2) ?? "",
              t.underlyingExit?.toFixed(2) ?? "",
              t.strike ?? "",
              t.optionSide ?? "",
              t.pnl.toFixed(2),
              "",
            ].join(",")
          );
        });
      } else {
        lines.push(
          [
            r.symbol,
            r.status,
            csvEscape(r.message || r.error || ""),
            r.lotSize ?? "",
            0,
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            csvEscape(r.error || ""),
          ].join(",")
        );
      }
    }

    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `fno-scan-${report.from}_${report.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="w-full overflow-hidden rounded-3xl border border-neutral-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      {fromCache && (
        <div className="border-b border-emerald-200 bg-emerald-50 px-4 py-3 sm:px-6">
          <p className="text-sm font-medium text-emerald-900">
            F&amp;O universe loaded from cloud
            {report.scanned
              ? ` · ${report.scanned} symbol(s)`
              : report.rows?.length
                ? ` · ${report.rows.length} symbol(s)`
                : ""}
          </p>
          <p className="mt-0.5 text-xs text-emerald-800/80">
            Multi-stock result (including &quot;run all F&amp;O&quot;) — no
            Upstox this run. Tick &quot;Force live scan&quot; only if you need a
            fresh broker pull.
          </p>
        </div>
      )}

      {/* Save F&O scan — successful symbols only (not shown on dual legs / single-symbol) */}
      {!hideSave && (
        <div className="border-b-2 border-neutral-900 bg-white px-4 py-4 sm:px-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-semibold tracking-tight text-black">
                Save F&amp;O scan results
              </p>
              <p className="mt-1 text-xs leading-relaxed text-neutral-500">
                Uploads symbols that finished without errors ({cleanCount} clean
                {errorCount ? ` · ${errorCount} error(s) skipped` : ""}
                ). Same strategy + date range overwrites the previous save. Next
                run loads this from cloud instead of Upstox.
                {!user ? " Sign in (top right) to enable." : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void saveFnoResults()}
              disabled={saving || !cleanCount}
              className="shrink-0 rounded-full bg-black px-6 py-3 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving
                ? "Saving F&O results…"
                : !user
                  ? "Save F&O results (sign in required)"
                  : "Save F&O results (no-error symbols)"}
            </button>
          </div>
          {saveMsg && (
            <p className="mt-3 rounded-xl bg-neutral-50 px-3 py-2 text-xs text-neutral-700">
              {saveMsg}
            </p>
          )}
        </div>
      )}

      {/* Header */}
      <div className="space-y-4 border-b border-neutral-100 px-4 py-5 sm:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p
              className={`text-xs font-medium tracking-wide uppercase ${
                report.side === "bullish" || heading?.toLowerCase().includes("bull")
                  ? "text-emerald-700"
                  : report.side === "bearish" ||
                      heading?.toLowerCase().includes("bear")
                    ? "text-rose-700"
                    : "text-neutral-500"
              }`}
            >
              {heading ||
                (report.side === "bullish"
                  ? "Bullish · CE"
                  : report.side === "bearish"
                    ? "Bearish · PE"
                    : "F&O equity report")}
            </p>
            <h2 className="mt-1 truncate text-xl font-semibold tracking-tight">
              {report.strategyName}
            </h2>
            <p className="mt-1 text-sm text-neutral-500 break-words">
              {report.from} → {report.to} · {report.interval} · {report.source} ·{" "}
              {report.tradeInstrument === "options_atm" ? "ATM options" : "equity"}
              {report.oneTradePerDay ? " · 1/day" : ""}
            </p>
            <p className="mt-0.5 text-xs text-neutral-400">
              Scanned {report.scanned} equity F&amp;O names
              {report.universeSize !== report.scanned
                ? ` (of ${report.universeSize})`
                : ""}
            </p>
            {report.sectorTrend && (
              <div className="mt-3 rounded-2xl border border-violet-200 bg-violet-50/80 px-3 py-2.5 text-xs text-violet-950">
                <p className="font-semibold">
                  Sector trend · {report.sectorTrend.mode}
                  {report.sectorTrend.mode === "auto" ? " (per day)" : ""} ·{" "}
                  {report.sectorTrend.windowLabel}
                </p>
                <p className="mt-1 text-[11px] text-violet-800/90">
                  Top {report.sectorTrend.topSectors} sectors by bar length ×{" "}
                  {report.sectorTrend.topStocksPerSector} stocks
                  {report.sectorTrend.weightMode
                    ? ` · ${report.sectorTrend.weightMode}`
                    : ""}
                  {report.sectorTrend.minStocks != null
                    ? ` · ≥${report.sectorTrend.minStocks} stocks`
                    : ""}
                  {report.sectorTrend.minBreadthPct != null
                    ? ` · breadth ≥${report.sectorTrend.minBreadthPct}%`
                    : ""}
                  {report.sectorTrend.mode === "auto"
                    ? ` · min |bar| ${report.sectorTrend.biasThreshold}%`
                    : ""}
                  {" · "}
                  <span className="text-emerald-800">
                    {report.sectorTrend.bullDays} bull day
                    {report.sectorTrend.bullDays === 1 ? "" : "s"}
                  </span>
                  {" / "}
                  <span className="text-rose-800">
                    {report.sectorTrend.bearDays} bear day
                    {report.sectorTrend.bearDays === 1 ? "" : "s"}
                  </span>
                </p>
                <p className="mt-1 leading-relaxed text-violet-900/90">
                  {report.sectorTrend.note ||
                    `Same as Market Watch: longest sector bars win; green=bull, red=bear.`}
                </p>
                {report.sectorTrend.dayPicks?.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer font-medium text-violet-800">
                      Daily picks ({report.sectorTrend.dayPicks.length} day
                      {report.sectorTrend.dayPicks.length === 1 ? "" : "s"})
                    </summary>
                    <ul className="mt-2 max-h-56 space-y-2 overflow-y-auto pr-1">
                      {report.sectorTrend.dayPicks.map((d) => (
                        <li
                          key={d.date}
                          className="rounded-lg bg-white/70 px-2 py-1.5"
                        >
                          <span className="font-medium">{d.date}</span>
                          <span
                            className={
                              d.direction === "bullish"
                                ? "ml-2 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800"
                                : d.direction === "bearish"
                                  ? "ml-2 rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-800"
                                  : "ml-2 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900"
                            }
                          >
                            {d.direction}
                          </span>
                          {d.sectors.map((sec) => {
                            const bar = Math.min(
                              100,
                              Math.abs(sec.strength ?? sec.avgChangePct) * 12
                            );
                            const isBull =
                              sec.direction === "bullish" ||
                              (sec.direction == null && sec.avgChangePct >= 0);
                            return (
                              <div
                                key={sec.sector}
                                className="mt-1.5 pl-1 text-[11px]"
                              >
                                <div className="flex items-center gap-2">
                                  <span
                                    className={
                                      isBull
                                        ? "rounded bg-emerald-100 px-1 font-semibold text-emerald-800"
                                        : "rounded bg-rose-100 px-1 font-semibold text-rose-800"
                                    }
                                  >
                                    {isBull ? "bull" : "bear"}
                                  </span>
                                  <span className="font-medium">
                                    {sec.sector}
                                  </span>
                                  <span className="text-violet-700/80">
                                    {sec.avgChangePct >= 0 ? "+" : ""}
                                    {sec.avgChangePct.toFixed(2)}% · |bar|{" "}
                                    {(sec.strength ?? Math.abs(sec.avgChangePct)).toFixed(2)}
                                  </span>
                                </div>
                                {/* Mini bar like Market Watch */}
                                <div className="mt-0.5 h-1.5 max-w-[12rem] overflow-hidden rounded-full bg-neutral-100">
                                  <div
                                    className={
                                      isBull
                                        ? "h-full rounded-full bg-emerald-500"
                                        : "h-full rounded-full bg-rose-500"
                                    }
                                    style={{ width: `${Math.max(4, bar)}%` }}
                                  />
                                </div>
                                <div className="mt-0.5 text-neutral-600">
                                  {sec.stocks
                                    .map(
                                      (s) =>
                                        `${s.symbol} (${s.changePct >= 0 ? "+" : ""}${s.changePct.toFixed(2)}%)`
                                    )
                                    .join(", ")}
                                </div>
                              </div>
                            );
                          })}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <button
              type="button"
              onClick={downloadCsv}
              className="rounded-full bg-black px-4 py-2 text-xs font-medium text-white hover:bg-neutral-800"
            >
              CSV
            </button>
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="rounded-full border border-neutral-300 px-4 py-2 text-xs font-medium hover:border-black"
              >
                Close
              </button>
            )}
          </div>
        </div>

        {/* Overall summary — same chips as before + capital / profit / loss */}
        <div>
          <p className="mb-2 text-[10px] font-medium tracking-wide text-neutral-500 uppercase">
            Overall
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            <MiniStat
              label="Combined P&L"
              value={formatMoney(s.totalPnl)}
              strong={s.totalPnl >= 0}
            />
            <MiniStat
              label="Win %"
              value={
                s.withTrades
                  ? `${((s.winners / s.withTrades) * 100).toFixed(0)}%`
                  : "-"
              }
              sub={`${s.winners}W / ${s.losers}L stocks`}
            />
            <MiniStat label="With trades" value={String(s.withTrades)} />
            <MiniStat label="No trade" value={String(noTradeCount)} />
            <MiniStat label="Errors" value={String(s.errors)} />
          </div>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <MiniStat
              label="Capital used"
              value={formatMoney(moneyTotals.capitalUsed)}
              sub="sum of entry capital across all trades"
            />
            <MiniStat
              label="Profit made"
              value={formatMoney(moneyTotals.grossProfit)}
              sub="sum of winning trades"
              strong
            />
            <MiniStat
              label="Loss made"
              value={formatMoney(moneyTotals.grossLoss)}
              sub="sum of losing trades"
            />
          </div>
        </div>

        {/* Per-day calendar — green profit / red loss boxes by month */}
        {daySummaries.length > 0 && (
          <div className="space-y-3 border-t border-neutral-100 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[10px] font-medium tracking-wide text-neutral-500 uppercase">
                Each day
                <span className="ml-2 font-normal normal-case text-neutral-400">
                  ({daySummaries.length} session day
                  {daySummaries.length === 1 ? "" : "s"} · calendar · IST)
                </span>
              </p>
              <p className="text-[10px] text-neutral-400">
                <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm bg-emerald-50 ring-1 ring-emerald-200" />
                Profit day
                <span className="ml-3 mr-2 inline-block h-2.5 w-2.5 rounded-sm bg-red-50 ring-1 ring-red-200" />
                Loss day
              </p>
            </div>
            <DayResultCalendar
              mode="scan"
              selectedDate={dayFilter}
              onDayClick={selectDay}
              days={daySummaries.map((d) => ({
                date: d.date,
                pnl: d.combinedPnl,
                trades: d.totalTrades,
                withTrades: d.withTrades,
                winners: d.winners,
                losers: d.losers,
                winPct: d.winPct,
                noTrade: d.noTrade,
                errors: d.errors,
                capitalUsed: d.capitalUsed,
                grossProfit: d.grossProfit,
                grossLoss: d.grossLoss,
              }))}
            />
            {dayFilter && (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
                <span>
                  Filtering list to trades on{" "}
                  <strong className="text-neutral-900">
                    {formatDayLabel(dayFilter)}
                  </strong>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setDayFilter(null);
                    setChartFilter(null);
                  }}
                  className="rounded-full bg-black px-3 py-1 text-[11px] font-medium text-white hover:bg-neutral-800"
                >
                  Clear day filter
                </button>
              </div>
            )}
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap gap-2">
          {(
            [
              { id: "all", label: "All", n: report.rows.length },
              { id: "ok", label: "Trades", n: s.withTrades },
              { id: "no_trades", label: "No trade", n: noTradeCount },
              { id: "error", label: "Error", n: s.errors },
            ] as const
          ).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                filter === f.id
                  ? "bg-black text-white"
                  : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
              }`}
            >
              {f.label} ({f.n})
            </button>
          ))}
        </div>
      </div>

      {/* Combined F&O performance charts */}
      <div
        id="fno-combined-charts"
        className="border-b border-neutral-100 px-4 py-5 sm:px-6"
      >
        <PerformanceCharts
          trades={combinedTrades}
          title="Combined F&O charts"
          subtitle={
            dayFilter
              ? `All symbols · ${combinedTrades.length} trade(s) · charts scoped to ${formatDayLabel(dayFilter)} · click a bar to filter list below`
              : `All symbols with trades · ${combinedTrades.length} total trade(s) · 15-min slots + hold time across all days · click a bar to filter list below`
          }
          selectedDay={dayFilter}
          activeFilter={chartFilter}
          onFilterChange={setChartFilter}
        />
      </div>

      {/* Responsive stock list */}
      <div className="border-b border-neutral-100 px-4 py-2 sm:px-6">
        <p className="text-xs text-neutral-500">
          {dayFilter || chartFilter
            ? `Showing ${rows.length} symbol(s) matching ${[
                dayFilter ? `day ${formatDayLabel(dayFilter)}` : "",
                chartFilter ? "chart selection" : "",
              ]
                .filter(Boolean)
                .join(" · ")}`
            : `${rows.length} symbol(s) in list`}
        </p>
      </div>
      <ul className="divide-y divide-neutral-100">
        {rows.map((r, i) => (
          <StockBlock
            key={r.symbol}
            row={r}
            index={i + 1}
            isOptions={report.tradeInstrument === "options_atm"}
            open={Boolean(effectiveExpanded[r.symbol])}
            onToggle={() => toggle(r.symbol)}
          />
        ))}
        {!rows.length && (
          <li className="px-4 py-10 text-center text-sm text-neutral-500">
            {chartFilter
              ? "No stocks match this chart bar. Clear the filter to see all."
              : "No stocks in this filter."}
          </li>
        )}
      </ul>
    </section>
  );
}

function StockBlock({
  row,
  index,
  isOptions,
  open,
  onToggle,
}: {
  row: ScanRow;
  index: number;
  isOptions: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const hasTrades = (row.tradeList?.length || 0) > 0;

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition hover:bg-neutral-50 sm:px-6"
      >
        <span className="w-7 shrink-0 text-xs tabular-nums text-neutral-400">
          {index}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold tracking-tight">{row.symbol}</span>
            <StatusPill status={row.status} />
          </div>
          <p className="mt-0.5 truncate text-xs text-neutral-500">
            {row.status === "ok" && (
              <>
                {row.trades} trade{row.trades === 1 ? "" : "s"}
                {row.lotSize ? ` · lot ${row.lotSize}` : ""}
                {` · win ${row.winRate.toFixed(0)}%`}
              </>
            )}
            {row.status === "no_trades" && "No trade - conditions not met"}
            {row.status === "error" && (
              <span className="text-neutral-700">Error - tap to view</span>
            )}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p
            className={`text-sm font-semibold tabular-nums ${
              row.status === "ok"
                ? row.totalPnl >= 0
                  ? "text-black"
                  : "text-neutral-500"
                : "text-neutral-300"
            }`}
          >
            {row.status === "ok" ? formatMoney(row.totalPnl) : "—"}
          </p>
          <p className="text-[10px] text-neutral-400">{open ? "Hide" : "Details"}</p>
        </div>
      </button>

      {open && (
        <div className="border-t border-neutral-50 bg-neutral-50 px-4 py-4 sm:px-6">
          {row.status === "error" && (
            <div className="rounded-2xl border border-neutral-300 bg-white p-4">
              <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
                Error
              </p>
              <p className="mt-2 text-sm leading-relaxed break-words text-neutral-800">
                {row.error || row.message || "Unknown error"}
              </p>
            </div>
          )}

          {row.status === "no_trades" && (
            <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-4">
              <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
                No trade
              </p>
              <p className="mt-2 text-sm leading-relaxed text-neutral-600">
                {row.message ||
                  "Entry conditions never met on any day in this range."}
              </p>
            </div>
          )}

          {hasTrades && (
            <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
              {/* Mobile-friendly: horizontal scroll only on subtable */}
              <table className="w-full min-w-[640px] text-left text-xs">
                <thead>
                  <tr className="border-b border-neutral-100 bg-neutral-50/80 text-[10px] font-medium tracking-wide text-neutral-500 uppercase">
                    <th className="px-3 py-2.5 font-medium">#</th>
                    {isOptions && (
                      <th className="px-3 py-2.5 font-medium">Contract</th>
                    )}
                    <th className="px-3 py-2.5 font-medium">Entry</th>
                    <th className="px-3 py-2.5 font-medium">Exit</th>
                    <th className="px-3 py-2.5 font-medium text-right">
                      {isOptions ? "Prem in" : "Price in"}
                    </th>
                    <th className="px-3 py-2.5 font-medium text-right">
                      {isOptions ? "Prem out" : "Price out"}
                    </th>
                    <th className="px-3 py-2.5 font-medium text-right">
                      Capital used
                    </th>
                    {isOptions && (
                      <th className="px-3 py-2.5 font-medium text-right">
                        Lot size
                      </th>
                    )}
                    <th className="px-3 py-2.5 font-medium text-right">P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  {row.tradeList!.map((t, ti) => (
                    <TradeRow
                      key={`${t.entryTime}-${ti}`}
                      t={t}
                      n={ti + 1}
                      isOptions={isOptions}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function TradeRow({
  t,
  n,
  isOptions,
}: {
  t: ScanTradeDetail;
  n: number;
  isOptions: boolean;
}) {
  return (
    <tr className="border-b border-neutral-50 last:border-0">
      <td className="px-3 py-2.5 text-neutral-400">{n}</td>
      {isOptions && (
        <td className="px-3 py-2.5 font-medium whitespace-nowrap">
          {t.label || `${t.strike ?? ""} ${t.optionSide ?? ""}`.trim() || "—"}
        </td>
      )}
      <td className="px-3 py-2.5 whitespace-nowrap text-neutral-700">
        {formatTime(t.entryTime)}
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap text-neutral-700">
        {formatTime(t.exitTime)}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums">
        {t.entryPrice.toFixed(2)}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums">
        {t.exitPrice.toFixed(2)}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums font-medium">
        {formatMoney(t.capitalUsed ?? t.entryPrice)}
      </td>
      {isOptions && (
        <td className="px-3 py-2.5 text-right tabular-nums">
          {t.lotSize != null ? t.lotSize : "-"}
        </td>
      )}
      <td
        className={`px-3 py-2.5 text-right tabular-nums font-medium ${
          t.pnl >= 0 ? "text-black" : "text-neutral-500"
        }`}
      >
        {formatMoney(t.pnl)}
      </td>
    </tr>
  );
}

function scanTradeToTrade(
  t: ScanTradeDetail,
  symbol: string,
  instrument: ScanReportType["tradeInstrument"]
): Trade {
  return {
    entryTime: t.entryTime,
    exitTime: t.exitTime,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    capitalUsed: t.capitalUsed,
    qty: (t.lots || 1) * (t.lotSize || 1),
    pnl: t.pnl,
    pnlPct: t.pnlPct,
    barsHeld: t.barsHeld,
    underlyingEntry: t.underlyingEntry,
    underlyingExit: t.underlyingExit,
    strike: t.strike,
    optionSide: t.optionSide,
    lots: t.lots,
    lotSize: t.lotSize,
    label: t.label || symbol,
    instrument: instrument === "options_atm" ? "options_atm" : "equity",
    ...({ _symbol: symbol } as object),
  } as Trade;
}

function StatusPill({ status }: { status: ScanRow["status"] }) {
  if (status === "ok") {
    return (
      <span className="rounded-full bg-black px-2 py-0.5 text-[10px] font-medium tracking-wide text-white uppercase">
        Trades
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-[10px] font-medium tracking-wide text-white uppercase">
        Error
      </span>
    );
  }
  return (
    <span className="rounded-full border border-neutral-300 px-2 py-0.5 text-[10px] font-medium tracking-wide text-neutral-500 uppercase">
      No trade
    </span>
  );
}

function MiniStat({
  label,
  value,
  sub,
  strong,
}: {
  label: string;
  value: string;
  sub?: string;
  strong?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border px-3 py-2 ${
        strong
          ? "border-neutral-900 bg-white"
          : "border-neutral-200 bg-white"
      }`}
    >
      <p className="text-[10px] font-medium tracking-wide text-neutral-500 uppercase">
        {label}
      </p>
      <p className="mt-0.5 text-base font-semibold tracking-tight tabular-nums">
        {value}
      </p>
      {sub && <p className="text-[10px] text-neutral-500">{sub}</p>}
    </div>
  );
}

function istDayKey(ms: number): string {
  const d = new Date(ms + 5.5 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function formatDayLabel(ymd: string): string {
  try {
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return ymd;
  }
}


function csvEscape(s: string) {
  if (!s) return "";
  return `"${s.replace(/"/g, '""')}"`;
}

function iso(ms: number) {
  return new Date(ms).toISOString();
}
