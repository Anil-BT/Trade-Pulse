"use client";

import { useMemo, useState } from "react";
import { formatMoney, formatPct, formatTime } from "@/lib/format";
import type {
  ScanReport as ScanReportType,
  ScanRow,
  ScanTradeDetail,
} from "@/lib/types";

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

  const noTradeCount = report.rows.filter((r) => r.status === "no_trades").length;

  const rows = useMemo(() => {
    if (filter === "all") return report.rows;
    return report.rows.filter((r) => r.status === filter);
  }, [report.rows, filter]);

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
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MiniStat label="With trades" value={String(s.withTrades)} />
          <MiniStat label="No trade" value={String(noTradeCount)} />
          <MiniStat label="Errors" value={String(s.errors)} />
          <MiniStat label="Combined P&L" value={formatMoney(s.totalPnl)} />
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

      {/* Responsive stock list */}
      <ul className="divide-y divide-neutral-100">
        {rows.map((r, i) => (
          <StockBlock
            key={r.symbol}
            row={r}
            index={i + 1}
            isOptions={report.tradeInstrument === "options_atm"}
            open={Boolean(expanded[r.symbol])}
            onToggle={() => toggle(r.symbol)}
          />
        ))}
        {!rows.length && (
          <li className="px-4 py-10 text-center text-sm text-neutral-500">
            No stocks in this filter.
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
                    {isOptions && (
                      <>
                        <th className="px-3 py-2.5 font-medium text-right">
                          Spot in
                        </th>
                        <th className="px-3 py-2.5 font-medium text-right">
                          Spot out
                        </th>
                        <th className="px-3 py-2.5 font-medium text-right">
                          Strike
                        </th>
                      </>
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
      {isOptions && (
        <>
          <td className="px-3 py-2.5 text-right tabular-nums text-neutral-500">
            {t.underlyingEntry?.toFixed(2) ?? "—"}
          </td>
          <td className="px-3 py-2.5 text-right tabular-nums text-neutral-500">
            {t.underlyingExit?.toFixed(2) ?? "—"}
          </td>
          <td className="px-3 py-2.5 text-right tabular-nums">
            {t.strike ?? "—"}
          </td>
        </>
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

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-neutral-200 px-3 py-2">
      <p className="text-[10px] font-medium tracking-wide text-neutral-500 uppercase">
        {label}
      </p>
      <p className="mt-0.5 text-base font-semibold tracking-tight tabular-nums">
        {value}
      </p>
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
