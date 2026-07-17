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
import { dayBoundsUnix } from "./data/dates";
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

export type RunBacktestJobOpts = {
  /** Skip broker fetch when candles already loaded (sector-trend scan). */
  candles?: import("./types").Candle[];
  /**
   * When true, attach equity candles on the result so a second strategy
   * (e.g. bear after bull) can reuse them without another broker fetch.
   */
  includeCandles?: boolean;
};

export async function runBacktestJob(
  body: BacktestRequest,
  opts?: RunBacktestJobOpts
): Promise<
  BacktestResult & {
    instrumentKey?: string;
    candles?: import("./types").Candle[];
  }
> {
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
  let candles = opts?.candles;
  let resolvedInstrumentKey: string | undefined;
  let lotSource = "manual";

  // Prefer request token; fall back to server env (useful on Vercel)
  const upstoxToken = sanitizeToken(
    body.upstoxAccessToken || process.env.UPSTOX_ACCESS_TOKEN || ""
  );
  if (body.source === "upstox" && !upstoxToken && !candles?.length) {
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

  // Block new entries before the user's From date (warmup lookback still loads)
  const { startMs: entryNotBeforeMs } = dayBoundsUnix(
    body.from,
    body.to,
    `${symbol}.NS`
  );

  if (candles?.length) {
    // Preloaded — still resolve instrument key for options if needed
    if (source === "upstox") {
      try {
        const resolved = await resolveUpstoxInstrumentKey(
          body.upstoxInstrumentKey?.includes("|")
            ? body.upstoxInstrumentKey
            : symbol
        );
        resolvedInstrumentKey = resolved.instrumentKey;
        symbol = resolved.tradingSymbol;
      } catch {
        /* keep symbol */
      }
    }
  } else if (source === "upstox") {
    const resolved = await resolveUpstoxInstrumentKey(
      body.upstoxInstrumentKey?.includes("|")
        ? body.upstoxInstrumentKey
        : symbol
    );
    resolvedInstrumentKey = resolved.instrumentKey;
    symbol = resolved.tradingSymbol;

    try {
      candles = await fetchUpstoxCandles({
        instrumentKey: resolved.instrumentKey,
        interval,
        from: body.from,
        to: body.to,
        accessToken: upstoxToken,
        lookbackDays: body.leaveOpenPositions ? 12 : 10,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Stale ISIN / wrong static key → re-resolve from master and retry once
      if (/UDAPI100011|Invalid Instrument key/i.test(msg)) {
        const again = await resolveUpstoxInstrumentKey(symbol);
        if (again.instrumentKey === resolved.instrumentKey) {
          throw new Error(
            `Upstox invalid instrument key for ${symbol} (${resolved.instrumentKey}). Try symbol alias (e.g. TATAMOTORS → TMCV) or paste full NSE_EQ|… key.`
          );
        }
        resolvedInstrumentKey = again.instrumentKey;
        symbol = again.tradingSymbol;
        candles = await fetchUpstoxCandles({
          instrumentKey: again.instrumentKey,
          interval,
          from: body.from,
          to: body.to,
          accessToken: upstoxToken,
          lookbackDays: 10,
        });
      } else {
        throw e;
      }
    }
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

  if (!candles?.length) {
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
    const signalTimes = body.sectorPickEntry
      ? previewSectorPickSignals(
          candles,
          body.allowedEntryDates || [],
          body.entryTimeWindows,
          entryNotBeforeMs,
          Boolean(body.oneTradePerDay)
        )
      : previewEntrySignals(
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
      entryNotBeforeMs,
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
    ...(opts?.includeCandles && candles?.length ? { candles } : {}),
  };
}

/**
 * Sector-pick entry times: first bar on each allowed day that is after
 * entryNotBefore and inside entry windows (mirrors sectorPickEntry backtest).
 */
export function previewSectorPickSignals(
  candles: import("./types").Candle[],
  allowedDates: string[],
  entryWindows: import("./types").EntryTimeWindow[] | undefined,
  entryNotBeforeMs: number,
  oneTradePerDay: boolean
): { timeMs: number; spot: number }[] {
  const allowed = new Set(allowedDates);
  if (!allowed.size) return [];
  const dayKey = (t: number) =>
    new Date(t + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const inWindow = (t: number) => {
    if (!entryWindows?.length) return true;
    const active = entryWindows.filter((w) => w.enabled);
    if (!active.length) return true;
    const d = new Date(t + 5.5 * 60 * 60 * 1000);
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    return active.some((w) => {
      const parse = (hm: string) => {
        const m = /^(\d{1,2}):(\d{2})/.exec(String(hm || "").trim());
        if (!m) return null;
        return Number(m[1]) * 60 + Number(m[2]);
      };
      const a = parse(w.start);
      const b = parse(w.end);
      if (a == null || b == null) return false;
      return a <= b ? mins >= a && mins <= b : mins >= a || mins <= b;
    });
  };

  const out: { timeMs: number; spot: number }[] = [];
  let day = "";
  let used = 0;
  for (const c of candles) {
    if (entryNotBeforeMs && c.time < entryNotBeforeMs) continue;
    const d = dayKey(c.time);
    if (d !== day) {
      day = d;
      used = 0;
    }
    if (!allowed.has(d)) continue;
    if (oneTradePerDay && used >= 1) continue;
    if (!inWindow(c.time)) continue;
    out.push({ timeMs: c.time, spot: c.close });
    used += 1;
  }
  return out;
}

/** Quick dry-run of entry conditions to know which ATM contracts to prefetch. */
export function previewEntrySignals(
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
    (op.indicator === "RSI" || op.indicator === "ADX"
      ? 14
      : op.indicator === "VOL_RATIO"
        ? 20
        : op.indicator === "OPENING_RANGE_HIGH" ||
            op.indicator === "OPENING_RANGE_LOW" ||
            op.indicator === "BREAKOUT_HIGH" ||
            op.indicator === "BREAKOUT_LOW"
          ? 15
          : op.indicator === "VWAP" ||
              op.indicator === "OBV" ||
              op.indicator.startsWith("FIB") ||
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
    if (c.op === "rising" || c.op === "falling") {
      if (i === 0) return false;
      const L = val(c.left, i, map);
      const Lp = val(c.left, i - 1, map);
      if (L == null || Lp == null) return false;
      return c.op === "rising" ? L > Lp : L < Lp;
    }
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
    (operand.indicator === "RSI" || operand.indicator === "ADX"
      ? 14
      : operand.indicator === "VOL_RATIO"
        ? 20
        : operand.indicator === "OPENING_RANGE_HIGH" ||
            operand.indicator === "OPENING_RANGE_LOW" ||
            operand.indicator === "BREAKOUT_HIGH" ||
            operand.indicator === "BREAKOUT_LOW"
          ? 15
          : operand.indicator === "VWAP" ||
              operand.indicator === "OBV" ||
              operand.indicator.startsWith("FIB") ||
              operand.indicator.startsWith("PREV")
            ? 1
            : 9);
  return map.get(indicatorKey(operand.indicator, period))?.[i] ?? null;
}
