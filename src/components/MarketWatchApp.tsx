"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { STRATEGY_PRESETS } from "@/lib/presets";
import { formatTime, uid } from "@/lib/format";
import {
  parseApiJson,
  safeErrorMessage,
  sanitizeToken,
} from "@/lib/http";
import {
  computeSectorStrength,
  sectorOf,
  type SectorStrength,
} from "@/lib/watch/sectors";
import { isNseSessionOpen, sessionStatus } from "@/lib/paper/market-hours";
import { useSavedStrategies } from "@/lib/hooks/use-saved-strategies";
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
  /** Realized vol annualized % */
  rvol?: number;
  message?: string;
  /** First time this symbol matched this strategy (sticky) */
  addedAt?: number;
  sector?: string;
};

/** Full-universe F&O quote (sector graph — no strategy filter). */
type WatchQuote = {
  symbol: string;
  price: number;
  barTime: number;
  changePct?: number;
};

type WatchSource = "yahoo" | "upstox";

type ScanResponse = {
  generatedAt: string;
  today: string;
  interval: string;
  source?: WatchSource;
  delayed?: boolean;
  strategies: string[];
  matchMode?: "session" | "last";
  universeSize: number;
  scanned: number;
  matchCount: number;
  quoteCount?: number;
  rateLimited?: number;
  errors?: number;
  matches: WatchMatch[];
  quotes?: WatchQuote[];
  batchSymbols?: string[];
  nextOffset?: number;
  batchSize?: number;
  batchIndex?: number;
  batchesPerCycle?: number;
  note?: string;
  error?: string;
};

type StrategyPick = {
  id: string;
  strategy: StrategyConfig;
  source: "preset" | "saved";
  selected: boolean;
};

type StickyCell = WatchMatch & {
  addedAt: number;
  sector: string;
};

function cloneStrategy(s: StrategyConfig): StrategyConfig {
  return structuredClone({
    ...s,
    entry: s.entry.map((c) => ({ ...c, id: c.id || uid() })),
    exit: s.exit.map((c) => ({ ...c, id: c.id || uid() })),
  });
}

function cellKey(m: { strategyName: string; symbol: string }) {
  return `${m.strategyName}::${m.symbol}`;
}

/** Sticky merge: never remove; only update price / % when re-seen. */
function mergeSticky(
  prev: Map<string, StickyCell>,
  batchMatches: WatchMatch[],
  now: number
): Map<string, StickyCell> {
  const next = new Map(prev);
  for (const m of batchMatches) {
    const k = cellKey(m);
    const existing = next.get(k);
    if (existing) {
      next.set(k, {
        ...existing,
        price: m.price,
        barTime: m.barTime,
        changePct: m.changePct,
        rvol: m.rvol ?? existing.rvol,
        exitMatch: m.exitMatch,
        message: m.message,
        sector: sectorOf(m.symbol),
      });
    } else {
      next.set(k, {
        ...m,
        addedAt: now,
        sector: sectorOf(m.symbol),
      });
    }
  }
  return next;
}

/** Sticky full-universe quotes for sector strength (keyed by symbol). */
function mergeQuotes(
  prev: Map<string, WatchQuote>,
  batch: WatchQuote[]
): Map<string, WatchQuote> {
  const next = new Map(prev);
  for (const q of batch) {
    const sym = String(q.symbol || "")
      .toUpperCase()
      .replace(/\.NS$/i, "");
    if (!sym) continue;
    next.set(sym, {
      symbol: sym,
      price: q.price,
      barTime: q.barTime,
      changePct: q.changePct,
    });
  }
  return next;
}

/**
 * Multi-strategy F&O scanner (sortable tables).
 * - Config strategies once; runs while market open
 * - Sticky rows: once matched, stay until cleared
 * - Sector strength bars filter the tables
 * - Click any column header to sort
 */
export function MarketWatchApp() {
  const [dataSource, setDataSource] = useState<WatchSource>("yahoo");
  const [upstoxToken, setUpstoxToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [interval, setIntervalBar] = useState<Interval>("5m");
  const [batchSize, setBatchSize] = useState(25);
  const [runOnMarketOpen, setRunOnMarketOpen] = useState(true);
  const [statusLine, setStatusLine] = useState(sessionStatus().label);

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

  /** Strategies saved from Backtest (local + cloud) */
  const { saved: savedStrategies, loading: savedLoading } =
    useSavedStrategies();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<ScanResponse | null>(null);
  const [sticky, setSticky] = useState<Map<string, StickyCell>>(() => new Map());
  /** Full F&O universe day quotes for sector graph (independent of strategies). */
  const [universeQuotes, setUniverseQuotes] = useState<Map<string, WatchQuote>>(
    () => new Map()
  );
  const [rotationOffset, setRotationOffset] = useState(0);
  const [sectorFilter, setSectorFilter] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(true);
  type SortKey =
    | "symbol"
    | "price"
    | "changePct"
    | "sector"
    | "rvol"
    | "addedAt"
    | "barTime";
  const [sortKey, setSortKey] = useState<SortKey>("changePct");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const rotationOffsetRef = useRef(0);
  const busyRef = useRef(false);
  const stickyRef = useRef(sticky);
  const selectedRef = useRef<StrategyConfig[]>([]);
  /** Strategy ids selected on previous render — detect newly checked strategies */
  const prevSelectedIdsRef = useRef<Set<string>>(new Set());
  const backfillRunningRef = useRef(false);
  const [backfillNote, setBackfillNote] = useState<string | null>(null);

  // Merge / refresh user strategies from Backtest (and keep selection)
  useEffect(() => {
    setPicks((prev) => {
      const selected = new Map(
        prev.filter((p) => p.selected).map((p) => [p.id, true] as const)
      );
      const presets: StrategyPick[] = STRATEGY_PRESETS.map((p) => {
        const id = `preset:${p.name}`;
        const was = prev.find((x) => x.id === id);
        return {
          id,
          strategy: was?.strategy ?? cloneStrategy(p),
          source: "preset" as const,
          selected: selected.has(id)
            ? true
            : was
              ? was.selected
              : p.name === "VWAP Bull" ||
                p.name === "Opening Range + EMA9" ||
                p.name.includes("bullish"),
        };
      });

      const savedPicks: StrategyPick[] = savedStrategies
        .filter((s) => s.strategy?.entry?.length)
        .map((s) => {
          const id = `saved:${s.id || s.name}`;
          return {
            id,
            strategy: cloneStrategy({
              ...s.strategy,
              name: s.name || s.strategy.name,
            }),
            source: "saved" as const,
            // Keep checked if user already selected this id
            selected: selected.has(id),
          };
        });

      return [...presets, ...savedPicks];
    });
  }, [savedStrategies]);

  const selectedStrategies = useMemo(
    () => picks.filter((p) => p.selected).map((p) => p.strategy),
    [picks]
  );

  useEffect(() => {
    selectedRef.current = selectedStrategies;
  }, [selectedStrategies]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    rotationOffsetRef.current = rotationOffset;
  }, [rotationOffset]);

  useEffect(() => {
    stickyRef.current = sticky;
  }, [sticky]);

  useEffect(() => {
    setBatchSize(dataSource === "yahoo" ? 25 : 40);
    setRotationOffset(0);
    rotationOffsetRef.current = 0;
    // New feed — rebuild universe quotes from scratch
    setUniverseQuotes(new Map());
  }, [dataSource]);

  // Market status line
  useEffect(() => {
    const t = setInterval(() => setStatusLine(sessionStatus().label), 30_000);
    return () => clearInterval(t);
  }, []);

  const runBatch = useCallback(
    async (opts?: {
      /** Force rotation offset for this request */
      offset?: number;
      /** Advance shared rotation after success (default true) */
      advance?: boolean;
      /** Override strategies for this call (defaults to current selection) */
      strategies?: StrategyConfig[];
    }): Promise<ScanResponse | null> => {
      // Always scan F&O for sector quotes; strategies optional for match tables
      const strats = opts?.strategies ?? selectedRef.current;
      if (busyRef.current) return null;

      const token = sanitizeToken(upstoxToken);
      if (dataSource === "upstox" && !token) {
        setError("Paste Upstox token or switch to Yahoo (free).");
        return null;
      }

      const offset =
        typeof opts?.offset === "number"
          ? opts.offset
          : rotationOffsetRef.current;

      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/watch/scan", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            strategies: strats,
            interval,
            source: dataSource,
            upstoxAccessToken:
              dataSource === "upstox" ? token || undefined : undefined,
            rotateUniverse: true,
            rotationOffset: offset,
            batchSize,
            /** Session mode: any bar from today's open */
            matchMode: "session",
          }),
        });
        const data = await parseApiJson<ScanResponse>(res);
        if (!res.ok) throw new Error(data.error || `Scan failed (${res.status})`);

        setMeta(data);
        const now = Date.now();
        setUniverseQuotes((prev) => mergeQuotes(prev, data.quotes || []));
        if (strats.length) {
          setSticky((prev) => mergeSticky(prev, data.matches || [], now));
        }

        if (opts?.advance !== false && typeof data.nextOffset === "number") {
          setRotationOffset(data.nextOffset);
          rotationOffsetRef.current = data.nextOffset;
        }
        return data;
      } catch (e) {
        setError(safeErrorMessage(e) || "Scan failed");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [upstoxToken, dataSource, interval, batchSize]
  );

  /**
   * Full F&O pass for newly selected strategies: match entry on any bar
   * from today's open through now, then keep normal 1-min rotation.
   */
  const runSessionBackfill = useCallback(
    async (strategyNames: string[]) => {
      if (backfillRunningRef.current) return;
      if (!strategyNames.length) return;
      backfillRunningRef.current = true;
      const label = strategyNames.join(", ");
      setBackfillNote(
        `Backfilling ${label}: scanning full F&O from today's open…`
      );
      try {
        let offset = 0;
        let covered = 0;
        let universeSize = 0;
        let guard = 0;
        const maxBatches = 40;

        while (guard < maxBatches) {
          guard += 1;
          // Wait out any in-flight scan
          while (busyRef.current) {
            await new Promise((r) => setTimeout(r, 150));
          }
          const data = await runBatch({
            offset,
            advance: true,
            strategies: selectedRef.current,
          });
          if (!data) break;

          universeSize = data.universeSize || universeSize;
          const step = data.scanned || data.batchSize || batchSize;
          covered += step;
          offset =
            typeof data.nextOffset === "number" ? data.nextOffset : offset;

          setBackfillNote(
            `Backfilling ${label}: batch ${data.batchIndex}/${data.batchesPerCycle} · ${Math.min(covered, universeSize || covered)}/${universeSize || "?"} F&O (today’s bars)`
          );

          if (
            universeSize > 0 &&
            (covered >= universeSize ||
              (data.batchesPerCycle != null &&
                data.batchIndex != null &&
                data.batchIndex >= data.batchesPerCycle))
          ) {
            break;
          }
          // Brief pause between batches (rate limits)
          await new Promise((r) =>
            setTimeout(r, dataSource === "yahoo" ? 800 : 300)
          );
        }
        setBackfillNote(
          `Backfill done for ${label} — matches use any bar from today’s open.`
        );
        window.setTimeout(() => setBackfillNote(null), 8000);
      } finally {
        backfillRunningRef.current = false;
      }
    },
    [runBatch, batchSize, dataSource]
  );

  // Detect newly selected strategies → session backfill from start of day
  useEffect(() => {
    const selectedIds = new Set(
      picks.filter((p) => p.selected).map((p) => p.id)
    );
    const newlySelected = picks.filter(
      (p) => p.selected && !prevSelectedIdsRef.current.has(p.id)
    );
    prevSelectedIdsRef.current = selectedIds;

    if (!newlySelected.length) return;

    // Drop prior rows for these strategies so table rebuilds from today’s scan
    const names = newlySelected.map((p) => p.strategy.name);
    setSticky((prev) => {
      const next = new Map(prev);
      for (const [k, v] of next) {
        if (names.includes(v.strategyName)) next.delete(k);
      }
      stickyRef.current = next;
      return next;
    });
    setRotationOffset(0);
    rotationOffsetRef.current = 0;

    void runSessionBackfill(names);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when selection set grows
  }, [picks, runSessionBackfill]);

  // Auto-run full F&O rotation (sector graph) when market open
  useEffect(() => {
    const shouldRun = () =>
      !backfillRunningRef.current &&
      (!runOnMarketOpen || isNseSessionOpen());

    if (shouldRun()) {
      void runBatch();
    }

    const t = setInterval(() => {
      if (shouldRun() && !busyRef.current) {
        void runBatch();
      } else {
        setStatusLine(sessionStatus().label);
      }
    }, 60_000);

    return () => clearInterval(t);
  }, [runOnMarketOpen, runBatch]);

  const cells = useMemo(() => [...sticky.values()], [sticky]);

  const sectorStrength: SectorStrength[] = useMemo(
    () => computeSectorStrength([...universeQuotes.values()]),
    [universeQuotes]
  );

  const quotesCovered = universeQuotes.size;

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(
        key === "symbol" || key === "sector" ? "asc" : "desc"
      );
    }
  }

  function sortRows(list: StickyCell[]): StickyCell[] {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (sortKey === "symbol" || sortKey === "sector") {
        return dir * String(av ?? "").localeCompare(String(bv ?? ""));
      }
      const an = Number(av);
      const bn = Number(bv);
      const aOk = Number.isFinite(an);
      const bOk = Number.isFinite(bn);
      if (!aOk && !bOk) return a.symbol.localeCompare(b.symbol);
      if (!aOk) return 1;
      if (!bOk) return -1;
      if (an !== bn) return dir * (an - bn);
      return a.symbol.localeCompare(b.symbol);
    });
  }

  const byStrategy = useMemo(() => {
    const map = new Map<string, StickyCell[]>();
    for (const c of cells) {
      if (sectorFilter && c.sector !== sectorFilter) continue;
      const list = map.get(c.strategyName) || [];
      list.push(c);
      map.set(c.strategyName, list);
    }
    for (const [k, list] of map) {
      map.set(k, sortRows(list));
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sort via sortKey/sortDir
  }, [cells, sectorFilter, sortKey, sortDir]);

  // Order strategy sections by selected order
  const strategyOrder = useMemo(
    () => selectedStrategies.map((s) => s.name),
    [selectedStrategies]
  );

  function togglePick(id: string) {
    setPicks((prev) =>
      prev.map((p) => (p.id === id ? { ...p, selected: !p.selected } : p))
    );
    // Backfill is triggered by the picks effect when a strategy is turned on
  }

  function clearMatches() {
    setSticky(new Map());
    stickyRef.current = new Map();
    setUniverseQuotes(new Map());
    setRotationOffset(0);
    rotationOffsetRef.current = 0;
    setSectorFilter(null);
  }

  const chartHeight = Math.max(360, sectorStrength.length * 22 + 48);

  return (
    <div className="mx-auto max-w-6xl px-5 pb-24 pt-10 sm:px-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <p className="mb-2 text-xs font-medium tracking-[0.2em] text-neutral-500 uppercase">
            Market watch
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-black sm:text-4xl">
            Live strategy watch
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-neutral-600">
            Full F&amp;O universe rotates for sector strength. When you select a
            strategy, the screener backfills the full universe using{" "}
            <strong>today’s bars from the open</strong> (not only the last bar).
            Click a sector bar to filter tables.
          </p>
          <p className="mt-2 text-xs text-neutral-500">
            {statusLine}
            {meta
              ? ` · batch ${meta.batchIndex}/${meta.batchesPerCycle} · universe ${meta.universeSize} · F&O priced ${quotesCovered}/${meta.universeSize} · ${meta.source || dataSource}`
              : quotesCovered
                ? ` · F&O priced ${quotesCovered}`
                : ""}
            {busy ? " · scanning…" : ""}
          </p>
          {backfillNote && (
            <p className="mt-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-950">
              {backfillNote}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setConfigOpen((v) => !v)}
            className="rounded-full border border-neutral-300 px-4 py-2 text-sm font-medium hover:border-black"
          >
            {configOpen ? "Hide config" : "Configure"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void runBatch()}
            className="rounded-full border border-neutral-300 px-4 py-2 text-sm font-medium hover:border-black disabled:opacity-50"
          >
            Scan now
          </button>
          <button
            type="button"
            onClick={clearMatches}
            className="rounded-full border border-neutral-300 px-4 py-2 text-sm font-medium hover:border-black"
          >
            Clear matches
          </button>
        </div>
      </header>

      {dataSource === "yahoo" && (
        <div className="mb-5 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-xs text-amber-950">
          <strong>Yahoo free / delayed</strong> — not for live trading. Switch
          to Upstox for live prices.
        </div>
      )}

      {error && (
        <p className="mb-4 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-800">
          {error}
        </p>
      )}

      {/* Config panel */}
      {configOpen && (
        <section className="mb-8 grid gap-4 rounded-3xl border border-neutral-200 bg-white p-5 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <p className="mb-2 text-xs font-medium tracking-wide text-neutral-500 uppercase">
              Data source
            </p>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  { id: "yahoo" as const, label: "Yahoo (free)" },
                  { id: "upstox" as const, label: "Upstox (live)" },
                ] as const
              ).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setDataSource(s.id)}
                  className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                    dataSource === s.id
                      ? "bg-black text-white"
                      : "bg-neutral-100 text-neutral-700"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            {dataSource === "upstox" && (
              <div className="mt-3 flex gap-2">
                <input
                  type={showToken ? "text" : "password"}
                  value={upstoxToken}
                  onChange={(e) => setUpstoxToken(e.target.value)}
                  placeholder="Upstox token"
                  className="field-input flex-1 text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowToken((v) => !v)}
                  className="rounded-full border px-3 text-xs"
                >
                  {showToken ? "Hide" : "Show"}
                </button>
              </div>
            )}
          </div>

          <div>
            <p className="mb-2 text-xs font-medium tracking-wide text-neutral-500 uppercase">
              Interval &amp; batch
            </p>
            <select
              value={interval}
              onChange={(e) => setIntervalBar(e.target.value as Interval)}
              className="field-input mb-2 text-sm"
            >
              {INTERVALS.map((i) => (
                <option key={i.value} value={i.value}>
                  {i.label}
                </option>
              ))}
            </select>
            <label className="block text-xs text-neutral-500">
              Batch / minute
              <input
                type="number"
                min={5}
                max={50}
                value={batchSize}
                onChange={(e) =>
                  setBatchSize(
                    Math.min(50, Math.max(5, Number(e.target.value) || 25))
                  )
                }
                className="field-input mt-1 text-sm"
              />
            </label>
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={runOnMarketOpen}
                onChange={(e) => setRunOnMarketOpen(e.target.checked)}
                className="accent-black"
              />
              Auto-run only in market hours (09:15–15:30 IST)
            </label>
          </div>

          <div className="sm:col-span-2 lg:col-span-1">
            <p className="mb-2 text-xs font-medium tracking-wide text-neutral-500 uppercase">
              Strategies (tables below)
            </p>
            <p className="mb-2 text-[11px] text-neutral-400">
              Presets + strategies you save in Backtest
              {savedLoading ? " · loading…" : ""}
              {!savedLoading && savedStrategies.length
                ? ` · ${savedStrategies.length} saved`
                : ""}
            </p>
            <ul className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
              {picks.map((p) => (
                <li key={p.id}>
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={p.selected}
                      onChange={() => togglePick(p.id)}
                      className="accent-black"
                    />
                    <span className="truncate font-medium">{p.strategy.name}</span>
                    <span className="text-[10px] text-neutral-400">
                      {p.source === "saved" ? "yours" : "preset"}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {!savedLoading && !savedStrategies.length && (
              <p className="mt-2 text-[11px] text-neutral-400">
                No saved strategies yet — open Backtest, edit a strategy, click{" "}
                <strong>Save</strong>.
              </p>
            )}
          </div>
        </section>
      )}

      {/* Sector strength — all sectors, full F&O universe (not strategy matches) */}
      <section className="mb-8 rounded-3xl border border-neutral-200 bg-white p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-medium tracking-wide text-neutral-500 uppercase">
              Sector strength
            </h2>
            <p className="mt-0.5 text-xs text-neutral-400">
              All sectors · avg day % from all F&amp;O stocks scanned (
              {quotesCovered} priced
              {meta?.universeSize ? ` / ${meta.universeSize}` : ""})
            </p>
          </div>
          {sectorFilter && (
            <button
              type="button"
              onClick={() => setSectorFilter(null)}
              className="text-xs font-medium text-neutral-600 underline hover:text-black"
            >
              Clear sector filter ({sectorFilter})
            </button>
          )}
        </div>
        <div
          className="w-full overflow-x-auto"
          style={{ height: chartHeight }}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              layout="vertical"
              data={sectorStrength}
              margin={{ top: 4, right: 16, left: 4, bottom: 4 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" horizontal={false} />
              <XAxis
                type="number"
                tick={{ fontSize: 11, fill: "#737373" }}
                tickFormatter={(v) => `${Number(v).toFixed(1)}%`}
              />
              <YAxis
                type="category"
                dataKey="sector"
                width={118}
                tick={{ fontSize: 10, fill: "#525252" }}
                interval={0}
              />
              <Tooltip
                formatter={(value, _n, item) => {
                  const p = item?.payload as SectorStrength | undefined;
                  const priced = p?.count ?? 0;
                  const uni = p?.universeCount ?? 0;
                  return [
                    `${Number(value ?? 0).toFixed(2)}% avg day · priced ${priced}/${uni} F&O · ↑${p?.bullish ?? 0} ↓${p?.bearish ?? 0}`,
                    "Strength",
                  ];
                }}
                labelFormatter={(l) => String(l)}
                contentStyle={{
                  fontSize: 12,
                  borderRadius: 12,
                  border: "1px solid #e5e5e5",
                }}
              />
              <Bar
                dataKey="avgChangePct"
                name="Avg day %"
                radius={[0, 4, 4, 0]}
                cursor="pointer"
                barSize={14}
                onClick={(state) => {
                  const sector =
                    state &&
                    typeof state === "object" &&
                    "sector" in state
                      ? String((state as { sector?: string }).sector || "")
                      : "";
                  if (!sector) return;
                  setSectorFilter((cur) =>
                    cur === sector ? null : sector
                  );
                }}
              >
                {sectorStrength.map((s) => (
                  <Cell
                    key={s.sector}
                    fill={
                      sectorFilter === s.sector
                        ? "#171717"
                        : s.count === 0
                          ? "#e5e5e5"
                          : s.avgChangePct >= 0
                            ? "#10b981"
                            : "#f43f5e"
                    }
                    opacity={
                      sectorFilter && sectorFilter !== s.sector ? 0.3 : 1
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-2 text-[11px] text-neutral-400">
          Horizontal scale = avg session day %. Bars use all F&amp;O stocks in
          each sector (not strategy matches) — e.g. IT has TCS/INFY/…, FMCG has
          HUL/ITC/…. Grey = none of that sector priced yet this cycle. Click a
          bar to filter match tables.
        </p>
      </section>

      {/* Sortable tables — one per strategy */}
      <div className="space-y-8">
        {strategyOrder.map((name) => {
          const list = byStrategy.get(name) || [];
          return (
            <section
              key={name}
              className="rounded-3xl border border-neutral-200 bg-white p-5"
            >
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-base font-semibold tracking-tight text-black">
                  {name}
                </h2>
                <p className="text-xs text-neutral-500">
                  {list.length} stock{list.length === 1 ? "" : "s"}
                  {sectorFilter ? ` · ${sectorFilter}` : ""}
                  {" · sticky · click headers to sort"}
                </p>
              </div>

              {list.length === 0 ? (
                <p className="py-8 text-center text-sm text-neutral-400">
                  No matches yet for this strategy
                  {sectorFilter ? ` in ${sectorFilter}` : ""}.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead>
                      <tr className="border-b border-neutral-200 text-left text-xs text-neutral-500 uppercase">
                        {(
                          [
                            { key: "symbol" as const, label: "Stock", align: "left" },
                            { key: "price" as const, label: "Price", align: "right" },
                            {
                              key: "changePct" as const,
                              label: "% chg",
                              align: "right",
                            },
                            {
                              key: "sector" as const,
                              label: "Sector",
                              align: "left",
                            },
                            { key: "rvol" as const, label: "Rvol", align: "right" },
                            {
                              key: "barTime" as const,
                              label: "Signal",
                              align: "left",
                            },
                            {
                              key: "addedAt" as const,
                              label: "Added",
                              align: "left",
                            },
                          ] as const
                        ).map((col) => {
                          const active = sortKey === col.key;
                          return (
                            <th
                              key={col.key}
                              className={`px-3 py-2.5 font-medium ${
                                col.align === "right" ? "text-right" : "text-left"
                              }`}
                            >
                              <button
                                type="button"
                                onClick={() => toggleSort(col.key)}
                                className={`inline-flex items-center gap-1 hover:text-black ${
                                  active ? "text-black" : ""
                                } ${col.align === "right" ? "ml-auto" : ""}`}
                              >
                                {col.label}
                                <span className="text-[10px] text-neutral-400">
                                  {active
                                    ? sortDir === "asc"
                                      ? "▲"
                                      : "▼"
                                    : "↕"}
                                </span>
                              </button>
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((c) => {
                        const ch = c.changePct;
                        const chCls =
                          ch == null
                            ? "text-neutral-500"
                            : ch >= 0
                              ? "text-emerald-700"
                              : "text-rose-600";
                        return (
                          <tr
                            key={cellKey(c)}
                            className="border-b border-neutral-100 hover:bg-neutral-50/80"
                          >
                            <td className="px-3 py-2.5 font-semibold text-black whitespace-nowrap">
                              {c.symbol}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-neutral-800">
                              ₹
                              {c.price.toLocaleString("en-IN", {
                                maximumFractionDigits: 2,
                                minimumFractionDigits: 2,
                              })}
                            </td>
                            <td
                              className={`px-3 py-2.5 text-right tabular-nums font-medium ${chCls}`}
                            >
                              {ch != null
                                ? `${ch >= 0 ? "+" : ""}${ch.toFixed(2)}%`
                                : "—"}
                            </td>
                            <td className="px-3 py-2.5 text-neutral-700">
                              {c.sector}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-neutral-700">
                              {c.rvol != null ? `${c.rvol.toFixed(1)}%` : "—"}
                            </td>
                            <td className="px-3 py-2.5 text-xs whitespace-nowrap text-neutral-600">
                              {c.barTime ? formatTime(c.barTime) : "—"}
                            </td>
                            <td className="px-3 py-2.5 text-xs whitespace-nowrap text-neutral-500">
                              {c.addedAt ? formatTime(c.addedAt) : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })}

        {!strategyOrder.length && (
          <div className="rounded-3xl border border-dashed border-neutral-300 bg-white px-6 py-16 text-center text-sm text-neutral-500">
            Select strategies in Configure. Watch starts automatically when the
            market is open.
          </div>
        )}
      </div>

      <p className="mt-6 text-[11px] text-neutral-400">
        Click a column header to sort (same sort applies to every strategy
        table). Selecting a strategy backfills full F&amp;O using today&apos;s
        bars from the open. Signal = first entry bar today; % chg = session day
        move; Rvol = annualized realized vol. Rows stay once matched (sticky).
      </p>
    </div>
  );
}
