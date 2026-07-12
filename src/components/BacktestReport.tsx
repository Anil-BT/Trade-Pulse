"use client";

import { useMemo, useState } from "react";
import type { BacktestResult, DaySummary, Trade } from "@/lib/types";
import { formatMoney, formatPct, formatTime } from "@/lib/format";

/**
 * Full backtest report: overall + per-day summary cards on top, then detail table.
 */
export function BacktestReport({ result }: { result: BacktestResult }) {
  const m = result.metrics;
  const [expanded, setExpanded] = useState<string | null>(null);

  const tradesByDay = useMemo(
    () => groupTradesByDay(result.trades),
    [result.trades]
  );

  /** Prefer server daySummaries; rebuild client-side if missing */
  const days = useMemo(() => {
    if (result.daySummaries?.length) return result.daySummaries;
    return buildDaySummariesClient(result.trades);
  }, [result.daySummaries, result.trades]);

  const profitableDays = days.filter((d) => d.pnl > 0).length;
  const losingDays = days.filter((d) => d.pnl < 0).length;
  const flatDays = days.filter((d) => d.pnl === 0).length;
  const bestDay = days.reduce<DaySummary | null>(
    (b, d) => (!b || d.pnl > b.pnl ? d : b),
    null
  );
  const worstDay = days.reduce<DaySummary | null>(
    (b, d) => (!b || d.pnl < b.pnl ? d : b),
    null
  );
  const maxAbsDayPnl = Math.max(1, ...days.map((d) => Math.abs(d.pnl)));

  const expectancy =
    m.totalTrades > 0
      ? (m.winRate / 100) * m.avgWin + ((100 - m.winRate) / 100) * m.avgLoss
      : 0;

  const rr =
    !Number.isFinite(m.riskRewardRatio) || m.riskRewardRatio >= 999
      ? "∞"
      : m.riskRewardRatio.toFixed(2);

  return (
    <div className="space-y-6">
      {/* ——— TOP: Overall + each day summary ——— */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
              Summary
            </p>
            <h3 className="mt-0.5 text-base font-semibold tracking-tight">
              Overall
              {days.length > 0
                ? ` · ${days.length} day${days.length === 1 ? "" : "s"}`
                : ""}
            </h3>
          </div>
          <p
            className={`text-xl font-semibold tabular-nums ${
              m.totalPnl >= 0 ? "text-black" : "text-neutral-500"
            }`}
          >
            {formatMoney(m.totalPnl)}
            <span className="ml-2 text-xs font-normal text-neutral-400">
              {formatPct(m.totalPnlPct)}
            </span>
          </p>
        </div>

        {/* Overall KPI strip — capital, profit, loss front and centre */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8">
          <MiniStat
            label="Total capital used"
            value={formatMoney(m.totalCapitalUsed ?? 0)}
            sub={`avg ${formatMoney(m.avgCapitalUsed ?? 0)} · max ${formatMoney(m.maxCapitalUsed ?? 0)}`}
            strong
          />
          <MiniStat
            label="Gross profit"
            value={formatMoney(m.grossProfit ?? m.avgWin * m.winners)}
            sub={`${m.winners} winning trade${m.winners === 1 ? "" : "s"}`}
            positive
            strong
          />
          <MiniStat
            label="Gross loss"
            value={formatMoney(
              m.grossLoss ?? Math.abs(m.avgLoss) * m.losers
            )}
            sub={`${m.losers} losing trade${m.losers === 1 ? "" : "s"}`}
            positive={false}
            strong
          />
          <MiniStat
            label="Net P&L"
            value={formatMoney(m.totalPnl)}
            sub={formatPct(m.totalPnlPct)}
            positive={m.totalPnl >= 0}
            strong
          />
          <MiniStat
            label="Trades"
            value={String(m.totalTrades)}
            sub={`${m.winners}W / ${m.losers}L`}
          />
          <MiniStat label="Win %" value={`${m.winRate.toFixed(1)}%`} />
          <MiniStat
            label="R : R"
            value={rr === "∞" ? "∞" : `${rr}:1`}
            sub={`PF ${m.profitFactor >= 999 ? "∞" : m.profitFactor.toFixed(2)}`}
          />
          <MiniStat
            label="Max DD"
            value={formatMoney(m.maxDrawdown)}
            sub={formatPct(-Math.abs(m.maxDrawdownPct))}
          />
        </div>

        {/* Per-day summary cards — always on top when we have days */}
        {days.length > 0 && (
          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
                Each day
              </p>
              <p className="text-[11px] text-neutral-400">
                {profitableDays} green · {losingDays} red
                {flatDays ? ` · ${flatDays} flat` : ""}
                {bestDay
                  ? ` · best ${formatIstDateShort(bestDay.date)} ${formatMoney(bestDay.pnl)}`
                  : ""}
                {worstDay && days.length > 1
                  ? ` · worst ${formatIstDateShort(worstDay.date)} ${formatMoney(worstDay.pnl)}`
                  : ""}
              </p>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {days.map((d) => {
                const selected = expanded === d.date;
                return (
                  <button
                    key={d.date}
                    type="button"
                    onClick={() =>
                      setExpanded((cur) => (cur === d.date ? null : d.date))
                    }
                    className={`rounded-2xl border p-3 text-left transition ${
                      selected
                        ? "border-black bg-neutral-50 shadow-sm"
                        : "border-neutral-200 bg-white hover:border-neutral-400"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold tracking-tight">
                          {formatIstDate(d.date)}
                        </p>
                        <p className="mt-0.5 text-[11px] text-neutral-400">
                          {d.trades} trade{d.trades === 1 ? "" : "s"} ·{" "}
                          {d.winners}W/{d.losers}L · {d.winRate.toFixed(0)}%
                        </p>
                      </div>
                      <p
                        className={`text-sm font-semibold tabular-nums ${
                          d.pnl >= 0 ? "text-black" : "text-neutral-500"
                        }`}
                      >
                        {formatMoney(d.pnl)}
                      </p>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-100">
                      <div
                        className={`h-full rounded-full ${
                          d.pnl >= 0 ? "bg-neutral-900" : "bg-neutral-400"
                        }`}
                        style={{
                          width: `${Math.min(100, (Math.abs(d.pnl) / maxAbsDayPnl) * 100)}%`,
                        }}
                      />
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-neutral-500">
                      <span>
                        capital {formatMoney(d.capitalUsed)}
                      </span>
                      <span className="text-black">
                        profit {formatMoney(d.grossProfit ?? 0)}
                      </span>
                      <span>
                        loss {formatMoney(d.grossLoss ?? 0)}
                      </span>
                      <span>avg {formatMoney(d.avgPnl)}</span>
                      {d.maxRiskStops > 0 && (
                        <span className="font-medium text-neutral-700">
                          {d.maxRiskStops} stop
                          {d.maxRiskStops === 1 ? "" : "s"}
                        </span>
                      )}
                      <span className="text-neutral-400">
                        cum {formatMoney(d.cumulativePnl)}
                      </span>
                    </div>
                    <p className="mt-1.5 text-[10px] text-neutral-400">
                      {selected ? "Hide trades ▴" : "Show trades ▾"}
                    </p>
                  </button>
                );
              })}
            </div>

            {/* Expanded day trades under the cards */}
            {expanded && (tradesByDay.get(expanded)?.length ?? 0) > 0 && (
              <div className="mt-3 overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
                <div className="border-b border-neutral-100 px-3 py-2 text-xs font-medium text-neutral-600">
                  Trades · {formatIstDate(expanded)}
                </div>
                <table className="w-full min-w-[640px] text-left text-xs">
                  <thead>
                    <tr className="border-b border-neutral-100 text-[10px] tracking-wide text-neutral-400 uppercase">
                      <th className="px-2.5 py-2 font-medium">#</th>
                      <th className="px-2.5 py-2 font-medium">Entry</th>
                      <th className="px-2.5 py-2 font-medium">Exit</th>
                      <th className="px-2.5 py-2 font-medium text-right">In</th>
                      <th className="px-2.5 py-2 font-medium text-right">Out</th>
                      <th className="px-2.5 py-2 font-medium text-right">
                        P&amp;L
                      </th>
                      <th className="px-2.5 py-2 font-medium">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(tradesByDay.get(expanded) || []).map((t, i) => (
                      <tr
                        key={`${t.entryTime}-${i}`}
                        className="border-b border-neutral-50 last:border-0"
                      >
                        <td className="px-2.5 py-1.5 text-neutral-400">
                          {i + 1}
                        </td>
                        <td className="px-2.5 py-1.5 whitespace-nowrap">
                          {formatTime(t.entryTime)}
                        </td>
                        <td className="px-2.5 py-1.5 whitespace-nowrap">
                          {formatTime(t.exitTime)}
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums">
                          {t.entryPrice.toFixed(2)}
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums">
                          {t.exitPrice.toFixed(2)}
                        </td>
                        <td
                          className={`px-2.5 py-1.5 text-right tabular-nums font-medium ${
                            t.pnl >= 0 ? "text-black" : "text-neutral-500"
                          }`}
                        >
                          {formatMoney(t.pnl)}
                        </td>
                        <td className="px-2.5 py-1.5 text-neutral-500">
                          {t.exitReason === "max_risk"
                            ? "Max risk"
                            : t.exitReason === "eod"
                              ? "EOD"
                              : "Strategy"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {days.length === 0 && result.trades.length === 0 && (
          <p className="rounded-2xl border border-dashed border-neutral-300 bg-neutral-50 px-4 py-6 text-center text-sm text-neutral-500">
            No trades — no daily summary for this range.
          </p>
        )}
      </section>

      {/* ——— More metrics ——— */}
      <section>
        <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
          More metrics
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          <MiniStat
            label="Final equity"
            value={formatMoney(m.finalEquity)}
            sub={`start ${formatMoney(m.initialCapital)}`}
          />
          <MiniStat
            label="Total capital used"
            value={formatMoney(m.totalCapitalUsed ?? 0)}
            sub={`avg ${formatMoney(m.avgCapitalUsed ?? 0)} · max ${formatMoney(m.maxCapitalUsed ?? 0)}`}
          />
          <MiniStat
            label="Gross profit"
            value={formatMoney(m.grossProfit ?? m.avgWin * m.winners)}
            sub={`${m.winners} win(s) · avg ${formatMoney(m.avgWin)}`}
            positive
          />
          <MiniStat
            label="Gross loss"
            value={formatMoney(m.grossLoss ?? Math.abs(m.avgLoss) * m.losers)}
            sub={`${m.losers} loss(es) · avg ${formatMoney(Math.abs(m.avgLoss))}`}
            positive={false}
          />
          <MiniStat
            label="Profit factor"
            value={m.profitFactor >= 999 ? "∞" : m.profitFactor.toFixed(2)}
            sub="gross profit ÷ gross loss"
          />
          <MiniStat
            label="Expectancy"
            value={formatMoney(expectancy)}
            sub="per trade"
            positive={expectancy >= 0}
          />
          {result.diagnostics?.maxRiskStops != null &&
            result.diagnostics.maxRiskStops > 0 && (
              <MiniStat
                label="Max-risk stops"
                value={String(result.diagnostics.maxRiskStops)}
                sub={
                  result.diagnostics.maxRiskCap
                    ? `cap −₹${Math.round(result.diagnostics.maxRiskCap).toLocaleString("en-IN")}`
                    : undefined
                }
              />
            )}
          {result.diagnostics?.candleCount != null && (
            <MiniStat
              label="Bars loaded"
              value={String(result.diagnostics.candleCount)}
              sub={
                result.diagnostics.equitySignals != null
                  ? `${result.diagnostics.equitySignals} equity signal(s)`
                  : undefined
              }
            />
          )}
        </div>
      </section>

      {/* ——— Full daily table (when 2+ days) ——— */}
      {days.length > 1 && (
        <section>
          <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
            Daily table
          </p>
          <p className="mt-1 text-xs text-neutral-500">
            Same day totals in table form · cumulative P&amp;L
          </p>
          <div className="mt-3 overflow-x-auto rounded-2xl border border-neutral-200">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-[10px] font-medium tracking-wide text-neutral-500 uppercase">
                  <th className="px-3 py-2.5 font-medium">Date</th>
                  <th className="px-3 py-2.5 font-medium text-right">Trades</th>
                  <th className="px-3 py-2.5 font-medium text-right">W / L</th>
                  <th className="px-3 py-2.5 font-medium text-right">Win %</th>
                  <th className="px-3 py-2.5 font-medium text-right">
                    Capital used
                  </th>
                  <th className="px-3 py-2.5 font-medium text-right">Profit</th>
                  <th className="px-3 py-2.5 font-medium text-right">Loss</th>
                  <th className="px-3 py-2.5 font-medium text-right">Day P&amp;L</th>
                  <th className="px-3 py-2.5 font-medium text-right">
                    Cum. P&amp;L
                  </th>
                  <th className="px-3 py-2.5 font-medium text-right">Stops</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => (
                  <tr
                    key={d.date}
                    className="cursor-pointer border-b border-neutral-100 hover:bg-neutral-50"
                    onClick={() =>
                      setExpanded((cur) => (cur === d.date ? null : d.date))
                    }
                  >
                    <td className="px-3 py-2.5 font-medium whitespace-nowrap">
                      {formatIstDate(d.date)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {d.trades}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-neutral-600">
                      {d.winners} / {d.losers}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {d.winRate.toFixed(0)}%
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-neutral-600">
                      {formatMoney(d.capitalUsed)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-black">
                      {formatMoney(d.grossProfit ?? 0)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-neutral-500">
                      {formatMoney(d.grossLoss ?? 0)}
                    </td>
                    <td
                      className={`px-3 py-2.5 text-right tabular-nums font-medium ${
                        d.pnl >= 0 ? "text-black" : "text-neutral-500"
                      }`}
                    >
                      {formatMoney(d.pnl)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-neutral-600">
                      {formatMoney(d.cumulativePnl)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-neutral-500">
                      {d.maxRiskStops || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-neutral-200 bg-neutral-50 font-semibold">
                  <td className="px-3 py-2.5">Total</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {m.totalTrades}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {m.winners} / {m.losers}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {m.winRate.toFixed(0)}%
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {formatMoney(m.totalCapitalUsed ?? 0)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {formatMoney(m.grossProfit ?? 0)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {formatMoney(m.grossLoss ?? 0)}
                  </td>
                  <td
                    className={`px-3 py-2.5 text-right tabular-nums ${
                      m.totalPnl >= 0 ? "text-black" : "text-neutral-500"
                    }`}
                  >
                    {formatMoney(m.totalPnl)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {formatMoney(m.totalPnl)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {result.diagnostics?.maxRiskStops ?? 0}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function MiniStat({
  label,
  value,
  sub,
  positive,
  strong,
}: {
  label: string;
  value: string;
  sub?: string;
  positive?: boolean;
  strong?: boolean;
}) {
  return (
    <div
      className={`rounded-xl px-3 py-2.5 ${
        strong
          ? "border-2 border-neutral-900 bg-white"
          : "border border-neutral-200 bg-white"
      }`}
    >
      <p className="text-[10px] font-medium tracking-wide text-neutral-500 uppercase">
        {label}
      </p>
      <p
        className={`mt-1 text-sm font-semibold tabular-nums sm:text-base ${
          positive === true
            ? "text-black"
            : positive === false
              ? "text-neutral-500"
              : "text-neutral-900"
        }`}
      >
        {value}
      </p>
      {sub && (
        <p className="mt-0.5 text-[10px] leading-snug text-neutral-400">{sub}</p>
      )}
    </div>
  );
}

function groupTradesByDay(trades: Trade[]): Map<string, Trade[]> {
  const map = new Map<string, Trade[]>();
  for (const t of trades) {
    const d = istDay(t.entryTime);
    const list = map.get(d) || [];
    list.push(t);
    map.set(d, list);
  }
  return map;
}

function istDay(ms: number): string {
  const d = new Date(ms + 5.5 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/** Client-side fallback if API did not send daySummaries */
function buildDaySummariesClient(trades: Trade[]): DaySummary[] {
  type Acc = {
    trades: number;
    winners: number;
    losers: number;
    pnl: number;
    grossProfit: number;
    grossLoss: number;
    capitalUsed: number;
    maxRiskStops: number;
    signalExits: number;
    bestTrade: number;
    worstTrade: number;
  };
  const byDay = new Map<string, Acc>();

  for (const t of trades) {
    const date = istDay(t.entryTime);
    let row = byDay.get(date);
    if (!row) {
      row = {
        trades: 0,
        winners: 0,
        losers: 0,
        pnl: 0,
        grossProfit: 0,
        grossLoss: 0,
        capitalUsed: 0,
        maxRiskStops: 0,
        signalExits: 0,
        bestTrade: -Infinity,
        worstTrade: Infinity,
      };
      byDay.set(date, row);
    }
    row.trades += 1;
    if (t.pnl > 0) {
      row.winners += 1;
      row.grossProfit += t.pnl;
    } else {
      row.losers += 1;
      row.grossLoss += Math.abs(t.pnl);
    }
    row.pnl += t.pnl;
    row.capitalUsed += t.capitalUsed ?? t.entryPrice * t.qty;
    if (t.exitReason === "max_risk") row.maxRiskStops += 1;
    else row.signalExits += 1;
    row.bestTrade = Math.max(row.bestTrade, t.pnl);
    row.worstTrade = Math.min(row.worstTrade, t.pnl);
  }

  let cumulative = 0;
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, r]) => {
      cumulative += r.pnl;
      return {
        date,
        trades: r.trades,
        winners: r.winners,
        losers: r.losers,
        winRate: r.trades ? (r.winners / r.trades) * 100 : 0,
        pnl: Number(r.pnl.toFixed(2)),
        grossProfit: Number(r.grossProfit.toFixed(2)),
        grossLoss: Number(r.grossLoss.toFixed(2)),
        avgPnl: r.trades ? Number((r.pnl / r.trades).toFixed(2)) : 0,
        avgWin: r.winners ? Number((r.grossProfit / r.winners).toFixed(2)) : 0,
        avgLoss: r.losers ? Number((-(r.grossLoss / r.losers)).toFixed(2)) : 0,
        bestTrade: Number.isFinite(r.bestTrade)
          ? Number(r.bestTrade.toFixed(2))
          : 0,
        worstTrade: Number.isFinite(r.worstTrade)
          ? Number(r.worstTrade.toFixed(2))
          : 0,
        capitalUsed: Number(r.capitalUsed.toFixed(2)),
        maxRiskStops: r.maxRiskStops,
        signalExits: r.signalExits,
        cumulativePnl: Number(cumulative.toFixed(2)),
      };
    });
}

function formatIstDate(ymd: string): string {
  try {
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", {
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return ymd;
  }
}

function formatIstDateShort(ymd: string): string {
  try {
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      timeZone: "UTC",
    });
  } catch {
    return ymd;
  }
}
