"use client";

import type {
  Comparator,
  CompareOperand,
  Condition,
  IndicatorType,
} from "@/lib/types";
import { uid } from "@/lib/format";

const PRICE_FIELDS = ["close", "open", "high", "low", "volume"] as const;

/** End clock time for OR: 09:15 + minutes (e.g. 15 → 09:30, 30 → 09:45). */
function orEndLabel(orMinutes: number): string {
  const mins = Math.max(1, Math.floor(orMinutes || 15));
  const total = 9 * 60 + 15 + mins; // end of half-open window [09:15, end)
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `09:15–${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const INDICATORS: { value: IndicatorType; label: string; defaultPeriod: number }[] = [
  { value: "EMA", label: "EMA", defaultPeriod: 9 },
  { value: "SMA", label: "SMA", defaultPeriod: 20 },
  { value: "RSI", label: "RSI", defaultPeriod: 14 },
  { value: "ADX", label: "ADX", defaultPeriod: 14 },
  { value: "OBV", label: "OBV", defaultPeriod: 1 },
  { value: "VOL_RATIO", label: "Vol / Vol SMA (spike if ≥ 1.5)", defaultPeriod: 20 },
  { value: "VWAP", label: "VWAP (session)", defaultPeriod: 1 },
  {
    value: "OPENING_RANGE_HIGH",
    label: "Opening Range High (mins from 09:15)",
    defaultPeriod: 15,
  },
  {
    value: "OPENING_RANGE_LOW",
    label: "Opening Range Low (mins from 09:15)",
    defaultPeriod: 15,
  },
  { value: "FIB_PIVOT", label: "Fib Pivot (P)", defaultPeriod: 1 },
  { value: "FIB_PIVOT_R1", label: "Fib Pivot R1", defaultPeriod: 1 },
  { value: "FIB_PIVOT_R2", label: "Fib Pivot R2", defaultPeriod: 1 },
  { value: "FIB_PIVOT_R3", label: "Fib Pivot R3", defaultPeriod: 1 },
  { value: "FIB_PIVOT_S1", label: "Fib Pivot S1", defaultPeriod: 1 },
  { value: "FIB_PIVOT_S2", label: "Fib Pivot S2", defaultPeriod: 1 },
  { value: "FIB_PIVOT_S3", label: "Fib Pivot S3", defaultPeriod: 1 },
  { value: "PREV_DAY_HIGH", label: "Prev Day High", defaultPeriod: 1 },
  { value: "PREV_DAY_LOW", label: "Prev Day Low", defaultPeriod: 1 },
  {
    value: "BREAKOUT_HIGH",
    label: "Breakout High (max OR / Fib R3 / PDH) — set OR mins",
    defaultPeriod: 15,
  },
  {
    value: "BREAKOUT_LOW",
    label: "Breakdown Low (min OR / Fib S3 / PDL) — set OR mins",
    defaultPeriod: 15,
  },
];

function isSessionLevelIndicator(type: IndicatorType): boolean {
  return (
    type === "VWAP" ||
    type === "OBV" ||
    type.startsWith("OPENING") ||
    type.startsWith("FIB_PIVOT") ||
    type === "PREV_DAY_HIGH" ||
    type === "PREV_DAY_LOW" ||
    type === "BREAKOUT_HIGH" ||
    type === "BREAKOUT_LOW"
  );
}

const OPS: { value: Comparator; label: string }[] = [
  { value: "gt", label: ">" },
  { value: "gte", label: "≥" },
  { value: "lt", label: "<" },
  { value: "lte", label: "≤" },
  { value: "cross_above", label: "crosses above" },
  { value: "cross_below", label: "crosses below" },
  { value: "rising", label: "is rising" },
  { value: "falling", label: "is falling" },
];

type RightMode = "price" | "indicator" | "number";

function operandMode(op: CompareOperand | number): RightMode {
  if (typeof op === "number") return "number";
  if (typeof op === "string") return "price";
  return "indicator";
}

interface Props {
  title: string;
  conditions: Condition[];
  logic: "and" | "or";
  onLogicChange: (l: "and" | "or") => void;
  onChange: (conditions: Condition[]) => void;
}

export function ConditionBuilder({
  title,
  conditions,
  logic,
  onLogicChange,
  onChange,
}: Props) {
  function update(i: number, next: Condition) {
    const copy = [...conditions];
    copy[i] = next;
    onChange(copy);
  }

  function remove(i: number) {
    onChange(conditions.filter((_, idx) => idx !== i));
  }

  function add() {
    onChange([
      ...conditions,
      {
        id: uid(),
        left: "close",
        op: "gt",
        right: { indicator: "EMA", period: 9 },
      },
    ]);
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium tracking-wide text-neutral-500 uppercase">
          {title}
        </h3>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-neutral-500">Match</span>
          <select
            value={logic}
            onChange={(e) => onLogicChange(e.target.value as "and" | "or")}
            className="rounded-full border border-neutral-300 bg-white px-3 py-1 text-sm outline-none focus:border-black"
          >
            <option value="and">ALL (AND)</option>
            <option value="or">ANY (OR)</option>
          </select>
        </div>
      </div>

      <div className="space-y-3">
        {conditions.map((c, i) => (
          <ConditionRow
            key={c.id}
            condition={c}
            onChange={(next) => update(i, next)}
            onRemove={() => remove(i)}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={add}
        className="text-sm font-medium text-black underline-offset-4 hover:underline"
      >
        + Add condition
      </button>
    </section>
  );
}

function ConditionRow({
  condition,
  onChange,
  onRemove,
}: {
  condition: Condition;
  onChange: (c: Condition) => void;
  onRemove: () => void;
}) {
  const leftMode = operandMode(condition.left);
  const rightMode = operandMode(condition.right);
  const unary = condition.op === "rising" || condition.op === "falling";

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-neutral-200 bg-neutral-50/50 p-3">
      <OperandSelect
        value={condition.left}
        allowNumber={false}
        onChange={(left) => onChange({ ...condition, left: left as CompareOperand })}
      />
      <select
        value={condition.op}
        onChange={(e) => {
          const op = e.target.value as Comparator;
          onChange({
            ...condition,
            op,
            // rising/falling ignore right — keep a placeholder number
            right:
              op === "rising" || op === "falling" ? 0 : condition.right,
          });
        }}
        className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-black"
      >
        {OPS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {unary ? (
        <span className="text-xs text-neutral-400">(vs previous bar)</span>
      ) : (
        <OperandSelect
          value={condition.right}
          allowNumber
          onChange={(right) => onChange({ ...condition, right })}
        />
      )}
      <button
        type="button"
        onClick={onRemove}
        className="ml-auto rounded-full px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-200 hover:text-black"
        aria-label="Remove condition"
      >
        Remove
      </button>
      <span className="sr-only">
        {leftMode}/{rightMode}
      </span>
    </div>
  );
}

function OperandSelect({
  value,
  allowNumber,
  onChange,
}: {
  value: CompareOperand | number;
  allowNumber: boolean;
  onChange: (v: CompareOperand | number) => void;
}) {
  const mode = operandMode(value);

  function setMode(m: RightMode) {
    if (m === "price") onChange("close");
    else if (m === "number") onChange(0);
    else onChange({ indicator: "EMA", period: 9 });
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <select
        value={mode}
        onChange={(e) => setMode(e.target.value as RightMode)}
        className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-black"
      >
        <option value="price">Price</option>
        <option value="indicator">Indicator</option>
        {allowNumber && <option value="number">Number</option>}
      </select>

      {mode === "price" && typeof value === "string" && (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value as CompareOperand)}
          className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-black"
        >
          {PRICE_FIELDS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      )}

      {mode === "indicator" && typeof value === "object" && (
        <>
          <select
            value={value.indicator}
            onChange={(e) => {
              const ind = e.target.value as IndicatorType;
              const meta = INDICATORS.find((x) => x.value === ind)!;
              onChange({ indicator: ind, period: meta.defaultPeriod });
            }}
            className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-black"
          >
            {INDICATORS.map((ind) => (
              <option key={ind.value} value={ind.value}>
                {ind.label}
              </option>
            ))}
          </select>
          {/* Period: EMA/SMA/RSI bars; OR + breakout = minutes from 09:15 IST */}
          {(value.indicator === "EMA" ||
            value.indicator === "SMA" ||
            value.indicator === "RSI" ||
            value.indicator === "ADX" ||
            value.indicator === "VOL_RATIO" ||
            value.indicator.startsWith("OPENING") ||
            value.indicator === "BREAKOUT_HIGH" ||
            value.indicator === "BREAKOUT_LOW") && (
            <>
              <input
                type="number"
                min={1}
                max={
                  value.indicator.startsWith("OPENING") ||
                  value.indicator === "BREAKOUT_HIGH" ||
                  value.indicator === "BREAKOUT_LOW"
                    ? 240
                    : 500
                }
                step={1}
                value={
                  value.period ??
                  (value.indicator === "RSI" || value.indicator === "ADX"
                    ? 14
                    : value.indicator === "VOL_RATIO"
                      ? 20
                      : value.indicator.startsWith("OPENING") ||
                          value.indicator === "BREAKOUT_HIGH" ||
                          value.indicator === "BREAKOUT_LOW"
                        ? 15
                        : 9)
                }
                onChange={(e) => {
                  const raw = Number(e.target.value) || 1;
                  const isOrMins =
                    value.indicator.startsWith("OPENING") ||
                    value.indicator === "BREAKOUT_HIGH" ||
                    value.indicator === "BREAKOUT_LOW";
                  onChange({
                    ...value,
                    period: isOrMins
                      ? Math.min(240, Math.max(1, Math.floor(raw)))
                      : Math.max(1, raw),
                  });
                }}
                className="w-16 rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-black"
                title={
                  value.indicator.startsWith("OPENING") ||
                  value.indicator === "BREAKOUT_HIGH" ||
                  value.indicator === "BREAKOUT_LOW"
                    ? "Opening range minutes from 09:15 IST. 15 → 09:15–09:30, 30 → 09:15–09:45, 45 → 09:15–10:00"
                    : value.indicator === "VOL_RATIO"
                      ? "Volume SMA period"
                      : value.indicator === "RSI"
                        ? "RSI period"
                        : "Period"
                }
              />
              {(value.indicator.startsWith("OPENING") ||
                value.indicator === "BREAKOUT_HIGH" ||
                value.indicator === "BREAKOUT_LOW") && (
                <span className="text-[10px] whitespace-nowrap text-neutral-500">
                  OR mins from 09:15 → {orEndLabel(value.period ?? 15)}
                </span>
              )}
            </>
          )}
          {isSessionLevelIndicator(value.indicator) &&
            value.indicator !== "OPENING_RANGE_HIGH" &&
            value.indicator !== "OPENING_RANGE_LOW" &&
            value.indicator !== "BREAKOUT_HIGH" &&
            value.indicator !== "BREAKOUT_LOW" && (
              <span className="text-[10px] text-neutral-400">session</span>
            )}
        </>
      )}

      {mode === "number" && typeof value === "number" && (
        <input
          type="number"
          step="any"
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-24 rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-black"
        />
      )}
    </div>
  );
}
