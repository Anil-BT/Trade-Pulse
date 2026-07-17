/**
 * Sector-trend F&O scan:
 *  1) Load candles for equity F&O universe
 *  2) Rank configurable IST window returns → top N sectors × top M stocks
 *  3) Auto (or forced) bull/bear per day from top-sector bias
 *  4) Backtest bull/bear strategies after window end on pick days
 */
import { listFnoEquitySymbols } from "./data/fno-meta";
import { fetchUpstoxCandles } from "./data/upstox";
import { resolveUpstoxInstrumentKey } from "./data/upstox-instruments";
import { fetchDhanCandles } from "./data/dhan";
import { fetchKiteCandles } from "./data/kite";
import { sanitizeToken, safeErrorMessage } from "./http";
import { runBacktestJob } from "./run-job";
import {
  buildSectorTrendPicks,
  formatMinsToHm,
  morningWindowStats,
  pickBalancedUniverse,
  resolveWindowMins,
  stockSector,
  type SectorTrendConfig,
  type SectorTrendMode,
  type SectorWeightMode,
  type StockDayReturn,
} from "./sector-trend";
import {
  PRESET_SECTOR_OR_EMA20_VWAP_FIB_BEAR,
  PRESET_SECTOR_OR_EMA20_VWAP_FIB_BULL,
} from "./presets";
import type {
  BacktestRequest,
  Candle,
  EntryTimeWindow,
  ScanReport,
  ScanRow,
  ScanTradeDetail,
  StrategyConfig,
  TradeInstrument,
} from "./types";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export type SectorTrendScanParams = {
  from: string;
  to: string;
  interval?: BacktestRequest["interval"];
  source?: BacktestRequest["source"];
  /** Forced strategies; defaults to sector OR+EMA20+VWAP+Fib presets */
  bullStrategy?: StrategyConfig;
  bearStrategy?: StrategyConfig;
  trend: SectorTrendConfig;
  initialCapital?: number;
  positionSizePct?: number;
  oneTradePerDay?: boolean;
  maxRiskPerTrade?: BacktestRequest["maxRiskPerTrade"];
  tradeInstrument?: TradeInstrument;
  options?: BacktestRequest["options"];
  /** Session end for entries after ranking window (IST HH:mm) */
  entryEnd?: string;
  upstoxAccessToken?: string;
  dhanAccessToken?: string;
  dhanClientId?: string;
  kiteApiKey?: string;
  kiteAccessToken?: string;
  maxSymbols?: number;
  concurrency?: number;
  scanAll?: boolean;
};

async function fetchSymbolCandles(
  symbol: string,
  params: SectorTrendScanParams
): Promise<{ symbol: string; candles: Candle[] }> {
  const interval = params.interval || "5m";
  const source = params.source || "upstox";
  const from = params.from;
  const to = params.to;
  let sym = symbol.toUpperCase().replace(/\.NS$/i, "");

  if (source === "upstox") {
    const token = sanitizeToken(
      params.upstoxAccessToken || process.env.UPSTOX_ACCESS_TOKEN || ""
    );
    if (!token) {
      throw new Error("Upstox access token required for sector-trend scan");
    }
    const resolved = await resolveUpstoxInstrumentKey(sym);
    sym = resolved.tradingSymbol;
    const candles = await fetchUpstoxCandles({
      instrumentKey: resolved.instrumentKey,
      interval,
      from,
      to,
      accessToken: token,
      lookbackDays: 10,
    });
    return { symbol: sym, candles };
  }
  if (source === "dhan") {
    const candles = await fetchDhanCandles({
      symbol: sym,
      interval,
      from,
      to,
      accessToken: sanitizeToken(
        params.dhanAccessToken || process.env.DHAN_ACCESS_TOKEN || ""
      ),
      clientId:
        sanitizeToken(
          params.dhanClientId || process.env.DHAN_CLIENT_ID || ""
        ) || undefined,
    });
    return { symbol: sym, candles };
  }
  if (source === "kite") {
    const candles = await fetchKiteCandles({
      symbol: sym,
      interval,
      from,
      to,
      apiKey: sanitizeToken(
        params.kiteApiKey || process.env.KITE_API_KEY || ""
      ),
      accessToken: sanitizeToken(
        params.kiteAccessToken || process.env.KITE_ACCESS_TOKEN || ""
      ),
    });
    return { symbol: sym, candles };
  }
  throw new Error(`Unsupported source ${source}`);
}

function mergeScanRows(a: ScanRow | undefined, b: ScanRow): ScanRow {
  if (!a) return b;
  const tradeList = [...(a.tradeList || []), ...(b.tradeList || [])].sort(
    (x, y) => x.entryTime - y.entryTime
  );
  const trades = tradeList.length;
  const winners = tradeList.filter((t) => t.pnl > 0).length;
  const totalPnl = tradeList.reduce((s, t) => s + t.pnl, 0);
  const status: ScanRow["status"] =
    a.status === "error" && b.status === "error"
      ? "error"
      : trades > 0
        ? "ok"
        : a.status === "error" || b.status === "error"
          ? "error"
          : "no_trades";
  return {
    symbol: a.symbol || b.symbol,
    lotSize: a.lotSize ?? b.lotSize,
    trades,
    winRate: trades ? (winners / trades) * 100 : 0,
    totalPnl,
    totalPnlPct: a.totalPnlPct, // not meaningful merged
    finalEquity: Math.max(a.finalEquity, b.finalEquity),
    equitySignals: (a.equitySignals || 0) + (b.equitySignals || 0),
    status,
    message: [a.message, b.message].filter(Boolean).join(" · "),
    tradeList,
    error: status === "error" ? a.error || b.error : undefined,
  };
}

export async function runSectorTrendScan(
  params: SectorTrendScanParams
): Promise<ScanReport> {
  const {
    from,
    to,
    initialCapital = 100_000,
    positionSizePct = 100,
    oneTradePerDay = true,
    tradeInstrument = "options_atm",
    maxSymbols = 200,
    concurrency = 3,
    scanAll = false,
  } = params;

  const trend: SectorTrendConfig = {
    windowStart: params.trend?.windowStart || "09:15",
    windowEnd: params.trend?.windowEnd || "09:45",
    topSectors: params.trend?.topSectors ?? 2,
    topStocksPerSector: params.trend?.topStocksPerSector ?? 3,
    mode: (params.trend?.mode || "auto") as SectorTrendMode,
    biasThreshold: params.trend?.biasThreshold ?? 0,
    weightMode: (params.trend?.weightMode || "turnover") as SectorWeightMode,
    minStocks: params.trend?.minStocks ?? 2,
    minBreadthPct: params.trend?.minBreadthPct ?? 0,
  };

  const { startMins, endMins, startLabel, endLabel } = resolveWindowMins(trend);
  const entryStart = endLabel; // entries only after ranking window
  const entryEnd = params.entryEnd || "15:15";
  const entryWindows: EntryTimeWindow[] = [
    { enabled: true, start: entryStart, end: entryEnd },
  ];

  const bullStrategy =
    params.bullStrategy || PRESET_SECTOR_OR_EMA20_VWAP_FIB_BULL;
  const bearStrategy =
    params.bearStrategy || PRESET_SECTOR_OR_EMA20_VWAP_FIB_BEAR;

  const interval = params.interval || "5m";
  const source = params.source || "upstox";

  const universe = await listFnoEquitySymbols();
  // Balanced across sectors (not A–Z slice) so top-sector picks have real members
  const list = scanAll
    ? universe
    : pickBalancedUniverse(
        universe,
        Math.min(Math.max(20, Number(maxSymbols) || 80), 400)
      );
  const conc = Math.min(Math.max(1, Number(concurrency) || 3), 6);

  type Loaded = {
    /** Resolved trading symbol used for candles / backtest */
    symbol: string;
    requestSymbol: string;
    lotSize: number;
    candles: Candle[];
    error?: string;
  };
  const loaded: Loaded[] = [];
  let idx = 0;

  async function loadWorker() {
    while (idx < list.length) {
      const i = idx++;
      const item = list[i];
      try {
        const { symbol, candles } = await fetchSymbolCandles(
          item.symbol,
          params
        );
        if (!candles.length) {
          loaded.push({
            symbol: item.symbol,
            requestSymbol: item.symbol,
            lotSize: item.lotSize,
            candles: [],
            error: "No candles",
          });
        } else {
          loaded.push({
            symbol,
            requestSymbol: item.symbol,
            lotSize: item.lotSize,
            candles,
          });
        }
      } catch (e) {
        loaded.push({
          symbol: item.symbol,
          requestSymbol: item.symbol,
          lotSize: item.lotSize,
          candles: [],
          error: safeErrorMessage(e),
        });
      }
      await sleep(100);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(conc, list.length) }, () => loadWorker())
  );

  const stockDays: StockDayReturn[] = [];
  /** Keys: resolved + request symbol (uppercase) */
  const candleBySymbol = new Map<string, Loaded>();

  let okLoads = 0;
  let withMorningRet = 0;
  const sectorSample = new Map<string, number>();

  for (const row of loaded) {
    candleBySymbol.set(row.symbol.toUpperCase(), row);
    candleBySymbol.set(row.requestSymbol.toUpperCase(), row);
    if (!row.candles.length || row.error) continue;
    okLoads += 1;
    const stats = morningWindowStats(row.candles, startMins, endMins);
    if (stats.size === 0) continue;
    withMorningRet += 1;
    // Prefer sector of request name (map-friendly), fall back to resolved
    const sector =
      stockSector(row.requestSymbol) !== "Others"
        ? stockSector(row.requestSymbol)
        : stockSector(row.symbol);
    sectorSample.set(sector, (sectorSample.get(sector) || 0) + 1);
    for (const [date, st] of stats) {
      // Only rank days inside the requested backtest range (skip lookback days)
      if (date < from || date > to) continue;
      stockDays.push({
        symbol: row.symbol,
        date,
        changePct: st.changePct,
        turnover: st.turnover,
        sector,
      });
    }
  }

  const {
    dayPicks,
    allowedBullBySymbol,
    allowedBearBySymbol,
    bullDays,
    bearDays,
  } = buildSectorTrendPicks(stockDays, trend);

  // Keep only dates inside [from, to] on allow-lists
  const clipDates = (m: Map<string, string[]>) => {
    for (const [sym, dates] of m) {
      const clipped = dates.filter((d) => d >= from && d <= to);
      if (clipped.length) m.set(sym, clipped);
      else m.delete(sym);
    }
  };
  clipDates(allowedBullBySymbol);
  clipDates(allowedBearBySymbol);

  const allPickSymbols = new Set([
    ...allowedBullBySymbol.keys(),
    ...allowedBearBySymbol.keys(),
  ]);

  const rowBySymbol = new Map<string, ScanRow>();

  // Sample load errors
  for (const row of loaded) {
    if (row.error && !allPickSymbols.has(row.symbol)) {
      // keep sample later
    }
  }

  type Job = {
    symbol: string;
    direction: "bullish" | "bearish";
    allowed: string[];
    strategy: StrategyConfig;
    optionSide: "CE" | "PE";
  };

  const jobs: Job[] = [];
  for (const [sym, dates] of allowedBullBySymbol) {
    if (dates.length)
      jobs.push({
        symbol: sym,
        direction: "bullish",
        allowed: dates,
        strategy: bullStrategy,
        optionSide: "CE",
      });
  }
  for (const [sym, dates] of allowedBearBySymbol) {
    if (dates.length)
      jobs.push({
        symbol: sym,
        direction: "bearish",
        allowed: dates,
        strategy: bearStrategy,
        optionSide: "PE",
      });
  }

  const bullJobCount = jobs.filter((j) => j.direction === "bullish").length;
  const bearJobCount = jobs.filter((j) => j.direction === "bearish").length;

  let jIdx = 0;
  async function backtestWorker() {
    while (jIdx < jobs.length) {
      const j = jIdx++;
      const job = jobs[j];
      const pack =
        candleBySymbol.get(job.symbol.toUpperCase()) ||
        candleBySymbol.get(job.symbol);
      const pickNote = `${job.direction} pick ${job.allowed.length}d: ${job.allowed.slice(0, 4).join(", ")}${job.allowed.length > 4 ? "…" : ""} · strategy “${job.strategy.name}”`;

      if (!pack?.candles?.length) {
        const errRow: ScanRow = {
          symbol: job.symbol,
          lotSize: 0,
          trades: 0,
          winRate: 0,
          totalPnl: 0,
          totalPnlPct: 0,
          finalEquity: initialCapital,
          status: "error",
          error: "No candles for picked stock",
          message: `Picked but no candles · ${pickNote}`,
          tradeList: [],
        };
        const prev = rowBySymbol.get(job.symbol);
        rowBySymbol.set(job.symbol, mergeScanRows(prev, errRow));
        continue;
      }

      const baseOpts = params.options;
      const options =
        tradeInstrument === "options_atm"
          ? {
              side: job.optionSide,
              lotSize: baseOpts?.lotSize ?? 0,
              strikeStep: baseOpts?.strikeStep ?? 0,
              iv: baseOpts?.iv ?? 0.18,
              daysToExpiry: baseOpts?.daysToExpiry ?? 7,
              listedStrikes: baseOpts?.listedStrikes,
            }
          : undefined;

      try {
        const result = await runBacktestJob(
          {
            symbol: job.symbol,
            interval,
            from,
            to,
            source,
            strategy: job.strategy,
            initialCapital,
            positionSizePct,
            oneTradePerDay,
            entryTimeWindows: entryWindows,
            maxRiskPerTrade: params.maxRiskPerTrade,
            tradeInstrument,
            options,
            upstoxAccessToken: params.upstoxAccessToken,
            dhanAccessToken: params.dhanAccessToken,
            dhanClientId: params.dhanClientId,
            kiteApiKey: params.kiteApiKey,
            kiteAccessToken: params.kiteAccessToken,
            // Shortlist gates days only; strategy entry (OR/VWAP/…) still required
            allowedEntryDates: job.allowed,
          },
          { candles: pack.candles }
        );

        const m = result.metrics;
        const tradeList: ScanTradeDetail[] = (result.trades || []).map((t) => ({
          entryTime: t.entryTime,
          exitTime: t.exitTime,
          entryPrice: t.entryPrice,
          exitPrice: t.exitPrice,
          capitalUsed: t.capitalUsed ?? t.entryPrice * t.qty,
          underlyingEntry: t.underlyingEntry,
          underlyingExit: t.underlyingExit,
          strike: t.strike,
          optionSide: t.optionSide || job.optionSide,
          lots: t.lots,
          lotSize: t.lotSize,
          label: t.label || `${job.direction}`,
          pnl: t.pnl,
          pnlPct: t.pnlPct,
          barsHeld: t.barsHeld,
        }));

        const sig = result.diagnostics?.equitySignals ?? 0;
        const row: ScanRow =
          m.totalTrades > 0
            ? {
                symbol: result.symbol || job.symbol,
                lotSize: result.optionsMeta?.lotSize ?? pack.lotSize,
                trades: m.totalTrades,
                winRate: m.winRate,
                totalPnl: m.totalPnl,
                totalPnlPct: m.totalPnlPct,
                finalEquity: m.finalEquity,
                equitySignals: sig,
                status: "ok",
                message: `${m.totalTrades} ${job.direction} trade(s) · ${pickNote}`,
                tradeList,
              }
            : {
                symbol: result.symbol || job.symbol,
                lotSize: result.optionsMeta?.lotSize ?? pack.lotSize,
                trades: 0,
                winRate: 0,
                totalPnl: 0,
                totalPnlPct: 0,
                finalEquity: m.finalEquity,
                equitySignals: sig,
                status: "no_trades",
                message:
                  result.diagnostics?.note ||
                  (sig === 0
                    ? `Picked ${job.direction} but no entry bar after ${entryStart} (check dates/window) · ${pickNote}`
                    : `Signals ${sig}x but no fills (capital/premium?) · ${pickNote}`),
                tradeList: [],
              };

        const prev = rowBySymbol.get(job.symbol);
        rowBySymbol.set(job.symbol, mergeScanRows(prev, row));
      } catch (e) {
        const errMsg = safeErrorMessage(e);
        const errRow: ScanRow = {
          symbol: job.symbol,
          lotSize: pack.lotSize,
          trades: 0,
          winRate: 0,
          totalPnl: 0,
          totalPnlPct: 0,
          finalEquity: initialCapital,
          error: errMsg,
          status: "error",
          message: `${job.direction}: ${errMsg} · ${pickNote}`,
          tradeList: [],
        };
        const prev = rowBySymbol.get(job.symbol);
        rowBySymbol.set(job.symbol, mergeScanRows(prev, errRow));
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(conc, Math.max(1, jobs.length)) },
      () => backtestWorker()
    )
  );

  const pickRows = [...rowBySymbol.values()];
  const errorSample = loaded
    .filter((r) => r.error && !allPickSymbols.has(r.symbol))
    .slice(0, 12)
    .map(
      (r): ScanRow => ({
        symbol: r.symbol,
        lotSize: r.lotSize,
        trades: 0,
        winRate: 0,
        totalPnl: 0,
        totalPnlPct: 0,
        finalEquity: initialCapital,
        error: r.error,
        status: "error",
        message: r.error,
        tradeList: [],
      })
    );

  const finalRows = [...pickRows, ...errorSample].sort((a, b) => {
    const order = { ok: 0, no_trades: 1, error: 2 } as const;
    if (order[a.status] !== order[b.status]) {
      return order[a.status] - order[b.status];
    }
    return b.totalPnl - a.totalPnl;
  });

  const withTrades = finalRows.filter((r) => r.trades > 0);
  const totalPnl = withTrades.reduce((s, r) => s + r.totalPnl, 0);
  const totalTrades = finalRows.reduce((s, r) => s + r.trades, 0);

  const modeLabel = trend.mode || "auto";
  const strategyName =
    modeLabel === "auto"
      ? `Sector trend auto (${startLabel}–${endLabel})`
      : modeLabel === "bearish"
        ? bearStrategy.name
        : bullStrategy.name;

  const topSectorsSample = [...sectorSample.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([s, n]) => `${s}(${n})`)
    .join(", ");

  const pickCount = allPickSymbols.size;
  const bearTrades = finalRows.reduce(
    (n, r) =>
      n +
      (r.tradeList || []).filter(
        (t) =>
          t.optionSide === "PE" ||
          (t.label || "").toLowerCase().includes("bear")
      ).length,
    0
  );
  const bullTrades = finalRows.reduce(
    (n, r) =>
      n +
      (r.tradeList || []).filter(
        (t) =>
          t.optionSide === "CE" ||
          (t.label || "").toLowerCase().includes("bull")
      ).length,
    0
  );

  const diag =
    `Load: ${okLoads}/${list.length} ok candles, ${withMorningRet} with ${startLabel}–${endLabel} returns, ` +
    `${stockDays.length} stock-days, ${dayPicks.length} pick-day(s). ` +
    `Jobs: ${bullJobCount} bull (“${bullStrategy.name}”) / ${bearJobCount} bear (“${bearStrategy.name}”). ` +
    `Trades tagged: ${bullTrades} bull / ${bearTrades} bear. ` +
    (topSectorsSample ? `Sectors seen: ${topSectorsSample}. ` : "") +
    (pickCount === 0
      ? "No stocks picked — check Upstox token, use 5m, trading days, or raise max symbols. "
      : "") +
    (bearJobCount === 0 && modeLabel === "auto"
      ? "No red among top sectors (top bars were all green or flat). "
      : "") +
    (bullJobCount === 0 && modeLabel === "auto"
      ? "No green among top sectors (top bars were all red or flat). "
      : "");

  return {
    generatedAt: new Date().toISOString(),
    strategyName:
      modeLabel === "auto"
        ? `Sector dual · ${bullStrategy.name} / ${bearStrategy.name}`
        : strategyName,
    from,
    to,
    interval,
    source,
    tradeInstrument: tradeInstrument || "equity",
    oneTradePerDay: Boolean(oneTradePerDay),
    universeSize: universe.length,
    scanned: finalRows.length,
    summary: {
      ok: finalRows.filter((r) => r.status === "ok").length,
      errors: finalRows.filter((r) => r.status === "error").length,
      withTrades: withTrades.length,
      totalTrades,
      totalPnl,
      avgPnl: withTrades.length ? totalPnl / withTrades.length : 0,
      winners: withTrades.filter((r) => r.totalPnl > 0).length,
      losers: withTrades.filter((r) => r.totalPnl <= 0).length,
    },
    rows: finalRows,
    sectorTrend: {
      mode: modeLabel,
      windowStart: startLabel,
      windowEnd: endLabel,
      windowLabel: `${startLabel}–${endLabel} IST`,
      topSectors: trend.topSectors ?? 2,
      topStocksPerSector: trend.topStocksPerSector ?? 3,
      biasThreshold: trend.biasThreshold ?? 0,
      weightMode: trend.weightMode ?? "turnover",
      minStocks: trend.minStocks ?? 2,
      minBreadthPct: trend.minBreadthPct ?? 0,
      bullDays,
      bearDays,
      dayPicks,
      note:
        `Strength: ${trend.weightMode ?? "turnover"}-weighted return, min ${trend.minStocks ?? 3} stocks, ` +
        `breadth ≥ ${trend.minBreadthPct ?? 55}%, min |bar| ${trend.biasThreshold ?? 0}%. ` +
        `Top ${trend.topSectors ?? 2} by |score| (bull/bear/mix). ` +
        `Green → “${bullStrategy.name}” (CE), red → “${bearStrategy.name}” (PE). ` +
        `Shortlist limits pick days after ${entryStart}; strategy entry (OR mins from 09:15, VWAP, …) must still be true. ` +
        `${trend.topStocksPerSector ?? 3} stocks/sector. ` +
        diag,
    },
  };
}

// re-export for callers that need labels
export { formatMinsToHm, resolveWindowMins };
