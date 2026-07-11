"use client";

import { useMemo, useState } from "react";
import { formatMoney, formatTime } from "@/lib/format";
import type {
  ScanReport as ScanReportType,
  ScanRow,
  ScanTradeDetail,
  Trade,
} from "@/lib/types";
import {
  PerformanceCharts,
  tradeMatchesChartFilter,
  type ChartBarFilter,
} from "./PerformanceCharts";

export function ScanReportView({
  report,
  onClose,
}: {
  report: ScanReportType;
  onClose?: () => void;
}) {
  const s = report.summary;
  const [filter, setFilter] = useState<"all" | "ok" | "no_trades" | "error">(
    "all"
  );
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [chartFilter, setChartFilter] = useState<ChartBarFilter | null>(null);

  const noTradeCount = report.rows.filter((r) => r.status === "no_trades").length;

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

  const rows = useMemo(() => {
    let base =
      filter === "all"
        ? report.rows
        : report.rows.filter((r) => r.status === filter);

    if (!chartFilter) return base;

    // Only rows that have trades matching the clicked chart bar
    return base
      .map((r) => {
        if (!r.tradeList?.length) return null;
        const matched = r.tradeList.filter((t) =>
          tradeMatchesChartFilter(
            scanTradeToTrade(t, r.symbol, report.tradeInstrument),
            chartFilter
          )
        );
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
  }, [report.rows, report.tradeInstrument, filter, chartFilter]);

  // Auto-expand symbols that match when a chart filter is active
  const effectiveExpanded = useMemo(() => {
    if (!chartFilter) return expanded;
    const next: Record<string, boolean> = { ...expanded };
    for (const r of rows) {
      if (r.tradeList?.length) next[r.symbol] = true;
    }
    return next;
  }, [chartFilter, rows, expanded]);

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
      {/* Header */}
      <div className="space-y-4 border-b border-neutral-100 px-4 py-5 sm:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
              F&amp;O equity report
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

        {/* Summary chips */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <MiniStat label="Combined P&L" value={formatMoney(s.totalPnl)} />
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
          subtitle={`All symbols with trades · ${combinedTrades.length} total trade(s) · 15-min slots on latest day + hold time · click a bar to filter list below`}
          activeFilter={chartFilter}
          onFilterChange={setChartFilter}
        />
      </div>

      {/* Responsive stock list */}
      <div className="border-b border-neutral-100 px-4 py-2 sm:px-6">
        <p className="text-xs text-neutral-500">
          {chartFilter
            ? `Showing ${rows.length} symbol(s) matching chart selection`
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
                        Strike
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
          {t.strike ?? "-"}
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
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-neutral-200 px-3 py-2">
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

function csvEscape(s: string) {
  if (!s) return "";
  return `"${s.replace(/"/g, '""')}"`;
}

function iso(ms: number) {
  return new Date(ms).toISOString();
}
