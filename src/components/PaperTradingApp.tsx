"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ConditionBuilder } from "./ConditionBuilder";
import { ScanReportView } from "./ScanReport";
import { StrategyLibrary } from "./StrategyLibrary";
import {
  STRATEGY_PRESETS,
  PRESET_OPENING_RANGE_EMA,
  PRESET_OR_EMA20_FIB_S3_PDL,
} from "@/lib/presets";
import { formatMoney, uid } from "@/lib/format";
import { sessionStatus } from "@/lib/paper/market-hours";
import { useAuth } from "@/lib/firebase/auth-context";
import type {
  EntryTimeWindow,
  Interval,
  OpenPosition,
  OptionsTradeSettings,
  ScanReport,
  StrategyConfig,
  TradeInstrument,
} from "@/lib/types";

const INTERVALS: { value: Interval; label: string }[] = [
  { value: "1m", label: "1 min" },
  { value: "5m", label: "5 min" },
  { value: "15m", label: "15 min" },
];

type StrategyPaperResult = {
  strategyName: string;
  slot: 1 | 2;
  report: ScanReport;
  openPositions: OpenPosition[];
};

type SafeSession = {
  id: string;
  status: string;
  sessionDay: string;
  startedAt: number;
  endsAt: number;
  updatedAt: number;
  lastWorkerAt?: number;
  workerNote?: string;
  lastError?: string;
  tickCount?: number;
  rotationOffset?: number;
  lastBatch?: {
    fromIndex: number;
    toIndex: number;
    universeSize: number;
    symbols: string[];
    rateLimited?: number;
    errors?: number;
  };
  report?: ScanReport | null;
  openPositions?: OpenPosition[];
  strategyResults?: StrategyPaperResult[];
  eventLog?: string[];
  config?: {
    strategy?: { name?: string };
    strategy2?: { name?: string };
  };
};

/**
 * Durable paper trading: session runs on the **server** for the whole NSE day.
 * Closing the browser or logging out does not stop it — reopen while signed in to view.
 */
export function PaperTradingApp() {
  const { user } = useAuth();
  const [upstoxToken, setUpstoxToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [barInterval, setBarInterval] = useState<Interval>("5m");
  const [capital, setCapital] = useState(100000);
  const [equityAllocPct, setEquityAllocPct] = useState(25);
  const [oneTradePerDay, setOneTradePerDay] = useState(true);
  const [maxRiskEnabled, setMaxRiskEnabled] = useState(false);
  const [maxRiskMode, setMaxRiskMode] = useState<"pct" | "amount">("pct");
  const [maxRiskPct, setMaxRiskPct] = useState(2);
  const [maxRiskAmount, setMaxRiskAmount] = useState(5000);
  const [limitEntryTimes, setLimitEntryTimes] = useState(false);
  const [entryWindow1, setEntryWindow1] = useState<EntryTimeWindow>({
    enabled: true,
    start: "09:15",
    end: "11:00",
  });
  const [entryWindow2, setEntryWindow2] = useState<EntryTimeWindow>({
    enabled: true,
    start: "13:15",
    end: "15:15",
  });
  const [tradeInstrument, setTradeInstrument] =
    useState<TradeInstrument>("options_atm");
  const [optionSide, setOptionSide] = useState<"CE" | "PE">("CE");
  const [lotSize, setLotSize] = useState(0);
  const [strikeStep, setStrikeStep] = useState(0);
  const [ivPct, setIvPct] = useState(18);
  const [daysToExpiry, setDaysToExpiry] = useState(7);
  const [strategy, setStrategy] = useState<StrategyConfig>(() =>
    structuredClone(PRESET_OPENING_RANGE_EMA)
  );
  /** Second strategy — same Upstox candles, separate paper book */
  const [dualStrategy, setDualStrategy] = useState(false);
  const [strategy2, setStrategy2] = useState<StrategyConfig>(() =>
    structuredClone(
      PRESET_OR_EMA20_FIB_S3_PDL || PRESET_OPENING_RANGE_EMA
    )
  );
  const [optionSide2, setOptionSide2] = useState<"CE" | "PE">("PE");
  const [scanMaxSymbols, setScanMaxSymbols] = useState(40);
  const [scanAllFno, setScanAllFno] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<SafeSession | null>(null);
  const [statusLine, setStatusLine] = useState(sessionStatus().label);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const running = session?.status === "running";

  async function idToken(): Promise<string | null> {
    if (!user) return null;
    try {
      return await user.getIdToken();
    } catch {
      return null;
    }
  }

  const refreshStatus = useCallback(async () => {
    const token = await idToken();
    if (!token) return;
    try {
      const res = await fetch("/api/paper/session/status", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) return;
      setSession(data.session || null);
    } catch {
      /* ignore */
    }
  }, [user]);

  // Load active session on mount / when user signs in
  useEffect(() => {
    if (!user) {
      setSession(null);
      return;
    }
    void refreshStatus();
  }, [user, refreshStatus]);

  // Poll status while session running (UI only — work is on server)
  useEffect(() => {
    if (!running || !user) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    pollRef.current = setInterval(() => {
      void refreshStatus();
    }, 8_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [running, user, refreshStatus]);

  useEffect(() => {
    const t = setInterval(() => setStatusLine(sessionStatus().label), 30_000);
    return () => clearInterval(t);
  }, []);

  function clonePreset(name: string): StrategyConfig | null {
    const p = STRATEGY_PRESETS.find((x) => x.name === name);
    if (!p) return null;
    return structuredClone({
      ...p,
      entry: p.entry.map((c) => ({ ...c, id: uid() })),
      exit: p.exit.map((c) => ({ ...c, id: uid() })),
    });
  }

  function applyPreset(name: string, slot: 1 | 2 = 1) {
    const next = clonePreset(name);
    if (!next) return;
    if (slot === 1) setStrategy(next);
    else setStrategy2(next);
  }

  function loadStrategy(s: StrategyConfig, slot: 1 | 2 = 1) {
    const next = structuredClone({
      ...s,
      entry: s.entry.map((c) => ({ ...c, id: c.id || uid() })),
      exit: s.exit.map((c) => ({ ...c, id: c.id || uid() })),
    });
    if (slot === 1) setStrategy(next);
    else setStrategy2(next);
  }

  function buildOptions(side: "CE" | "PE" = optionSide): OptionsTradeSettings {
    return {
      side,
      lotSize,
      strikeStep,
      iv: ivPct / 100,
      daysToExpiry,
    };
  }

  async function start() {
    setError(null);
    if (!user) {
      setError("Sign in (top right) so the session can keep running after you close the browser.");
      return;
    }
    const token = await idToken();
    if (!token) {
      setError("Could not get auth token — try signing in again.");
      return;
    }
    if (!strategy.entry.length || !strategy.exit.length) {
      setError("Strategy 1 needs entry and exit conditions.");
      return;
    }
    if (dualStrategy) {
      if (!strategy2.entry.length || !strategy2.exit.length) {
        setError("Strategy 2 needs entry and exit conditions (or turn dual off).");
        return;
      }
    }

    setBusy(true);
    try {
      const res = await fetch("/api/paper/session/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          upstoxAccessToken: upstoxToken || undefined,
          config: {
            strategy,
            strategy2: dualStrategy ? strategy2 : undefined,
            options2:
              dualStrategy && tradeInstrument === "options_atm"
                ? buildOptions(optionSide2)
                : undefined,
            interval: barInterval,
            initialCapital: capital,
            positionSizePct: equityAllocPct,
            oneTradePerDay,
            entryTimeWindows: limitEntryTimes
              ? [entryWindow1, entryWindow2]
              : undefined,
            maxRiskPerTrade: maxRiskEnabled
              ? {
                  enabled: true,
                  mode: maxRiskMode,
                  pct: maxRiskMode === "pct" ? maxRiskPct : undefined,
                  amount: maxRiskMode === "amount" ? maxRiskAmount : undefined,
                }
              : undefined,
            tradeInstrument,
            options:
              tradeInstrument === "options_atm"
                ? buildOptions(optionSide)
                : undefined,
            maxSymbols: scanMaxSymbols,
            scanAll: scanAllFno,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Start failed");
      await refreshStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Start failed");
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setError(null);
    const token = await idToken();
    if (!token) {
      setError("Sign in to stop the server session.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/paper/session/stop", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ sessionId: session?.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Stop failed");
      await refreshStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Stop failed");
    } finally {
      setBusy(false);
    }
  }

  const strategyResults =
    session?.strategyResults && session.strategyResults.length > 0
      ? session.strategyResults
      : session?.report
        ? [
            {
              strategyName: session.report.strategyName,
              slot: 1 as const,
              report: session.report,
              openPositions: session.openPositions || [],
            },
          ]
        : [];
  const openPositions = session?.openPositions || [];
  const eventLog = session?.eventLog || [];

  return (
    <div className="mx-auto max-w-6xl px-5 pb-24 pt-10 sm:px-8">
      <header className="mb-10 max-w-2xl">
        <p className="mb-3 text-xs font-medium tracking-[0.2em] text-neutral-500 uppercase">
          Paper trading
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-black sm:text-4xl">
          Durable server session.
          <br />
          <span className="text-neutral-400">Survives logout &amp; close.</span>
        </h1>
        <p className="mt-4 text-base leading-relaxed text-neutral-600">
          Start once while signed in — runs on the{" "}
          <strong>server until 15:30 IST</strong>. Optionally run{" "}
          <strong>two strategies</strong> on the same Upstox candles (no extra
          market-data load). Closing the browser does not stop the session.
        </p>
      </header>

      <div className="space-y-10">
        <div className="mx-auto max-w-2xl space-y-8">
          <section className="rounded-3xl border-2 border-neutral-900 bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-black">
                  {running
                    ? "Server session running"
                    : session?.status === "ended"
                      ? "Session ended"
                      : session?.status === "stopped"
                        ? "Session stopped"
                        : "No active session"}
                </p>
                <p className="mt-1 text-xs text-neutral-500">{statusLine}</p>
                {session?.workerNote && (
                  <p className="mt-0.5 text-[11px] text-neutral-600">
                    {session.workerNote}
                  </p>
                )}
                {session?.lastWorkerAt && (
                  <p className="mt-0.5 text-[11px] text-neutral-400">
                    Last server tick{" "}
                    {new Date(session.lastWorkerAt).toLocaleTimeString("en-IN")}
                    {session.tickCount != null
                      ? ` · #${session.tickCount}`
                      : ""}
                  </p>
                )}
                {session?.lastBatch && session.lastBatch.universeSize > 0 && (
                  <p className="mt-1 text-[11px] text-neutral-600">
                    Rotating universe: batch index {session.lastBatch.fromIndex}{" "}
                    · {session.lastBatch.universeSize} F&amp;O names · ~
                    {Math.ceil(session.lastBatch.universeSize / 80)} min for a
                    full pass
                    {session.lastBatch.rateLimited
                      ? ` · ${session.lastBatch.rateLimited} rate-limited (retry next cycle)`
                      : ""}
                  </p>
                )}
                {!user && (
                  <p className="mt-2 text-xs text-amber-800">
                    Sign in required to start a durable session.
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {!running ? (
                  <button
                    type="button"
                    disabled={busy || !user}
                    onClick={() => void start()}
                    className="rounded-full bg-black px-6 py-3 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
                  >
                    {busy ? "Starting…" : "Start live paper (server)"}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void stop()}
                    className="rounded-full border border-neutral-300 px-6 py-3 text-sm font-medium hover:border-black disabled:opacity-50"
                  >
                    Stop server session
                  </button>
                )}
                {user && (
                  <button
                    type="button"
                    onClick={() => void refreshStatus()}
                    className="rounded-full border border-neutral-300 px-4 py-3 text-sm font-medium hover:border-black"
                  >
                    Refresh
                  </button>
                )}
              </div>
            </div>
            {error && (
              <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-800">
                {error}
              </p>
            )}
            {session?.lastError && (
              <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">
                Worker: {session.lastError}
              </p>
            )}
          </section>

          <section className="rounded-3xl border border-neutral-200 bg-white p-6">
            <h2 className="mb-2 text-sm font-medium tracking-wide text-neutral-500 uppercase">
              Live data (Upstox)
            </h2>
            <p className="mb-4 text-xs text-neutral-500">
              Token is stored with the server session so market data continues
              after you leave. No date / single-symbol fields — F&amp;O universe
              for <strong>today</strong>.
            </p>
            <Field label="Upstox access token">
              <div className="flex gap-2">
                <input
                  type={showToken ? "text" : "password"}
                  value={upstoxToken}
                  onChange={(e) => setUpstoxToken(e.target.value)}
                  placeholder="Paste token (or server env)"
                  className="field-input flex-1"
                  disabled={running}
                />
                <button
                  type="button"
                  onClick={() => setShowToken((v) => !v)}
                  className="rounded-full border border-neutral-300 px-3 text-xs"
                >
                  {showToken ? "Hide" : "Show"}
                </button>
              </div>
            </Field>
            <div className="mt-4">
              <Field label="Bar interval">
                <select
                  value={barInterval}
                  onChange={(e) => setBarInterval(e.target.value as Interval)}
                  className="field-input"
                  disabled={running}
                >
                  {INTERVALS.map((i) => (
                    <option key={i.value} value={i.value}>
                      {i.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <label className="mt-4 flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={scanAllFno}
                disabled={running}
                onChange={(e) => setScanAllFno(e.target.checked)}
                className="mt-0.5 accent-black"
              />
              <span>
                <span className="font-medium text-neutral-800">
                  All F&amp;O — rotate through full universe
                </span>
                <span className="mt-0.5 block text-xs text-neutral-500">
                  Each minute processes ~80 names, then moves to the next 80,
                  until all ~210 have run, then wraps. Strategy still applies
                  to every F&amp;O name over a full cycle (~3 min). Rate limits
                  skip that symbol for now and retry next cycle — session keeps
                  running.
                </span>
              </span>
            </label>
            {!scanAllFno && (
              <div className="mt-3">
                <Field label="Max symbols">
                  <input
                    type="number"
                    min={5}
                    max={80}
                    disabled={running}
                    value={scanMaxSymbols}
                    onChange={(e) =>
                      setScanMaxSymbols(
                        Math.min(80, Math.max(5, Number(e.target.value) || 40))
                      )
                    }
                    className="field-input"
                  />
                </Field>
              </div>
            )}
          </section>

          <section className="rounded-3xl border border-neutral-200 bg-white p-6">
            <h2 className="mb-4 text-sm font-medium tracking-wide text-neutral-500 uppercase">
              Capital &amp; risk
            </h2>
            <div className="space-y-3">
              <Field label="Initial capital (₹)">
                <input
                  type="number"
                  value={capital}
                  disabled={running}
                  onChange={(e) => setCapital(Number(e.target.value) || 0)}
                  className="field-input"
                />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={oneTradePerDay}
                  disabled={running}
                  onChange={(e) => setOneTradePerDay(e.target.checked)}
                  className="accent-black"
                />
                1 trade per day
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={maxRiskEnabled}
                  disabled={running}
                  onChange={(e) => setMaxRiskEnabled(e.target.checked)}
                  className="accent-black"
                />
                Max risk stop
              </label>
              {maxRiskEnabled && (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={running}
                    onClick={() => setMaxRiskMode("pct")}
                    className={`rounded-full px-3 py-1 text-xs ${
                      maxRiskMode === "pct" ? "bg-black text-white" : "bg-neutral-100"
                    }`}
                  >
                    %
                  </button>
                  <button
                    type="button"
                    disabled={running}
                    onClick={() => setMaxRiskMode("amount")}
                    className={`rounded-full px-3 py-1 text-xs ${
                      maxRiskMode === "amount"
                        ? "bg-black text-white"
                        : "bg-neutral-100"
                    }`}
                  >
                    ₹
                  </button>
                  <input
                    type="number"
                    disabled={running}
                    className="field-input w-28"
                    value={maxRiskMode === "pct" ? maxRiskPct : maxRiskAmount}
                    onChange={(e) =>
                      maxRiskMode === "pct"
                        ? setMaxRiskPct(Number(e.target.value) || 1)
                        : setMaxRiskAmount(Number(e.target.value) || 1)
                    }
                  />
                </div>
              )}
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={limitEntryTimes}
                  disabled={running}
                  onChange={(e) => setLimitEntryTimes(e.target.checked)}
                  className="accent-black"
                />
                Entry time windows
              </label>
              {limitEntryTimes && (
                <div className="space-y-2">
                  <TimeWindowRow
                    label="W1"
                    window={entryWindow1}
                    onChange={setEntryWindow1}
                    disabled={running}
                  />
                  <TimeWindowRow
                    label="W2"
                    window={entryWindow2}
                    onChange={setEntryWindow2}
                    disabled={running}
                  />
                </div>
              )}
            </div>
          </section>

          <section className="rounded-3xl border border-neutral-200 bg-white p-6">
            <h2 className="mb-4 text-sm font-medium tracking-wide text-neutral-500 uppercase">
              Trade instrument
            </h2>
            <div className="mb-3 flex gap-2">
              {(
                [
                  { id: "equity" as const, label: "Equity" },
                  { id: "options_atm" as const, label: "ATM options" },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  disabled={running}
                  onClick={() => setTradeInstrument(t.id)}
                  className={`rounded-full px-4 py-2 text-sm ${
                    tradeInstrument === t.id
                      ? "bg-black text-white"
                      : "bg-neutral-100"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {tradeInstrument === "options_atm" && (
              <div className="space-y-2">
                <p className="text-xs text-neutral-500">
                  Strategy 1 option side
                </p>
                <div className="flex flex-wrap gap-2">
                  {(["CE", "PE"] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      disabled={running}
                      onClick={() => setOptionSide(s)}
                      className={`rounded-full px-4 py-2 text-sm ${
                        optionSide === s
                          ? "bg-black text-white"
                          : "bg-neutral-100"
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                  <input
                    type="number"
                    disabled={running}
                    placeholder="Lot (0=auto)"
                    value={lotSize}
                    onChange={(e) => setLotSize(Number(e.target.value) || 0)}
                    className="field-input w-28"
                  />
                </div>
              </div>
            )}
          </section>

          <section className="rounded-3xl border border-neutral-200 bg-white p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-medium tracking-wide text-neutral-500 uppercase">
                Strategies
              </h2>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-700">
                <input
                  type="checkbox"
                  checked={dualStrategy}
                  disabled={running}
                  onChange={(e) => setDualStrategy(e.target.checked)}
                  className="h-4 w-4 accent-black"
                />
                Run 2 strategies at once
              </label>
            </div>
            <p className="mb-4 text-xs text-neutral-500">
              Dual mode shares one Upstox candle fetch per symbol — no extra
              market-data cost. Each strategy keeps its own paper book.
            </p>

            {/* Strategy 1 */}
            <div className="rounded-2xl border border-neutral-200 bg-neutral-50/50 p-4">
              <p className="mb-3 text-xs font-semibold text-neutral-800">
                Strategy 1
                {tradeInstrument === "options_atm"
                  ? ` · ${optionSide}`
                  : ""}
              </p>
              <select
                className="field-input mb-3"
                disabled={running}
                value={strategy.name}
                onChange={(e) => applyPreset(e.target.value, 1)}
              >
                {STRATEGY_PRESETS.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
              <Field label="Name">
                <input
                  value={strategy.name}
                  disabled={running}
                  onChange={(e) =>
                    setStrategy((s) => ({ ...s, name: e.target.value }))
                  }
                  className="field-input mb-4"
                />
              </Field>
              <div className="space-y-6">
                <ConditionBuilder
                  title="Entry when"
                  conditions={strategy.entry}
                  logic={strategy.entryLogic ?? "and"}
                  onLogicChange={(entryLogic) =>
                    setStrategy((s) => ({ ...s, entryLogic }))
                  }
                  onChange={(entry) => setStrategy((s) => ({ ...s, entry }))}
                />
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
              <div className="mt-4">
                <StrategyLibrary
                  strategy={strategy}
                  onLoad={(s) => loadStrategy(s, 1)}
                  onRenamed={(name) => setStrategy((s) => ({ ...s, name }))}
                />
              </div>
            </div>

            {/* Strategy 2 */}
            {dualStrategy && (
              <div className="mt-4 rounded-2xl border border-neutral-900 bg-white p-4">
                <p className="mb-3 text-xs font-semibold text-neutral-800">
                  Strategy 2
                  {tradeInstrument === "options_atm"
                    ? ` · ${optionSide2}`
                    : ""}
                </p>
                {tradeInstrument === "options_atm" && (
                  <div className="mb-3 flex flex-wrap gap-2">
                    <span className="text-xs text-neutral-500 self-center">
                      Option side
                    </span>
                    {(["CE", "PE"] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        disabled={running}
                        onClick={() => setOptionSide2(s)}
                        className={`rounded-full px-3 py-1.5 text-xs ${
                          optionSide2 === s
                            ? "bg-black text-white"
                            : "bg-neutral-100"
                        }`}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}
                <select
                  className="field-input mb-3"
                  disabled={running}
                  value={strategy2.name}
                  onChange={(e) => applyPreset(e.target.value, 2)}
                >
                  {STRATEGY_PRESETS.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <Field label="Name">
                  <input
                    value={strategy2.name}
                    disabled={running}
                    onChange={(e) =>
                      setStrategy2((s) => ({ ...s, name: e.target.value }))
                    }
                    className="field-input mb-4"
                  />
                </Field>
                <div className="space-y-6">
                  <ConditionBuilder
                    title="Entry when"
                    conditions={strategy2.entry}
                    logic={strategy2.entryLogic ?? "and"}
                    onLogicChange={(entryLogic) =>
                      setStrategy2((s) => ({ ...s, entryLogic }))
                    }
                    onChange={(entry) =>
                      setStrategy2((s) => ({ ...s, entry }))
                    }
                  />
                  <ConditionBuilder
                    title="Exit when"
                    conditions={strategy2.exit}
                    logic={strategy2.exitLogic ?? "and"}
                    onLogicChange={(exitLogic) =>
                      setStrategy2((s) => ({ ...s, exitLogic }))
                    }
                    onChange={(exit) => setStrategy2((s) => ({ ...s, exit }))}
                  />
                </div>
                <div className="mt-4">
                  <StrategyLibrary
                    strategy={strategy2}
                    onLoad={(s) => loadStrategy(s, 2)}
                    onRenamed={(name) =>
                      setStrategy2((s) => ({ ...s, name }))
                    }
                  />
                </div>
              </div>
            )}
          </section>

          {eventLog.length > 0 && (
            <section className="rounded-3xl border border-neutral-200 bg-white p-5">
              <h2 className="mb-3 text-sm font-medium tracking-wide text-neutral-500 uppercase">
                Server log
              </h2>
              <ul className="max-h-48 space-y-1 overflow-y-auto font-mono text-[11px] text-neutral-600">
                {eventLog.map((line, i) => (
                  <li key={i} className="border-b border-neutral-50 py-1">
                    {line}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {openPositions.length > 0 && (
          <section className="rounded-3xl border border-neutral-200 bg-white p-6">
            <h2 className="mb-4 text-sm font-medium tracking-wide text-neutral-500 uppercase">
              Open paper positions (all strategies)
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-neutral-500 uppercase">
                    <th className="px-2 py-2 text-left">Strategy / symbol</th>
                    <th className="px-2 py-2 text-right">Entry</th>
                    <th className="px-2 py-2 text-right">Mark</th>
                    <th className="px-2 py-2 text-right">uP&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  {openPositions.map((p, i) => (
                    <tr
                      key={`${p.label || p.symbol}-${p.entryTime}-${i}`}
                      className="border-b border-neutral-100"
                    >
                      <td className="px-2 py-2 font-medium">
                        {p.label || p.symbol}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {p.entryPrice.toFixed(2)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {p.markPrice.toFixed(2)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {formatMoney(p.unrealizedPnl)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {strategyResults.map((sr) => (
          <div key={`${sr.slot}-${sr.strategyName}`} className="space-y-2">
            <p className="px-1 text-sm font-semibold text-neutral-800">
              Results · Strategy {sr.slot}: {sr.strategyName}
            </p>
            <ScanReportView
              report={sr.report}
              onClose={() => {
                /* keep session report */
              }}
            />
          </div>
        ))}
      </div>
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

function TimeWindowRow({
  label,
  window,
  onChange,
  disabled,
}: {
  label: string;
  window: EntryTimeWindow;
  onChange: (w: EntryTimeWindow) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={window.enabled}
        disabled={disabled}
        onChange={(e) => onChange({ ...window, enabled: e.target.checked })}
        className="accent-black"
      />
      <span className="w-8 text-xs text-neutral-500">{label}</span>
      <input
        type="time"
        value={window.start}
        disabled={disabled || !window.enabled}
        onChange={(e) => onChange({ ...window, start: e.target.value })}
        className="rounded-lg border px-2 py-1"
      />
      <span>–</span>
      <input
        type="time"
        value={window.end}
        disabled={disabled || !window.enabled}
        onChange={(e) => onChange({ ...window, end: e.target.value })}
        className="rounded-lg border px-2 py-1"
      />
    </div>
  );
}
