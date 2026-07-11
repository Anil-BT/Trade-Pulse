"use client";

import { useMemo, useState } from "react";
import { ConditionBuilder } from "./ConditionBuilder";
import { EquityChart } from "./EquityChart";
import { MetricsGrid } from "./MetricsGrid";
import { ScanReportView } from "./ScanReport";
import { TradesTable } from "./TradesTable";
import { STRATEGY_PRESETS, PRESET_OPENING_RANGE_EMA } from "@/lib/presets";
import { defaultDateRange, uid } from "@/lib/format";
import type {
  BacktestResult,
  DataSource,
  Interval,
  OptionsTradeSettings,
  ScanReport,
  StrategyConfig,
  TradeInstrument,
} from "@/lib/types";

const INTERVALS: { value: Interval; label: string }[] = [
  { value: "1m", label: "1 min" },
  { value: "5m", label: "5 min" },
  { value: "15m", label: "15 min" },
  { value: "30m", label: "30 min" },
  { value: "60m", label: "1 hour" },
  { value: "1d", label: "Daily" },
];

const POPULAR = [
  { symbol: "RELIANCE", yahoo: "RELIANCE.NS", label: "Reliance" },
  { symbol: "TCS", yahoo: "TCS.NS", label: "TCS" },
  { symbol: "INFY", yahoo: "INFY.NS", label: "Infosys" },
  { symbol: "HDFCBANK", yahoo: "HDFCBANK.NS", label: "HDFC Bank" },
  { symbol: "SBIN", yahoo: "SBIN.NS", label: "SBI" },
  { symbol: "NIFTYBEES", yahoo: "NIFTYBEES.NS", label: "Nifty BeES" },
];

export function BacktestApp() {
  const defaults = useMemo(() => defaultDateRange(30), []);
  const [symbol, setSymbol] = useState("RELIANCE");
  const [interval, setInterval] = useState<Interval>("5m");
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [source, setSource] = useState<DataSource>("yahoo");
  const [upstoxToken, setUpstoxToken] = useState("");
  const [capital, setCapital] = useState(100000);
  const [sizePct, setSizePct] = useState(100);
  const [oneTradePerDay, setOneTradePerDay] = useState(true);
  const [tradeInstrument, setTradeInstrument] =
    useState<TradeInstrument>("options_atm");
  const [optionSide, setOptionSide] = useState<"CE" | "PE">("CE");
  /** 0 = auto from NSE F&O master (RELIANCE=500, TCS=225, …) */
  const [lotSize, setLotSize] = useState(0);
  const [strikeStep, setStrikeStep] = useState(0); // 0 = auto
  const [ivPct, setIvPct] = useState(18);
  const [daysToExpiry, setDaysToExpiry] = useState(7);
  const [strategy, setStrategy] = useState<StrategyConfig>(() =>
    structuredClone(PRESET_OPENING_RANGE_EMA)
  );
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [scanReport, setScanReport] = useState<ScanReport | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [scanMaxSymbols, setScanMaxSymbols] = useState(50);
  const [scanAllFno, setScanAllFno] = useState(false);

  function applyPreset(name: string) {
    const p = STRATEGY_PRESETS.find((x) => x.name === name);
    if (p) {
      setStrategy(
        structuredClone({
          ...p,
          entry: p.entry.map((c) => ({ ...c, id: uid() })),
          exit: p.exit.map((c) => ({ ...c, id: uid() })),
        })
      );
    }
  }

  function buildOptions(): OptionsTradeSettings {
    return {
      side: optionSide,
      lotSize,
      strikeStep,
      iv: ivPct / 100,
      daysToExpiry,
    };
  }

  function validateCommon() {
    if (!from || !to) {
      throw new Error("Please select both From and To dates.");
    }
    if (from > to) {
      throw new Error("From date must be on or before To date.");
    }
    if (!strategy.entry.length) {
      throw new Error("Add at least one entry condition to the strategy.");
    }
    if (!strategy.exit.length) {
      throw new Error("Add at least one exit condition to the strategy.");
    }
  }

  async function run() {
    setLoading(true);
    setError(null);
    setResult(null);
    setScanReport(null);

    try {
      if ((source === "yahoo" || source === "upstox") && !symbol.trim()) {
        throw new Error("Please enter a stock symbol (e.g. RELIANCE or TCS).");
      }
      validateCommon();

      const requestSymbol =
        source === "yahoo" ? toYahooSymbol(symbol) : toUpstoxSymbol(symbol);

      const res = await fetch("/api/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: requestSymbol,
          interval,
          from,
          to,
          source,
          strategy,
          initialCapital: capital,
          positionSizePct: sizePct,
          oneTradePerDay,
          tradeInstrument,
          options: tradeInstrument === "options_atm" ? buildOptions() : undefined,
          upstoxAccessToken: upstoxToken || undefined,
        }),
      });

      let data: { error?: string } & Partial<BacktestResult>;
      try {
        data = await res.json();
      } catch {
        throw new Error(
          `Backtest failed (HTTP ${res.status}). Server returned an invalid response.`
        );
      }

      if (!res.ok) {
        throw new Error(
          data.error || `Backtest failed with status ${res.status}.`
        );
      }

      setResult(data as BacktestResult);
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function runFnoScan() {
    setScanning(true);
    setError(null);
    setResult(null);
    setScanReport(null);

    try {
      validateCommon();

      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to,
          interval,
          source: source === "sample" ? "yahoo" : source,
          strategy,
          initialCapital: capital,
          positionSizePct: sizePct,
          oneTradePerDay,
          tradeInstrument,
          options: tradeInstrument === "options_atm" ? buildOptions() : undefined,
          upstoxAccessToken: upstoxToken || undefined,
          maxSymbols: scanAllFno ? 400 : scanMaxSymbols,
          scanAll: scanAllFno,
          concurrency: 3,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Scan failed (${res.status})`);
      }
      setScanReport(data as ScanReport);
    } catch (e) {
      setScanReport(null);
      setError(e instanceof Error ? e.message : "F&O scan failed");
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-5 pb-24 pt-10 sm:px-8">
      <header className="mb-12 max-w-2xl">
        <p className="mb-3 text-xs font-medium tracking-[0.2em] text-neutral-500 uppercase">
          TradePulse
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-black sm:text-5xl">
          Test strategies.
          <br />
          <span className="text-neutral-400">With real history.</span>
        </h1>
        <p className="mt-5 text-base leading-relaxed text-neutral-600 sm:text-lg">
          Pull free historical candles, define rules with technical indicators,
          and see how a strategy would have performed — clean and simple.
        </p>
      </header>

      {/* Config → actions (centered form), then full-width results below */}
      <div className="space-y-10">
        <div className="mx-auto max-w-2xl space-y-8">
          <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <h2 className="mb-5 text-sm font-medium tracking-wide text-neutral-500 uppercase">
              Market data
            </h2>

            <div className="mb-5 flex flex-wrap gap-2">
              {(
                [
                  { id: "yahoo", label: "Yahoo (free)" },
                  { id: "upstox", label: "Upstox" },
                  { id: "sample", label: "Sample" },
                ] as const
              ).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSource(s.id)}
                  className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                    source === s.id
                      ? "bg-black text-white"
                      : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>

            {(source === "yahoo" || source === "upstox") && (
              <div className="space-y-4">
                <Field label="Symbol">
                  <input
                    value={symbol}
                    onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                    placeholder={
                      source === "upstox" ? "RELIANCE" : "RELIANCE or RELIANCE.NS"
                    }
                    className="field-input"
                  />
                </Field>
                <div className="flex flex-wrap gap-2">
                  {POPULAR.map((p) => {
                    const active =
                      toUpstoxSymbol(symbol) === p.symbol ||
                      symbol === p.yahoo ||
                      symbol === p.symbol;
                    return (
                      <button
                        key={p.symbol}
                        type="button"
                        onClick={() =>
                          setSymbol(source === "yahoo" ? p.yahoo : p.symbol)
                        }
                        className={`rounded-full border px-3 py-1 text-xs transition ${
                          active
                            ? "border-black bg-black text-white"
                            : "border-neutral-200 text-neutral-600 hover:border-neutral-400"
                        }`}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
                {source === "yahoo" ? (
                  <p className="text-xs text-neutral-500">
                    NSE symbols work as <code className="text-neutral-800">RELIANCE</code>{" "}
                    or <code className="text-neutral-800">RELIANCE.NS</code>. Default
                    interval is 5 min.
                  </p>
                ) : (
                  <p className="text-xs text-neutral-500">
                    Type the NSE trading symbol (e.g.{" "}
                    <code className="text-neutral-800">RELIANCE</code>). We look up the
                    Upstox instrument key for you.
                  </p>
                )}
              </div>
            )}

            {source === "upstox" && (
              <div className="mt-4 space-y-4">
                <Field label="Access token">
                  <div className="relative">
                    <input
                      type={showToken ? "text" : "password"}
                      value={upstoxToken}
                      onChange={(e) => setUpstoxToken(e.target.value)}
                      placeholder="Access token from Upstox developer app"
                      className="field-input pr-16 font-mono text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => setShowToken((v) => !v)}
                      className="absolute top-1/2 right-3 -translate-y-1/2 text-xs text-neutral-500 hover:text-black"
                    >
                      {showToken ? "Hide" : "Show"}
                    </button>
                  </div>
                </Field>
                <p className="text-xs text-neutral-500">
                  Free Upstox historical API. Paste your access token, or set{" "}
                  <code className="text-neutral-800">UPSTOX_ACCESS_TOKEN</code> in{" "}
                  <code className="text-neutral-800">.env.local</code>.
                </p>
              </div>
            )}

            {source === "sample" && (
              <p className="text-xs leading-relaxed text-neutral-500">
                Offline synthetic candles — useful when live APIs are
                rate-limited.
              </p>
            )}

            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Field label="Interval">
                <select
                  value={interval}
                  onChange={(e) => setInterval(e.target.value as Interval)}
                  className="field-input"
                >
                  {INTERVALS.map((i) => (
                    <option key={i.value} value={i.value}>
                      {i.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="From">
                <input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="field-input"
                />
              </Field>
              <Field label="To">
                <input
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="field-input"
                />
              </Field>
            </div>
          </section>

          <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <h2 className="mb-5 text-sm font-medium tracking-wide text-neutral-500 uppercase">
              Capital
            </h2>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Initial capital (₹)">
                <input
                  type="number"
                  min={1000}
                  step={1000}
                  value={capital}
                  onChange={(e) => setCapital(Number(e.target.value))}
                  className="field-input"
                />
              </Field>
              <Field label="Position size %">
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={sizePct}
                  onChange={(e) => setSizePct(Number(e.target.value))}
                  className="field-input"
                />
              </Field>
            </div>
          </section>

          <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <h2 className="mb-5 text-sm font-medium tracking-wide text-neutral-500 uppercase">
              Trade rules
            </h2>

            <div className="mb-5 flex flex-wrap gap-2">
              {(
                [
                  { id: "options_atm" as const, label: "Options (ATM)" },
                  { id: "equity" as const, label: "Equity" },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setTradeInstrument(m.id)}
                  className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                    tradeInstrument === m.id
                      ? "bg-black text-white"
                      : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>

            <label className="mb-5 flex cursor-pointer items-start gap-3 rounded-2xl border border-neutral-200 bg-neutral-50/80 p-4">
              <input
                type="checkbox"
                checked={oneTradePerDay}
                onChange={(e) => setOneTradePerDay(e.target.checked)}
                className="mt-1 h-4 w-4 accent-black"
              />
              <span>
                <span className="block text-sm font-medium text-black">
                  1 trade per day
                </span>
                <span className="mt-0.5 block text-xs text-neutral-500">
                  At most one entry each session day (after that entry/exit, no
                  more entries until the next trading day).
                </span>
              </span>
            </label>

            {tradeInstrument === "options_atm" && (
              <div className="space-y-4">
                <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4 text-xs leading-relaxed text-neutral-600">
                  <p className="font-medium text-neutral-800">
                    How options mode works
                  </p>
                  <ol className="mt-2 list-decimal space-y-1 pl-4">
                    <li>
                      <strong>Signals</strong> run only on equity (close, EMA,
                      opening range, Fib R3, …).
                    </li>
                    <li>
                      On a valid entry we buy the <strong>ATM</strong>{" "}
                      {optionSide} (strike nearest to equity close).
                    </li>
                    <li>
                      <strong>Lot size</strong> is taken from the live NSE F&amp;O
                      master (e.g. RELIANCE 500, TCS 225) unless you override.
                    </li>
                    <li>
                      Premium is estimated (Black–Scholes) — not a live option
                      quote. Research only.
                    </li>
                  </ol>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <Field label="Side">
                    <select
                      value={optionSide}
                      onChange={(e) =>
                        setOptionSide(e.target.value as "CE" | "PE")
                      }
                      className="field-input"
                    >
                      <option value="CE">Call (CE)</option>
                      <option value="PE">Put (PE)</option>
                    </select>
                  </Field>
                  <Field label="Lot size (0 = NSE F&O auto)">
                    <input
                      type="number"
                      min={0}
                      value={lotSize}
                      onChange={(e) =>
                        setLotSize(Math.max(0, Number(e.target.value) || 0))
                      }
                      className="field-input"
                      placeholder="0 = auto"
                    />
                  </Field>
                  <Field label="Strike step (0 = auto)">
                    <input
                      type="number"
                      min={0}
                      step={5}
                      value={strikeStep}
                      onChange={(e) =>
                        setStrikeStep(Math.max(0, Number(e.target.value) || 0))
                      }
                      className="field-input"
                    />
                  </Field>
                  <Field label="IV %">
                    <input
                      type="number"
                      min={5}
                      max={100}
                      value={ivPct}
                      onChange={(e) =>
                        setIvPct(
                          Math.min(100, Math.max(5, Number(e.target.value) || 18))
                        )
                      }
                      className="field-input"
                    />
                  </Field>
                  <Field label="Days to expiry (entry)">
                    <input
                      type="number"
                      min={1}
                      max={45}
                      value={daysToExpiry}
                      onChange={(e) =>
                        setDaysToExpiry(
                          Math.max(1, Number(e.target.value) || 7)
                        )
                      }
                      className="field-input"
                    />
                  </Field>
                </div>
              </div>
            )}
          </section>

          <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-medium tracking-wide text-neutral-500 uppercase">
                Strategy
              </h2>
              <select
                defaultValue={PRESET_OPENING_RANGE_EMA.name}
                onChange={(e) => applyPreset(e.target.value)}
                className="rounded-full border border-neutral-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-black"
              >
                {STRATEGY_PRESETS.map((p) => (
                  <option key={p.name} value={p.name}>
                    Preset: {p.name}
                  </option>
                ))}
              </select>
            </div>

            <Field label="Name">
              <input
                value={strategy.name}
                onChange={(e) =>
                  setStrategy((s) => ({ ...s, name: e.target.value }))
                }
                className="field-input mb-6"
              />
            </Field>

            <div className="space-y-8">
              <ConditionBuilder
                title="Entry when"
                conditions={strategy.entry}
                logic={strategy.entryLogic ?? "and"}
                onLogicChange={(entryLogic) =>
                  setStrategy((s) => ({ ...s, entryLogic }))
                }
                onChange={(entry) => setStrategy((s) => ({ ...s, entry }))}
              />
              <div className="border-t border-neutral-100" />
              <ConditionBuilder
                title="Exit when"
                conditions={strategy.exit}
                logic={strategy.exitLogic ?? "and"}
                onLogicChange={(exitLogic) =>
                  setStrategy((s) => ({ ...s, exitLogic }))
                }
                onChange={(exit) => setStrategy((s) => ({ ...s, exit }))}
              />
            </div>

            <div className="mt-6 space-y-3 rounded-2xl bg-neutral-50 p-4 text-sm text-neutral-600">
              <div>
                <p className="font-medium text-neutral-800">
                  Prev Day High (new)
                </p>
                <p className="mt-1 leading-relaxed">
                  Use condition <strong>close &gt; Prev Day High</strong> so
                  price must trade above yesterday&apos;s session high. Included
                  in preset <strong>OR + EMA20 + Fib R3 + PDH</strong>.
                </p>
              </div>
            </div>
          </section>

          <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <h2 className="mb-3 text-sm font-medium tracking-wide text-neutral-500 uppercase">
              F&amp;O universe scan
            </h2>
            <p className="mb-4 text-xs leading-relaxed text-neutral-500">
              Run the current strategy across equity F&amp;O names and build one
              report. Each stock expands to show entry/exit time &amp; price;
              stocks with no signal show <strong>No trade</strong>; failures
              show <strong>Error</strong>.
            </p>

            <label className="mb-4 flex cursor-pointer items-start gap-3 rounded-2xl border border-neutral-200 bg-neutral-50/80 p-4">
              <input
                type="checkbox"
                checked={scanAllFno}
                onChange={(e) => setScanAllFno(e.target.checked)}
                className="mt-1 h-4 w-4 accent-black"
              />
              <span>
                <span className="block text-sm font-medium text-black">
                  Run on all F&amp;O stocks
                </span>
                <span className="mt-0.5 block text-xs text-neutral-500">
                  Full NSE equity F&amp;O universe. Can take several minutes
                  (Yahoo rate limits). Uncheck to limit count below.
                </span>
              </span>
            </label>

            {!scanAllFno && (
              <div className="mb-4">
                <Field label="Max symbols">
                  <input
                    type="number"
                    min={5}
                    max={400}
                    value={scanMaxSymbols}
                    onChange={(e) =>
                      setScanMaxSymbols(
                        Math.min(400, Math.max(5, Number(e.target.value) || 50))
                      )
                    }
                    className="field-input"
                  />
                </Field>
              </div>
            )}

            <button
              type="button"
              onClick={runFnoScan}
              disabled={loading || scanning}
              className="w-full rounded-full border border-black bg-white py-3 text-sm font-medium text-black transition hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {scanning
                ? "Scanning F&O stocks… (please wait)"
                : scanAllFno
                  ? "Run all F&O report"
                  : `Run F&O report (max ${scanMaxSymbols})`}
            </button>
          </section>

          <button
            type="button"
            onClick={run}
            disabled={loading || scanning}
            className="w-full rounded-full bg-black py-3.5 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Running backtest…" : "Run backtest (single symbol)"}
          </button>
        </div>

        {/* Results below submit — full width for readable tables */}
        <div className="w-full space-y-6 border-t border-neutral-200 pt-10">
          <h2 className="text-sm font-medium tracking-wide text-neutral-500 uppercase">
            Results
          </h2>
          {(loading || scanning) && (
            <div className="flex min-h-[320px] items-center justify-center rounded-3xl border border-neutral-200 bg-white">
              <div className="text-center">
                <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-neutral-200 border-t-black" />
                <p className="text-sm text-neutral-600">
                  {scanning
                    ? "Scanning F&O universe - this can take a few minutes..."
                    : "Fetching data & running backtest..."}
                </p>
              </div>
            </div>
          )}

          {error && !loading && !scanning && (
            <div
              role="alert"
              className="rounded-3xl border border-neutral-900 bg-white p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
            >
              <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
                Backtest failed
              </p>
              <p className="mt-3 text-base font-medium tracking-tight text-black">
                Something went wrong
              </p>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-neutral-700">
                {error}
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={run}
                  className="rounded-full bg-black px-4 py-2 text-xs font-medium text-white hover:bg-neutral-800"
                >
                  Try again
                </button>
                <button
                  type="button"
                  onClick={() => setError(null)}
                  className="rounded-full border border-neutral-300 px-4 py-2 text-xs font-medium text-neutral-700 hover:border-black"
                >
                  Dismiss
                </button>
              </div>
              <p className="mt-4 text-xs text-neutral-500">
                Tips: use a trading day (Mon–Fri), widen the date range, switch
                to Sample if Yahoo is rate-limited, or add an Upstox token.
              </p>
            </div>
          )}

          {scanReport && !loading && !scanning && !error && (
            <ScanReportView
              report={scanReport}
              onClose={() => setScanReport(null)}
            />
          )}

          {result && !loading && !scanning && !error && !scanReport && (
            <>
              <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                <div className="mb-5">
                  <h2 className="text-lg font-semibold tracking-tight">
                    {result.symbol || symbol}
                  </h2>
                  <p className="text-sm text-neutral-500">
                    {strategy.name} · {result.interval} · {result.source} ·{" "}
                    {result.tradeInstrument === "options_atm"
                      ? "signals on equity → ATM options"
                      : "equity"}
                    {result.oneTradePerDay ? " · 1/day" : ""} ·{" "}
                    {result.trades.length} trades
                  </p>
                  {result.optionsMeta && (
                    <p className="mt-1 text-xs text-neutral-500">
                      {result.optionsMeta.side} · lot{" "}
                      <strong className="text-neutral-800">
                        {result.optionsMeta.lotSize}
                      </strong>
                      {result.optionsMeta.lotSource
                        ? ` (${result.optionsMeta.lotSource})`
                        : ""}
                      {result.optionsMeta.listedStrikesCount
                        ? ` · ${result.optionsMeta.listedStrikesCount} listed strikes`
                        : ""}
                      · IV {(result.optionsMeta.iv * 100).toFixed(0)}% · DTE{" "}
                      {result.optionsMeta.daysToExpiry}d
                    </p>
                  )}
                  {result.diagnostics?.note && (
                    <div
                      className={`mt-3 rounded-2xl border px-4 py-3 text-sm ${
                        result.trades.length === 0
                          ? "border-neutral-900 bg-neutral-50 text-neutral-800"
                          : "border-neutral-200 bg-neutral-50 text-neutral-600"
                      }`}
                    >
                      <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
                        {result.trades.length === 0
                          ? "No trades executed"
                          : "Note"}
                      </p>
                      <p className="mt-1 leading-relaxed">
                        {result.diagnostics.note}
                      </p>
                      {result.diagnostics.equitySignals > 0 && (
                        <p className="mt-1 text-xs text-neutral-500">
                          Equity signals: {result.diagnostics.equitySignals}
                          {result.diagnostics.skippedInsufficientCapital
                            ? ` · skipped (capital): ${result.diagnostics.skippedInsufficientCapital}`
                            : ""}
                          {result.diagnostics.minLotCost
                            ? ` · ~₹${Math.ceil(result.diagnostics.minLotCost).toLocaleString("en-IN")}/lot`
                            : ""}
                        </p>
                      )}
                    </div>
                  )}
                </div>
                <MetricsGrid metrics={result.metrics} />
              </section>

              <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                <h2 className="mb-4 text-sm font-medium tracking-wide text-neutral-500 uppercase">
                  Equity curve
                </h2>
                <EquityChart data={result.equityCurve} />
              </section>

              <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                <h2 className="mb-4 text-sm font-medium tracking-wide text-neutral-500 uppercase">
                  Trades
                </h2>
                <TradesTable trades={result.trades} />
              </section>
            </>
          )}

          {!result && !scanReport && !loading && !scanning && !error && (
            <div className="flex min-h-[200px] flex-col items-center justify-center rounded-3xl border border-dashed border-neutral-300 bg-neutral-50/50 px-8 text-center">
              <p className="text-base font-medium tracking-tight text-black">
                Results appear here
              </p>
              <p className="mt-2 max-w-sm text-sm text-neutral-500">
                Run a single-symbol backtest, or scan equity F&amp;O names for
                one combined report.
              </p>
            </div>
          )}
        </div>
      </div>

      <footer className="mt-20 border-t border-neutral-200 pt-8 text-center text-xs text-neutral-400">
        For research only. Not investment advice. Past performance ≠ future results.
      </footer>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-neutral-500">
        {label}
      </span>
      {children}
    </label>
  );
}

/** NSE trading symbol for Upstox lookup (strip Yahoo suffixes). */
function toUpstoxSymbol(s: string): string {
  return s
    .trim()
    .toUpperCase()
    .replace(/\.NS$/i, "")
    .replace(/\.BO$/i, "")
    .replace(/\.BSE$/i, "");
}

/** Yahoo symbol — add .NS for plain NSE names when missing an exchange suffix. */
function toYahooSymbol(s: string): string {
  const t = s.trim().toUpperCase();
  if (!t) return t;
  if (t.includes(".")) return t;
  // US-looking single names without dots stay as-is only if user intends US;
  // for this India-first app, bare names map to NSE.
  return `${t}.NS`;
}
