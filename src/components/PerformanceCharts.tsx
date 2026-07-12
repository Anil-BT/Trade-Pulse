"use client";

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Trade } from "@/lib/types";
import { formatMoney } from "@/lib/format";

const SESSION_START_MIN = 9 * 60 + 15; // 09:15 IST
const SESSION_END_MIN = 15 * 60 + 30; // 15:30 IST

/** Serializable filter set when a chart bar is clicked. */
export type ChartBarFilter =
  | {
      chart: "day15m";
      /** IST YYYY-MM-DD, or "" when slot applies across all days */
      dayKey: string;
      startMin: number;
      label: string;
    }
  | {
      chart: "hold";
      mode: "histogram";
      min: number;
      max: number;
      label: string;
    }
  | {
      chart: "hold";
      mode: "per-trade";
      entryTime: number;
      exitTime: number;
      pnl: number;
      label: string;
    };

export function tradeMatchesChartFilter(
  t: Trade,
  f: ChartBarFilter
): boolean {
  if (f.chart === "day15m") {
    if (f.dayKey) {
      const day = istDayKey(t.entryTime || t.exitTime);
      if (day !== f.dayKey) return false;
    }
    const m = istMinutesFromMidnight(t.entryTime);
    let slotMin = Math.floor(m / 15) * 15;
    if (slotMin < SESSION_START_MIN) slotMin = SESSION_START_MIN;
    if (slotMin >= SESSION_END_MIN) slotMin = SESSION_END_MIN - 15;
    return slotMin === f.startMin;
  }

  if (f.mode === "histogram") {
    const mins = holdMinutes(t);
    return mins >= f.min && mins < f.max;
  }

  return (
    t.entryTime === f.entryTime &&
    t.exitTime === f.exitTime &&
    Math.abs(t.pnl - f.pnl) < 0.01
  );
}

export function filterTradesByChart(
  trades: Trade[],
  f: ChartBarFilter | null
): Trade[] {
  if (!f) return trades;
  return trades.filter((t) => tradeMatchesChartFilter(t, f));
}

export function chartFilterLabel(f: ChartBarFilter): string {
  if (f.chart === "day15m") {
    if (f.dayKey) {
      return `${formatDayShort(f.dayKey)} · ${f.label} IST entry slot`;
    }
    return `All days · ${f.label} IST entry slot`;
  }
  if (f.mode === "histogram") {
    return `Hold time · ${f.label}`;
  }
  return `Hold · trade ${f.label}`;
}

/**
 * Two charts (single symbol or combined F&O universe):
 * 1) P&L by 15-minute entry slots — selected calendar day, else all days
 * 2) Hold time (entry → exit) — same day scope
 *
 * Click a bar to filter the results table below.
 */
export function PerformanceCharts({
  trades,
  title,
  subtitle,
  /** IST YYYY-MM-DD from calendar — scopes both charts to that day */
  selectedDay = null,
  activeFilter = null,
  onFilterChange,
}: {
  trades: Trade[];
  /** e.g. "Combined F&O" */
  title?: string;
  subtitle?: string;
  selectedDay?: string | null;
  activeFilter?: ChartBarFilter | null;
  onFilterChange?: (filter: ChartBarFilter | null) => void;
}) {
  const safeTrades = Array.isArray(trades) ? trades : [];

  /** Scope both charts to selected day, else all trades in range */
  const scopedTrades = useMemo(() => {
    if (!selectedDay) return safeTrades;
    return safeTrades.filter(
      (t) => istDayKey(t.entryTime || t.exitTime) === selectedDay
    );
  }, [safeTrades, selectedDay]);

  const dayChart = useMemo(
    () => buildDay15m(scopedTrades, selectedDay),
    [scopedTrades, selectedDay]
  );
  const holdChart = useMemo(
    () => buildHoldTimes(scopedTrades, scopedTrades.length > 40),
    [scopedTrades]
  );

  function selectFilter(next: ChartBarFilter) {
    if (!onFilterChange) return;
    // Toggle off if same bar clicked again
    if (
      activeFilter &&
      activeFilter.chart === next.chart &&
      activeFilter.label === next.label &&
      JSON.stringify(activeFilter) === JSON.stringify(next)
    ) {
      onFilterChange(null);
      return;
    }
    onFilterChange(next);
  }

  if (!safeTrades.length) {
    return (
      <div className="rounded-2xl border border-dashed border-neutral-300 bg-neutral-50 px-4 py-10 text-center">
        <p className="text-sm font-medium text-neutral-700">No trades to chart</p>
        <p className="mt-1 text-xs text-neutral-500">
          {subtitle ||
            "Run a backtest or F&O scan that generates trades to see charts."}
        </p>
      </div>
    );
  }

  if (selectedDay && !scopedTrades.length) {
    return (
      <div className="rounded-2xl border border-dashed border-neutral-300 bg-neutral-50 px-4 py-10 text-center">
        <p className="text-sm font-medium text-neutral-700">
          No trades on {formatDayShort(selectedDay)}
        </p>
        <p className="mt-1 text-xs text-neutral-500">
          Clear the day filter to see all days, or pick another date on the
          calendar.
        </p>
      </div>
    );
  }

  const clickable = Boolean(onFilterChange);
  const scopeNote = selectedDay
    ? formatDayShort(selectedDay)
    : dayChart.scopeLabel;

  return (
    <div className="space-y-4">
      {(title || subtitle) && (
        <div>
          {title && (
            <p className="text-sm font-semibold text-neutral-900">{title}</p>
          )}
          {subtitle && (
            <p className="mt-0.5 text-xs text-neutral-500">{subtitle}</p>
          )}
        </div>
      )}

      {activeFilter && onFilterChange && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2">
          <span className="text-xs text-neutral-600">
            Filtered by:{" "}
            <span className="font-semibold text-neutral-900">
              {chartFilterLabel(activeFilter)}
            </span>
          </span>
          <button
            type="button"
            onClick={() => onFilterChange(null)}
            className="rounded-full bg-black px-3 py-1 text-[11px] font-medium text-white hover:bg-neutral-800"
          >
            Clear filter
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Chart 1: 15-min slots — selected day or all days */}
        <div className="min-w-0 rounded-2xl border border-neutral-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-neutral-900">
            {selectedDay || dayChart.uniqueDays === 1
              ? "Every 15 min"
              : "Every 15 min — all days"}
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-neutral-500">
            {scopeNote}
            {" · "}
            {dayChart.tradeCount} trade
            {dayChart.tradeCount === 1 ? "" : "s"}
            {dayChart.uniqueDays > 1
              ? ` · ${dayChart.uniqueDays} session(s)`
              : ""}
            {dayChart.symbolCount > 1
              ? ` · ${dayChart.symbolCount} symbols`
              : ""}
            . Combined P&amp;L by entry slot
            {dayChart.uniqueDays > 1 && !selectedDay
              ? " (same clock time summed across days)"
              : ""}
            .
            {clickable ? " Click a bar to filter trades below." : ""}
          </p>
          <div className="mt-4 w-full" style={{ height: 280, minHeight: 280 }}>
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <BarChart
                data={dayChart.slots}
                margin={{ top: 8, right: 4, left: 0, bottom: 4 }}
              >
                <CartesianGrid stroke="#eee" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fill: "#a3a3a3", fontSize: 9 }}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                  minTickGap={12}
                />
                <YAxis
                  tick={{ fill: "#a3a3a3", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={48}
                  tickFormatter={(v) => shortMoney(Number(v))}
                />
                <Tooltip
                  cursor={{ fill: "#f5f5f5" }}
                  contentStyle={{
                    borderRadius: 12,
                    border: "1px solid #e5e5e5",
                    fontSize: 12,
                  }}
                  formatter={(value, _n, item) => {
                    const row = item?.payload as {
                      count?: number;
                      symbols?: number;
                    };
                    return [
                      `${formatMoney(Number(value))}${
                        row?.count
                          ? ` · ${row.count} trade${row.count > 1 ? "s" : ""}`
                          : ""
                      }${
                        row?.symbols && row.symbols > 1
                          ? ` · ${row.symbols} symbols`
                          : ""
                      }`,
                      "P&L",
                    ];
                  }}
                  labelFormatter={(label) => `${label} IST`}
                />
                <Bar
                  dataKey="pnl"
                  isAnimationActive={false}
                  maxBarSize={16}
                  radius={[2, 2, 0, 0]}
                  cursor={clickable ? "pointer" : "default"}
                  onClick={(data) => {
                    const row = barPayload(data) as {
                      label?: string;
                      startMin?: number;
                      count?: number;
                    } | null;
                    if (!row || row.startMin == null || !row.count) {
                      return;
                    }
                    selectFilter({
                      chart: "day15m",
                      // Pin to selected day when set; else slot across all days
                      dayKey: selectedDay || "",
                      startMin: row.startMin,
                      label: String(row.label ?? ""),
                    });
                  }}
                >
                  {dayChart.slots.map((d, i) => {
                    const selected =
                      activeFilter?.chart === "day15m" &&
                      activeFilter.startMin === d.startMin &&
                      (activeFilter.dayKey || "") === (selectedDay || "");
                    return (
                      <Cell
                        key={i}
                        fill={
                          d.pnl > 0
                            ? selected
                              ? "#000000"
                              : "#111111"
                            : d.pnl < 0
                              ? selected
                                ? "#525252"
                                : "#a3a3a3"
                              : "#e5e5e5"
                        }
                        opacity={
                          activeFilter && !selected && d.count > 0 ? 0.35 : 1
                        }
                        stroke={selected ? "#000" : undefined}
                        strokeWidth={selected ? 1.5 : 0}
                      />
                    );
                  })}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-2 text-[10px] tracking-wide text-neutral-400 uppercase">
            Black = profit · Grey = loss · Light = no trades
            {clickable ? " · Click bar to filter" : ""}
          </p>
        </div>

        {/* Chart 2: hold time → P/L */}
        <div className="min-w-0 rounded-2xl border border-neutral-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-neutral-900">
            Time between entry &amp; exit
            {selectedDay || dayChart.uniqueDays === 1
              ? ""
              : " — all days"}
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-neutral-500">
            {scopeNote}
            {" · "}
            {holdChart.mode === "histogram"
              ? "P&L by hold-time bucket (entry → exit)"
              : "P&L per trade (X = hold duration)"}
            {holdChart.avgLabel ? ` · avg hold ${holdChart.avgLabel}` : ""}
            {holdChart.medianLabel
              ? ` · median ${holdChart.medianLabel}`
              : ""}
            {` · ${scopedTrades.length} trade${scopedTrades.length === 1 ? "" : "s"}`}
            {clickable ? ". Click a bar to filter trades below." : "."}
          </p>
          <div className="mt-4 w-full" style={{ height: 280, minHeight: 280 }}>
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <BarChart
                data={holdChart.bars}
                margin={{ top: 8, right: 4, left: 0, bottom: 4 }}
              >
                <CartesianGrid stroke="#eee" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fill: "#a3a3a3", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  interval={
                    holdChart.mode === "histogram" ? 0 : "preserveStartEnd"
                  }
                  angle={holdChart.mode === "histogram" ? -20 : 0}
                  textAnchor={
                    holdChart.mode === "histogram" ? "end" : "middle"
                  }
                  height={holdChart.mode === "histogram" ? 50 : 30}
                />
                <YAxis
                  tick={{ fill: "#a3a3a3", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={48}
                  tickFormatter={(v) => shortMoney(Number(v))}
                />
                <Tooltip
                  cursor={{ fill: "#f5f5f5" }}
                  contentStyle={{
                    borderRadius: 12,
                    border: "1px solid #e5e5e5",
                    fontSize: 12,
                  }}
                  formatter={(value, _n, item) => {
                    const row = item?.payload as {
                      minutes?: number;
                      pnl?: number;
                      count?: number;
                      holdLabel?: string;
                    };
                    if (holdChart.mode === "histogram") {
                      return [
                        `${formatMoney(Number(value))}${
                          row?.count
                            ? ` · ${row.count} trade${row.count > 1 ? "s" : ""}`
                            : ""
                        }`,
                        "P&L",
                      ];
                    }
                    return [
                      `${formatMoney(Number(value))}${
                        row?.holdLabel ? ` · hold ${row.holdLabel}` : ""
                      }`,
                      "P&L",
                    ];
                  }}
                />
                <Bar
                  dataKey="pnl"
                  isAnimationActive={false}
                  maxBarSize={holdChart.mode === "histogram" ? 36 : 28}
                  radius={[2, 2, 0, 0]}
                  cursor={clickable ? "pointer" : "default"}
                  onClick={(data) => {
                    const row = barPayload(data) as {
                      label?: string;
                      count?: number;
                      min?: number;
                      max?: number;
                      entryTime?: number;
                      exitTime?: number;
                      pnl?: number;
                    } | null;
                    if (!row) return;
                    if (holdChart.mode === "histogram") {
                      if (!row.count || row.min == null || row.max == null)
                        return;
                      selectFilter({
                        chart: "hold",
                        mode: "histogram",
                        min: row.min,
                        max: row.max,
                        label: String(row.label ?? ""),
                      });
                      return;
                    }
                    if (row.entryTime == null || row.exitTime == null) return;
                    selectFilter({
                      chart: "hold",
                      mode: "per-trade",
                      entryTime: row.entryTime,
                      exitTime: row.exitTime,
                      pnl: Number(row.pnl ?? 0),
                      label: String(row.label ?? ""),
                    });
                  }}
                >
                  {holdChart.bars.map((d, i) => {
                    const selected =
                      activeFilter?.chart === "hold" &&
                      activeFilter.label === d.label &&
                      (activeFilter.mode === "histogram"
                        ? activeFilter.min === d.min &&
                          activeFilter.max === d.max
                        : activeFilter.entryTime === d.entryTime &&
                          activeFilter.exitTime === d.exitTime);
                    return (
                      <Cell
                        key={i}
                        fill={
                          d.pnl > 0
                            ? "#111111"
                            : d.pnl < 0
                              ? "#a3a3a3"
                              : "#e5e5e5"
                        }
                        opacity={
                          activeFilter && !selected && d.count > 0 ? 0.35 : 1
                        }
                        stroke={selected ? "#000" : undefined}
                        strokeWidth={selected ? 1.5 : 0}
                      />
                    );
                  })}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-2 text-[10px] tracking-wide text-neutral-400 uppercase">
            Y-axis = P&amp;L · Black = profit · Grey = loss
            {clickable ? " · Click bar to filter" : ""}
          </p>
        </div>
      </div>
    </div>
  );
}

/** Recharts 3 Bar onClick receives entry with original row in `.payload`. */
function barPayload(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { payload?: Record<string, unknown> };
  if (d.payload && typeof d.payload === "object") return d.payload;
  // Fallback if library passes the row directly
  if ("label" in d || "startMin" in d || "pnl" in d) {
    return d as Record<string, unknown>;
  }
  return null;
}

function shortMoney(v: number): string {
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}

function istDayKey(ms: number): string {
  const d = new Date(ms + 5.5 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function istMinutesFromMidnight(ms: number): number {
  const d = new Date(ms + 5.5 * 60 * 60 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function formatSlotLabel(minutesFromMidnight: number): string {
  const h = Math.floor(minutesFromMidnight / 60);
  const m = minutesFromMidnight % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function formatDayShort(iso: string): string {
  try {
    const [y, mo, da] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, mo - 1, da)).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return iso;
  }
}

function holdMinutes(t: Trade): number {
  const ms = Math.max(0, (t.exitTime || 0) - (t.entryTime || 0));
  let mins = ms / 60000;
  if (mins < 0.5 && t.barsHeld > 0) mins = t.barsHeld * 5;
  return Math.max(mins, 0);
}

/**
 * Aggregate P&L into 15-min entry slots for the scoped trades.
 * - selectedDay set → that day only
 * - otherwise → all days, same clock slots summed together
 */
function buildDay15m(
  trades: Trade[],
  selectedDay: string | null
): {
  scopeLabel: string;
  uniqueDays: number;
  tradeCount: number;
  symbolCount: number;
  slots: {
    label: string;
    pnl: number;
    count: number;
    symbols: number;
    startMin: number;
  }[];
} {
  if (!trades.length) {
    return {
      scopeLabel: selectedDay ? formatDayShort(selectedDay) : "No trades",
      uniqueDays: 0,
      tradeCount: 0,
      symbolCount: 0,
      slots: [],
    };
  }

  const dayKeys = new Set<string>();
  for (const t of trades) {
    dayKeys.add(istDayKey(t.entryTime || t.exitTime));
  }
  const sortedDays = [...dayKeys].sort();
  const uniqueDays = sortedDays.length;

  let scopeLabel: string;
  if (selectedDay) {
    scopeLabel = formatDayShort(selectedDay);
  } else if (uniqueDays === 1) {
    scopeLabel = formatDayShort(sortedDays[0]);
  } else if (uniqueDays > 1) {
    scopeLabel = `${formatDayShort(sortedDays[0])} – ${formatDayShort(sortedDays[uniqueDays - 1])}`;
  } else {
    scopeLabel = "All days";
  }

  const symbols = new Set(
    trades.map((t) => (t as Trade & { _symbol?: string })._symbol || "")
  );
  symbols.delete("");

  const slots: {
    label: string;
    pnl: number;
    count: number;
    symbols: number;
    startMin: number;
    _syms: Set<string>;
  }[] = [];
  for (let min = SESSION_START_MIN; min < SESSION_END_MIN; min += 15) {
    slots.push({
      label: formatSlotLabel(min),
      pnl: 0,
      count: 0,
      symbols: 0,
      startMin: min,
      _syms: new Set(),
    });
  }

  for (const t of trades) {
    const m = istMinutesFromMidnight(t.entryTime);
    let slotMin = Math.floor(m / 15) * 15;
    if (slotMin < SESSION_START_MIN) slotMin = SESSION_START_MIN;
    if (slotMin >= SESSION_END_MIN) slotMin = SESSION_END_MIN - 15;
    const slot = slots.find((s) => s.startMin === slotMin);
    if (slot) {
      slot.pnl += t.pnl;
      slot.count += 1;
      const sym = (t as Trade & { _symbol?: string })._symbol;
      if (sym) slot._syms.add(sym);
    }
  }

  const out = slots.map(({ _syms, ...rest }) => ({
    ...rest,
    pnl: Number(rest.pnl.toFixed(2)),
    symbols: _syms.size,
  }));

  return {
    scopeLabel,
    uniqueDays,
    tradeCount: trades.length,
    symbolCount: symbols.size || (trades.length ? 1 : 0),
    slots: out,
  };
}

function buildHoldTimes(
  trades: Trade[],
  useHistogram: boolean
): {
  mode: "per-trade" | "histogram";
  bars: {
    label: string;
    minutes: number;
    pnl: number;
    count: number;
    min?: number;
    max?: number;
    entryTime?: number;
    exitTime?: number;
    holdLabel?: string;
  }[];
  avgLabel: string;
  medianLabel: string;
} {
  if (!trades.length) {
    return { mode: "per-trade", bars: [], avgLabel: "", medianLabel: "" };
  }

  const minutesList = trades.map((t) => {
    const minutes = Number(holdMinutes(t).toFixed(1));
    return {
      minutes,
      pnl: t.pnl,
      entryTime: t.entryTime,
      exitTime: t.exitTime,
    };
  });

  const sorted = [...minutesList.map((m) => m.minutes)].sort((a, b) => a - b);
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const mid = sorted[Math.floor(sorted.length / 2)] ?? 0;

  if (!useHistogram) {
    return {
      mode: "per-trade",
      bars: minutesList.map((m) => ({
        label: formatHoldShort(m.minutes),
        minutes: m.minutes,
        pnl: Number(m.pnl.toFixed(2)),
        count: 1,
        entryTime: m.entryTime,
        exitTime: m.exitTime,
        holdLabel: formatHoldLabel(m.minutes),
      })),
      avgLabel: formatHoldLabel(avg),
      medianLabel: formatHoldLabel(mid),
    };
  }

  // Histogram buckets for many combined trades — Y = P/L
  const buckets = [
    { label: "0-5m", min: 0, max: 5 },
    { label: "5-15m", min: 5, max: 15 },
    { label: "15-30m", min: 15, max: 30 },
    { label: "30-60m", min: 30, max: 60 },
    { label: "1-2h", min: 60, max: 120 },
    { label: "2-3h", min: 120, max: 180 },
    { label: "3h+", min: 180, max: Infinity },
  ];

  const bars = buckets.map((b) => {
    const inB = minutesList.filter(
      (m) => m.minutes >= b.min && m.minutes < b.max
    );
    const pnl = inB.reduce((s, x) => s + x.pnl, 0);
    return {
      label: b.label,
      minutes: b.min,
      min: b.min,
      max: b.max,
      pnl: Number(pnl.toFixed(2)),
      count: inB.length,
    };
  });

  return {
    mode: "histogram",
    bars,
    avgLabel: formatHoldLabel(avg),
    medianLabel: formatHoldLabel(mid),
  };
}

function formatHoldShort(mins: number): string {
  if (mins < 60) return `${Math.round(mins)}m`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return m ? `${h}h${m}` : `${h}h`;
}

function formatHoldLabel(mins: number): string {
  if (!Number.isFinite(mins) || mins < 0) return "-";
  if (mins < 1) return "<1 min";
  if (mins < 60) return `${Math.round(mins)} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
