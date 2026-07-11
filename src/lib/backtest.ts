import { computeIndicator, indicatorKey } from "./indicators";
import {
  atmStrike,
  entryYearsToExpiry,
  formatOptionLabel,
  optionPremium,
  yearsToExpiry,
  type OptionsConfig,
} from "./options";
import type {
  BacktestMetrics,
  BacktestRequest,
  BacktestResult,
  Candle,
  CompareOperand,
  Condition,
  EquityPoint,
  IndicatorType,
  OptionsTradeSettings,
  Trade,
  TradeInstrument,
} from "./types";

/** IST session day key (same as indicators). */
function sessionDayKey(timeMs: number): string {
  const d = new Date(timeMs + 5.5 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

export function runBacktest(candles: Candle[], req: BacktestRequest): BacktestResult {
  if (candles.length < 5) {
    throw new Error("Not enough candles to backtest");
  }

  /**
   * Signals ALWAYS on equity OHLC + indicators.
   * options_atm only changes execution (ATM option fill).
   */
  const seriesMap = buildSeriesMap(candles, req.strategy.entry, req.strategy.exit);
  const indicators: Record<string, (number | null)[]> = {};
  for (const [k, v] of seriesMap) {
    if (!["close", "open", "high", "low", "volume"].includes(k)) {
      indicators[k] = v;
    }
  }

  const entryLogic = req.strategy.entryLogic ?? "and";
  const exitLogic = req.strategy.exitLogic ?? "and";
  const initialCapital = req.initialCapital > 0 ? req.initialCapital : 100000;
  const sizePct = Math.min(100, Math.max(1, req.positionSizePct || 100)) / 100;
  const oneTradePerDay = Boolean(req.oneTradePerDay);
  const tradeInstrument: TradeInstrument = req.tradeInstrument || "equity";
  const optCfg = mergeOptions(req.options, tradeInstrument === "options_atm");

  let cash = initialCapital;
  let positionQty = 0;
  let entryPrice = 0;
  let entryTime = 0;
  let entryBar = 0;
  let entryUnderlying = 0;
  let entryStrike = 0;
  let entryLots = 0;
  let tradesOnDay = 0;
  let currentDay = "";

  let equitySignals = 0;
  let skippedInsufficientCapital = 0;
  let minLotCost = Infinity;

  const trades: Trade[] = [];
  const equityCurve: EquityPoint[] = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const day = sessionDayKey(c.time);
    if (day !== currentDay) {
      currentDay = day;
      tradesOnDay = 0;
    }

    const markUnit =
      positionQty > 0
        ? markUnitPrice(c, tradeInstrument, optCfg, {
            entryTime,
            entryStrike,
          })
        : 0;
    equityCurve.push({ time: c.time, equity: cash + positionQty * markUnit });

    // EXIT — equity signal
    if (positionQty > 0) {
      if (evalConditions(req.strategy.exit, exitLogic, i, seriesMap)) {
        closePosition(i, c);
      }
    }

    // ENTRY — equity signal, then execute equity or ATM option
    if (positionQty === 0) {
      const dayLimitHit = oneTradePerDay && tradesOnDay >= 1;
      if (
        !dayLimitHit &&
        evalConditions(req.strategy.entry, entryLogic, i, seriesMap)
      ) {
        equitySignals += 1;
        openPosition(i, c);
      }
    }
  }

  if (positionQty > 0) {
    const last = candles[candles.length - 1];
    closePosition(candles.length - 1, last);
    equityCurve[equityCurve.length - 1] = { time: last.time, equity: cash };
  }

  const diagnostics = buildDiagnostics({
    equitySignals,
    entriesTaken: trades.length,
    skippedInsufficientCapital,
    minLotCost: Number.isFinite(minLotCost) ? minLotCost : undefined,
    tradeInstrument,
    oneTradePerDay,
    lotSize: optCfg.lotSize,
    initialCapital,
  });

  return {
    candles,
    trades,
    equityCurve,
    metrics: computeMetrics(trades, initialCapital, equityCurve),
    indicators,
    source: req.source,
    symbol: req.symbol,
    interval: req.interval,
    tradeInstrument,
    oneTradePerDay,
    optionsMeta:
      tradeInstrument === "options_atm"
        ? {
            side: optCfg.side,
            lotSize: optCfg.lotSize,
            strikeStep: optCfg.strikeStep,
            iv: optCfg.iv,
            daysToExpiry: optCfg.daysToExpiry,
            listedStrikesCount: optCfg.listedStrikes?.length || 0,
          }
        : undefined,
    diagnostics,
  };

  function openPosition(i: number, c: Candle) {
    const spot = c.close; // equity close for signal bar

    if (tradeInstrument === "options_atm") {
      if (optCfg.lotSize <= 0) {
        throw new Error(
          "Options lot size missing. Set lot size or use auto (NSE F&O)."
        );
      }

      // True ATM from listed FO strikes (fallback: step)
      const strike = atmStrike(
        spot,
        optCfg.strikeStep,
        optCfg.listedStrikes
      );
      const premium = optionPremium(
        spot,
        strike,
        entryYearsToExpiry(optCfg.daysToExpiry),
        optCfg.riskFreeRate ?? 0.065,
        optCfg.iv,
        optCfg.side
      );

      const costPerLot = premium * optCfg.lotSize;
      if (costPerLot < minLotCost) minLotCost = costPerLot;
      if (costPerLot <= 0) {
        skippedInsufficientCapital += 1;
        return;
      }

      // How many lots can we buy? Prefer at least 1 lot if cash allows.
      const budget = cash * sizePct;
      let lots = Math.floor(budget / costPerLot);
      if (lots <= 0 && cash >= costPerLot) {
        // Position-% floor left us at 0 but we can still afford 1 lot
        lots = 1;
      }
      if (lots <= 0) {
        skippedInsufficientCapital += 1;
        return;
      }

      const units = lots * optCfg.lotSize;
      const cost = units * premium;
      cash -= cost;
      positionQty = units;
      entryPrice = premium;
      entryTime = c.time;
      entryBar = i;
      entryUnderlying = spot;
      entryStrike = strike;
      entryLots = lots;
      tradesOnDay += 1;
      return;
    }

    const budget = cash * sizePct;
    let qty = Math.floor(budget / spot);
    if (qty <= 0 && cash >= spot) qty = 1;
    if (qty <= 0) {
      skippedInsufficientCapital += 1;
      return;
    }
    cash -= qty * spot;
    positionQty = qty;
    entryPrice = spot;
    entryTime = c.time;
    entryBar = i;
    entryUnderlying = spot;
    entryStrike = 0;
    entryLots = 0;
    tradesOnDay += 1;
  }

  function closePosition(i: number, c: Candle) {
    const spot = c.close;
    let exitPx: number;

    if (tradeInstrument === "options_atm") {
      exitPx = optionPremium(
        spot,
        entryStrike,
        yearsToExpiry(optCfg.daysToExpiry, c.time - entryTime),
        optCfg.riskFreeRate ?? 0.065,
        optCfg.iv,
        optCfg.side
      );
    } else {
      exitPx = spot;
    }

    const pnl = (exitPx - entryPrice) * positionQty;
    const pnlPct = entryPrice > 0 ? ((exitPx - entryPrice) / entryPrice) * 100 : 0;

    const cleanSym = req.symbol
      .replace(/\.NS$/i, "")
      .replace(/\.BO$/i, "")
      .toUpperCase();

    const trade: Trade = {
      entryTime,
      exitTime: c.time,
      entryPrice,
      exitPrice: exitPx,
      qty: positionQty,
      pnl,
      pnlPct,
      barsHeld: i - entryBar,
      underlyingEntry: entryUnderlying,
      underlyingExit: spot,
      instrument: tradeInstrument,
    };

    if (tradeInstrument === "options_atm") {
      trade.optionSide = optCfg.side;
      trade.strike = entryStrike;
      trade.lots = entryLots;
      trade.lotSize = optCfg.lotSize;
      trade.label = formatOptionLabel(cleanSym, entryStrike, optCfg.side);
      trade.lotCostEntry = entryPrice * optCfg.lotSize;
      trade.lotCostExit = exitPx * optCfg.lotSize;
    }

    trades.push(trade);
    cash += positionQty * exitPx;
    positionQty = 0;
  }
}

function buildDiagnostics(d: {
  equitySignals: number;
  entriesTaken: number;
  skippedInsufficientCapital: number;
  minLotCost?: number;
  tradeInstrument: TradeInstrument;
  oneTradePerDay: boolean;
  lotSize: number;
  initialCapital: number;
}): BacktestResult["diagnostics"] {
  let note: string | undefined;

  if (d.entriesTaken === 0 && d.equitySignals === 0) {
    note =
      "No equity entry signals in this range. Loosen the strategy, widen dates, or use a 5m interval on trading days.";
  } else if (
    d.entriesTaken === 0 &&
    d.skippedInsufficientCapital > 0 &&
    d.tradeInstrument === "options_atm"
  ) {
    const need = d.minLotCost
      ? `≈ ₹${Math.ceil(d.minLotCost).toLocaleString("en-IN")}`
      : "1 full lot";
    note = `Equity signals fired ${d.equitySignals}× but capital was too low for options. Need ${need} per lot (lot size ${d.lotSize}). Increase capital or lower lot size.`;
  } else if (d.entriesTaken === 0 && d.equitySignals > 0) {
    note = `Equity signals fired ${d.equitySignals}× but no trades were opened. Check capital / lot size.`;
  } else if (d.skippedInsufficientCapital > 0) {
    note = `${d.skippedInsufficientCapital} signal(s) skipped - not enough capital for another lot.`;
  } else if (d.oneTradePerDay) {
    note = "Max 1 entry per session day is on.";
  }

  return {
    equitySignals: d.equitySignals,
    entriesTaken: d.entriesTaken,
    skippedInsufficientCapital: d.skippedInsufficientCapital,
    minLotCost:
      d.minLotCost && Number.isFinite(d.minLotCost) ? d.minLotCost : undefined,
    note,
  };
}

function markUnitPrice(
  c: Candle,
  instrument: TradeInstrument,
  optCfg: OptionsConfig,
  pos: { entryTime: number; entryStrike: number }
): number {
  if (instrument !== "options_atm") return c.close;
  return optionPremium(
    c.close,
    pos.entryStrike,
    yearsToExpiry(optCfg.daysToExpiry, c.time - pos.entryTime),
    optCfg.riskFreeRate ?? 0.065,
    optCfg.iv,
    optCfg.side
  );
}

function mergeOptions(
  settings: OptionsTradeSettings | undefined,
  enabled: boolean
): OptionsConfig {
  return {
    enabled,
    side: settings?.side || "CE",
    lotSize: Math.max(0, settings?.lotSize ?? 0),
    strikeStep: Math.max(0, settings?.strikeStep ?? 0),
    listedStrikes: settings?.listedStrikes || [],
    iv: Math.min(2, Math.max(0.05, settings?.iv ?? 0.18)),
    daysToExpiry: Math.max(1, settings?.daysToExpiry ?? 7),
    riskFreeRate: 0.065,
  };
}

function buildSeriesMap(
  candles: Candle[],
  entry: Condition[],
  exit: Condition[]
): Map<string, (number | null)[]> {
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
  for (const cond of [...entry, ...exit]) {
    collectOperand(cond.left, needed);
    if (typeof cond.right !== "number") collectOperand(cond.right, needed);
  }

  for (const [key, { type, period }] of needed) {
    if (!map.has(key)) {
      map.set(key, computeIndicator(candles, type, period));
    }
  }

  return map;
}

function collectOperand(
  op: CompareOperand,
  needed: Map<string, { type: IndicatorType; period: number }>
) {
  if (typeof op === "string") return;
  const period = op.period ?? defaultPeriod(op.indicator);
  const key = indicatorKey(op.indicator, period);
  needed.set(key, { type: op.indicator, period });
}

function defaultPeriod(type: IndicatorType): number {
  if (type === "RSI") return 14;
  if (type === "OPENING_RANGE_HIGH" || type === "OPENING_RANGE_LOW") return 1;
  if (type.startsWith("FIB_PIVOT")) return 1;
  if (type === "PREV_DAY_HIGH" || type === "PREV_DAY_LOW") return 1;
  return 9;
}

function resolveValue(
  operand: CompareOperand | number,
  i: number,
  seriesMap: Map<string, (number | null)[]>
): number | null {
  if (typeof operand === "number") return operand;
  if (typeof operand === "string") {
    return seriesMap.get(operand)?.[i] ?? null;
  }
  const period = operand.period ?? defaultPeriod(operand.indicator);
  const key = indicatorKey(operand.indicator, period);
  return seriesMap.get(key)?.[i] ?? null;
}

function evalConditions(
  conditions: Condition[],
  logic: "and" | "or",
  i: number,
  seriesMap: Map<string, (number | null)[]>
): boolean {
  if (conditions.length === 0) return false;
  const results = conditions.map((c) => evalCondition(c, i, seriesMap));
  return logic === "and" ? results.every(Boolean) : results.some(Boolean);
}

function evalCondition(
  cond: Condition,
  i: number,
  seriesMap: Map<string, (number | null)[]>
): boolean {
  const left = resolveValue(cond.left, i, seriesMap);
  const right = resolveValue(cond.right, i, seriesMap);
  if (left == null || right == null) return false;

  const op = cond.op;
  if (op === "gt") return left > right;
  if (op === "gte") return left >= right;
  if (op === "lt") return left < right;
  if (op === "lte") return left <= right;

  if (i === 0) return false;
  const leftPrev = resolveValue(cond.left, i - 1, seriesMap);
  const rightPrev = resolveValue(cond.right, i - 1, seriesMap);
  if (leftPrev == null || rightPrev == null) return false;

  if (op === "cross_above") return leftPrev <= rightPrev && left > right;
  if (op === "cross_below") return leftPrev >= rightPrev && left < right;
  return false;
}

function computeMetrics(
  trades: Trade[],
  initialCapital: number,
  equityCurve: EquityPoint[]
): BacktestMetrics {
  const totalTrades = trades.length;
  const winners = trades.filter((t) => t.pnl > 0);
  const losers = trades.filter((t) => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const finalEquity = equityCurve.length
    ? equityCurve[equityCurve.length - 1].equity
    : initialCapital;

  const grossProfit = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));

  let peak = -Infinity;
  let maxDd = 0;
  let maxDdPct = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak - p.equity;
    if (dd > maxDd) {
      maxDd = dd;
      maxDdPct = peak > 0 ? (dd / peak) * 100 : 0;
    }
  }

  return {
    totalTrades,
    winners: winners.length,
    losers: losers.length,
    winRate: totalTrades ? (winners.length / totalTrades) * 100 : 0,
    totalPnl,
    totalPnlPct: initialCapital ? (totalPnl / initialCapital) * 100 : 0,
    avgPnl: totalTrades ? totalPnl / totalTrades : 0,
    avgWin: winners.length ? grossProfit / winners.length : 0,
    avgLoss: losers.length ? -grossLoss / losers.length : 0,
    maxDrawdown: maxDd,
    maxDrawdownPct: maxDdPct,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0,
    finalEquity,
    initialCapital,
  };
}
