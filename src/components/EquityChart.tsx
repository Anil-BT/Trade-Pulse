"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { EquityPoint } from "@/lib/types";
import { formatMoney } from "@/lib/format";

export function EquityChart({ data }: { data: EquityPoint[] }) {
  if (!data.length) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-neutral-500">
        No equity data
      </div>
    );
  }

  const chartData = data.map((d) => ({
    t: d.time,
    equity: Number(d.equity.toFixed(2)),
    label: new Date(d.time).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
    }),
  }));

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#000" stopOpacity={0.12} />
              <stop offset="100%" stopColor="#000" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#eee" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: "#737373", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            minTickGap={40}
          />
          <YAxis
            tick={{ fill: "#737373", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={72}
            tickFormatter={(v) =>
              v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)
            }
          />
          <Tooltip
            contentStyle={{
              borderRadius: 12,
              border: "1px solid #e5e5e5",
              boxShadow: "none",
              fontSize: 13,
            }}
            formatter={(value) => [
              formatMoney(typeof value === "number" ? value : Number(value)),
              "Equity",
            ]}
            labelFormatter={(_, payload) => {
              const t = payload?.[0]?.payload?.t;
              return t
                ? new Date(t).toLocaleString("en-IN")
                : "";
            }}
          />
          <Area
            type="monotone"
            dataKey="equity"
            stroke="#000"
            strokeWidth={1.5}
            fill="url(#eqFill)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
