"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { STRATEGY_PRESETS } from "@/lib/presets";
import { formatTime, uid } from "@/lib/format";
import {
  parseApiJson,
  safeErrorMessage,
  sanitizeToken,
} from "@/lib/http";
import { listSavedStrategies } from "@/lib/strategy-store";
import type { Interval, StrategyConfig } from "@/lib/types";

const INTERVALS: { value: Interval; label: string }[] = [
  { value: "1m", label: "1 min" },
  { value: "5m", label: "5 min" },
  { value: "15m", label: "15 min" },
];

type WatchMatch = {
  symbol: string;
  strategyName: string;
  price: number;
  barTime: number;
  entryMatch: boolean;
  exitMatch: boolean;
  changePct?: number;
  message?: string;
};

type ScanResponse = {
  generatedAt: string;
  today: string;
  interval: string;
  strategies: string[];
  universeSize: number;
  scanned: number;
  matchCount: number;
  rateLimited?: number;
  errors?: number;
  matches: WatchMatch[];
  note?: string;
  error?: string;
};

type StrategyPick = {
  id: string;
  strategy: StrategyConfig;
  source: "preset" | "saved";
  selected: boolean;
};

function cloneStrategy(s: StrategyConfig): StrategyConfig {
  return structuredClone({
    ...s,
    entry: s.entry.map((c) => ({ ...c, id: c.id || uid() })),
    exit: s.exit.map((c) => ({ ...c, id: c.id || uid() })),
  });
}

/**
 * TradingView / TradeFinder-style multi-strategy F&O market watch.
 */
export function MarketWatchApp() {
  const [upstoxToken, setUpstoxToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [interval, setIntervalBar] = useState<Interval>("5m");
  const [maxSymbols, setMaxSymbols] = useState(40);
  const [scanAll, setScanAll] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [picks, setPicks] = useState<StrategyPick[]>(() =>
    STRATEGY_PRESETS.map((p) => ({
      id: `preset:${p.name}`,
      strategy: cloneStrategy(p),
      source: "preset" as const,
      selected:
        p.name === "VWAP Bull" ||
        p.name === "Opening Range + EMA9" ||
        p.name.includes("bullish"),
    }))
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResponse | null>(null);
  const [filterStrategy, setFilterStrategy] = useState<string>("all");
  const [filterText, setFilterText] = useState("");

  // Merge saved strategies from local library
  useEffect(() => {
    try {
      const saved = listSavedStrategies();
      if (!saved.length) return;
      setPicks((prev) => {
        const existing = new Set(prev.map((p) => p.id));
        const extra: StrategyPick[] = [];
        for (const s of saved) {
          const id = `saved:${s.id || s.name}`;
          if (existing.has(id)) continue;
          if (!s.strategy?.entry?.length) continue;
          extra.push({
            id,
            strategy: cloneStrategy({
              ...s.strategy,
              name: s.name || s.strategy.name,
            }),
            source: "saved",
            selected: false,
          });
        }
        return extra.length ? [...prev, ...extra] : prev;
      });
    } catch {
      /* ignore */
    }
  }, []);

  const selectedStrategies = useMemo(
    () => picks.filter((p) => p.selected).map((p) => p.strategy),
    [picks]
  );

  const runScan = useCallback(async () => {
    setError(null);
    if (!selectedStrategies.length) {
      setError("Select at least one strategy to watch.");
      return;
    }
    const token = sanitizeToken(upstoxToken);
    if (!token && !process.env.NEXT_PUBLIC_HAS_UPSTOX) {
      // Server may still have env token
    }

    setBusy(true);
    try {
      const res = await fetch("/api/watch/scan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          strategies: selectedStrategies,
          interval,
          upstoxAccessToken: token || undefined,
          maxSymbols,
          scanAll,
        }),
      });
      const data = await parseApiJson<ScanResponse>(res);
      if (!res.ok) throw new Error(data.error || `Scan failed (${res.status})`);
      setResult(data);
    } catch (e) {
      setError(safeErrorMessage(e) || "Scan failed");
    } finally {
      setBusy(false);
    }
  }, [selectedStrategies, upstoxToken, interval, maxSymbols, scanAll]);

  // Optional auto-refresh (like a live scanner)
  useEffect(() => {
    if (!autoRefresh || !result) return;
    const t = setInterval(() => {
      if (!busy) void runScan();
    }, 60_000);
    return () => clearInterval(t);
  }, [autoRefresh, result, busy, runScan]);

  const filteredMatches = useMemo(() => {
    if (!result?.matches) return [];
    let rows = result.matches;
    if (filterStrategy !== "all") {
      rows = rows.filter((m) => m.strategyName === filterStrategy);
    }
    const q = filterText.trim().toUpperCase();
    if (q) {
      rows = rows.filter(
        (m) =>
          m.symbol.includes(q) || m.strategyName.toUpperCase().includes(q)
      );
    }
    return rows;
  }, [result, filterStrategy, filterText]);

  const byStrategy = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of result?.matches || []) {
      map.set(m.strategyName, (map.get(m.strategyName) || 0) + 1);
    }
    return map;
  }, [result]);

  function togglePick(id: string) {
    setPicks((prev) =>
      prev.map((p) => (p.id === id ? { ...p, selected: !p.selected } : p))
    );
  }

  function selectAll(on: boolean) {
    setPicks((prev) => prev.map((p) => ({ ...p, selected: on })));
  }

  return (
    <div className="mx-auto max-w-6xl px-5 pb-24 pt-10 sm:px-8">
      <header className="mb-10 max-w-2xl">
        <p className="mb-3 text-xs font-medium tracking-[0.2em] text-neutral-500 uppercase">
          Market watch
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-black sm:text-4xl">
          Strategy scanner.
          <br />
          <span className="text-neutral-400">F&amp;O names that match now.</span>
        </h1>
        <p className="mt-4 text-base leading-relaxed text-neutral-600">
          Pick one or more strategies. We scan the equity F&amp;O universe and
          list stocks where <strong>entry conditions are true on the latest
          bar</strong> — similar to TradingView / TradeFinder scanners.
        </p>
      </header>

      <div className="grid gap-8 lg:grid-cols-[320px_1fr]">
        {/* Controls */}
        <aside className="space-y-6">
          <section className="rounded-3xl border border-neutral-200 bg-white p-5">
            <h2 className="mb-3 text-xs font-medium tracking-wide text-neutral-500 uppercase">
              Market data
            </h2>
            <label className="mb-1 block text-xs text-neutral-500">
              Upstox access token
            </label>
            <div className="flex gap-2">
              <input
                type={showToken ? "text" : "password"}
                value={upstoxToken}
                onChange={(e) => setUpstoxToken(e.target.value)}
                placeholder="Paste token (or server env)"
                className="field-input flex-1 text-sm"
              />
              <button
                type="button"
                onClick={() => setShowToken((v) => !v)}
                className="rounded-full border border-neutral-300 px-3 text-xs"
              >
                {showToken ? "Hide" : "Show"}
              </button>
            </div>

            <label className="mb-1 mt-4 block text-xs text-neutral-500">
              Interval
            </label>
            <select
              value={interval}
              onChange={(e) => setIntervalBar(e.target.value as Interval)}
              className="field-input text-sm"
            >
              {INTERVALS.map((i) => (
                <option key={i.value} value={i.value}>
                  {i.label}
                </option>
              ))}
            </select>

            <label className="mt-4 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={scanAll}
                onChange={(e) => setScanAll(e.target.checked)}
                className="mt-0.5 accent-black"
              />
              <span>
                Scan max F&amp;O batch (up to 80)
                <span className="mt-0.5 block text-xs text-neutral-500">
                  Larger scans take longer and may hit rate limits.
                </span>
              </span>
            </label>

            {!scanAll && (
              <label className="mt-3 block text-xs text-neutral-500">
                Max symbols
                <input
                  type="number"
                  min={5}
                  max={80}
                  value={maxSymbols}
                  onChange={(e) =>
                    setMaxSymbols(
                      Math.min(80, Math.max(5, Number(e.target.value) || 40))
                    )
                  }
                  className="field-input mt-1 text-sm"
                />
              </label>
            )}

            <label className="mt-4 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="accent-black"
              />
              Auto-refresh every 60s
            </label>

            <button
              type="button"
              disabled={busy || !selectedStrategies.length}
              onClick={() => void runScan()}
              className="mt-5 w-full rounded-full bg-black px-4 py-3 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
            >
              {busy ? "Scanning…" : "Run market watch"}
            </button>
            {error && (
              <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-800">
                {error}
              </p>
            )}
          </section>

          <section className="rounded-3xl border border-neutral-200 bg-white p-5">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
                Strategies
              </h2>
              <div className="flex gap-2 text-[11px]">
                <button
                  type="button"
                  onClick={() => selectAll(true)}
                  className="text-neutral-600 underline hover:text-black"
                >
                  All
                </button>
                <button
                  type="button"
                  onClick={() => selectAll(false)}
                  className="text-neutral-600 underline hover:text-black"
                >
                  None
                </button>
              </div>
            </div>
            <p className="mb-3 text-xs text-neutral-500">
              {selectedStrategies.length} selected · presets + saved library
            </p>
            <ul className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
              {picks.map((p) => (
                <li key={p.id}>
                  <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-neutral-100 px-3 py-2 hover:border-neutral-300">
                    <input
                      type="checkbox"
                      checked={p.selected}
                      onChange={() => togglePick(p.id)}
                      className="mt-1 accent-black"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-black">
                        {p.strategy.name}
                      </span>
                      <span className="text-[11px] text-neutral-500">
                        {p.source === "preset" ? "Preset" : "Saved"} ·{" "}
                        {p.strategy.entry.length} entry ·{" "}
                        {p.strategy.exit.length} exit
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        </aside>

        {/* Results */}
        <section className="min-w-0">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium tracking-wide text-neutral-500 uppercase">
                Matches
              </h2>
              {result && (
                <p className="mt-1 text-xs text-neutral-500">
                  {result.matchCount} match
                  {result.matchCount === 1 ? "" : "es"} · scanned{" "}
                  {result.scanned}/{result.universeSize} · {result.interval} ·{" "}
                  {result.today}
                  {result.generatedAt
                    ? ` · ${formatTime(Date.parse(result.generatedAt))}`
                    : ""}
                  {result.rateLimited
                    ? ` · ${result.rateLimited} rate-limited`
                    : ""}
                  {result.errors ? ` · ${result.errors} errors` : ""}
                </p>
              )}
            </div>
            {result && (
              <div className="flex flex-wrap gap-2">
                <select
                  value={filterStrategy}
                  onChange={(e) => setFilterStrategy(e.target.value)}
                  className="rounded-full border border-neutral-300 bg-white px-3 py-1.5 text-xs"
                >
                  <option value="all">All strategies</option>
                  {result.strategies.map((n) => (
                    <option key={n} value={n}>
                      {n} ({byStrategy.get(n) || 0})
                    </option>
                  ))}
                </select>
                <input
                  type="search"
                  placeholder="Filter symbol…"
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  className="w-36 rounded-full border border-neutral-300 px-3 py-1.5 text-xs"
                />
              </div>
            )}
          </div>

          {result?.note && (
            <p className="mb-3 rounded-xl bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
              {result.note}
            </p>
          )}

          {!result && !busy && (
            <div className="rounded-3xl border border-dashed border-neutral-300 bg-white px-6 py-16 text-center text-sm text-neutral-500">
              Select strategies and run market watch to list F&amp;O names
              matching entry rules on the latest bar.
            </div>
          )}

          {busy && (
            <div className="rounded-3xl border border-neutral-200 bg-white px-6 py-16 text-center text-sm text-neutral-500">
              Scanning F&amp;O universe…
            </div>
          )}

          {result && !busy && filteredMatches.length === 0 && (
            <div className="rounded-3xl border border-neutral-200 bg-white px-6 py-12 text-center text-sm text-neutral-500">
              No matches right now for the selected strategies
              {filterStrategy !== "all" || filterText
                ? " (try clearing filters)"
                : ""}
              .
            </div>
          )}

          {filteredMatches.length > 0 && (
            <div className="overflow-x-auto rounded-3xl border border-neutral-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-xs text-neutral-500 uppercase">
                    <th className="px-4 py-3 text-left">Symbol</th>
                    <th className="px-4 py-3 text-left">Strategy</th>
                    <th className="px-4 py-3 text-right">Price</th>
                    <th className="px-4 py-3 text-right">Chg%</th>
                    <th className="px-4 py-3 text-left">Bar time</th>
                    <th className="px-4 py-3 text-left">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredMatches.map((m, i) => (
                    <tr
                      key={`${m.strategyName}-${m.symbol}-${i}`}
                      className="border-b border-neutral-100 hover:bg-neutral-50/80"
                    >
                      <td className="px-4 py-3 font-semibold tabular-nums text-black">
                        {m.symbol}
                      </td>
                      <td className="px-4 py-3 text-neutral-700">
                        {m.strategyName}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {m.price.toFixed(2)}
                      </td>
                      <td
                        className={`px-4 py-3 text-right tabular-nums ${
                          (m.changePct ?? 0) >= 0
                            ? "text-black"
                            : "text-neutral-500"
                        }`}
                      >
                        {m.changePct != null
                          ? `${m.changePct >= 0 ? "+" : ""}${m.changePct.toFixed(2)}%`
                          : "—"}
                      </td>
                      <td className="px-4 py-3 text-xs whitespace-nowrap text-neutral-600">
                        {formatTime(m.barTime)}
                      </td>
                      <td className="px-4 py-3 text-xs text-neutral-500">
                        {m.exitMatch ? (
                          <span className="rounded-full bg-neutral-100 px-2 py-0.5">
                            Entry + exit both true
                          </span>
                        ) : (
                          m.message || "Entry match"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {result && byStrategy.size > 0 && (
            <div className="mt-6 flex flex-wrap gap-2">
              {[...byStrategy.entries()].map(([name, n]) => (
                <button
                  key={name}
                  type="button"
                  onClick={() =>
                    setFilterStrategy((cur) => (cur === name ? "all" : name))
                  }
                  className={`rounded-full border px-3 py-1 text-xs ${
                    filterStrategy === name
                      ? "border-black bg-black text-white"
                      : "border-neutral-300 bg-white text-neutral-700 hover:border-black"
                  }`}
                >
                  {name}: {n}
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
