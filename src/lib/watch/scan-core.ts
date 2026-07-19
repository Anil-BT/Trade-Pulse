/**
 * Core Market Watch batch scan (shared by POST /api/watch/scan and shared worker).
 */
import { listFnoEquitySymbols } from "../data/fno-meta";
import { fetchUpstoxCandles } from "../data/upstox";
import { resolveUpstoxInstrumentKey } from "../data/upstox-instruments";
import {
  fetchYahooCandles,
  YAHOO_FNO_SAMPLE,
  toYahooSymbol,
} from "../data/yahoo";
import { todayIst } from "../paper/market-hours";
import { isRateLimitError } from "../paper/sanitize";
import { sanitizeToken } from "../http";
import {
  matchStrategyOnCandles,
  quoteFromCandles,
  type MatchScanMode,
  type WatchMatch,
  type WatchQuote,
} from "./match";
import type { Interval, StrategyConfig } from "../types";

export type WatchDataSource = "yahoo" | "upstox";

const BATCH_YAHOO = 25;
const BATCH_UPSTOX = 40;

export type WatchBatchResult = {
  generatedAt: string;
  today: string;
  interval: string;
  source: WatchDataSource;
  delayed: boolean;
  strategies: string[];
  matchMode: MatchScanMode;
  universeSize: number;
  scanned: number;
  matchCount: number;
  quoteCount: number;
  rateLimited: number;
  errors: number;
  matches: (WatchMatch & { strategyName: string })[];
  quotes: WatchQuote[];
  batchSymbols: string[];
  rotationOffset: number;
  nextOffset: number;
  batchSize: number;
  batchIndex: number;
  batchesPerCycle: number;
  rotateUniverse: boolean;
  note: string;
  yahooSample?: string;
  error?: string;
};

export type WatchBatchParams = {
  strategies?: StrategyConfig[];
  interval?: Interval;
  source?: WatchDataSource;
  upstoxAccessToken?: string;
  rotateUniverse?: boolean;
  rotationOffset?: number;
  batchSize?: number;
  matchMode?: MatchScanMode;
  symbols?: string[];
};

export async function runWatchBatch(
  params: WatchBatchParams
): Promise<WatchBatchResult> {
  const {
    strategies,
    interval = "5m",
    source = "yahoo",
    upstoxAccessToken,
    rotateUniverse = true,
    rotationOffset = 0,
    batchSize,
    matchMode = "session",
    symbols: symbolFilter,
  } = params;

  const mode: MatchScanMode = matchMode === "last" ? "last" : "session";
  const dataSource: WatchDataSource =
    source === "upstox" ? "upstox" : "yahoo";

  const token = sanitizeToken(
    String(upstoxAccessToken || process.env.UPSTOX_ACCESS_TOKEN || "")
  );
  if (dataSource === "upstox" && !token) {
    throw new Error(
      "Upstox access token required for live source. Or use Yahoo (free/dev)."
    );
  }

  const strats = (strategies || []).filter((s) => s?.name && s.entry?.length);

  let universe: { symbol: string; lotSize: number }[] = [];
  if (symbolFilter?.length) {
    universe = symbolFilter.map((s) => ({
      symbol: s.toUpperCase().replace(/\.NS$/i, ""),
      lotSize: 0,
    }));
  } else if (dataSource === "yahoo") {
    try {
      const fo = await listFnoEquitySymbols();
      universe =
        fo.length > 20
          ? fo.map((x) => ({ symbol: x.symbol, lotSize: x.lotSize }))
          : YAHOO_FNO_SAMPLE.map((s) => ({ symbol: s, lotSize: 0 }));
    } catch {
      universe = YAHOO_FNO_SAMPLE.map((s) => ({ symbol: s, lotSize: 0 }));
    }
  } else {
    universe = (await listFnoEquitySymbols()).map((x) => ({
      symbol: x.symbol,
      lotSize: x.lotSize,
    }));
  }

  universe.sort((a, b) => a.symbol.localeCompare(b.symbol));
  const universeSize = universe.length;
  if (!universeSize) {
    throw new Error("F&O universe empty — try again later");
  }

  const defaultBatch = dataSource === "yahoo" ? BATCH_YAHOO : BATCH_UPSTOX;
  const size = Math.min(
    defaultBatch,
    Math.max(5, Number(batchSize) || defaultBatch),
    universeSize
  );

  const offset =
    ((Number(rotationOffset) || 0) % universeSize + universeSize) %
    universeSize;
  const list: typeof universe = [];
  const batchSymbols: string[] = [];
  for (let j = 0; j < size; j++) {
    const item = universe[(offset + j) % universeSize];
    list.push(item);
    batchSymbols.push(item.symbol);
  }
  const nextOffset = (offset + size) % universeSize;
  const batchesPerCycle = Math.ceil(universeSize / size);
  const batchIndex = Math.floor(offset / size) + 1;

  const today = todayIst();
  const matches: (WatchMatch & { strategyName: string })[] = [];
  const quotes: WatchQuote[] = [];
  let scanned = 0;
  let errors = 0;
  let rateLimited = 0;
  const errorSamples: string[] = [];

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    try {
      let symbol = item.symbol;
      let candles;

      if (dataSource === "yahoo") {
        candles = await fetchYahooCandles({
          symbol: item.symbol,
          interval: interval as Interval,
          lookbackDays: 12,
        });
        symbol = item.symbol.replace(/\.NS$/i, "");
      } else {
        const resolved = await resolveUpstoxInstrumentKey(item.symbol, "NSE");
        symbol = resolved.tradingSymbol || item.symbol;
        candles = await fetchUpstoxCandles({
          instrumentKey: resolved.instrumentKey,
          interval: interval as Interval,
          from: today,
          to: today,
          accessToken: token,
          lookbackDays: 12,
        });
      }

      scanned += 1;
      if (candles.length < 2) continue;

      const q = quoteFromCandles(candles);
      if (q) {
        quotes.push({ symbol, ...q });
      }

      if (candles.length >= 5 && strats.length) {
        for (const strategy of strats) {
          const m = matchStrategyOnCandles(candles, strategy, { mode });
          if (m) {
            matches.push({
              symbol,
              strategyName: strategy.name,
              ...m,
            });
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isRateLimitError(msg) || /429|rate limit/i.test(msg)) {
        rateLimited += 1;
        await new Promise((r) =>
          setTimeout(r, dataSource === "yahoo" ? 3000 : 1500)
        );
      } else {
        errors += 1;
        if (errorSamples.length < 5) {
          errorSamples.push(`${item.symbol}: ${msg.slice(0, 80)}`);
        }
      }
    }
    if (dataSource === "yahoo") {
      await new Promise((r) => setTimeout(r, 300));
    } else if (i % 5 === 4) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  matches.sort((a, b) => {
    const c = a.strategyName.localeCompare(b.strategyName);
    if (c !== 0) return c;
    return a.symbol.localeCompare(b.symbol);
  });

  const notes: string[] = [];
  if (dataSource === "yahoo") {
    notes.push(
      "Yahoo free feed — delayed/unofficial, not for live trading. Equity underlyings only (.NS)."
    );
  }
  notes.push(
    `Shared F&O rotation: batch ${batchIndex}/${batchesPerCycle} · offset ${offset} · ${size}/tick · match=${mode}.`
  );
  if (rateLimited) {
    notes.push(`${rateLimited} rate-limited this tick (retried next cycle).`);
  }
  if (errorSamples.length) {
    notes.push(`Examples: ${errorSamples.join(" · ")}`);
  }

  return {
    generatedAt: new Date().toISOString(),
    today,
    interval,
    source: dataSource,
    delayed: dataSource === "yahoo",
    strategies: strats.map((s) => s.name),
    matchMode: mode,
    universeSize,
    scanned,
    matchCount: matches.length,
    quoteCount: quotes.length,
    rateLimited,
    errors,
    matches,
    quotes,
    batchSymbols,
    rotationOffset: offset,
    nextOffset,
    batchSize: size,
    batchIndex,
    batchesPerCycle,
    rotateUniverse: Boolean(rotateUniverse),
    note: notes.join(" "),
    yahooSample:
      dataSource === "yahoo"
        ? `Tickers like ${toYahooSymbol(list[0]?.symbol || "RELIANCE")}`
        : undefined,
  };
}
