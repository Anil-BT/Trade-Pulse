"use client";

import type { BacktestMetrics } from "@/lib/types";
import { formatMoney, formatPct } from "@/lib/format";

export function MetricsGrid({ metrics }: { metrics: BacktestMetrics }) {
  const items = [
    {
      label: "Net P&L",
      value: formatMoney(metrics.totalPnl),
      sub: formatPct(metrics.totalPnlPct),
      positive: metrics.totalPnl >= 0,
    },
    {
      label: "Final equity",
      value: formatMoney(metrics.finalEquity),
      sub: `from ${formatMoney(metrics.initialCapital)}`,
    },
    {
      label: "Win rate",
      value: `${metrics.winRate.toFixed(1)}%`,
      sub: `${metrics.winners}W / ${metrics.losers}L`,
    },
    {
      label: "Trades",
      value: String(metrics.totalTrades),
      sub: `avg ${formatMoney(metrics.avgPnl)}`,
    },
    {
      label: "Profit factor",
      value:
        metrics.profitFactor >= 999
          ? "∞"
          : metrics.profitFactor.toFixed(2),
      sub: `avg win ${formatMoney(metrics.avgWin)}`,
    },
    {
      label: "Max drawdown",
      value: formatMoney(metrics.maxDrawdown),
      sub: formatPct(-Math.abs(metrics.maxDrawdownPct)),
      positive: false,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {items.map((item) => (
        <div
          key={item.label}
          className="rounded-2xl border border-neutral-200 bg-white p-4"
        >
          <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
            {item.label}
          </p>
          <p
            className={`mt-2 text-xl font-semibold tracking-tight ${
              item.positive === true
                ? "text-black"
                : item.positive === false
                  ? "text-neutral-600"
                  : "text-black"
            }`}
          >
            {item.value}
          </p>
          {item.sub && (
            <p className="mt-1 text-xs text-neutral-500">{item.sub}</p>
          )}
        </div>
      ))}
    </div>
  );
}
