"use client";

import type { Trade } from "@/lib/types";
import { formatMoney, formatPct, formatTime } from "@/lib/format";

export function TradesTable({ trades }: { trades: Trade[] }) {
  if (!trades.length) {
    return (
      <div className="space-y-2 py-8 text-center text-sm text-neutral-500">
        <p className="font-medium text-neutral-700">No trades in this period</p>
        <p>
          Price data loaded, but entry/exit rules never triggered. Try a wider
          date range, or loosen conditions (e.g. only EMA, or OR instead of AND).
        </p>
      </div>
    );
  }

  const isOptions = trades.some((t) => t.instrument === "options_atm");

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead>
          <tr className="border-b border-neutral-200 text-xs font-medium tracking-wide text-neutral-500 uppercase">
            <th className="px-3 py-3 font-medium">#</th>
            {isOptions && (
              <>
                <th className="px-3 py-3 font-medium">Contract</th>
                <th className="px-3 py-3 font-medium text-right">Strike</th>
              </>
            )}
            <th className="px-3 py-3 font-medium">Entry</th>
            <th className="px-3 py-3 font-medium">Exit</th>
            <th className="px-3 py-3 font-medium text-right">
              {isOptions ? "Prem in" : "Entry ₹"}
            </th>
            <th className="px-3 py-3 font-medium text-right">
              {isOptions ? "Prem out" : "Exit ₹"}
            </th>
            {isOptions && (
              <>
                <th className="px-3 py-3 font-medium text-right">Equity in</th>
                <th className="px-3 py-3 font-medium text-right">Equity out</th>
                <th className="px-3 py-3 font-medium text-right">Lots×size</th>
                <th className="px-3 py-3 font-medium text-right">₹/lot in</th>
              </>
            )}
            {!isOptions && (
              <th className="px-3 py-3 font-medium text-right">Qty</th>
            )}
            <th className="px-3 py-3 font-medium text-right">P&amp;L</th>
            <th className="px-3 py-3 font-medium text-right">%</th>
            <th className="px-3 py-3 font-medium text-right">Bars</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t, i) => (
            <tr
              key={`${t.entryTime}-${i}`}
              className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50"
            >
              <td className="px-3 py-3 text-neutral-500">{i + 1}</td>
              {isOptions && (
                <>
                  <td className="px-3 py-3 whitespace-nowrap text-xs font-medium">
                    {t.label ||
                      `${t.strike ?? "—"} ${t.optionSide ?? ""}`}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums font-medium">
                    {t.strike != null ? t.strike.toFixed(0) : "—"}
                    {t.underlyingEntry != null && (
                      <span className="block text-[10px] font-normal text-neutral-400">
                        spot {t.underlyingEntry.toFixed(1)}
                      </span>
                    )}
                  </td>
                </>
              )}
              <td className="px-3 py-3 whitespace-nowrap">
                {formatTime(t.entryTime)}
              </td>
              <td className="px-3 py-3 whitespace-nowrap">
                {formatTime(t.exitTime)}
              </td>
              <td className="px-3 py-3 text-right tabular-nums">
                {t.entryPrice.toFixed(2)}
              </td>
              <td className="px-3 py-3 text-right tabular-nums">
                {t.exitPrice.toFixed(2)}
              </td>
              {isOptions && (
                <>
                  <td className="px-3 py-3 text-right tabular-nums text-neutral-600">
                    {t.underlyingEntry?.toFixed(2) ?? "—"}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-neutral-600">
                    {t.underlyingExit?.toFixed(2) ?? "—"}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {t.lots ?? "—"}
                    {t.lotSize ? (
                      <span className="text-neutral-400">×{t.lotSize}</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-neutral-600">
                    {t.lotCostEntry != null ? t.lotCostEntry.toFixed(0) : "—"}
                  </td>
                </>
              )}
              {!isOptions && (
                <td className="px-3 py-3 text-right tabular-nums">{t.qty}</td>
              )}
              <td
                className={`px-3 py-3 text-right tabular-nums font-medium ${
                  t.pnl >= 0 ? "text-black" : "text-neutral-500"
                }`}
              >
                {formatMoney(t.pnl)}
              </td>
              <td className="px-3 py-3 text-right tabular-nums text-neutral-600">
                {formatPct(t.pnlPct)}
              </td>
              <td className="px-3 py-3 text-right tabular-nums text-neutral-500">
                {t.barsHeld}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
