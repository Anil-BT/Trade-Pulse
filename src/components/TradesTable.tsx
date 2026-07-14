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
          date range, or loosen conditions.
        </p>
      </div>
    );
  }

  const isOptions = trades.some((t) => t.instrument === "options_atm");

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[800px] text-left text-sm">
        <thead>
          <tr className="border-b border-neutral-200 text-xs font-medium tracking-wide text-neutral-500 uppercase">
            <th className="px-3 py-3 font-medium">#</th>
            {isOptions && (
              <>
                <th className="px-3 py-3 font-medium">Contract</th>
                <th className="px-3 py-3 font-medium text-right">Lot size</th>
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
            <th className="px-3 py-3 font-medium text-right">Capital used</th>
            {!isOptions && (
              <th className="px-3 py-3 font-medium text-right">Qty</th>
            )}
            {isOptions && (
              <th className="px-3 py-3 font-medium text-right">Lots</th>
            )}
            <th className="px-3 py-3 font-medium text-right">P&amp;L</th>
            <th className="px-3 py-3 font-medium text-right">%</th>
            <th className="px-3 py-3 font-medium">Exit reason</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t, i) => {
            const capitalUsed = t.capitalUsed ?? t.entryPrice * t.qty;
            return (
              <tr
                key={`${t.entryTime}-${i}`}
                className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50"
              >
                <td className="px-3 py-3 text-neutral-500">{i + 1}</td>
                {isOptions && (
                  <>
                    <td className="px-3 py-3 whitespace-nowrap text-xs font-medium">
                      {t.label || `${t.strike ?? "-"} ${t.optionSide ?? ""}`}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums font-medium">
                      {t.lotSize != null ? t.lotSize : "-"}
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
                <td className="px-3 py-3 text-right tabular-nums font-medium text-neutral-800">
                  {formatMoney(capitalUsed)}
                </td>
                {!isOptions && (
                  <td className="px-3 py-3 text-right tabular-nums">{t.qty}</td>
                )}
                {isOptions && (
                  <td className="px-3 py-3 text-right tabular-nums">
                    {t.lots ?? 1}
                    {t.lotSize ? (
                      <span className="text-neutral-400">×{t.lotSize}</span>
                    ) : null}
                  </td>
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
                <td className="px-3 py-3 text-xs whitespace-nowrap text-neutral-500">
                  {t.exitReason === "max_risk"
                    ? "Max risk stop"
                    : t.exitReason === "trail_cost"
                      ? "Trail to cost"
                      : t.exitReason === "eod"
                        ? "End of data"
                        : "Strategy"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
