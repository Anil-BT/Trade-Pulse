/**
 * Shared single-symbol backtest job used by /api/backtest and /api/scan.
 */
import { runBacktest } from "./backtest";
import { fetchUpstoxCandles } from "./data/upstox";
import { resolveUpstoxInstrumentKey } from "./data/upstox-instruments";
import { fetchDhanCandles } from "./data/dhan";
import { fetchKiteCandles } from "./data/kite";
import { resolveFnoMeta } from "./data/fno-meta";
import { sanitizeToken } from "./http";
import { createOptionPricer } from "./option-pricing";
import { computeIndicator, indicatorKey } from "./indicators";
import type {
  BacktestRequest,
  BacktestResult,
  CompareOperand,
  Condition,
  IndicatorType,
} from "./types";

function cleanSymbol(symbol: string): string {
  return symbol
    .trim()
    .toUpperCase()
    .replace(/\.NS$/i, "")
    .replace(/\.BO$/i, "");
}

export async function runBacktestJob(
  body: BacktestRequest
): Promise<BacktestResult & { instrumentKey?: string }> {
  if (!body.symbol?.trim()) {
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
  let symbol = cleanSymbol(body.symbol);
  let candles;
  let resolvedInstrumentKey: string | undefined;
  let lotSource = "manual";

  // Prefer request token; fall back to server env (useful on Vercel)
  const upstoxToken = sanitizeToken(
    body.upstoxAccessToken || process.env.UPSTOX_ACCESS_TOKEN || ""
  );
  if (body.source === "upstox" && !upstoxToken) {
    throw new Error(
      "Upstox access token is required. Paste it under Market data, or set UPSTOX_ACCESS_TOKEN in Vercel Environment Variables and redeploy."
    );
  }
  const dhanToken = sanitizeToken(
    body.dhanAccessToken || process.env.DHAN_ACCESS_TOKEN || ""
  );
  const dhanClientId = sanitizeToken(
    body.dhanClientId || process.env.DHAN_CLIENT_ID || ""
  );
  const kiteApiKey = sanitizeToken(
    body.kiteApiKey || process.env.KITE_API_KEY || ""
  );
  const kiteAccessToken = sanitizeToken(
    body.kiteAccessToken || process.env.KITE_ACCESS_TOKEN || ""
  );

  const source = body.source || "upstox";

  if (source === "upstox") {
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
      accessToken: upstoxToken,
    });
  } else if (source === "dhan") {
    candles = await fetchDhanCandles({
      symbol,
      interval,
      from: body.from,
      to: body.to,
      accessToken: dhanToken,
      clientId: dhanClientId || undefined,
    });
  } else if (source === "kite") {
    candles = await fetchKiteCandles({
      symbol,
      interval,
      from: body.from,
      to: body.to,
      apiKey: kiteApiKey,
      accessToken: kiteAccessToken,
    });
  } else {
    throw new Error(
      `Unknown data source “${source}”. Use upstox, dhan, or kite.`
    );
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

  // Option pricer: market OHLC when Upstox token present, else realized-vol model
  let optionPricer;
  if (body.tradeInstrument === "options_atm" && options) {
    const signalTimes = previewEntrySignals(
      candles,
      body.strategy.entry,
      body.strategy.entryLogic ?? "and",
      Boolean(body.oneTradePerDay)
    );

    optionPricer = await createOptionPricer({
      symbol,
      side: options.side || "CE",
      equityCandles: candles,
      from: body.from,
      to: body.to,
      interval,
      listedStrikes: options.listedStrikes || [],
      strikeStep: options.strikeStep || 0,
      lotSize: options.lotSize,
      preferredDaysToExpiry: options.daysToExpiry ?? 7,
      fallbackIv: options.iv ?? 0.18,
      accessToken: upstoxToken || undefined,
      signalTimes,
    });
  }

  const result = runBacktest(
    candles,
    {
      ...body,
      symbol,
      interval,
      source,
      options,
      initialCapital: body.initialCapital ?? 100000,
      positionSizePct: body.positionSizePct ?? 100,
    },
    { optionPricer }
  );

  if (result.optionsMeta) {
    result.optionsMeta.lotSource = lotSource;
  }

  return {
    ...result,
    symbol,
    instrumentKey: resolvedInstrumentKey,
  };
}

/** Quick dry-run of entry conditions to know which ATM contracts to prefetch. */
function previewEntrySignals(
  candles: import("./types").Candle[],
  entry: Condition[],
  logic: "and" | "or",
  oneTradePerDay: boolean
): { timeMs: number; spot: number }[] {
  const map = new Map<string, (number | null)[]>();
  map.set(
    "close",
    candles.map((c) => c.close)
  );
  map.set(
    "open",
    candles.map((c) => c.open)
  );
  map.set(
    "high",
    candles.map((c) => c.high)
  );
  map.set(
    "low",
    candles.map((c) => c.low)
  );
  map.set(
    "volume",
    candles.map((c) => c.volume)
  );

  const needed = new Map<string, { type: IndicatorType; period: number }>();
  for (const cond of entry) {
    collect(cond.left, needed);
    if (typeof cond.right !== "number") collect(cond.right, needed);
  }
  for (const [key, { type, period }] of needed) {
    if (!map.has(key)) map.set(key, computeIndicator(candles, type, period));
  }

  const out: { timeMs: number; spot: number }[] = [];
  let day = "";
  let used = 0;
  for (let i = 0; i < candles.length; i++) {
    const d = new Date(candles[i].time + 5.5 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    if (d !== day) {
      day = d;
      used = 0;
    }
    if (oneTradePerDay && used >= 1) continue;
    if (evalAll(entry, logic, i, map)) {
      out.push({ timeMs: candles[i].time, spot: candles[i].close });
      used += 1;
    }
  }
  return out;
}

function collect(
  op: CompareOperand,
  needed: Map<string, { type: IndicatorType; period: number }>
) {
  if (typeof op === "string") return;
  const period =
    op.period ??
    (op.indicator === "RSI"
      ? 14
      : op.indicator.startsWith("FIB") ||
          op.indicator.startsWith("OPENING") ||
          op.indicator.startsWith("PREV")
        ? 1
        : 9);
  needed.set(indicatorKey(op.indicator, period), {
    type: op.indicator,
    period,
  });
}

function evalAll(
  conditions: Condition[],
  logic: "and" | "or",
  i: number,
  map: Map<string, (number | null)[]>
): boolean {
  if (!conditions.length) return false;
  const res = conditions.map((c) => {
    const L = val(c.left, i, map);
    const R = val(c.right, i, map);
    if (L == null || R == null) return false;
    if (c.op === "gt") return L > R;
    if (c.op === "gte") return L >= R;
    if (c.op === "lt") return L < R;
    if (c.op === "lte") return L <= R;
    if (i === 0) return false;
    const Lp = val(c.left, i - 1, map);
    const Rp = val(c.right, i - 1, map);
    if (Lp == null || Rp == null) return false;
    if (c.op === "cross_above") return Lp <= Rp && L > R;
    if (c.op === "cross_below") return Lp >= Rp && L < R;
    return false;
  });
  return logic === "and" ? res.every(Boolean) : res.some(Boolean);
}

function val(
  operand: CompareOperand | number,
  i: number,
  map: Map<string, (number | null)[]>
): number | null {
  if (typeof operand === "number") return operand;
  if (typeof operand === "string") return map.get(operand)?.[i] ?? null;
  const period =
    operand.period ??
    (operand.indicator === "RSI"
      ? 14
      : operand.indicator.startsWith("FIB") ||
          operand.indicator.startsWith("OPENING") ||
          operand.indicator.startsWith("PREV")
        ? 1
        : 9);
  return map.get(indicatorKey(operand.indicator, period))?.[i] ?? null;
}
