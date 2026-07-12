"use client";

import { useMemo } from "react";
import { formatMoney } from "@/lib/format";

export type CalendarDayResult = {
  date: string; // YYYY-MM-DD
  pnl: number;
  trades?: number;
  withTrades?: number;
  winners?: number;
  losers?: number;
  winPct?: number;
  noTrade?: number;
  errors?: number;
  capitalUsed?: number;
  grossProfit?: number;
  grossLoss?: number;
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

/**
 * Weekday-only month calendar of daily results.
 * Rectangular day cells (grow with content) · full labels · click filters trades.
 */
export function DayResultCalendar({
  days,
  onDayClick,
  selectedDate,
  mode = "scan",
}: {
  days: CalendarDayResult[];
  onDayClick?: (date: string) => void;
  selectedDate?: string | null;
  mode?: "scan" | "single";
}) {
  const byDate = useMemo(() => {
    const m = new Map<string, CalendarDayResult>();
    for (const d of days) m.set(d.date, d);
    return m;
  }, [days]);

  const months = useMemo(() => {
    if (!days.length) return [] as string[];
    const set = new Set<string>();
    for (const d of days) set.add(d.date.slice(0, 7));
    return [...set].sort();
  }, [days]);

  if (!days.length) return null;

  return (
    <div className="space-y-8">
      {months.map((ym) => (
        <MonthGrid
          key={ym}
          yearMonth={ym}
          byDate={byDate}
          onDayClick={onDayClick}
          selectedDate={selectedDate}
          mode={mode}
        />
      ))}
    </div>
  );
}

function MonthGrid({
  yearMonth,
  byDate,
  onDayClick,
  selectedDate,
  mode,
}: {
  yearMonth: string;
  byDate: Map<string, CalendarDayResult>;
  onDayClick?: (date: string) => void;
  selectedDate?: string | null;
  mode: "scan" | "single";
}) {
  const [y, mo] = yearMonth.split("-").map(Number);
  const cells = buildWeekdayCells(yearMonth, byDate);

  const monthLabel = new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString(
    "en-IN",
    { month: "long", year: "numeric", timeZone: "UTC" }
  );

  let mPnl = 0;
  let mCap = 0;
  let mProfit = 0;
  let mLoss = 0;
  let mDays = 0;
  for (const d of byDate.values()) {
    if (!d.date.startsWith(yearMonth)) continue;
    mDays += 1;
    mPnl += d.pnl;
    mCap += d.capitalUsed ?? 0;
    mProfit += d.grossProfit ?? 0;
    mLoss += d.grossLoss ?? 0;
  }

  return (
    <div className="overflow-hidden rounded-3xl border border-neutral-200 bg-white">
      <div className="flex flex-col gap-2 border-b border-neutral-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <p className="text-base font-semibold tracking-tight">{monthLabel}</p>
        {mDays > 0 && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-600">
            <span>
              Session days: <strong className="text-neutral-900">{mDays}</strong>
            </span>
            <span>
              Combined P&amp;L:{" "}
              <strong className={mPnl >= 0 ? "text-emerald-800" : "text-red-700"}>
                {formatMoney(mPnl)}
              </strong>
            </span>
            <span>
              Capital used:{" "}
              <strong className="text-neutral-900">{formatMoney(mCap)}</strong>
            </span>
            <span>
              Profit made:{" "}
              <strong className="text-emerald-800">{formatMoney(mProfit)}</strong>
            </span>
            <span>
              Loss made:{" "}
              <strong className="text-red-700">{formatMoney(mLoss)}</strong>
            </span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-5 border-b border-neutral-100 bg-neutral-50">
        {WEEKDAYS.map((w) => (
          <div
            key={w}
            className="px-2 py-2.5 text-center text-xs font-medium text-neutral-600"
          >
            {w}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-5">
        {cells.map((cell, i) => {
          if (cell.kind === "pad") {
            return (
              <div
                key={`pad-${i}`}
                className="min-h-[8rem] border-b border-r border-neutral-100 bg-neutral-50/40"
              />
            );
          }

          if (cell.kind === "empty") {
            return (
              <div
                key={`empty-${cell.date}`}
                className="min-h-[8rem] border-b border-r border-neutral-100 bg-white p-3 sm:p-4"
              >
                <p className="text-sm font-medium tabular-nums text-neutral-300">
                  {cell.dayNum}
                </p>
                <p className="mt-3 text-xs text-neutral-300">No trades</p>
              </div>
            );
          }

          const d = cell.data;
          const selected = selectedDate === d.date;
          const isProfit = d.pnl > 0;
          const isLoss = d.pnl < 0;
          const bg = isProfit
            ? "bg-emerald-50"
            : isLoss
              ? "bg-red-50"
              : "bg-neutral-50";
          const ring = selected
            ? "ring-2 ring-inset ring-black"
            : isProfit
              ? "ring-1 ring-inset ring-emerald-200/80"
              : isLoss
                ? "ring-1 ring-inset ring-red-200/80"
                : "";

          const clickable = Boolean(onDayClick);
          const Tag = clickable ? "button" : "div";

          return (
            <Tag
              key={d.date}
              type={clickable ? "button" : undefined}
              onClick={clickable ? () => onDayClick?.(d.date) : undefined}
              className={`min-h-[8rem] w-full border-b border-r border-neutral-100 p-3 text-left transition sm:p-4 ${bg} ${ring} ${
                clickable ? "cursor-pointer hover:brightness-[0.98]" : ""
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-base font-semibold tabular-nums text-neutral-800 sm:text-lg">
                  {cell.dayNum}
                </span>
                <span className="text-xs text-neutral-500">
                  {WEEKDAYS[weekdayIndex(d.date)]}
                </span>
              </div>

              <div className="mt-3 space-y-2 text-xs leading-relaxed sm:text-[13px]">
                <Row
                  label="Combined P&L"
                  value={formatMoney(d.pnl)}
                  valueClass={
                    isProfit
                      ? "text-emerald-800"
                      : isLoss
                        ? "text-red-700"
                        : "text-neutral-800"
                  }
                />

                {mode === "scan" ? (
                  <>
                    <Row
                      label="Win %"
                      value={
                        d.withTrades && d.winPct != null
                          ? `${d.winPct.toFixed(0)}%`
                          : "—"
                      }
                    />
                    <Row
                      label="With trades"
                      value={
                        d.winners != null
                          ? `${d.withTrades ?? 0} (${d.winners}W/${d.losers ?? 0}L)`
                          : String(d.withTrades ?? 0)
                      }
                    />
                  </>
                ) : (
                  <>
                    <Row
                      label="Win %"
                      value={
                        d.winPct != null ? `${d.winPct.toFixed(0)}%` : "—"
                      }
                    />
                    <Row
                      label="Trades"
                      value={
                        d.winners != null
                          ? `${d.trades ?? 0} (${d.winners}W/${d.losers ?? 0}L)`
                          : String(d.trades ?? 0)
                      }
                    />
                  </>
                )}

                <div className="space-y-2 border-t border-black/5 pt-2">
                  <Row
                    label="Capital used"
                    value={formatMoney(d.capitalUsed ?? 0)}
                  />
                  <Row
                    label="Profit made"
                    value={formatMoney(d.grossProfit ?? 0)}
                    valueClass="text-emerald-800"
                  />
                  <Row
                    label="Loss made"
                    value={formatMoney(d.grossLoss ?? 0)}
                    valueClass="text-red-700"
                  />
                </div>
              </div>

              {clickable && (
                <p className="mt-3 text-[11px] text-neutral-400">
                  {selected ? "Click to clear filter" : "Click to filter trades"}
                </p>
              )}
            </Tag>
          );
        })}
      </div>
    </div>
  );
}

/** Label and value on one row — no truncation of full amounts */
function Row({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="shrink-0 text-[11px] text-neutral-500 sm:text-xs">
        {label}
      </span>
      <span
        className={`text-right text-xs font-semibold tabular-nums break-all sm:text-sm ${
          valueClass || "text-neutral-900"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function weekdayColumn(jsDow: number): number | null {
  if (jsDow === 0 || jsDow === 6) return null;
  return jsDow - 1;
}

function weekdayIndex(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  const col = weekdayColumn(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
  return col ?? 0;
}

type BuiltCell =
  | { kind: "pad" }
  | { kind: "empty"; date: string; dayNum: number }
  | { kind: "data"; date: string; dayNum: number; data: CalendarDayResult };

function buildWeekdayCells(
  yearMonth: string,
  byDate: Map<string, CalendarDayResult>
): BuiltCell[] {
  const [y, mo] = yearMonth.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const out: BuiltCell[] = [];

  for (let day = 1; day <= daysInMonth; day++) {
    const dow = new Date(Date.UTC(y, mo - 1, day)).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const col = weekdayColumn(dow)!;
    if (out.length === 0) {
      for (let i = 0; i < col; i++) out.push({ kind: "pad" });
    }
    const date = `${yearMonth}-${String(day).padStart(2, "0")}`;
    const data = byDate.get(date);
    if (data) {
      out.push({ kind: "data", date, dayNum: day, data });
    } else {
      out.push({ kind: "empty", date, dayNum: day });
    }
  }
  while (out.length % 5 !== 0) out.push({ kind: "pad" });
  return out;
}
