"use client";

import type { BacktestMetrics } from "@/lib/types";
import { formatMoney, formatPct } from "@/lib/format";

export function MetricsGrid({ metrics }: { metrics: BacktestMetrics }) {
  const ratio = metrics.riskRewardRatio ?? 0;
  const rrDisplay =
    !Number.isFinite(ratio) || ratio >= 999 ? "∞" : ratio.toFixed(2);

  const hero = [
    {
      label: "Net P&L",
      value: formatMoney(metrics.totalPnl),
      sub: formatPct(metrics.totalPnlPct),
      positive: metrics.totalPnl >= 0,
    },
    {
      label: "Win percentage",
      value: `${metrics.winRate.toFixed(1)}%`,
      sub: `${metrics.winners}W / ${metrics.losers}L`,
    },
    {
      label: "Risk : Reward ratio",
      value: rrDisplay === "∞" ? "∞" : `${rrDisplay} : 1`,
      sub:
        metrics.avgLoss !== 0
          ? `avg reward ${formatMoney(metrics.avgWin)} · avg risk ${formatMoney(Math.abs(metrics.avgLoss))}`
          : metrics.avgWin > 0
            ? "no losing trades (infinite R:R)"
            : "n/a",
    },
    {
      label: "Total capital used",
      value: formatMoney(metrics.totalCapitalUsed ?? 0),
      sub: `avg ${formatMoney(metrics.avgCapitalUsed ?? 0)} / trade · max ${formatMoney(metrics.maxCapitalUsed ?? 0)}`,
    },
  ];

  const rest = [
    {
      label: "Trades",
      value: String(metrics.totalTrades),
      sub: `avg P&L ${formatMoney(metrics.avgPnl)}`,
    },
    {
      label: "Final equity",
      value: formatMoney(metrics.finalEquity),
      sub: `pool ${formatMoney(metrics.initialCapital)}`,
    },
    {
      label: "Profit factor",
      value:
        metrics.profitFactor >= 999 ? "∞" : metrics.profitFactor.toFixed(2),
      sub: `avg win ${formatMoney(metrics.avgWin)}`,
    },
    {
      label: "Max drawdown",
      value: formatMoney(metrics.maxDrawdown),
      sub: formatPct(-Math.abs(metrics.maxDrawdownPct)),
      positive: false as boolean | undefined,
    },
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {hero.map((item) => (
          <div
            key={item.label}
            className="rounded-2xl border-2 border-neutral-900 bg-white p-4 sm:p-5"
          >
            <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
              {item.label}
            </p>
            <p
              className={`mt-2 text-2xl font-semibold tracking-tight tabular-nums ${
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

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {rest.map((item) => (
          <div
            key={item.label}
            className="rounded-2xl border border-neutral-200 bg-white p-4"
          >
            <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
              {item.label}
            </p>
            <p
              className={`mt-2 text-lg font-semibold tracking-tight tabular-nums ${
                item.positive === false ? "text-neutral-600" : "text-black"
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
    </div>
  );
}
