"use client";

import type { DaySummary } from "@/lib/types";
import { formatMoney } from "@/lib/format";

export function DaySummaryTable({
  days,
  overall,
}: {
  days: DaySummary[];
  overall: {
    trades: number;
    winners: number;
    losers: number;
    winRate: number;
    pnl: number;
    capitalUsed: number;
    maxRiskStops?: number;
  };
}) {
  if (!days.length) return null;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-neutral-900">
          Overall summary
        </h3>
        <p className="mt-0.5 text-xs text-neutral-500">
          All days combined · {days.length} session day
          {days.length === 1 ? "" : "s"}
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Days" value={String(days.length)} />
          <Stat label="Trades" value={String(overall.trades)} />
          <Stat
            label="Win %"
            value={`${overall.winRate.toFixed(1)}%`}
            sub={`${overall.winners}W / ${overall.losers}L`}
          />
          <Stat
            label="Net P&L"
            value={formatMoney(overall.pnl)}
            positive={overall.pnl >= 0}
          />
          <Stat
            label="Capital used"
            value={formatMoney(overall.capitalUsed)}
          />
          <Stat
            label="Risk stops"
            value={String(overall.maxRiskStops ?? 0)}
          />
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-neutral-900">
          Day-by-day summary
        </h3>
        <p className="mt-0.5 text-xs text-neutral-500">
          Grouped by entry session day (IST)
        </p>
        <div className="mt-3 overflow-x-auto rounded-2xl border border-neutral-200">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-xs font-medium tracking-wide text-neutral-500 uppercase">
                <th className="px-3 py-2.5 font-medium">Date</th>
                <th className="px-3 py-2.5 font-medium text-right">Trades</th>
                <th className="px-3 py-2.5 font-medium text-right">W / L</th>
                <th className="px-3 py-2.5 font-medium text-right">Win %</th>
                <th className="px-3 py-2.5 font-medium text-right">P&amp;L</th>
                <th className="px-3 py-2.5 font-medium text-right">
                  Capital used
                </th>
                <th className="px-3 py-2.5 font-medium text-right">
                  Risk stops
                </th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr
                  key={d.date}
                  className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50"
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
                  <td
                    className={`px-3 py-2.5 text-right tabular-nums font-medium ${
                      d.pnl >= 0 ? "text-black" : "text-neutral-500"
                    }`}
                  >
                    {formatMoney(d.pnl)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-neutral-600">
                    {formatMoney(d.capitalUsed)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-neutral-500">
                    {d.maxRiskStops || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-neutral-200 bg-neutral-50 font-medium">
                <td className="px-3 py-2.5">Total</td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {overall.trades}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {overall.winners} / {overall.losers}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {overall.winRate.toFixed(0)}%
                </td>
                <td
                  className={`px-3 py-2.5 text-right tabular-nums ${
                    overall.pnl >= 0 ? "text-black" : "text-neutral-500"
                  }`}
                >
                  {formatMoney(overall.pnl)}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {formatMoney(overall.capitalUsed)}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {overall.maxRiskStops ?? 0}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  positive,
}: {
  label: string;
  value: string;
  sub?: string;
  positive?: boolean;
}) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white px-3 py-2.5">
      <p className="text-[10px] font-medium tracking-wide text-neutral-500 uppercase">
        {label}
      </p>
      <p
        className={`mt-1 text-sm font-semibold tabular-nums ${
          positive === true
            ? "text-black"
            : positive === false
              ? "text-neutral-500"
              : "text-neutral-900"
        }`}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-[10px] text-neutral-400">{sub}</p>}
    </div>
  );
}

function formatIstDate(ymd: string): string {
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
