/**
 * Shared single-symbol backtest job used by /api/backtest and /api/scan.
 */
import { runBacktest } from "./backtest";
import { fetchYahooCandles } from "./data/yahoo";
import { fetchUpstoxCandles } from "./data/upstox";
import { resolveUpstoxInstrumentKey } from "./data/upstox-instruments";
import { resolveFnoMeta } from "./data/fno-meta";
import { generateSampleCandles } from "./data/sample";
import { sanitizeToken } from "./http";
import type { BacktestRequest, BacktestResult } from "./types";

export async function runBacktestJob(
  body: BacktestRequest
): Promise<BacktestResult & { instrumentKey?: string }> {
  if (!body.symbol?.trim() && body.source !== "sample") {
    throw new Error("Symbol is required");
  }
  if (!body.from || !body.to) {
    throw new Error("from and to dates are required");
  }
  if (!body.strategy?.entry?.length) {
    throw new Error("Strategy needs at least one entry condition");
  }
  if (!body.strategy?.exit?.length) {
    throw new Error("Strategy needs at least one exit condition");
  }

  const interval = body.interval || "5m";
  let symbol = body.symbol?.trim() || "SAMPLE";
  let candles;
  let resolvedInstrumentKey: string | undefined;
  let lotSource = "manual";

  if (body.source === "upstox") {
    const resolved = await resolveUpstoxInstrumentKey(
      body.upstoxInstrumentKey?.includes("|")
        ? body.upstoxInstrumentKey
        : symbol
    );
    resolvedInstrumentKey = resolved.instrumentKey;
    symbol = resolved.tradingSymbol;

    candles = await fetchUpstoxCandles({
      instrumentKey: resolved.instrumentKey,
      interval,
      from: body.from,
      to: body.to,
      accessToken: sanitizeToken(
        body.upstoxAccessToken || process.env.UPSTOX_ACCESS_TOKEN || ""
      ),
    });
  } else if (body.source === "sample") {
    candles = generateSampleCandles(symbol, interval, body.from, body.to);
  } else {
    const ySym = symbol.includes(".") ? symbol : `${symbol}.NS`;
    candles = await fetchYahooCandles(ySym, interval, body.from, body.to);
    symbol = symbol.replace(/\.NS$/i, "").replace(/\.BO$/i, "");
  }

  if (!candles.length) {
    throw new Error(
      `No candles for ${symbol} from ${body.from} to ${body.to}`
    );
  }

  let options = body.options;
  if (body.tradeInstrument === "options_atm") {
    const fno = await resolveFnoMeta(symbol);
    const userLot = Number(options?.lotSize) || 0;
    const userStep = Number(options?.strikeStep) || 0;
    options = {
      side: options?.side || "CE",
      lotSize: userLot > 0 ? userLot : fno.lotSize,
      strikeStep: userStep > 0 ? userStep : fno.strikeStep,
      listedStrikes: fno.strikes || [],
      iv: options?.iv ?? 0.18,
      daysToExpiry: options?.daysToExpiry ?? 7,
    };
    lotSource =
      userLot > 0
        ? "manual"
        : fno.source === "nse_fo"
          ? `NSE F&O (${fno.symbol}, ${fno.strikes?.length || 0} strikes)`
          : `fallback (${fno.symbol})`;
  }

  const result = runBacktest(candles, {
    ...body,
    symbol,
    interval,
    options,
    initialCapital: body.initialCapital ?? 100000,
    positionSizePct: body.positionSizePct ?? 100,
  });

  if (result.optionsMeta) {
    result.optionsMeta.lotSource = lotSource;
  }

  return {
    ...result,
    symbol,
    instrumentKey: resolvedInstrumentKey,
  };
}
