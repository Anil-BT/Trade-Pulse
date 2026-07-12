/**
 * Merge chunked / day-cached backtest pieces into one BacktestResult.
 */
import { buildDaySummaries } from "./backtest";
import type {
  BacktestMetrics,
  BacktestResult,
  Candle,
  DaySummary,
  EquityPoint,
  Trade,
} from "./types";

export function groupTradesByIstDay(trades: Trade[]): Map<string, Trade[]> {
  const map = new Map<string, Trade[]>();
  for (const t of trades) {
    const day = istDayKey(t.entryTime);
    const list = map.get(day) || [];
    list.push(t);
    map.set(day, list);
  }
  return map;
}

export function istDayKey(ms: number): string {
  const d = new Date(ms + 5.5 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

export function filterTradesToDays(
  trades: Trade[],
  days: Set<string>
): Trade[] {
  return trades.filter((t) => days.has(istDayKey(t.entryTime)));
}

export function mergeCandles(chunks: Candle[][]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const list of chunks) {
    for (const c of list) byTime.set(c.time, c);
  }
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

export function buildEquityCurve(
  trades: Trade[],
  initialCapital: number,
  candles: Candle[]
): EquityPoint[] {
  if (!candles.length) {
    // Point per trade exit
    let equity = initialCapital;
    const curve: EquityPoint[] = [{ time: Date.now(), equity }];
    const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
    for (const t of sorted) {
      equity += t.pnl;
      curve.push({ time: t.exitTime, equity });
    }
    return curve;
  }
  // Simple: mark equity at each candle by summing closed trade PnL up to that time
  const sortedTrades = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let ti = 0;
  let realized = 0;
  const curve: EquityPoint[] = [];
  for (const c of candles) {
    while (ti < sortedTrades.length && sortedTrades[ti].exitTime <= c.time) {
      realized += sortedTrades[ti].pnl;
      ti += 1;
    }
    curve.push({ time: c.time, equity: initialCapital + realized });
  }
  return curve;
}

export function metricsFromTrades(
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
    : initialCapital + totalPnl;

  const grossProfit = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));
  const avgWin = winners.length ? grossProfit / winners.length : 0;
  const avgLoss = losers.length ? -grossLoss / losers.length : 0;
  const absAvgLoss = Math.abs(avgLoss);
  const riskRewardRatio =
    absAvgLoss > 0 ? avgWin / absAvgLoss : avgWin > 0 ? 999 : 0;

  const totalCapitalUsed = trades.reduce(
    (s, t) => s + (t.capitalUsed ?? t.entryPrice * t.qty),
    0
  );
  const maxCapitalUsed = trades.reduce(
    (m, t) => Math.max(m, t.capitalUsed ?? t.entryPrice * t.qty),
    0
  );

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
    avgWin,
    avgLoss,
    grossProfit: Number(grossProfit.toFixed(2)),
    grossLoss: Number(grossLoss.toFixed(2)),
    riskRewardRatio,
    maxDrawdown: maxDd,
    maxDrawdownPct: maxDdPct,
    profitFactor:
      grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0,
    finalEquity,
    initialCapital,
    totalCapitalUsed,
    avgCapitalUsed: totalTrades ? totalCapitalUsed / totalTrades : 0,
    maxCapitalUsed,
  };
}

export function assembleBacktestResult(opts: {
  symbol: string;
  interval: BacktestResult["interval"];
  source: BacktestResult["source"];
  tradeInstrument?: BacktestResult["tradeInstrument"];
  oneTradePerDay?: boolean;
  initialCapital: number;
  trades: Trade[];
  candles: Candle[];
  optionsMeta?: BacktestResult["optionsMeta"];
  diagnostics?: BacktestResult["diagnostics"];
}): BacktestResult {
  const trades = [...opts.trades].sort((a, b) => a.entryTime - b.entryTime);
  const candles = mergeCandles([opts.candles]);
  const equityCurve = buildEquityCurve(
    trades,
    opts.initialCapital,
    candles
  );
  const metrics = metricsFromTrades(trades, opts.initialCapital, equityCurve);
  const daySummaries: DaySummary[] = buildDaySummaries(trades);

  return {
    symbol: opts.symbol,
    interval: opts.interval,
    source: opts.source,
    tradeInstrument: opts.tradeInstrument,
    oneTradePerDay: opts.oneTradePerDay,
    candles,
    trades,
    equityCurve,
    metrics,
    daySummaries: daySummaries.length ? daySummaries : undefined,
    indicators: {},
    optionsMeta: opts.optionsMeta,
    diagnostics: {
      equitySignals: opts.diagnostics?.equitySignals ?? trades.length,
      entriesTaken: trades.length,
      skippedInsufficientCapital:
        opts.diagnostics?.skippedInsufficientCapital ?? 0,
      maxRiskStops:
        opts.diagnostics?.maxRiskStops ??
        trades.filter((t) => t.exitReason === "max_risk").length,
      candleCount: candles.length,
      firstBarTime: candles[0]?.time,
      lastBarTime: candles[candles.length - 1]?.time,
      note: opts.diagnostics?.note,
      minLotCost: opts.diagnostics?.minLotCost,
      maxRiskCap: opts.diagnostics?.maxRiskCap,
    },
  };
}
