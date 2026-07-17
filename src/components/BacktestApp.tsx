"use client";

import { useMemo, useRef, useState } from "react";
import { ConditionBuilder } from "./ConditionBuilder";
import { BacktestReport } from "./BacktestReport";
import {
  PerformanceCharts,
  filterTradesByChart,
  type ChartBarFilter,
} from "./PerformanceCharts";
import { ScanReportView } from "./ScanReport";
import { StrategyLibrary } from "./StrategyLibrary";
import { TradesTable } from "./TradesTable";
import {
  STRATEGY_PRESETS,
  PRESET_OPENING_RANGE_EMA,
  PRESET_SECTOR_OR_EMA20_VWAP_FIB_BULL,
  PRESET_SECTOR_OR_EMA20_VWAP_FIB_BEAR,
} from "@/lib/presets";
import { defaultDateRange, uid } from "@/lib/format";
import {
  buildCacheFingerprint,
  buildFnoScanFingerprints,
} from "@/lib/fingerprint";
import {
  chunkDayList,
  listWeekdays,
  sleep,
} from "@/lib/date-chunks";
import {
  assembleBacktestResult,
  filterTradesToDays,
  groupTradesByIstDay,
  istDayKey,
  mergeCandles,
} from "@/lib/merge-results";
import {
  dayCacheAvailable,
  loadDaysFromCache,
  saveDayCaches,
  type DayCacheRecord,
} from "@/lib/firebase/day-cache";
import {
  loadScanResult,
  saveScanResult,
  scanResultsAvailable,
} from "@/lib/firebase/scan-results";
import { useAuth } from "@/lib/firebase/auth-context";
import { useSavedStrategies } from "@/lib/hooks/use-saved-strategies";
import type {
  BacktestResult,
  Candle,
  DataSource,
  DualScanReport,
  EntryTimeWindow,
  Interval,
  OptionsTradeSettings,
  ScanReport,
  StrategyConfig,
  Trade,
  TradeInstrument,
} from "@/lib/types";

/** Days per API call + pause between chunks to ease broker rate limits */
const CHUNK_DAYS = 2;
const CHUNK_PAUSE_MS = 5000;
/** Extra wait when a chunk hits 429 before retrying that chunk */
const RATE_LIMIT_CHUNK_RETRIES = 4;

const INTERVALS: { value: Interval; label: string }[] = [
  { value: "1m", label: "1 min" },
  { value: "5m", label: "5 min" },
  { value: "15m", label: "15 min" },
  { value: "30m", label: "30 min" },
  { value: "60m", label: "1 hour" },
  { value: "1d", label: "Daily" },
];

const POPULAR = [
  { symbol: "RELIANCE", label: "Reliance" },
  { symbol: "TCS", label: "TCS" },
  { symbol: "INFY", label: "Infosys" },
  { symbol: "HDFCBANK", label: "HDFC Bank" },
  { symbol: "SBIN", label: "SBI" },
  { symbol: "BAJFINANCE", label: "Bajaj Fin" },
  { symbol: "TMCV", label: "Tata Motors" },
  { symbol: "NIFTYBEES", label: "Nifty BeES" },
];

export function BacktestApp() {
  const defaults = useMemo(() => defaultDateRange(30), []);
  const [symbol, setSymbol] = useState("RELIANCE");
  const [interval, setInterval] = useState<Interval>("5m");
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [source, setSource] = useState<DataSource>("upstox");
  const [upstoxToken, setUpstoxToken] = useState("");
  const [dhanToken, setDhanToken] = useState("");
  const [dhanClientId, setDhanClientId] = useState("");
  const [kiteApiKey, setKiteApiKey] = useState("");
  const [kiteAccessToken, setKiteAccessToken] = useState("");
  /** Total capital pool for the entire backtest run */
  const [capital, setCapital] = useState(100000);
  /** Equity only: max % of total capital per trade (not used for F&O — always 1 lot) */
  const [equityAllocPct, setEquityAllocPct] = useState(25);
  const [oneTradePerDay, setOneTradePerDay] = useState(true);
  /** Cap capital-at-risk per trade (equity notional / options premium) */
  const [maxRiskEnabled, setMaxRiskEnabled] = useState(false);
  const [maxRiskMode, setMaxRiskMode] = useState<"pct" | "amount">("pct");
  const [maxRiskPct, setMaxRiskPct] = useState(2);
  const [maxRiskAmount, setMaxRiskAmount] = useState(5000);
  /** Limit new entries to up to 2 IST time windows */
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
  /** 0 = auto from NSE F&O master (RELIANCE=500, TCS=225, …) */
  const [lotSize, setLotSize] = useState(0);
  /** F&O lots per entry (1–5); per-lot trail configured on each strategy */
  const [lotsPerTrade, setLotsPerTrade] = useState(1);
  const [strikeStep, setStrikeStep] = useState(0); // 0 = auto
  const [ivPct, setIvPct] = useState(18);
  const [daysToExpiry, setDaysToExpiry] = useState(7);
  /** Single-symbol backtest uses bullish strategy by default */
  const [strategy, setStrategy] = useState<StrategyConfig>(() =>
    structuredClone(PRESET_SECTOR_OR_EMA20_VWAP_FIB_BULL)
  );
  const [bullStrategy, setBullStrategy] = useState<StrategyConfig>(() =>
    structuredClone(PRESET_SECTOR_OR_EMA20_VWAP_FIB_BULL)
  );
  const [bearStrategy, setBearStrategy] = useState<StrategyConfig>(() =>
    structuredClone(PRESET_SECTOR_OR_EMA20_VWAP_FIB_BEAR)
  );
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [scanReport, setScanReport] = useState<ScanReport | null>(null);
  /** Second table when dual bull+bear condition scan (sector filter off) */
  const [scanReportBear, setScanReportBear] = useState<ScanReport | null>(null);
  const [dualScanNote, setDualScanNote] = useState<string | null>(null);
  const [chartFilter, setChartFilter] = useState<ChartBarFilter | null>(null);

  function clearScanResults() {
    setScanReport(null);
    setScanReportBear(null);
    setDualScanNote(null);
    setScanFromCache(false);
  }
  /** IST YYYY-MM-DD from calendar day click */
  const [dayFilter, setDayFilter] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [scanMaxSymbols, setScanMaxSymbols] = useState(50);
  const [scanAllFno, setScanAllFno] = useState(false);
  /** When true, F&O scan skips Firestore and hits broker APIs */
  const [forceLiveScan, setForceLiveScan] = useState(false);
  /** Sector-trend scan config (optional filter) */
  const [useSectorFilter, setUseSectorFilter] = useState(false);
  const [sectorWindowStart, setSectorWindowStart] = useState("09:15");
  const [sectorWindowEnd, setSectorWindowEnd] = useState("09:45");
  const [sectorTopN, setSectorTopN] = useState(2);
  const [sectorTopStocks, setSectorTopStocks] = useState(3);
  const [sectorMode, setSectorMode] = useState<"auto" | "bullish" | "bearish">(
    "auto"
  );
  const [sectorBiasThreshold, setSectorBiasThreshold] = useState(0);
  const [sectorEntryEnd, setSectorEntryEnd] = useState("15:15");
  const [sectorWeightMode, setSectorWeightMode] = useState<
    "turnover" | "equal"
  >("turnover");
  const [sectorMinStocks, setSectorMinStocks] = useState(2);
  const [sectorMinBreadth, setSectorMinBreadth] = useState(0);

  const [runProgress, setRunProgress] = useState<string | null>(null);
  /** F&O report loaded from cloud (no Upstox this run) */
  const [scanFromCache, setScanFromCache] = useState(false);
  const { user } = useAuth();
  const { saved: savedStrategies } = useSavedStrategies();
  /** Days that completed without fetch/backtest errors (safe to upload) */
  const okDaysRef = useRef<Set<string>>(new Set());

  /**
   * F&O multi-symbol cache keys (all stocks vs limited).
   * Primary + legacy candidates so re-runs hit cloud without Upstox.
   */
  function fnoScanCacheKeys() {
    const base = cacheSettings();
    const { symbol: _sym, ...rest } = base;
    return buildFnoScanFingerprints({
      base: rest,
      scanAll: scanAllFno,
      maxSymbols: scanMaxSymbols,
    });
  }

  function fnoCacheFingerprint(): string {
    return fnoScanCacheKeys().primary;
  }

  const filteredTrades = useMemo(() => {
    let list = filterTradesByChart(result?.trades || [], chartFilter);
    if (dayFilter) {
      list = list.filter((t) => {
        const d = new Date(t.entryTime + 5.5 * 60 * 60 * 1000);
        return d.toISOString().slice(0, 10) === dayFilter;
      });
    }
    return list;
  }, [result?.trades, chartFilter, dayFilter]);

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

  function applyStrategyPick(key: string) {
    if (key.startsWith("saved:")) {
      const id = key.slice("saved:".length);
      const row = savedStrategies.find((s) => s.id === id);
      if (row?.strategy) loadStrategy(row.strategy);
      return;
    }
    if (key.startsWith("preset:")) {
      applyPreset(key.slice("preset:".length));
    }
  }

  function strategySelectValue(s: StrategyConfig): string {
    const saved = savedStrategies.find(
      (row) => row.name === s.name || row.strategy?.name === s.name
    );
    if (saved) return `saved:${saved.id}`;
    if (STRATEGY_PRESETS.some((p) => p.name === s.name)) {
      return `preset:${s.name}`;
    }
    return "custom";
  }

  function loadStrategy(s: StrategyConfig) {
    setStrategy(
      structuredClone({
        ...s,
        entry: s.entry.map((c) => ({ ...c, id: c.id || uid() })),
        exit: s.exit.map((c) => ({ ...c, id: c.id || uid() })),
      })
    );
  }

  function buildOptions(): OptionsTradeSettings {
    return {
      side: optionSide,
      lotSize,
      lots: lotsPerTrade,
      strikeStep,
      iv: ivPct / 100,
      daysToExpiry,
    };
  }

  /** Sync lot count onto strategy for backtest engine */
  function withLots(s: StrategyConfig): StrategyConfig {
    return {
      ...s,
      positionLots: lotsPerTrade,
      lotRules:
        s.lotRules && s.lotRules.length >= lotsPerTrade
          ? s.lotRules.slice(0, lotsPerTrade)
          : padLotRules(s, lotsPerTrade),
    };
  }

  function padLotRules(s: StrategyConfig, n: number) {
    const rules = [...(s.lotRules || [])];
    const fallbackTrail = s.trailStop?.enabled ? s.trailStop.pct : undefined;
    const fallbackToCost = Boolean(s.trailStopToCost?.enabled);
    const fallbackToCostPct = s.trailStopToCost?.profitPctOfCapital ?? 20;
    const hadNoRules = rules.length === 0;
    while (rules.length < n) {
      const idx = rules.length;
      // 2+ lots default scale-out: lot 1 books +20% TP; other lots trail to cost after partial TP
      if (n >= 2 && idx === 0 && hadNoRules) {
        rules.push({
          takeProfitPct: 20,
          trailPct: fallbackTrail,
          trailToCost: false,
          exitOnSignal: true,
        });
      } else if (n >= 2 && idx >= 1) {
        rules.push({
          trailPct: fallbackTrail,
          trailToCost: true,
          trailToCostProfitPctOfCapital: fallbackToCostPct,
          armToCostOnPartialTp: true,
          exitOnSignal: true,
        });
      } else {
        rules.push({
          trailPct: fallbackTrail,
          trailToCost: fallbackToCost,
          trailToCostProfitPctOfCapital: fallbackToCostPct,
          exitOnSignal: true,
        });
      }
    }
    // First time expanding to multi-lot without any TP: seed scale-out on lot 1
    if (
      n >= 2 &&
      !rules.some((r) => r.takeProfitPct != null && r.takeProfitPct > 0)
    ) {
      rules[0] = {
        ...rules[0],
        takeProfitPct: 20,
      };
      for (let i = 1; i < n; i++) {
        rules[i] = {
          ...rules[i],
          trailToCost: rules[i].trailToCost ?? true,
          armToCostOnPartialTp: rules[i].armToCostOnPartialTp !== false,
        };
      }
    }
    return rules.slice(0, n);
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

  function validateSourceCredentials() {
    // Upstox: allow empty if server has UPSTOX_ACCESS_TOKEN env
    if (source === "dhan" && !dhanToken.trim()) {
      throw new Error("Paste your Dhan access token.");
    }
    if (source === "kite" && (!kiteApiKey.trim() || !kiteAccessToken.trim())) {
      throw new Error("Paste Kite API key and access token.");
    }
  }

  function credentialsPayload() {
    return {
      upstoxAccessToken:
        source === "upstox" ? upstoxToken || undefined : undefined,
      dhanAccessToken: source === "dhan" ? dhanToken || undefined : undefined,
      dhanClientId:
        source === "dhan" ? dhanClientId || undefined : undefined,
      kiteApiKey: source === "kite" ? kiteApiKey || undefined : undefined,
      kiteAccessToken:
        source === "kite" ? kiteAccessToken || undefined : undefined,
    };
  }

  function entryTimeWindowsPayload(): EntryTimeWindow[] | undefined {
    if (!limitEntryTimes) return undefined;
    return [
      { ...entryWindow1 },
      { ...entryWindow2 },
    ];
  }

  function maxRiskPayload() {
    if (!maxRiskEnabled) return undefined;
    return {
      enabled: true as const,
      mode: maxRiskMode,
      pct: maxRiskMode === "pct" ? maxRiskPct : undefined,
      amount: maxRiskMode === "amount" ? maxRiskAmount : undefined,
    };
  }

  function cacheSettings(strat?: StrategyConfig) {
    const s = strat || strategy;
    return {
      symbol: cleanSymbol(symbol),
      interval,
      source,
      tradeInstrument,
      strategy: s,
      oneTradePerDay,
      entryTimeWindows: entryTimeWindowsPayload(),
      maxRiskPerTrade: maxRiskPayload(),
      options: tradeInstrument === "options_atm" ? buildOptions() : undefined,
      positionSizePct: equityAllocPct,
      initialCapital: capital,
    };
  }

  async function fetchBacktestChunkOnce(
    chunkFrom: string,
    chunkTo: string,
    strat?: StrategyConfig
  ): Promise<BacktestResult> {
    const s = strat || strategy;
    const res = await fetch("/api/backtest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: cleanSymbol(symbol),
        interval,
        from: chunkFrom,
        to: chunkTo,
        source,
        strategy: s,
        initialCapital: capital,
        positionSizePct: equityAllocPct,
        oneTradePerDay,
        entryTimeWindows: entryTimeWindowsPayload(),
        maxRiskPerTrade: maxRiskPayload(),
        tradeInstrument,
        options:
          tradeInstrument === "options_atm" ? buildOptions() : undefined,
        ...credentialsPayload(),
      }),
    });
    const rawText = await res.text();
    let data: { error?: string } & Partial<BacktestResult>;
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      throw new Error(
        res.status === 504 || res.status === 408
          ? "Backtest timed out. Try again — shorter chunks help."
          : `Backtest failed (HTTP ${res.status}). ${rawText.slice(0, 180) || "Invalid response"}`
      );
    }
    if (!res.ok) {
      throw new Error(data.error || `Backtest failed with status ${res.status}.`);
    }
    return data as BacktestResult;
  }

  /** Retry chunk on 429 with long waits; latency OK for user */
  async function fetchBacktestChunk(
    chunkFrom: string,
    chunkTo: string,
    onWait?: (msg: string) => void,
    strat?: StrategyConfig
  ): Promise<BacktestResult> {
    let lastErr = "chunk failed";
    for (let attempt = 0; attempt < RATE_LIMIT_CHUNK_RETRIES; attempt++) {
      try {
        return await fetchBacktestChunkOnce(chunkFrom, chunkTo, strat);
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        const rateLimited = /429|rate.?limit|1015|being rate.limited/i.test(
          lastErr
        );
        if (!rateLimited || attempt >= RATE_LIMIT_CHUNK_RETRIES - 1) {
          throw e instanceof Error ? e : new Error(lastErr);
        }
        const waitSec = [45, 90, 120, 150][attempt] || 120;
        onWait?.(
          `Rate limited (429). Waiting ${waitSec}s then retry ${attempt + 2}/${RATE_LIMIT_CHUNK_RETRIES} for ${chunkFrom}→${chunkTo}…`
        );
        await sleep(waitSec * 1000);
      }
    }
    throw new Error(lastErr);
  }

  /**
   * Chunked run: few days at a time + pause (rate-limit friendly).
   * Reuses Firestore day cache when signed in (same strategy + day).
   * Uses bullish strategy for single-symbol runs.
   */
  async function run() {
    const runStrat = withLots(structuredClone(bullStrategy));
    setStrategy(runStrat);
    setLoading(true);
    setError(null);
    setResult(null);
    clearScanResults();
    setChartFilter(null);
    setDayFilter(null);
    setRunProgress(null);

    try {
      if (!symbol.trim()) {
        throw new Error("Please enter a stock symbol (e.g. RELIANCE or TCS).");
      }
      if (!from || !to) throw new Error("Please select both From and To dates.");
      if (from > to) throw new Error("From date must be on or before To date.");
      if (!runStrat.entry.length) {
        throw new Error("Bullish strategy needs at least one entry condition.");
      }
      if (!runStrat.exit.length) {
        throw new Error("Bullish strategy needs at least one exit condition.");
      }
      validateSourceCredentials();

      const allDays = listWeekdays(from, to);
      if (!allDays.length) {
        throw new Error(
          "No weekdays in this range. Pick a Mon–Fri span for NSE."
        );
      }

      const fingerprint = buildCacheFingerprint(cacheSettings(runStrat));
      const dayTrades = new Map<string, Trade[]>();
      const dayCandles = new Map<string, Candle[]>();
      const okDays = new Set<string>();
      okDaysRef.current = new Set();
      let optionsMeta: BacktestResult["optionsMeta"];
      let lastDiag: BacktestResult["diagnostics"];
      let resolvedSymbol = cleanSymbol(symbol);
      let chunkErrors = 0;

      // 1) Load cached days from Firestore (if signed in)
      let missing = [...allDays];
      if (user && dayCacheAvailable()) {
        setRunProgress("Checking cloud day cache…");
        const cached = await loadDaysFromCache(user.uid, fingerprint, allDays);
        const still: string[] = [];
        for (const day of allDays) {
          const hit = cached.get(day);
          // Only trust cache entries that were stored as clean (no trade errors)
          if (hit?.trades && dayTradesAreClean(hit.trades)) {
            dayTrades.set(day, hit.trades);
            if (hit.candles?.length) dayCandles.set(day, hit.candles);
            okDays.add(day);
          } else {
            still.push(day);
          }
        }
        missing = still;
        if (cached.size) {
          setRunProgress(
            `Cache hit ${okDays.size} day(s) · ${missing.length} to fetch…`
          );
        }
      }

      // 2) Fetch missing days in small chunks with pause (avoids rate limits)
      const chunks = chunkDayList(missing, CHUNK_DAYS);
      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        const cFrom = chunk[0];
        const cTo = chunk[chunk.length - 1];
        setRunProgress(
          `Fetching ${cFrom} → ${cTo} (${ci + 1}/${chunks.length})${
            chunks.length > 1 ? " · pacing for rate limits…" : ""
          }`
        );

        try {
          const partial = await fetchBacktestChunk(
            cFrom,
            cTo,
            setRunProgress,
            runStrat
          );
          resolvedSymbol = partial.symbol || resolvedSymbol;
          optionsMeta = partial.optionsMeta || optionsMeta;
          lastDiag = partial.diagnostics;

          const chunkDaySet = new Set(chunk);
          const tradesInChunk = filterTradesToDays(
            partial.trades || [],
            chunkDaySet
          );
          const byDay = groupTradesByIstDay(tradesInChunk);

          // Candles by IST day for this chunk
          const candlesByDay = new Map<string, Candle[]>();
          for (const c of partial.candles || []) {
            const day = istDayKey(c.time);
            if (!chunkDaySet.has(day)) continue;
            const list = candlesByDay.get(day) || [];
            list.push(c);
            candlesByDay.set(day, list);
          }

          // Successful chunk → each day is independently cacheable
          // (even if other days/chunks fail later)
          const cleanChunkDays: string[] = [];
          for (const day of chunk) {
            const trades = byDay.get(day) || [];
            const candles = candlesByDay.get(day) || [];
            if (!dayTradesAreClean(trades)) {
              chunkErrors += 1;
              continue;
            }
            dayTrades.set(day, trades);
            if (candles.length) dayCandles.set(day, candles);
            okDays.add(day);
            cleanChunkDays.push(day);
          }
          okDaysRef.current = new Set(okDays);

          // Auto-save only error-free days as soon as the chunk succeeds
          if (user && dayCacheAvailable() && cleanChunkDays.length) {
            try {
              const records: DayCacheRecord[] = cleanChunkDays.map((day) => ({
                fingerprint,
                day,
                symbol: resolvedSymbol,
                interval,
                source,
                trades: dayTrades.get(day) || [],
                candles: dayCandles.get(day) || [],
                savedAt: Date.now(),
                strategyName: runStrat.name,
              }));
              const n = await saveDayCaches(user.uid, records);
              setRunProgress(
                `Saved ${n} clean day(s) from ${cFrom}→${cTo} · continuing…`
              );
            } catch {
              // non-fatal — user can still Save manually
            }
          }
        } catch (chunkErr) {
          chunkErrors += chunk.length;
          const msg =
            chunkErr instanceof Error ? chunkErr.message : String(chunkErr);
          setRunProgress(
            `Chunk ${cFrom}→${cTo} failed — those days not saved; other days kept. ${msg.slice(0, 60)}`
          );
          // Failed chunk days stay out of okDays → re-fetched next run
          await sleep(CHUNK_PAUSE_MS);
          continue;
        }

        // Progressive UI
        const partialTrades = allDays.flatMap((d) => dayTrades.get(d) || []);
        const partialCandles = mergeCandles(
          allDays.map((d) => dayCandles.get(d) || [])
        );
        setResult(
          assembleBacktestResult({
            symbol: resolvedSymbol,
            interval,
            source,
            tradeInstrument,
            oneTradePerDay,
            initialCapital: capital,
            trades: partialTrades,
            candles: partialCandles,
            optionsMeta,
            diagnostics: {
              equitySignals: lastDiag?.equitySignals ?? partialTrades.length,
              entriesTaken: partialTrades.length,
              skippedInsufficientCapital:
                lastDiag?.skippedInsufficientCapital ?? 0,
              maxRiskStops: lastDiag?.maxRiskStops,
              minLotCost: lastDiag?.minLotCost,
              maxRiskCap: lastDiag?.maxRiskCap,
              note: `Partial: ${ci + 1}/${chunks.length} chunk(s) · ${okDays.size} clean day(s)${
                chunkErrors ? ` · ${chunkErrors} issue(s)` : ""
              }`,
            },
          })
        );

        if (ci < chunks.length - 1) {
          await sleep(CHUNK_PAUSE_MS);
        }
      }

      okDaysRef.current = okDays;

      // 3) Final assemble
      const allTrades = allDays.flatMap((d) => dayTrades.get(d) || []);
      const allCandles = mergeCandles(
        allDays.map((d) => dayCandles.get(d) || [])
      );
      const cacheHits = [...okDays].filter((d) => !missing.includes(d)).length;
      setResult(
        assembleBacktestResult({
          symbol: resolvedSymbol,
          interval,
          source,
          tradeInstrument,
          oneTradePerDay,
          initialCapital: capital,
          trades: allTrades,
          candles: allCandles,
          optionsMeta,
          diagnostics: {
            equitySignals: lastDiag?.equitySignals ?? allTrades.length,
            entriesTaken: allTrades.length,
            skippedInsufficientCapital:
              lastDiag?.skippedInsufficientCapital ?? 0,
            maxRiskStops: lastDiag?.maxRiskStops,
            minLotCost: lastDiag?.minLotCost,
            maxRiskCap: lastDiag?.maxRiskCap,
            note:
              `Done · ${okDays.size}/${allDays.length} clean day(s)` +
              (cacheHits ? ` · ${cacheHits} from cloud` : "") +
              (chunks.length ? ` · ${chunks.length} live chunk(s)` : "") +
              (chunkErrors
                ? ` · ${chunkErrors} day/chunk error(s) not saved`
                : "") +
              " · paced for rate limits.",
          },
        })
      );
      setRunProgress(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      // keep partial result if any
    } finally {
      setLoading(false);
      setRunProgress(null);
    }
  }

  function loadStrategyPick(
    key: string,
    set: (s: StrategyConfig) => void
  ) {
    if (key.startsWith("saved:")) {
      const id = key.slice("saved:".length);
      const row = savedStrategies.find(
        (s) => s.id === id || s.name === id || s.strategy?.name === id
      );
      if (row?.strategy?.entry?.length) {
        set(
          structuredClone({
            ...row.strategy,
            name: row.name || row.strategy.name,
          })
        );
        return;
      }
    }
    if (key.startsWith("preset:")) {
      const name = key.slice("preset:".length);
      const p = STRATEGY_PRESETS.find((x) => x.name === name);
      if (p) set(structuredClone(p));
    }
  }

  function strategyPickValue(s: StrategyConfig): string {
    const saved = savedStrategies.find(
      (row) => row.name === s.name || row.strategy?.name === s.name
    );
    if (saved) return `saved:${saved.id}`;
    if (STRATEGY_PRESETS.some((p) => p.name === s.name)) {
      return `preset:${s.name}`;
    }
    return "custom";
  }

  /**
   * Sector filter ON: rank morning sectors → bull strategy on green sectors,
   * bear strategy on red sectors.
   */
  async function runSectorTrendScan() {
    setScanning(true);
    setError(null);
    setResult(null);
    clearScanResults();
    setChartFilter(null);
    setDayFilter(null);
    setRunProgress(null);

    try {
      if (!from || !to) {
        throw new Error("Please select both From and To dates.");
      }
      if (from > to) {
        throw new Error("From date must be on or before To date.");
      }
      validateSourceCredentials();

      const bull = withLots(structuredClone(bullStrategy));
      const bear = withLots(structuredClone(bearStrategy));
      if (!bull.entry?.length || !bull.exit?.length) {
        throw new Error("Bullish strategy needs entry and exit conditions.");
      }
      if (!bear.entry?.length || !bear.exit?.length) {
        throw new Error("Bearish strategy needs entry and exit conditions.");
      }

      const scopeLabel = scanAllFno
        ? "all F&O (sector rank)"
        : `up to ${Math.min(scanMaxSymbols, 120)} F&O (sector rank)`;
      setRunProgress(
        `Sector filter ${sectorMode}: ${sectorWindowStart}–${sectorWindowEnd}, top ${sectorTopN}×${sectorTopStocks} · bull “${bull.name}” / bear “${bear.name}” on ${scopeLabel}…`
      );

      const res = await fetch("/api/scan/sector-trend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to,
          interval: interval === "1d" ? "5m" : interval,
          source,
          mode: sectorMode,
          windowStart: sectorWindowStart,
          windowEnd: sectorWindowEnd,
          topSectors: sectorTopN,
          topStocksPerSector: sectorTopStocks,
          biasThreshold: sectorBiasThreshold,
          weightMode: sectorWeightMode,
          minStocks: sectorMinStocks,
          minBreadthPct: sectorMinBreadth,
          entryEnd: sectorEntryEnd,
          bullStrategy: bull,
          bearStrategy: bear,
          initialCapital: capital,
          positionSizePct: equityAllocPct,
          oneTradePerDay: true,
          maxRiskPerTrade: maxRiskPayload(),
          tradeInstrument,
          options:
            tradeInstrument === "options_atm" ? buildOptions() : undefined,
          ...credentialsPayload(),
          maxSymbols: scanAllFno
            ? 400
            : Math.min(120, Math.max(20, scanMaxSymbols)),
          scanAll: scanAllFno,
          concurrency: 3,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          data.error || `Sector-trend scan failed (${res.status})`
        );
      }
      const report = data as ScanReport;
      setScanReport(report);
      setScanReportBear(null);
      setDualScanNote(null);
      setScanFromCache(false);
      const st = report.sectorTrend;
      setRunProgress(
        `Sector filter done · ${report.summary?.withTrades ?? 0} symbol(s) with trades` +
          (st
            ? ` · ${st.bullDays} bull / ${st.bearDays} bear day(s)`
            : "")
      );
    } catch (e) {
      clearScanResults();
      setError(e instanceof Error ? e.message : "Sector-trend scan failed");
      setRunProgress(null);
    } finally {
      setScanning(false);
    }
  }

  /**
   * No sector filter: run F&O universe with bull or bear strategy conditions only.
   */
  async function runBullBearScenario(side: "bullish" | "bearish") {
    setScanning(true);
    setError(null);
    setResult(null);
    clearScanResults();
    setChartFilter(null);
    setDayFilter(null);
    setRunProgress(null);

    try {
      if (!from || !to) {
        throw new Error("Please select both From and To dates.");
      }
      if (from > to) {
        throw new Error("From date must be on or before To date.");
      }
      validateSourceCredentials();

      const strat = withLots(
        structuredClone(side === "bullish" ? bullStrategy : bearStrategy)
      );
      if (!strat.entry?.length || !strat.exit?.length) {
        throw new Error(
          `${side === "bullish" ? "Bullish" : "Bearish"} strategy needs entry and exit conditions.`
        );
      }
      setStrategy(structuredClone(strat));
      if (side === "bullish") setOptionSide("CE");
      else setOptionSide("PE");

      const scopeLabel = scanAllFno
        ? "all F&O"
        : `up to ${scanMaxSymbols} F&O`;
      setRunProgress(
        `${side === "bullish" ? "Bullish" : "Bearish"} scenario · “${strat.name}” on ${scopeLabel}…`
      );

      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to,
          interval,
          source,
          strategy: strat,
          initialCapital: capital,
          positionSizePct: equityAllocPct,
          oneTradePerDay,
          entryTimeWindows: entryTimeWindowsPayload(),
          maxRiskPerTrade: maxRiskPayload(),
          tradeInstrument,
          options:
            tradeInstrument === "options_atm"
              ? {
                  ...buildOptions(),
                  side: side === "bullish" ? "CE" : "PE",
                }
              : undefined,
          ...credentialsPayload(),
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
      setScanReportBear(null);
      setDualScanNote(null);
      setScanFromCache(false);
      setRunProgress(
        `${side === "bullish" ? "Bullish" : "Bearish"} scenario done · ${(data as ScanReport).summary?.withTrades ?? 0} symbol(s) with trades.`
      );
    } catch (e) {
      clearScanResults();
      setError(
        e instanceof Error ? e.message : `${side} scenario scan failed`
      );
      setRunProgress(null);
    } finally {
      setScanning(false);
    }
  }

  /**
   * F&O universe scan.
   * - dualBoth: sector filter off — fetch each symbol once, evaluate bullish (CE)
   *   and bearish (PE) independently → two result tables.
   * - strategyOverride: single-strategy scan.
   */
  async function runFnoScan(
    strategyOverride?: StrategyConfig,
    opts?: { dualBoth?: boolean }
  ) {
    setScanning(true);
    setError(null);
    setResult(null);
    clearScanResults();
    setChartFilter(null);
    setDayFilter(null);
    setRunProgress(null);

    try {
      const dualBoth = Boolean(opts?.dualBoth) && !strategyOverride;
      const bull = withLots(structuredClone(bullStrategy));
      const bear = withLots(structuredClone(bearStrategy));
      const strat = withLots(strategyOverride || bullStrategy);

      if (!from || !to) throw new Error("Please select both From and To dates.");
      if (from > to) throw new Error("From date must be on or before To date.");

      if (dualBoth) {
        if (!bull.entry.length || !bull.exit.length) {
          throw new Error("Bullish strategy needs entry and exit conditions.");
        }
        if (!bear.entry.length || !bear.exit.length) {
          throw new Error("Bearish strategy needs entry and exit conditions.");
        }
      } else {
        if (!strat.entry.length) {
          throw new Error("Add at least one entry condition to the strategy.");
        }
        if (!strat.exit.length) {
          throw new Error("Add at least one exit condition to the strategy.");
        }
      }
      validateSourceCredentials();
      setStrategy(structuredClone(dualBoth ? bull : strat));

      const { primary: fingerprint, candidates } = fnoScanCacheKeys();
      const scopeLabel = scanAllFno
        ? "all F&O stocks"
        : `up to ${scanMaxSymbols} F&O symbols`;

      if (!dualBoth && !forceLiveScan && user && scanResultsAvailable()) {
        setRunProgress(
          `Checking cloud cache for ${scopeLabel} (${from} → ${to})…`
        );
        const cached = await loadScanResult(
          user.uid,
          fingerprint,
          from,
          to,
          candidates
        );
        if (cached) {
          setScanReport(cached);
          setScanReportBear(null);
          setDualScanNote(null);
          setScanFromCache(true);
          setRunProgress(
            `Loaded ${cached.scanned || cached.rows.length} symbol(s) from cloud — no Upstox calls.`
          );
          return;
        }
        setRunProgress(
          `No saved ${scopeLabel} result for this strategy/dates — live scan via broker…`
        );
      } else if (dualBoth) {
        setRunProgress(
          `Fetching ${scopeLabel} · check bull “${bull.name}” (CE) + bear “${bear.name}” (PE)…`
        );
      } else if (!user) {
        setRunProgress(
          "Not signed in — live scan (sign in + save to skip Upstox next time)…"
        );
      } else if (forceLiveScan) {
        setRunProgress("Force live scan — ignoring cloud cache…");
      }

      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to,
          interval,
          source,
          strategy: dualBoth ? bull : strat,
          ...(dualBoth
            ? { bullStrategy: bull, bearStrategy: bear }
            : {}),
          initialCapital: capital,
          positionSizePct: equityAllocPct,
          oneTradePerDay,
          entryTimeWindows: entryTimeWindowsPayload(),
          maxRiskPerTrade: maxRiskPayload(),
          tradeInstrument,
          options:
            tradeInstrument === "options_atm" ? buildOptions() : undefined,
          ...credentialsPayload(),
          maxSymbols: scanAllFno ? 400 : scanMaxSymbols,
          scanAll: scanAllFno,
          concurrency: 3,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Scan failed (${res.status})`);
      }

      // Dual response: separate bull + bear tables
      if (dualBoth && data && data.dual === true) {
        const dual = data as DualScanReport;
        setScanReport(dual.bull);
        setScanReportBear(dual.bear);
        setDualScanNote(
          dual.note ||
            "One API fetch per symbol; bullish and bearish conditions run independently."
        );
        setScanFromCache(false);
        setRunProgress(
          `Done · bull ${dual.bull.summary.withTrades} symbol(s) / ${dual.bull.summary.totalTrades} trade(s)` +
            ` · bear ${dual.bear.summary.withTrades} symbol(s) / ${dual.bear.summary.totalTrades} trade(s).`
        );
        return;
      }

      const liveReport = data as ScanReport;
      setScanReport(liveReport);
      setScanReportBear(null);
      setDualScanNote(null);
      setScanFromCache(false);

      if (
        !dualBoth &&
        user &&
        scanResultsAvailable() &&
        liveReport.rows?.length
      ) {
        try {
          setRunProgress(
            `Scan done — saving ${scopeLabel} to cloud for next run…`
          );
          const { savedRows, skippedErrors } = await saveScanResult(
            user.uid,
            liveReport,
            fingerprint
          );
          setRunProgress(
            `Saved ${savedRows} symbol(s) to cloud` +
              (skippedErrors ? ` · ${skippedErrors} error(s) skipped` : "") +
              `. Re-run same setup will skip Upstox.`
          );
        } catch (saveErr) {
          const msg =
            saveErr instanceof Error ? saveErr.message : "auto-save failed";
          setRunProgress(`Live scan done · cloud auto-save failed: ${msg}`);
        }
      }
    } catch (e) {
      clearScanResults();
      setError(e instanceof Error ? e.message : "F&O scan failed");
    } finally {
      setScanning(false);
      setTimeout(() => setRunProgress(null), 4000);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-5 pb-24 pt-10 sm:px-8">
      <header className="mb-10 max-w-2xl">
        <p className="mb-3 text-xs font-medium tracking-[0.2em] text-neutral-500 uppercase">
          Backtest
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-black sm:text-4xl">
          Test strategies.
          <br />
          <span className="text-neutral-400">With real history.</span>
        </h1>
        <p className="mt-4 text-base leading-relaxed text-neutral-600">
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
                  { id: "upstox", label: "Upstox" },
                  { id: "dhan", label: "Dhan" },
                  { id: "kite", label: "Zerodha Kite" },
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

            <div className="space-y-4">
              <Field label="Symbol">
                <input
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                  placeholder="RELIANCE"
                  className="field-input"
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                {POPULAR.map((p) => {
                  const active = cleanSymbol(symbol) === p.symbol;
                  return (
                    <button
                      key={p.symbol}
                      type="button"
                      onClick={() => setSymbol(p.symbol)}
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
              <p className="text-xs text-neutral-500">
                NSE trading symbol (e.g.{" "}
                <code className="text-neutral-800">RELIANCE</code>). Instrument
                id is resolved automatically.
              </p>
            </div>

            {source === "upstox" && (
              <div className="mt-4 space-y-4">
                <Field label="Upstox access token">
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
                  Fresh token from the Upstox developer app (tokens expire daily).
                  On production you can also set{" "}
                  <code className="text-neutral-800">UPSTOX_ACCESS_TOKEN</code>{" "}
                  in Vercel → Project → Environment Variables, then redeploy.
                </p>
              </div>
            )}

            {source === "dhan" && (
              <div className="mt-4 space-y-4">
                <Field label="Dhan access token">
                  <div className="relative">
                    <input
                      type={showToken ? "text" : "password"}
                      value={dhanToken}
                      onChange={(e) => setDhanToken(e.target.value)}
                      placeholder="JWT from web.dhan.co → DhanHQ APIs"
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
                <Field label="Client ID (optional)">
                  <input
                    value={dhanClientId}
                    onChange={(e) => setDhanClientId(e.target.value)}
                    placeholder="Dhan client id if required"
                    className="field-input font-mono text-sm"
                  />
                </Field>
                <p className="text-xs text-neutral-500">
                  DhanHQ historical (1/5/15/60m, daily). Env:{" "}
                  <code className="text-neutral-800">DHAN_ACCESS_TOKEN</code>.
                </p>
              </div>
            )}

            {source === "kite" && (
              <div className="mt-4 space-y-4">
                <Field label="Kite API key">
                  <input
                    type={showToken ? "text" : "password"}
                    value={kiteApiKey}
                    onChange={(e) => setKiteApiKey(e.target.value)}
                    placeholder="API key from developers.kite.trade"
                    className="field-input font-mono text-sm"
                  />
                </Field>
                <Field label="Kite access token">
                  <div className="relative">
                    <input
                      type={showToken ? "text" : "password"}
                      value={kiteAccessToken}
                      onChange={(e) => setKiteAccessToken(e.target.value)}
                      placeholder="Session access token"
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
                  Kite Connect historical requires a paid app + daily login
                  token. Env:{" "}
                  <code className="text-neutral-800">KITE_API_KEY</code>,{" "}
                  <code className="text-neutral-800">KITE_ACCESS_TOKEN</code>.
                </p>
              </div>
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
            <h2 className="mb-3 text-sm font-medium tracking-wide text-neutral-500 uppercase">
              Capital
            </h2>
            <p className="mb-4 text-xs leading-relaxed text-neutral-500">
              Total capital for the whole backtest (e.g. ₹1,00,000). Cash is
              shared across sequential trades — not 100% reinvested per trade.
              {tradeInstrument === "options_atm"
                ? " F&O always uses 1 lot per trade if cash covers the premium."
                : ""}
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Total capital (₹)">
                <input
                  type="number"
                  min={1000}
                  step={1000}
                  value={capital}
                  onChange={(e) => setCapital(Number(e.target.value))}
                  className="field-input"
                />
              </Field>
              {tradeInstrument === "equity" ? (
                <Field label="Max capital per equity trade (% of total)">
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={equityAllocPct}
                    onChange={(e) =>
                      setEquityAllocPct(
                        Math.min(100, Math.max(1, Number(e.target.value) || 25))
                      )
                    }
                    className="field-input"
                  />
                </Field>
              ) : (
                <div className="flex items-end">
                  <p className="rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-xs text-neutral-600">
                    <strong className="text-neutral-900">F&amp;O:</strong> 1 lot
                    per trade. With ₹{capital.toLocaleString("en-IN")} you can
                    open as many sequential 1-lot trades as cash allows after
                    each exit.
                  </p>
                </div>
              )}
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

            <label className="mb-4 flex cursor-pointer items-start gap-3 rounded-2xl border border-neutral-200 bg-neutral-50/80 p-4">
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

            <div className="mb-4 rounded-2xl border border-neutral-200 bg-neutral-50/80 p-4">
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={maxRiskEnabled}
                  onChange={(e) => setMaxRiskEnabled(e.target.checked)}
                  className="mt-1 h-4 w-4 accent-black"
                />
                <span>
                  <span className="block text-sm font-medium text-black">
                    Max risk per trade (stop)
                  </span>
                  <span className="mt-0.5 block text-xs text-neutral-500">
                    Hard stop: exit when loss reaches this limit. Equity uses
                    the bar low so the fill is at the stop price (not a worse
                    close). Options clamp premium so loss ≈ the cap.
                  </span>
                </span>
              </label>

              {maxRiskEnabled && (
                <div className="mt-4 space-y-3 border-t border-neutral-200 pt-4">
                  <div className="flex flex-wrap gap-2">
                    {(
                      [
                        { id: "pct" as const, label: "% of capital" },
                        { id: "amount" as const, label: "Fixed ₹" },
                      ] as const
                    ).map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setMaxRiskMode(m.id)}
                        className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                          maxRiskMode === m.id
                            ? "bg-black text-white"
                            : "bg-white text-neutral-600 ring-1 ring-neutral-200 hover:ring-neutral-400"
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                  {maxRiskMode === "pct" ? (
                    <Field label="Max loss (% of total capital)">
                      <input
                        type="number"
                        min={0.1}
                        max={100}
                        step={0.1}
                        value={maxRiskPct}
                        onChange={(e) =>
                          setMaxRiskPct(Math.max(0.1, Number(e.target.value) || 0.1))
                        }
                        className="field-input"
                      />
                    </Field>
                  ) : (
                    <Field label="Max loss (₹)">
                      <input
                        type="number"
                        min={1}
                        step={100}
                        value={maxRiskAmount}
                        onChange={(e) =>
                          setMaxRiskAmount(
                            Math.max(1, Number(e.target.value) || 1)
                          )
                        }
                        className="field-input"
                      />
                    </Field>
                  )}
                  <p className="text-[11px] text-neutral-400">
                    Stop ≈ −₹
                    {Math.round(
                      maxRiskMode === "pct"
                        ? (capital * maxRiskPct) / 100
                        : maxRiskAmount
                    ).toLocaleString("en-IN")}{" "}
                    MTM loss
                    {tradeInstrument === "options_atm"
                      ? " on option premium"
                      : " on equity position"}
                    .
                  </p>
                </div>
              )}
            </div>

            <div className="mb-5 rounded-2xl border border-neutral-200 bg-neutral-50/80 p-4">
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={limitEntryTimes}
                  onChange={(e) => setLimitEntryTimes(e.target.checked)}
                  className="mt-1 h-4 w-4 accent-black"
                />
                <span>
                  <span className="block text-sm font-medium text-black">
                    Entry time windows (IST)
                  </span>
                  <span className="mt-0.5 block text-xs text-neutral-500">
                    Only open new trades when the bar time falls in one of the
                    two ranges below (e.g. morning + afternoon). Exits still
                    work anytime.
                  </span>
                </span>
              </label>

              {limitEntryTimes && (
                <div className="mt-4 space-y-3 border-t border-neutral-200 pt-4">
                  <TimeWindowRow
                    label="Window 1"
                    window={entryWindow1}
                    onChange={setEntryWindow1}
                  />
                  <TimeWindowRow
                    label="Window 2"
                    window={entryWindow2}
                    onChange={setEntryWindow2}
                  />
                  <p className="text-[11px] text-neutral-400">
                    NSE cash session is typically 09:15–15:30 IST. Uncheck a
                    window to disable it.
                  </p>
                </div>
              )}
            </div>

            {tradeInstrument === "options_atm" && (
              <div className="space-y-4">
                <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4 text-xs leading-relaxed text-neutral-600">
                  <p className="font-medium text-neutral-800">
                    How options mode works
                  </p>
                  <ol className="mt-2 list-decimal space-y-1 pl-4">
                    <li>
                      <strong>Signals</strong> run only on equity (close, EMA,
                      opening range, Fib, prev day high, ...).
                    </li>
                    <li>
                      On entry we buy the <strong>ATM</strong> {optionSide}{" "}
                      (closest listed NSE strike).
                    </li>
                    <li>
                      <strong>Lot size</strong> from NSE F&amp;O master (auto)
                      unless you override.
                    </li>
                    <li>
                      <strong>Premiums:</strong> with an Upstox token we use{" "}
                      <em>real F&amp;O historical OHLC</em> for that contract.
                      Without a token we use a realized-vol model (better than
                      fixed IV, still an estimate).
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
                  <Field label="Lots per trade">
                    <select
                      value={lotsPerTrade}
                      onChange={(e) => {
                        const n = Math.min(
                          5,
                          Math.max(1, Number(e.target.value) || 1)
                        );
                        setLotsPerTrade(n);
                        setBullStrategy((s) => ({
                          ...s,
                          positionLots: n,
                          lotRules: padLotRules(s, n),
                        }));
                        setBearStrategy((s) => ({
                          ...s,
                          positionLots: n,
                          lotRules: padLotRules(s, n),
                        }));
                      }}
                      className="field-input"
                    >
                      <option value={1}>1 lot</option>
                      <option value={2}>2 lots</option>
                      <option value={3}>3 lots</option>
                    </select>
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

          {/* 4 · Sector filter (optional) */}
          <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <h2 className="mb-3 text-sm font-medium tracking-wide text-neutral-500 uppercase">
              Sector filter
              <span className="ml-2 font-normal normal-case text-neutral-400">
                (optional)
              </span>
            </h2>
            <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-violet-200 bg-violet-50/40 p-4">
              <input
                type="checkbox"
                checked={useSectorFilter}
                onChange={(e) => setUseSectorFilter(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-violet-700"
              />
              <span>
                <span className="block text-sm font-medium text-black">
                  Enable sector filter
                </span>
                <span className="mt-0.5 block text-xs text-neutral-500">
                  When on: morning bars shortlist stocks (top sectors). Only
                  those names may trade after the ranking window, and only if
                  the bullish/bearish strategy entry conditions still pass
                  (e.g. close ≥ OR high with period 30 = 09:15–09:45 range).
                  When off: each strategy runs by conditions on the full
                  F&amp;O list.
                </span>
              </span>
            </label>

            {useSectorFilter && (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <Field label="Trend window start (IST)">
                  <input
                    type="time"
                    value={sectorWindowStart}
                    onChange={(e) => setSectorWindowStart(e.target.value)}
                    className="field-input"
                  />
                </Field>
                <Field label="Trend window end (IST)">
                  <input
                    type="time"
                    value={sectorWindowEnd}
                    onChange={(e) => setSectorWindowEnd(e.target.value)}
                    className="field-input"
                  />
                </Field>
                <Field label="Top sectors">
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={sectorTopN}
                    onChange={(e) =>
                      setSectorTopN(
                        Math.min(8, Math.max(1, Number(e.target.value) || 2))
                      )
                    }
                    className="field-input"
                  />
                </Field>
                <Field label="Top stocks / sector">
                  <input
                    type="number"
                    min={1}
                    max={15}
                    value={sectorTopStocks}
                    onChange={(e) =>
                      setSectorTopStocks(
                        Math.min(15, Math.max(1, Number(e.target.value) || 3))
                      )
                    }
                    className="field-input"
                  />
                </Field>
                <Field label="Sector pool">
                  <select
                    value={sectorMode}
                    onChange={(e) =>
                      setSectorMode(
                        e.target.value as "auto" | "bullish" | "bearish"
                      )
                    }
                    className="field-input"
                  >
                    <option value="auto">
                      Auto (top N by bar — bull, bear, or mix)
                    </option>
                    <option value="bullish">Green bars only</option>
                    <option value="bearish">Red bars only</option>
                  </select>
                </Field>
                <Field label="Min bar length |%|">
                  <input
                    type="number"
                    step={0.1}
                    min={0}
                    value={sectorBiasThreshold}
                    onChange={(e) =>
                      setSectorBiasThreshold(
                        Math.max(0, Number(e.target.value) || 0)
                      )
                    }
                    className="field-input"
                  />
                </Field>
                <Field label="Strength weight">
                  <select
                    value={sectorWeightMode}
                    onChange={(e) =>
                      setSectorWeightMode(
                        e.target.value === "equal" ? "equal" : "turnover"
                      )
                    }
                    className="field-input"
                  >
                    <option value="turnover">
                      Turnover-weighted (recommended)
                    </option>
                    <option value="equal">Equal-weight avg</option>
                  </select>
                </Field>
                <Field label="Min stocks / sector">
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={sectorMinStocks}
                    onChange={(e) =>
                      setSectorMinStocks(
                        Math.min(20, Math.max(1, Number(e.target.value) || 3))
                      )
                    }
                    className="field-input"
                  />
                </Field>
                <Field label="Min breadth % (same side)">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={sectorMinBreadth}
                    onChange={(e) =>
                      setSectorMinBreadth(
                        Math.min(100, Math.max(0, Number(e.target.value) || 0))
                      )
                    }
                    className="field-input"
                    title="0 = off. e.g. 55 requires ≥55% stocks same colour as sector"
                  />
                </Field>
                <Field label="Entry window ends (IST)">
                  <input
                    type="time"
                    value={sectorEntryEnd}
                    onChange={(e) => setSectorEntryEnd(e.target.value)}
                    className="field-input"
                  />
                </Field>
                <p className="sm:col-span-2 text-[11px] text-neutral-400">
                  Strength: {sectorWeightMode} avg return, ≥{sectorMinStocks}{" "}
                  stocks, breadth ≥{sectorMinBreadth}%, min |bar|{" "}
                  {sectorBiasThreshold}%. Top {sectorTopN} by |score| (bull /
                  bear / mix). Green → bull strategy, red → bear. Window{" "}
                  {sectorWindowStart}–{sectorWindowEnd}. Prefer 5m.
                </p>
              </div>
            )}
          </section>

          {/* 5 · Bullish strategy */}
          <section className="rounded-3xl border border-emerald-200 bg-white p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-medium tracking-wide text-emerald-800 uppercase">
                Bullish strategy
              </h2>
              <select
                value={strategyPickValue(bullStrategy)}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "custom") return;
                  loadStrategyPick(v, (s) => {
                    setBullStrategy(s);
                    setStrategy(structuredClone(s));
                  });
                }}
                className="rounded-full border border-emerald-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-emerald-700"
              >
                <optgroup label="Presets">
                  {STRATEGY_PRESETS.map((p) => (
                    <option key={p.name} value={`preset:${p.name}`}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
                {savedStrategies.length > 0 && (
                  <optgroup label="Your strategies">
                    {savedStrategies.map((s) => (
                      <option key={s.id} value={`saved:${s.id}`}>
                        {s.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {strategyPickValue(bullStrategy) === "custom" && (
                  <option value="custom">{bullStrategy.name} (custom)</option>
                )}
              </select>
            </div>
            <p className="mb-4 text-xs text-neutral-500">
              {useSectorFilter
                ? "Applied to stocks in green (bullish) sectors."
                : "Used for CE when sector filter is off (Run all F&O or Run bullish)."}
            </p>
            <Field label="Name">
              <input
                value={bullStrategy.name}
                onChange={(e) =>
                  setBullStrategy((s) => ({ ...s, name: e.target.value }))
                }
                className="field-input mb-4"
              />
            </Field>
            <TrailStopFields
              strategy={bullStrategy}
              onChange={setBullStrategy}
            />
            <div className="mt-4 space-y-8">
              <ConditionBuilder
                title="Entry when"
                conditions={bullStrategy.entry}
                logic={bullStrategy.entryLogic ?? "and"}
                onLogicChange={(entryLogic) =>
                  setBullStrategy((s) => ({ ...s, entryLogic }))
                }
                onChange={(entry) => setBullStrategy((s) => ({ ...s, entry }))}
              />
              <div className="border-t border-neutral-100" />
              <ConditionBuilder
                title="Exit when"
                conditions={bullStrategy.exit}
                logic={bullStrategy.exitLogic ?? "and"}
                onLogicChange={(exitLogic) =>
                  setBullStrategy((s) => ({ ...s, exitLogic }))
                }
                onChange={(exit) => setBullStrategy((s) => ({ ...s, exit }))}
              />
            </div>
            <div className="mt-4">
              <StrategyLibrary
                strategy={bullStrategy}
                onLoad={(s) => {
                  setBullStrategy(structuredClone(s));
                  setStrategy(structuredClone(s));
                }}
                onRenamed={(name) =>
                  setBullStrategy((s) => ({ ...s, name }))
                }
              />
            </div>
          </section>

          {/* 6 · Bearish strategy */}
          <section className="rounded-3xl border border-rose-200 bg-white p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-medium tracking-wide text-rose-800 uppercase">
                Bearish strategy
              </h2>
              <select
                value={strategyPickValue(bearStrategy)}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "custom") return;
                  loadStrategyPick(v, setBearStrategy);
                }}
                className="rounded-full border border-rose-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-rose-700"
              >
                <optgroup label="Presets">
                  {STRATEGY_PRESETS.map((p) => (
                    <option key={p.name} value={`preset:${p.name}`}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
                {savedStrategies.length > 0 && (
                  <optgroup label="Your strategies">
                    {savedStrategies.map((s) => (
                      <option key={s.id} value={`saved:${s.id}`}>
                        {s.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {strategyPickValue(bearStrategy) === "custom" && (
                  <option value="custom">{bearStrategy.name} (custom)</option>
                )}
              </select>
            </div>
            <p className="mb-4 text-xs text-neutral-500">
              {useSectorFilter
                ? "Applied to stocks in red (bearish) sectors."
                : "Used for PE when sector filter is off (Run all F&O or Run bearish)."}
            </p>
            <Field label="Name">
              <input
                value={bearStrategy.name}
                onChange={(e) =>
                  setBearStrategy((s) => ({ ...s, name: e.target.value }))
                }
                className="field-input mb-4"
              />
            </Field>
            <TrailStopFields
              strategy={bearStrategy}
              onChange={setBearStrategy}
            />
            <div className="mt-4 space-y-8">
              <ConditionBuilder
                title="Entry when"
                conditions={bearStrategy.entry}
                logic={bearStrategy.entryLogic ?? "and"}
                onLogicChange={(entryLogic) =>
                  setBearStrategy((s) => ({ ...s, entryLogic }))
                }
                onChange={(entry) => setBearStrategy((s) => ({ ...s, entry }))}
              />
              <div className="border-t border-neutral-100" />
              <ConditionBuilder
                title="Exit when"
                conditions={bearStrategy.exit}
                logic={bearStrategy.exitLogic ?? "and"}
                onLogicChange={(exitLogic) =>
                  setBearStrategy((s) => ({ ...s, exitLogic }))
                }
                onChange={(exit) => setBearStrategy((s) => ({ ...s, exit }))}
              />
            </div>
            <div className="mt-4">
              <StrategyLibrary
                strategy={bearStrategy}
                onLoad={(s) => setBearStrategy(structuredClone(s))}
                onRenamed={(name) =>
                  setBearStrategy((s) => ({ ...s, name }))
                }
              />
            </div>
          </section>

          {/* 7 · F&O universe scan */}
          <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <h2 className="mb-3 text-sm font-medium tracking-wide text-neutral-500 uppercase">
              F&amp;O universe scan
            </h2>
            <p className="mb-4 text-xs leading-relaxed text-neutral-500">
              {useSectorFilter
                ? "Sector filter is on: one run ranks sectors, then applies bullish strategy on green sectors and bearish strategy on red sectors."
                : "Sector filter is off: Run all F&O checks both bullish and bearish entry/exit conditions on every symbol (CE + PE). Use the side buttons for one strategy only."}
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
                  Full NSE equity F&amp;O universe. Uncheck to limit count
                  below.
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

            <label className="mb-4 flex cursor-pointer items-start gap-3 rounded-2xl border border-neutral-200 p-3">
              <input
                type="checkbox"
                checked={forceLiveScan}
                onChange={(e) => setForceLiveScan(e.target.checked)}
                className="mt-1 h-4 w-4 accent-black"
              />
              <span>
                <span className="block text-sm font-medium text-black">
                  Force live scan (ignore cloud save)
                </span>
                <span className="mt-0.5 block text-xs text-neutral-500">
                  Tick only when you want a fresh broker pull.
                </span>
              </span>
            </label>

            {useSectorFilter ? (
              <button
                type="button"
                onClick={() => void runSectorTrendScan()}
                disabled={loading || scanning}
                className="w-full rounded-full bg-violet-700 py-3 text-sm font-medium text-white transition hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {scanning
                  ? "Running sector + bull/bear…"
                  : "Run F&O scan (sector filter → bull/bear strategies)"}
              </button>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => void runBullBearScenario("bullish")}
                  disabled={loading || scanning}
                  className="rounded-full bg-emerald-700 py-3 text-sm font-medium text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {scanning ? "Running…" : "Run bullish (by conditions)"}
                </button>
                <button
                  type="button"
                  onClick={() => void runBullBearScenario("bearish")}
                  disabled={loading || scanning}
                  className="rounded-full bg-rose-700 py-3 text-sm font-medium text-white transition hover:bg-rose-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {scanning ? "Running…" : "Run bearish (by conditions)"}
                </button>
                <button
                  type="button"
                  onClick={() => void runFnoScan(undefined, { dualBoth: true })}
                  disabled={loading || scanning}
                  className="sm:col-span-2 w-full rounded-full border border-black bg-white py-3 text-sm font-medium text-black transition hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {scanning
                    ? "Scanning bull + bear…"
                    : scanAllFno
                      ? "Run all F&O (bull + bear conditions)"
                      : `Run F&O max ${scanMaxSymbols} (bull + bear conditions)`}
                </button>
              </div>
            )}
          </section>

          <button
            type="button"
            onClick={() => void run()}
            disabled={loading || scanning}
            className="w-full rounded-full bg-black py-3.5 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading
              ? runProgress
                ? "Running (chunked)…"
                : "Running backtest…"
              : "Run backtest (single symbol · bullish strategy)"}
          </button>
          <p className="text-center text-[11px] text-neutral-400">
            Single-symbol uses the bullish strategy + symbol under Market data.
            Long ranges run in {CHUNK_DAYS}-day chunks. Sign in + Save days to
            reuse cache.
          </p>
        </div>

        {/* Results below submit — full width for readable tables */}
        <div className="w-full space-y-6 border-t border-neutral-200 pt-10">
          <h2 className="text-sm font-medium tracking-wide text-neutral-500 uppercase">
            Results
          </h2>
          {(loading || scanning) && (
            <div className="flex min-h-[200px] items-center justify-center rounded-3xl border border-neutral-200 bg-white">
              <div className="max-w-md px-4 text-center">
                <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-neutral-200 border-t-black" />
                <p className="text-sm text-neutral-600">
                  {scanning
                    ? "Scanning F&O universe - this can take a few minutes..."
                    : runProgress ||
                      "Fetching data & running backtest..."}
                </p>
                {loading && runProgress && (
                  <p className="mt-2 text-xs text-neutral-400">
                    Partial results may appear below as chunks finish.
                  </p>
                )}
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

          {(scanReport || scanReportBear) &&
            !loading &&
            !scanning &&
            !error && (
              <div className="space-y-6">
                {dualScanNote && (
                  <div className="rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs leading-relaxed text-neutral-600">
                    {dualScanNote}
                  </div>
                )}
                {scanReport && (
                  <ScanReportView
                    report={scanReport}
                    onClose={clearScanResults}
                    cacheFingerprint={
                      scanReportBear ? undefined : fnoCacheFingerprint()
                    }
                    fromCache={scanFromCache && !scanReportBear}
                    hideSave={Boolean(scanReportBear)}
                    heading={
                      scanReport.side === "bullish" || scanReportBear
                        ? "Bullish · CE"
                        : undefined
                    }
                  />
                )}
                {scanReportBear && (
                  <ScanReportView
                    report={scanReportBear}
                    onClose={clearScanResults}
                    hideSave
                    heading="Bearish · PE"
                  />
                )}
              </div>
            )}

          {result && !scanning && !scanReport && !scanReportBear && (
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
                    {" · "}
                    Win {result.metrics.winRate.toFixed(1)}%
                    {" · "}
                    R:R{" "}
                    {(result.metrics.riskRewardRatio ?? 0) >= 999
                      ? "∞"
                      : `${(result.metrics.riskRewardRatio ?? 0).toFixed(2)}:1`}
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
                        ? ` · ${result.optionsMeta.listedStrikesCount} strikes`
                        : ""}
                      {" · "}
                      {result.optionsMeta.pricingMode === "market"
                        ? "premiums: market F&O"
                        : result.optionsMeta.pricingMode === "mixed"
                          ? `premiums: ${result.optionsMeta.marketFills ?? 0} market / ${result.optionsMeta.modelFills ?? 0} model`
                          : "premiums: model (add Upstox token for real F&O prices)"}
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
                      <p className="mt-1 text-xs text-neutral-500">
                        {result.diagnostics.candleCount != null
                          ? `${result.diagnostics.candleCount} bars loaded`
                          : ""}
                        {result.diagnostics.equitySignals > 0
                          ? ` · equity signals: ${result.diagnostics.equitySignals}`
                          : result.diagnostics.candleCount != null
                            ? " · equity signals: 0"
                            : ""}
                        {result.diagnostics.skippedInsufficientCapital
                          ? ` · skipped (capital): ${result.diagnostics.skippedInsufficientCapital}`
                          : ""}
                        {result.diagnostics.maxRiskStops
                          ? ` · max-risk stops: ${result.diagnostics.maxRiskStops}`
                          : ""}
                        {result.diagnostics.maxRiskCap
                          ? ` · stop −₹${Math.round(result.diagnostics.maxRiskCap).toLocaleString("en-IN")}`
                          : ""}
                        {result.diagnostics.trailCostStops
                          ? ` · trail-to-cost: ${result.diagnostics.trailCostStops}`
                          : ""}
                        {result.diagnostics.trailSlStops
                          ? ` · trailing SL: ${result.diagnostics.trailSlStops}`
                          : ""}
                        {result.diagnostics.trailProfitThreshold
                          ? ` · trail arms +₹${Math.round(result.diagnostics.trailProfitThreshold).toLocaleString("en-IN")}`
                          : ""}
                        {result.diagnostics.minLotCost
                          ? ` · ~₹${Math.ceil(result.diagnostics.minLotCost).toLocaleString("en-IN")}/lot`
                          : ""}
                      </p>
                    </div>
                  )}
                </div>
                <BacktestReport
                  result={result}
                  dayFilter={dayFilter}
                  onDayFilterChange={(d) => {
                    setDayFilter(d);
                    // Day scope drives both charts; clear bar filter so it doesn't fight the new day
                    setChartFilter(null);
                  }}
                />
              </section>

              {/* Charts always visible after metrics for single-symbol runs */}
              <section
                id="performance-charts"
                className="rounded-3xl border border-neutral-200 bg-white p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)] sm:p-6"
              >
                <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-medium tracking-wide text-neutral-500 uppercase">
                      Charts
                    </h2>
                    <p className="mt-1 text-xs text-neutral-500">
                      (1) Every 15 min
                      {dayFilter
                        ? ` · selected day ${dayFilter}`
                        : " · all days in range"}{" "}
                      · (2) Hold time entry → exit
                      {result.trades?.length
                        ? ` · ${result.trades.length} trade(s)`
                        : " · no trades yet"}
                    </p>
                  </div>
                </div>
                <PerformanceCharts
                  trades={result.trades || []}
                  selectedDay={dayFilter}
                  activeFilter={chartFilter}
                  onFilterChange={(f) => {
                    setChartFilter(f);
                    // Slot/hold filter keeps day scope if a day is already selected
                  }}
                />
              </section>

              <section className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-medium tracking-wide text-neutral-500 uppercase">
                    Trades
                    {chartFilter || dayFilter
                      ? ` · ${filteredTrades.length} of ${result.trades?.length || 0}`
                      : ""}
                    {dayFilter ? ` · day ${dayFilter}` : ""}
                  </h2>
                  {(chartFilter || dayFilter) && (
                    <button
                      type="button"
                      onClick={() => {
                        setChartFilter(null);
                        setDayFilter(null);
                      }}
                      className="rounded-full border border-neutral-300 px-3 py-1 text-xs font-medium hover:border-black"
                    >
                      Show all trades
                    </button>
                  )}
                </div>
                <TradesTable trades={filteredTrades} />
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

/** Per-lot take-profit / trailing SL / trail-to-cost / strategy-exit flags. */
function TrailStopFields({
  strategy,
  onChange,
}: {
  strategy: StrategyConfig;
  onChange: (
    s: StrategyConfig | ((prev: StrategyConfig) => StrategyConfig)
  ) => void;
}) {
  const nLots = Math.min(5, Math.max(1, strategy.positionLots || 1));
  const rules = strategy.lotRules || [];

  function updateLot(
    idx: number,
    patch: Partial<NonNullable<StrategyConfig["lotRules"]>[0]>
  ) {
    onChange((s) => {
      const n = Math.min(5, Math.max(1, s.positionLots || 1));
      const next = [...(s.lotRules || [])];
      while (next.length < n) {
        next.push({
          trailPct: undefined,
          trailToCost: false,
          exitOnSignal: true,
        });
      }
      next[idx] = { ...next[idx], ...patch };
      return { ...s, positionLots: n, lotRules: next.slice(0, n) };
    });
  }

  return (
    <div className="mb-4 space-y-3 rounded-2xl border border-neutral-200 bg-neutral-50/80 p-4">
      <p className="text-sm font-medium text-black">
        Per-lot take-profit / trailing / exits
      </p>
      <p className="text-xs text-neutral-500">
        Lots per trade is under Trade rules. Scale-out example: lot 1 take-profit
        20%, lot 2 trail to cost (arms after lot 1 books) and/or trailing SL.
      </p>
      {Array.from({ length: nLots }, (_, idx) => {
        const rule = rules[idx] || {};
        const trailOn = rule.trailPct != null && rule.trailPct > 0;
        const tpOn = rule.takeProfitPct != null && rule.takeProfitPct > 0;
        return (
          <div
            key={idx}
            className="rounded-xl border border-neutral-200 bg-white p-3"
          >
            <p className="mb-2 text-xs font-semibold tracking-wide text-neutral-600 uppercase">
              Lot {idx + 1}
            </p>
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                checked={tpOn}
                onChange={(e) =>
                  updateLot(idx, {
                    takeProfitPct: e.target.checked
                      ? rule.takeProfitPct || 20
                      : 0,
                  })
                }
                className="mt-0.5 h-4 w-4 accent-black"
              />
              <span className="flex-1 text-sm">
                Take-profit %
                {tpOn && (
                  <span className="mt-1 flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={500}
                      step={1}
                      value={rule.takeProfitPct || 20}
                      onChange={(e) =>
                        updateLot(idx, {
                          takeProfitPct: Math.min(
                            500,
                            Math.max(1, Number(e.target.value) || 1)
                          ),
                        })
                      }
                      className="field-input w-20"
                    />
                    <span className="text-xs text-neutral-500">
                      close lot when mark ≥ entry + this %
                    </span>
                  </span>
                )}
              </span>
            </label>
            <label className="mt-2 flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                checked={trailOn}
                onChange={(e) =>
                  updateLot(idx, {
                    trailPct: e.target.checked ? rule.trailPct || 1 : 0,
                  })
                }
                className="mt-0.5 h-4 w-4 accent-black"
              />
              <span className="flex-1 text-sm">
                Trailing SL %
                {trailOn && (
                  <span className="mt-1 flex items-center gap-2">
                    <input
                      type="number"
                      min={0.1}
                      max={50}
                      step={0.1}
                      value={rule.trailPct || 1}
                      onChange={(e) =>
                        updateLot(idx, {
                          trailPct: Math.min(
                            50,
                            Math.max(0.1, Number(e.target.value) || 0.1)
                          ),
                        })
                      }
                      className="field-input w-20"
                    />
                    <span className="text-xs text-neutral-500">
                      % below peak
                    </span>
                  </span>
                )}
              </span>
            </label>
            <label className="mt-2 flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                checked={Boolean(rule.trailToCost)}
                onChange={(e) =>
                  updateLot(idx, {
                    trailToCost: e.target.checked,
                    armToCostOnPartialTp:
                      e.target.checked && nLots > 1
                        ? rule.armToCostOnPartialTp !== false
                        : rule.armToCostOnPartialTp,
                  })
                }
                className="mt-0.5 h-4 w-4 accent-black"
              />
              <span className="flex-1 text-sm">
                Trail to cost (breakeven)
                {rule.trailToCost && (
                  <span className="mt-1 flex flex-col gap-1">
                    <span className="flex items-center gap-2">
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={rule.trailToCostProfitPctOfCapital ?? 20}
                        onChange={(e) =>
                          updateLot(idx, {
                            trailToCostProfitPctOfCapital: Math.min(
                              100,
                              Math.max(1, Number(e.target.value) || 1)
                            ),
                          })
                        }
                        className="field-input w-20"
                      />
                      <span className="text-xs text-neutral-500">
                        % of capital (this lot&apos;s share) to arm BE
                      </span>
                    </span>
                    {nLots > 1 && (
                      <label className="flex cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          checked={rule.armToCostOnPartialTp !== false}
                          onChange={(e) =>
                            updateLot(idx, {
                              armToCostOnPartialTp: e.target.checked,
                            })
                          }
                          className="h-4 w-4 accent-black"
                        />
                        <span className="text-xs text-neutral-600">
                          Arm BE when another lot takes profit
                        </span>
                      </label>
                    )}
                  </span>
                )}
              </span>
            </label>
            <label className="mt-2 flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={rule.exitOnSignal !== false}
                onChange={(e) =>
                  updateLot(idx, { exitOnSignal: e.target.checked })
                }
                className="h-4 w-4 accent-black"
              />
              <span className="text-sm">
                Exit on strategy signal
              </span>
            </label>
          </div>
        );
      })}
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
}: {
  label: string;
  window: EntryTimeWindow;
  onChange: (w: EntryTimeWindow) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 sm:gap-3">
      <label className="flex items-center gap-2 text-xs font-medium text-neutral-700">
        <input
          type="checkbox"
          checked={window.enabled}
          onChange={(e) =>
            onChange({ ...window, enabled: e.target.checked })
          }
          className="h-3.5 w-3.5 accent-black"
        />
        {label}
      </label>
      <input
        type="time"
        value={window.start}
        disabled={!window.enabled}
        onChange={(e) => onChange({ ...window, start: e.target.value })}
        className="field-input w-auto py-1.5 text-sm disabled:opacity-40"
      />
      <span className="text-xs text-neutral-400">to</span>
      <input
        type="time"
        value={window.end}
        disabled={!window.enabled}
        onChange={(e) => onChange({ ...window, end: e.target.value })}
        className="field-input w-auto py-1.5 text-sm disabled:opacity-40"
      />
      <span className="text-[10px] text-neutral-400">IST</span>
    </div>
  );
}

/** NSE trading symbol (strip exchange suffixes). */
function cleanSymbol(s: string): string {
  return s
    .trim()
    .toUpperCase()
    .replace(/\.NS$/i, "")
    .replace(/\.BO$/i, "")
    .replace(/\.BSE$/i, "");
}

/** True if every trade has valid prices/PnL (safe to cache/upload). */
function dayTradesAreClean(trades: Trade[]): boolean {
  for (const t of trades) {
    if (
      !Number.isFinite(t.entryTime) ||
      !Number.isFinite(t.exitTime) ||
      !Number.isFinite(t.entryPrice) ||
      !Number.isFinite(t.exitPrice) ||
      !Number.isFinite(t.pnl) ||
      t.entryPrice < 0 ||
      t.exitPrice < 0
    ) {
      return false;
    }
  }
  return true;
}
