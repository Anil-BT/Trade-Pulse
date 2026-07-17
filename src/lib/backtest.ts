import { computeIndicator, indicatorKey } from "./indicators";
import {
  atmStrike,
  entryYearsToExpiry,
  formatOptionLabel,
  optionPremium,
  yearsToExpiry,
  type OptionsConfig,
} from "./options";
import type { OptionPricer } from "./option-pricing";
import type {
  BacktestMetrics,
  BacktestRequest,
  BacktestResult,
  Candle,
  CompareOperand,
  Condition,
  DaySummary,
  EntryTimeWindow,
  EquityPoint,
  IndicatorType,
  LotTrailRule,
  OptionsTradeSettings,
  StrategyConfig,
  Trade,
  TradeInstrument,
} from "./types";

/** One open lot (or equity slice) with its own trail rules */
type PositionLeg = {
  /** 1-based lot label */
  lotNo: number;
  units: number;
  lots: number;
  trailPeak: number;
  trailPct: number | null;
  /** Take profit at +this % from entry (price/premium) */
  takeProfitPct: number | null;
  trailToCostArmed: boolean;
  trailToCostEnabled: boolean;
  /** ₹ profit on this leg that arms trail-to-cost */
  trailToCostThreshold: number | null;
  /** Arm BE when another lot books take-profit */
  armToCostOnPartialTp: boolean;
  exitOnSignal: boolean;
};

/** IST session day key (same as indicators). */
function sessionDayKey(timeMs: number): string {
  const d = new Date(timeMs + 5.5 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/** Minutes from midnight IST. */
function istMinutesFromMidnight(timeMs: number): number {
  const d = new Date(timeMs + 5.5 * 60 * 60 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function parseHmToMinutes(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) {
    return null;
  }
  return h * 60 + min;
}

/**
 * If no windows enabled → allow all day.
 * Else entry time (IST) must fall in at least one enabled [start, end] inclusive.
 */
export function isInEntryTimeWindows(
  timeMs: number,
  windows: EntryTimeWindow[] | undefined
): boolean {
  if (!windows?.length) return true;
  const active = windows.filter((w) => w.enabled);
  if (!active.length) return true;

  const mins = istMinutesFromMidnight(timeMs);
  return active.some((w) => {
    const a = parseHmToMinutes(w.start);
    const b = parseHmToMinutes(w.end);
    if (a == null || b == null) return false;
    if (a <= b) return mins >= a && mins <= b;
    // wraps midnight (unusual for NSE cash)
    return mins >= a || mins <= b;
  });
}

export interface BacktestExtras {
  /** Market/model option pricer - when set, options_atm uses this for fills */
  optionPricer?: OptionPricer;
}

export function runBacktest(
  candles: Candle[],
  req: BacktestRequest,
  extras: BacktestExtras = {}
): BacktestResult {
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
  // Equity only: max fraction of *total* capital per trade (default 25%)
  const sizePct = Math.min(100, Math.max(1, req.positionSizePct || 25)) / 100;
  const oneTradePerDay = Boolean(req.oneTradePerDay);
  const tradeInstrument: TradeInstrument = req.tradeInstrument || "equity";
  const optCfg = mergeOptions(req.options, tradeInstrument === "options_atm");
  const pricer = extras.optionPricer;
  /** Skip new entries during indicator warmup bars (lookback fetch). */
  const entryNotBeforeMs = req.entryNotBeforeMs ?? 0;
  const entryWindows = req.entryTimeWindows;
  const allowedEntryDates = req.allowedEntryDates?.length
    ? new Set(req.allowedEntryDates)
    : null;
  const maxRiskCap = resolveMaxRiskCap(req.maxRiskPerTrade, initialCapital);
  const positionLots = resolvePositionLots(req);
  const lotRules = resolveLotRules(req.strategy, positionLots, initialCapital);

  let cash = initialCapital;
  let legs: PositionLeg[] = [];
  const positionQty = () => legs.reduce((s, l) => s + l.units, 0);
  let entryPrice = 0;
  let entryTime = 0;
  let entryBar = 0;
  let entryUnderlying = 0;
  let entryStrike = 0;
  let entryLots = 0;
  let entryLabel = "";
  let entryPremiumSource: "market" | "model" | undefined;
  let entryInstrumentKey = "";
  let tradesOnDay = 0;
  let currentDay = "";

  let equitySignals = 0;
  let skippedInsufficientCapital = 0;
  let skippedNoMarketPremium = 0;
  let maxRiskStops = 0;
  let trailCostStops = 0;
  let trailSlStops = 0;
  let takeProfitStops = 0;
  let minLotCost = Infinity;
  let marketFills = 0;
  let modelFills = 0;
  const requireMarketPremium = Boolean(pricer?.marketOnly);

  const trades: Trade[] = [];
  const equityCurve: EquityPoint[] = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const day = sessionDayKey(c.time);
    if (day !== currentDay) {
      currentDay = day;
      tradesOnDay = 0;
    }

    const qtyNow = positionQty();
    const markUnit =
      qtyNow > 0
        ? markUnitPrice(c, tradeInstrument, optCfg, pricer, {
            entryTime,
            entryStrike,
            entryPrice,
          })
        : 0;
    equityCurve.push({ time: c.time, equity: cash + qtyNow * markUnit });

    // EXIT — max risk → take-profit per lot → trail % / trail-to-cost → strategy
    if (qtyNow > 0 && i > entryBar) {
      const stop = maxRiskStopHit(
        c,
        tradeInstrument,
        entryPrice,
        qtyNow,
        maxRiskCap,
        markUnit
      );
      if (stop.hit) {
        maxRiskStops += 1;
        closeAllLegs(i, c, "max_risk", stop.exitPx);
      } else {
        // 1) Take-profit lots (e.g. lot 1 at +20%)
        let anyTp = false;
        for (let li = legs.length - 1; li >= 0; li--) {
          const leg = legs[li];
          const tp = takeProfitHit(
            c,
            tradeInstrument,
            entryPrice,
            leg.takeProfitPct,
            markUnit
          );
          if (tp.hit) {
            takeProfitStops += 1;
            anyTp = true;
            closeOneLeg(li, i, c, "take_profit", tp.exitPx);
          }
        }
        // After partial TP, arm trail-to-cost on remaining lots that opted in
        if (anyTp) {
          for (const leg of legs) {
            if (leg.armToCostOnPartialTp && leg.trailToCostEnabled) {
              leg.trailToCostArmed = true;
            }
          }
        }

        // 2) Per-lot trail SL / trail-to-cost
        for (let li = legs.length - 1; li >= 0; li--) {
          const leg = legs[li];
          if (
            leg.trailToCostEnabled &&
            leg.trailToCostThreshold != null &&
            !leg.trailToCostArmed
          ) {
            const legU = (markUnit - entryPrice) * leg.units;
            if (legU >= leg.trailToCostThreshold) leg.trailToCostArmed = true;
          }

          const trailSl = trailStopPctHit(
            c,
            tradeInstrument,
            leg.trailPeak,
            leg.trailPct,
            markUnit
          );
          if (trailSl.hit) {
            trailSlStops += 1;
            closeOneLeg(li, i, c, "trail_sl", trailSl.exitPx);
            continue;
          }
          if (leg.trailPct != null) {
            leg.trailPeak =
              tradeInstrument === "options_atm"
                ? Math.max(leg.trailPeak, markUnit)
                : Math.max(leg.trailPeak, c.high, c.close);
          }

          const trailCost = trailToCostHit(
            c,
            tradeInstrument,
            entryPrice,
            leg.units,
            leg.trailToCostArmed,
            markUnit
          );
          if (trailCost.hit) {
            trailCostStops += 1;
            closeOneLeg(li, i, c, "trail_cost", trailCost.exitPx);
          }
        }

        if (
          legs.length > 0 &&
          evalConditions(req.strategy.exit, exitLogic, i, seriesMap)
        ) {
          for (let li = legs.length - 1; li >= 0; li--) {
            if (legs[li].exitOnSignal) closeOneLeg(li, i, c, "signal");
          }
        }
      }
    } else if (qtyNow > 0) {
      for (const leg of legs) {
        leg.trailPeak =
          tradeInstrument === "options_atm"
            ? Math.max(entryPrice, markUnit)
            : Math.max(entryPrice, c.high, c.close);
      }
      if (evalConditions(req.strategy.exit, exitLogic, i, seriesMap)) {
        for (let li = legs.length - 1; li >= 0; li--) {
          if (legs[li].exitOnSignal) closeOneLeg(li, i, c, "signal");
        }
      }
    }

    // ENTRY
    if (positionQty() === 0) {
      const inDateWindow = !entryNotBeforeMs || c.time >= entryNotBeforeMs;
      const inTimeWindow = isInEntryTimeWindows(c.time, entryWindows);
      const dayLimitHit = oneTradePerDay && tradesOnDay >= 1;
      const dayAllowed =
        !allowedEntryDates || allowedEntryDates.has(sessionDayKey(c.time));
      if (
        inDateWindow &&
        inTimeWindow &&
        dayAllowed &&
        !dayLimitHit &&
        evalConditions(req.strategy.entry, entryLogic, i, seriesMap)
      ) {
        equitySignals += 1;
        openPosition(i, c);
      }
    }
  }

  let openLeg: BacktestResult["openPosition"] | undefined;
  if (positionQty() > 0) {
    const last = candles[candles.length - 1];
    const qtyOpen = positionQty();
    if (req.leaveOpenPositions) {
      let mark = markUnitPrice(last, tradeInstrument, optCfg, pricer, {
        entryTime,
        entryStrike,
        entryPrice,
      });
      let markSource: "market" | "model" | "ltp" | undefined;
      if (tradeInstrument === "options_atm" && pricer) {
        const q = pricer.quote({
          timeMs: last.time,
          spot: last.close,
          strike: entryStrike,
          heldFromMs: entryTime,
        });
        if (!q.missing && q.source === "market" && q.premium > 0) {
          mark = q.premium;
          markSource = "market";
        } else if (pricer.marketOnly) {
          mark = entryPrice;
          markSource = "market";
        } else {
          mark = q.premium;
          markSource = q.source;
        }
      } else if (tradeInstrument === "options_atm") {
        markSource = requireMarketPremium ? "market" : "model";
      }
      const unrealized = (mark - entryPrice) * qtyOpen;
      equityCurve[equityCurve.length - 1] = {
        time: last.time,
        equity: cash + qtyOpen * mark,
      };
      openLeg = {
        entryTime,
        entryPrice,
        qty: qtyOpen,
        capitalUsed: entryPrice * Math.abs(qtyOpen),
        underlyingEntry: entryUnderlying || undefined,
        underlyingMark: last.close,
        strike: entryStrike || undefined,
        lots: entryLots || undefined,
        lotSize:
          tradeInstrument === "options_atm" ? optCfg.lotSize : undefined,
        optionSide: tradeInstrument === "options_atm" ? optCfg.side : undefined,
        markPrice: mark,
        unrealizedPnl: unrealized,
        symbol: req.symbol,
        instrumentKey: entryInstrumentKey || undefined,
        premiumSource: entryPremiumSource,
        markSource,
      };
    } else {
      closeAllLegs(candles.length - 1, last, "eod");
      equityCurve[equityCurve.length - 1] = { time: last.time, equity: cash };
    }
  }

  const diagnostics = buildDiagnostics({
    equitySignals,
    entriesTaken: trades.length,
    skippedInsufficientCapital,
    skippedNoMarketPremium,
    maxRiskStops,
    trailCostStops,
    trailSlStops,
    takeProfitStops,
    minLotCost: Number.isFinite(minLotCost) ? minLotCost : undefined,
    maxRiskCap: maxRiskCap ?? undefined,
    trailProfitThreshold: undefined,
    trailSlPct: lotRules.some((r) => r.trailPct && r.trailPct > 0)
      ? lotRules.find((r) => r.trailPct && r.trailPct > 0)?.trailPct
      : undefined,
    tradeInstrument,
    oneTradePerDay,
    lotSize: optCfg.lotSize,
    initialCapital,
    marketFills,
    modelFills,
    candleCount: candles.length,
    firstBarTime: candles[0]?.time,
    lastBarTime: candles[candles.length - 1]?.time,
  });

  const metrics = computeMetrics(trades, initialCapital, equityCurve);
  const daySummaries = buildDaySummaries(trades);

  return {
    candles,
    trades,
    equityCurve,
    metrics,
    daySummaries: daySummaries.length > 0 ? daySummaries : undefined,
    indicators,
    source: req.source,
    symbol: req.symbol,
    interval: req.interval,
    tradeInstrument,
    oneTradePerDay,
    openPosition: openLeg,
    optionsMeta:
      tradeInstrument === "options_atm"
        ? {
            side: optCfg.side,
            lotSize: optCfg.lotSize,
            strikeStep: optCfg.strikeStep,
            iv: optCfg.iv,
            daysToExpiry: optCfg.daysToExpiry,
            listedStrikesCount: optCfg.listedStrikes?.length || 0,
            pricingMode: pricer?.pricingMode,
            marketContractsUsed: pricer?.marketContractsUsed,
            marketFills,
            modelFills,
          }
        : undefined,
    diagnostics,
  };

  function openPosition(i: number, c: Candle) {
    const spot = c.close;
    const nLots = positionLots;

    if (tradeInstrument === "options_atm") {
      if (optCfg.lotSize <= 0) {
        throw new Error(
          "Options lot size missing. Set lot size or use auto (NSE F&O)."
        );
      }

      const strike = pricer
        ? pricer.strikeFor(spot)
        : atmStrike(spot, optCfg.strikeStep, optCfg.listedStrikes);

      if (requireMarketPremium && !pricer) {
        skippedNoMarketPremium += 1;
        return;
      }

      const q = pricer
        ? pricer.quote({ timeMs: c.time, spot, strike })
        : {
            premium: optionPremium(
              spot,
              strike,
              entryYearsToExpiry(optCfg.daysToExpiry),
              0.065,
              optCfg.iv,
              optCfg.side
            ),
            source: "model" as const,
            strike,
          };

      if (
        requireMarketPremium &&
        (q.missing ||
          q.source !== "market" ||
          !(q.premium > 0) ||
          !q.instrumentKey)
      ) {
        skippedNoMarketPremium += 1;
        return;
      }

      const premium = q.premium;
      if (q.source === "market") marketFills += 1;
      else modelFills += 1;

      const costPerLot = premium * optCfg.lotSize;
      if (costPerLot < minLotCost) minLotCost = costPerLot;
      const totalCost = costPerLot * nLots;
      if (costPerLot <= 0 || cash < totalCost) {
        skippedInsufficientCapital += 1;
        return;
      }

      cash -= totalCost;
      entryPrice = premium;
      entryTime = c.time;
      entryBar = i;
      entryUnderlying = spot;
      entryStrike = q.strike || strike;
      entryLots = nLots;
      entryPremiumSource = q.source;
      entryInstrumentKey =
        ("instrumentKey" in q && typeof q.instrumentKey === "string"
          ? q.instrumentKey
          : "") || "";
      entryLabel =
        q.contractLabel ||
        formatOptionLabel(
          req.symbol.replace(/\.NS$/i, "").replace(/\.BO$/i, ""),
          entryStrike,
          optCfg.side
        );

      legs = [];
      for (let ln = 1; ln <= nLots; ln++) {
        const rule = lotRules[ln - 1];
        const trailPct =
          rule.trailPct != null && rule.trailPct > 0
            ? Math.min(50, rule.trailPct)
            : null;
        const thrPct = rule.trailToCostProfitPctOfCapital ?? 20;
        const trailToCostEnabled = Boolean(rule.trailToCost);
        const takeProfitPct =
          rule.takeProfitPct != null && rule.takeProfitPct > 0
            ? Math.min(500, rule.takeProfitPct)
            : null;
        legs.push({
          lotNo: ln,
          units: optCfg.lotSize,
          lots: 1,
          trailPeak: premium,
          trailPct,
          takeProfitPct,
          trailToCostArmed: false,
          trailToCostEnabled,
          trailToCostThreshold: trailToCostEnabled
            ? (initialCapital * Math.min(100, thrPct)) / 100 / nLots
            : null,
          armToCostOnPartialTp:
            rule.armToCostOnPartialTp !== undefined
              ? Boolean(rule.armToCostOnPartialTp)
              : trailToCostEnabled,
          exitOnSignal: rule.exitOnSignal !== false,
        });
      }
      tradesOnDay += 1;
      return;
    }

    // Equity: split position into nLots equal slices
    const maxSpend = Math.min(cash, initialCapital * sizePct);
    let qty = Math.floor(maxSpend / spot);
    if (qty <= 0 && cash >= spot) qty = 1;
    if (qty <= 0) {
      skippedInsufficientCapital += 1;
      return;
    }
    // Ensure at least nLots shares when possible
    if (qty < nLots && cash >= spot * nLots) qty = nLots;
    const base = Math.floor(qty / nLots);
    const rem = qty - base * nLots;
    if (base <= 0) {
      // single slice
      cash -= qty * spot;
      entryPrice = spot;
      entryTime = c.time;
      entryBar = i;
      entryUnderlying = spot;
      entryStrike = 0;
      entryLots = 0;
      entryLabel = "";
      entryPremiumSource = undefined;
      entryInstrumentKey = "";
      const rule = lotRules[0];
      const trailToCostEnabled = Boolean(rule.trailToCost);
      const takeProfitPct =
        rule.takeProfitPct != null && rule.takeProfitPct > 0
          ? Math.min(500, rule.takeProfitPct)
          : null;
      legs = [
        {
          lotNo: 1,
          units: qty,
          lots: 0,
          trailPeak: Math.max(spot, c.high),
          trailPct:
            rule.trailPct != null && rule.trailPct > 0
              ? Math.min(50, rule.trailPct)
              : null,
          takeProfitPct,
          trailToCostArmed: false,
          trailToCostEnabled,
          trailToCostThreshold: trailToCostEnabled
            ? (initialCapital *
                Math.min(100, rule.trailToCostProfitPctOfCapital ?? 20)) /
              100
            : null,
          armToCostOnPartialTp:
            rule.armToCostOnPartialTp !== undefined
              ? Boolean(rule.armToCostOnPartialTp)
              : trailToCostEnabled,
          exitOnSignal: rule.exitOnSignal !== false,
        },
      ];
      tradesOnDay += 1;
      return;
    }

    cash -= qty * spot;
    entryPrice = spot;
    entryTime = c.time;
    entryBar = i;
    entryUnderlying = spot;
    entryStrike = 0;
    entryLots = 0;
    entryLabel = "";
    entryPremiumSource = undefined;
    entryInstrumentKey = "";
    legs = [];
    for (let ln = 1; ln <= nLots; ln++) {
      const units = base + (ln <= rem ? 1 : 0);
      if (units <= 0) continue;
      const rule = lotRules[ln - 1] || lotRules[0];
      const trailToCostEnabled = Boolean(rule.trailToCost);
      const takeProfitPct =
        rule.takeProfitPct != null && rule.takeProfitPct > 0
          ? Math.min(500, rule.takeProfitPct)
          : null;
      legs.push({
        lotNo: ln,
        units,
        lots: 0,
        trailPeak: Math.max(spot, c.high),
        trailPct:
          rule.trailPct != null && rule.trailPct > 0
            ? Math.min(50, rule.trailPct)
            : null,
        takeProfitPct,
        trailToCostArmed: false,
        trailToCostEnabled,
        trailToCostThreshold: trailToCostEnabled
          ? (initialCapital *
              Math.min(100, rule.trailToCostProfitPctOfCapital ?? 20)) /
            100 /
            nLots
          : null,
        armToCostOnPartialTp:
          rule.armToCostOnPartialTp !== undefined
            ? Boolean(rule.armToCostOnPartialTp)
            : trailToCostEnabled,
        exitOnSignal: rule.exitOnSignal !== false,
      });
    }
    tradesOnDay += 1;
  }

  function resolveExitPx(
    c: Candle,
    forcedExitPx?: number
  ): { exitPx: number; exitSource?: "market" | "model" } {
    const spot = c.close;
    if (forcedExitPx != null && Number.isFinite(forcedExitPx)) {
      return {
        exitPx: Math.max(0, forcedExitPx),
        exitSource:
          tradeInstrument === "options_atm"
            ? entryPremiumSource || "model"
            : undefined,
      };
    }
    if (tradeInstrument === "options_atm") {
      if (pricer) {
        const q = pricer.quote({
          timeMs: c.time,
          spot,
          strike: entryStrike,
          heldFromMs: entryTime,
        });
        if (q.source === "market") marketFills += 1;
        else modelFills += 1;
        return { exitPx: q.premium, exitSource: q.source };
      }
      modelFills += 1;
      return {
        exitPx: optionPremium(
          spot,
          entryStrike,
          yearsToExpiry(optCfg.daysToExpiry, c.time - entryTime),
          0.065,
          optCfg.iv,
          optCfg.side
        ),
        exitSource: "model",
      };
    }
    return { exitPx: spot };
  }

  function closeOneLeg(
    legIndex: number,
    i: number,
    c: Candle,
    exitReason:
      | "signal"
      | "max_risk"
      | "trail_cost"
      | "trail_sl"
      | "take_profit"
      | "eod" = "signal",
    forcedExitPx?: number
  ) {
    const leg = legs[legIndex];
    if (!leg || leg.units <= 0) return;
    let { exitPx, exitSource } = resolveExitPx(c, forcedExitPx);
    const units = leg.units;

    if (
      exitReason === "max_risk" &&
      maxRiskCap != null &&
      units > 0
    ) {
      const rawPnl = (exitPx - entryPrice) * units;
      // scale max risk share by leg size vs original entry lots
      const share =
        entryLots > 0 ? leg.lots / entryLots : 1 / Math.max(1, legs.length);
      const cap = maxRiskCap * share;
      if (rawPnl < -cap) {
        exitPx = Math.max(0, entryPrice - cap / units);
      }
    }

    const pnl = (exitPx - entryPrice) * units;
    const pnlPct =
      entryPrice > 0 ? ((exitPx - entryPrice) / entryPrice) * 100 : 0;
    const capitalUsed = entryPrice * units;
    const spot = c.close;

    const trade: Trade = {
      entryTime,
      exitTime: c.time,
      entryPrice,
      exitPrice: exitPx,
      qty: units,
      capitalUsed,
      pnl,
      pnlPct,
      barsHeld: i - entryBar,
      underlyingEntry: entryUnderlying,
      underlyingExit: spot,
      instrument: tradeInstrument,
      exitReason,
      label:
        tradeInstrument === "options_atm"
          ? `${entryLabel || "opt"} · lot ${leg.lotNo}`
          : `lot ${leg.lotNo}`,
    };

    if (tradeInstrument === "options_atm") {
      trade.optionSide = optCfg.side;
      trade.strike = entryStrike;
      trade.lots = leg.lots;
      trade.lotSize = optCfg.lotSize;
      trade.lotCostEntry = entryPrice * optCfg.lotSize;
      trade.lotCostExit = exitPx * optCfg.lotSize;
      trade.premiumSource = entryPremiumSource;
      trade.exitPremiumSource = exitSource;
    }

    trades.push(trade);
    cash += units * exitPx;
    legs.splice(legIndex, 1);
    if (legs.length === 0) {
      entryLots = 0;
    }
  }

  function closeAllLegs(
    i: number,
    c: Candle,
    exitReason:
      | "signal"
      | "max_risk"
      | "trail_cost"
      | "trail_sl"
      | "take_profit"
      | "eod" = "signal",
    forcedExitPx?: number
  ) {
    for (let li = legs.length - 1; li >= 0; li--) {
      closeOneLeg(li, i, c, exitReason, forcedExitPx);
    }
  }
}

function markUnitPrice(
  c: Candle,
  instrument: TradeInstrument,
  optCfg: OptionsConfig,
  pricer: OptionPricer | undefined,
  pos: { entryTime: number; entryStrike: number; entryPrice?: number }
): number {
  if (instrument !== "options_atm") return c.close;
  if (pricer) {
    const q = pricer.quote({
      timeMs: c.time,
      spot: c.close,
      strike: pos.entryStrike,
      heldFromMs: pos.entryTime,
    });
    if (pricer.marketOnly) {
      // Never BS: use market candle, else freeze at entry (caller may apply LTP)
      if (!q.missing && q.source === "market" && q.premium > 0) {
        return q.premium;
      }
      return pos.entryPrice && pos.entryPrice > 0 ? pos.entryPrice : 0;
    }
    return q.premium;
  }
  return optionPremium(
    c.close,
    pos.entryStrike,
    yearsToExpiry(optCfg.daysToExpiry, c.time - pos.entryTime),
    0.065,
    optCfg.iv,
    optCfg.side
  );
}

/**
 * Detect max-risk stop and the fill unit price so realized loss ≈ cap
 * (not the worse bar close after the stop was already blown through).
 *
 * Equity longs: use candle low vs stop price.
 * Options: premium only available at bar close — clamp exit premium to stop.
 */
function maxRiskStopHit(
  c: Candle,
  instrument: TradeInstrument,
  entryPrice: number,
  qty: number,
  maxRiskCap: number | null,
  markUnit: number
): { hit: boolean; exitPx?: number } {
  if (maxRiskCap == null || qty <= 0 || entryPrice <= 0) {
    return { hit: false };
  }

  // Unit price where PnL = -maxRiskCap
  const stopUnit = entryPrice - maxRiskCap / qty;

  if (instrument !== "options_atm") {
    // Long equity: stop if bar traded down through stop level
    if (c.low <= stopUnit || c.close <= stopUnit) {
      // Fill at stop (or open if gapped through below stop)
      const fill =
        c.open < stopUnit ? Math.max(0, c.open) : Math.max(0, stopUnit);
      return { hit: true, exitPx: fill };
    }
    return { hit: false };
  }

  // Options long premium: stop when mark premium implies loss >= cap
  const unrealized = (markUnit - entryPrice) * qty;
  if (unrealized <= -maxRiskCap) {
    return { hit: true, exitPx: Math.max(0, stopUnit) };
  }
  return { hit: false };
}

/**
 * Once trail-to-cost is armed, exit at entry (breakeven) if price returns to cost.
 * Equity long: bar low ≤ entry → fill at entry (or open if gap below).
 * Options long: mark premium ≤ entry → fill at entry premium.
 */
function trailToCostHit(
  c: Candle,
  instrument: TradeInstrument,
  entryPrice: number,
  qty: number,
  armed: boolean,
  markUnit: number
): { hit: boolean; exitPx?: number } {
  if (!armed || qty <= 0 || entryPrice <= 0) {
    return { hit: false };
  }

  if (instrument !== "options_atm") {
    if (c.low <= entryPrice || c.close <= entryPrice) {
      const fill =
        c.open < entryPrice ? Math.max(0, c.open) : Math.max(0, entryPrice);
      return { hit: true, exitPx: fill };
    }
    return { hit: false };
  }

  if (markUnit <= entryPrice) {
    return { hit: true, exitPx: entryPrice };
  }
  return { hit: false };
}

/**
 * Classic trailing SL: stop = peak × (1 − pct/100).
 * Equity: hit if bar low ≤ stop (fill at stop, or open if gap through).
 * Options: hit if mark premium ≤ stop.
 */
function trailStopPctHit(
  c: Candle,
  instrument: TradeInstrument,
  peak: number,
  trailPct: number | null,
  markUnit: number
): { hit: boolean; exitPx?: number } {
  if (trailPct == null || !(peak > 0) || trailPct <= 0) {
    return { hit: false };
  }
  const stopLevel = peak * (1 - trailPct / 100);
  if (!(stopLevel > 0)) return { hit: false };

  if (instrument !== "options_atm") {
    if (c.low <= stopLevel || c.close <= stopLevel) {
      // Gap open below stop → fill open; else fill at stop
      const fill =
        c.open < stopLevel ? Math.max(0, c.open) : Math.max(0, stopLevel);
      return { hit: true, exitPx: fill };
    }
    return { hit: false };
  }

  if (markUnit <= stopLevel) {
    return { hit: true, exitPx: Math.max(0, stopLevel) };
  }
  return { hit: false };
}

function resolveTrailStopPct(
  cfg: StrategyConfig["trailStop"] | undefined
): number | null {
  if (!cfg?.enabled) return null;
  const pct = Number(cfg.pct);
  if (!Number.isFinite(pct) || pct <= 0) return null;
  return Math.min(50, pct); // cap 50% trail distance
}

function resolvePositionLots(req: BacktestRequest): number {
  const fromStrat = Number(req.strategy.positionLots);
  const fromOpt = Number(req.options?.lots);
  const n = Number.isFinite(fromStrat) && fromStrat > 0
    ? fromStrat
    : Number.isFinite(fromOpt) && fromOpt > 0
      ? fromOpt
      : 1;
  return Math.min(5, Math.max(1, Math.floor(n)));
}

/** Build per-lot rules; fall back to strategy-level trailStop / trailStopToCost. */
function resolveLotRules(
  strategy: StrategyConfig,
  nLots: number,
  _initialCapital: number
): LotTrailRule[] {
  const globalTrail = resolveTrailStopPct(strategy.trailStop);
  const globalToCost = Boolean(strategy.trailStopToCost?.enabled);
  const globalToCostPct = strategy.trailStopToCost?.profitPctOfCapital ?? 20;
  const rules: LotTrailRule[] = [];
  for (let i = 0; i < nLots; i++) {
    const custom = strategy.lotRules?.[i];
    if (custom) {
      const tp =
        custom.takeProfitPct != null && custom.takeProfitPct > 0
          ? custom.takeProfitPct
          : undefined;
      const trailToCost = Boolean(custom.trailToCost);
      rules.push({
        takeProfitPct: tp,
        trailPct:
          custom.trailPct != null && custom.trailPct > 0
            ? custom.trailPct
            : undefined,
        trailToCost,
        trailToCostProfitPctOfCapital:
          custom.trailToCostProfitPctOfCapital ?? globalToCostPct,
        // Default: arm BE when any lot books TP (scale-out runner)
        armToCostOnPartialTp:
          custom.armToCostOnPartialTp !== undefined
            ? custom.armToCostOnPartialTp
            : trailToCost,
        exitOnSignal: custom.exitOnSignal !== false,
      });
    } else {
      rules.push({
        trailPct: globalTrail ?? undefined,
        trailToCost: globalToCost,
        trailToCostProfitPctOfCapital: globalToCostPct,
        armToCostOnPartialTp: globalToCost,
        exitOnSignal: true,
      });
    }
  }
  return rules;
}

/**
 * Take-profit: close when mark is +pct% above entry.
 * Equity long: bar high/close ≥ target → fill min(high, max(open, target)).
 * Options long: mark premium ≥ target → fill at target (or mark if worse).
 */
function takeProfitHit(
  c: Candle,
  instrument: TradeInstrument,
  entryPrice: number,
  takeProfitPct: number | null,
  markUnit: number
): { hit: boolean; exitPx?: number } {
  if (
    takeProfitPct == null ||
    !(takeProfitPct > 0) ||
    !(entryPrice > 0)
  ) {
    return { hit: false };
  }
  const target = entryPrice * (1 + takeProfitPct / 100);
  if (!(target > entryPrice)) return { hit: false };

  if (instrument !== "options_atm") {
    if (c.high >= target || c.close >= target) {
      // Gap open above target → fill open; else fill at target
      const fill =
        c.open > target ? c.open : Math.min(c.high, Math.max(c.open, target));
      return { hit: true, exitPx: Math.max(0, fill) };
    }
    return { hit: false };
  }

  if (markUnit >= target) {
    return { hit: true, exitPx: Math.max(0, markUnit) };
  }
  return { hit: false };
}

function resolveTrailProfitThreshold(
  cfg: StrategyConfig["trailStopToCost"] | undefined,
  initialCapital: number
): number | null {
  if (!cfg?.enabled) return null;
  const pct = Number(cfg.profitPctOfCapital);
  const usePct = Number.isFinite(pct) && pct > 0 ? pct : 20;
  return (initialCapital * Math.min(100, usePct)) / 100;
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

function resolveMaxRiskCap(
  cfg: BacktestRequest["maxRiskPerTrade"],
  initialCapital: number
): number | null {
  if (!cfg?.enabled) return null;
  if (cfg.mode === "amount") {
    const a = Number(cfg.amount);
    if (!Number.isFinite(a) || a <= 0) return null;
    return a;
  }
  const pct = Number(cfg.pct);
  if (!Number.isFinite(pct) || pct <= 0) return null;
  return (initialCapital * Math.min(100, pct)) / 100;
}

function buildDiagnostics(d: {
  equitySignals: number;
  entriesTaken: number;
  skippedInsufficientCapital: number;
  skippedNoMarketPremium?: number;
  maxRiskStops?: number;
  trailCostStops?: number;
  trailSlStops?: number;
  takeProfitStops?: number;
  minLotCost?: number;
  maxRiskCap?: number;
  trailProfitThreshold?: number;
  trailSlPct?: number;
  tradeInstrument: TradeInstrument;
  oneTradePerDay: boolean;
  lotSize: number;
  initialCapital: number;
  marketFills: number;
  modelFills: number;
  candleCount?: number;
  firstBarTime?: number;
  lastBarTime?: number;
}): BacktestResult["diagnostics"] {
  let note: string | undefined;
  const barsNote =
    d.candleCount != null
      ? ` Loaded ${d.candleCount} bar(s)${
          d.firstBarTime && d.lastBarTime
            ? ` (${new Date(d.firstBarTime + 5.5 * 3600000).toISOString().slice(0, 10)} → ${new Date(d.lastBarTime + 5.5 * 3600000).toISOString().slice(0, 10)} IST)`
            : ""
        }.`
      : "";
  const riskCapNote =
    d.maxRiskCap != null
      ? ` Stop when loss >= Rs ${Math.round(d.maxRiskCap).toLocaleString("en-IN")}.`
      : "";
  const trailNote =
    d.trailProfitThreshold != null
      ? ` Trail-to-cost arms at +Rs ${Math.round(d.trailProfitThreshold).toLocaleString("en-IN")} profit.`
      : "";
  const trailSlNote =
    d.trailSlPct != null
      ? ` Trailing SL ${d.trailSlPct}% from peak.`
      : "";

  if (d.entriesTaken === 0 && d.equitySignals === 0) {
    note =
      "No equity entry signals in this range. Loosen the strategy, widen dates, or use a 5m interval on trading days." +
      barsNote;
  } else if (
    d.entriesTaken === 0 &&
    (d.skippedNoMarketPremium || 0) > 0 &&
    d.tradeInstrument === "options_atm"
  ) {
    note = `Equity signals ${d.equitySignals}x but skipped ${d.skippedNoMarketPremium}x — no Upstox option market premium (strict mode, no model).`;
  } else if (
    d.entriesTaken === 0 &&
    d.skippedInsufficientCapital > 0 &&
    d.tradeInstrument === "options_atm"
  ) {
    const need = d.minLotCost
      ? `approx Rs ${Math.ceil(d.minLotCost).toLocaleString("en-IN")}`
      : "1 full lot";
    note = `Equity signals fired ${d.equitySignals}x but capital was too low for 1 lot. Need ${need} (lot size ${d.lotSize}). Increase total capital.`;
  } else if (d.entriesTaken === 0 && d.equitySignals > 0) {
    note = `Equity signals fired ${d.equitySignals}x but no trades were opened. Check capital.`;
  } else if ((d.maxRiskStops || 0) > 0) {
    note = `${d.maxRiskStops} trade(s) exited on max-risk stop.${riskCapNote}`;
  } else if ((d.takeProfitStops || 0) > 0) {
    note = `${d.takeProfitStops} lot(s) booked take-profit (scale-out).`;
  } else if ((d.trailSlStops || 0) > 0) {
    note = `${d.trailSlStops} trade(s) exited on trailing SL.${trailSlNote}`;
  } else if ((d.trailCostStops || 0) > 0) {
    note = `${d.trailCostStops} trade(s) exited on trail-to-cost (breakeven).${trailNote}`;
  } else if (d.skippedInsufficientCapital > 0) {
    note = `${d.skippedInsufficientCapital} signal(s) skipped - not enough free cash for the next 1-lot trade.`;
  } else if (d.tradeInstrument === "options_atm" && d.marketFills + d.modelFills > 0) {
    if (d.marketFills > 0 && d.modelFills === 0) {
      note = "Option premiums from Upstox market data only (strict / market fills).";
    } else if (d.marketFills > 0) {
      note = `Option premiums: ${d.marketFills} market fills, ${d.modelFills} model fills (realized-vol BS when F&O history missing).`;
    } else {
      note =
        "Option premiums are model estimates (realized equity vol). Add Upstox access token for actual F&O option OHLC prices.";
    }
  } else if (d.oneTradePerDay) {
    note = "Max 1 entry per session day is on.";
  }

  return {
    equitySignals: d.equitySignals,
    entriesTaken: d.entriesTaken,
    skippedInsufficientCapital: d.skippedInsufficientCapital,
    skippedNoMarketPremium: d.skippedNoMarketPremium || 0,
    maxRiskStops: d.maxRiskStops || 0,
    trailCostStops: d.trailCostStops || 0,
    trailSlStops: d.trailSlStops || 0,
    candleCount: d.candleCount,
    firstBarTime: d.firstBarTime,
    lastBarTime: d.lastBarTime,
    maxRiskCap: d.maxRiskCap,
    trailProfitThreshold: d.trailProfitThreshold,
    minLotCost:
      d.minLotCost && Number.isFinite(d.minLotCost) ? d.minLotCost : undefined,
    note,
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
  if (type === "RSI" || type === "ADX") return 14;
  if (type === "VWAP" || type === "OBV") return 1;
  if (type === "VOL_RATIO") return 20;
  if (type === "OPENING_RANGE_HIGH" || type === "OPENING_RANGE_LOW") return 15;
  if (type === "BREAKOUT_HIGH" || type === "BREAKOUT_LOW") return 15;
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
  const op = cond.op;

  // rising / falling: left[i] vs left[i-1] (right ignored)
  if (op === "rising" || op === "falling") {
    if (i === 0) return false;
    const left = resolveValue(cond.left, i, seriesMap);
    const leftPrev = resolveValue(cond.left, i - 1, seriesMap);
    if (left == null || leftPrev == null) return false;
    return op === "rising" ? left > leftPrev : left < leftPrev;
  }

  const left = resolveValue(cond.left, i, seriesMap);
  const right = resolveValue(cond.right, i, seriesMap);
  if (left == null || right == null) return false;

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

/** Aggregate trades by IST session day (entry day). */
export function buildDaySummaries(trades: Trade[]): DaySummary[] {
  type Acc = {
    trades: number;
    winners: number;
    losers: number;
    pnl: number;
    grossProfit: number;
    grossLoss: number;
    capitalUsed: number;
    maxRiskStops: number;
    signalExits: number;
    bestTrade: number;
    worstTrade: number;
  };

  const byDay = new Map<string, Acc>();

  for (const t of trades) {
    const date = sessionDayKey(t.entryTime);
    let row = byDay.get(date);
    if (!row) {
      row = {
        trades: 0,
        winners: 0,
        losers: 0,
        pnl: 0,
        grossProfit: 0,
        grossLoss: 0,
        capitalUsed: 0,
        maxRiskStops: 0,
        signalExits: 0,
        bestTrade: -Infinity,
        worstTrade: Infinity,
      };
      byDay.set(date, row);
    }
    row.trades += 1;
    if (t.pnl > 0) {
      row.winners += 1;
      row.grossProfit += t.pnl;
    } else {
      row.losers += 1;
      row.grossLoss += Math.abs(t.pnl);
    }
    row.pnl += t.pnl;
    row.capitalUsed += t.capitalUsed ?? t.entryPrice * t.qty;
    if (t.exitReason === "max_risk") row.maxRiskStops += 1;
    else if (
      t.exitReason === "signal" ||
      t.exitReason === "trail_cost" ||
      t.exitReason === "trail_sl" ||
      !t.exitReason
    )
      row.signalExits += 1;
    row.bestTrade = Math.max(row.bestTrade, t.pnl);
    row.worstTrade = Math.min(row.worstTrade, t.pnl);
  }

  let cumulative = 0;
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, r]) => {
      cumulative += r.pnl;
      return {
        date,
        trades: r.trades,
        winners: r.winners,
        losers: r.losers,
        winRate: r.trades ? (r.winners / r.trades) * 100 : 0,
        pnl: Number(r.pnl.toFixed(2)),
        grossProfit: Number(r.grossProfit.toFixed(2)),
        grossLoss: Number(r.grossLoss.toFixed(2)),
        avgPnl: r.trades ? Number((r.pnl / r.trades).toFixed(2)) : 0,
        avgWin: r.winners ? Number((r.grossProfit / r.winners).toFixed(2)) : 0,
        avgLoss: r.losers
          ? Number((-(r.grossLoss / r.losers)).toFixed(2))
          : 0,
        bestTrade: Number.isFinite(r.bestTrade)
          ? Number(r.bestTrade.toFixed(2))
          : 0,
        worstTrade: Number.isFinite(r.worstTrade)
          ? Number(r.worstTrade.toFixed(2))
          : 0,
        capitalUsed: Number(r.capitalUsed.toFixed(2)),
        maxRiskStops: r.maxRiskStops,
        signalExits: r.signalExits,
        cumulativePnl: Number(cumulative.toFixed(2)),
      };
    });
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
  const avgWin = winners.length ? grossProfit / winners.length : 0;
  const avgLoss = losers.length ? -grossLoss / losers.length : 0; // negative
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
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0,
    finalEquity,
    initialCapital,
    totalCapitalUsed,
    avgCapitalUsed: totalTrades ? totalCapitalUsed / totalTrades : 0,
    maxCapitalUsed,
  };
}
