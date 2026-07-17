import type { StrategyConfig } from "./types";

/**
 * Pad / seed per-lot trail & take-profit rules.
 * 2+ lots default scale-out: lot 1 take-profit 20%; remaining lots trail to cost after partial TP.
 */
export function padLotRules(s: StrategyConfig, n: number) {
  const rules = [...(s.lotRules || [])];
  const fallbackTrail = s.trailStop?.enabled ? s.trailStop.pct : undefined;
  const fallbackToCost = Boolean(s.trailStopToCost?.enabled);
  const fallbackToCostPct = s.trailStopToCost?.profitPctOfCapital ?? 20;
  const hadNoRules = rules.length === 0;
  const nLots = Math.min(5, Math.max(1, Math.floor(n) || 1));

  while (rules.length < nLots) {
    const idx = rules.length;
    if (nLots >= 2 && idx === 0 && hadNoRules) {
      rules.push({
        takeProfitPct: 20,
        trailPct: fallbackTrail,
        trailToCost: false,
        exitOnSignal: true,
      });
    } else if (nLots >= 2 && idx >= 1) {
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

  if (
    nLots >= 2 &&
    !rules.some((r) => r.takeProfitPct != null && r.takeProfitPct > 0)
  ) {
    rules[0] = {
      ...rules[0],
      takeProfitPct: 20,
    };
    for (let i = 1; i < nLots; i++) {
      rules[i] = {
        ...rules[i],
        trailToCost: rules[i].trailToCost ?? true,
        armToCostOnPartialTp: rules[i].armToCostOnPartialTp !== false,
      };
    }
  }

  return rules.slice(0, nLots);
}

/** Attach positionLots + lotRules for the backtest/paper engine. */
export function withLots(
  s: StrategyConfig,
  lotsPerTrade: number
): StrategyConfig {
  const n = Math.min(5, Math.max(1, Math.floor(lotsPerTrade) || 1));
  return {
    ...s,
    positionLots: n,
    lotRules:
      s.lotRules && s.lotRules.length >= n
        ? s.lotRules.slice(0, n)
        : padLotRules(s, n),
  };
}
