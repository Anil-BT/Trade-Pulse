/**
 * Option premium sources:
 * 1) market - real F&O OHLC (Upstox) when token + contract history available
 * 2) model  - realized-vol Black-Scholes calibrated to equity (better than fixed IV)
 */
import type { Candle } from "./types";
import type { OptionSide } from "./options";
import {
  optionPremium as bsPremium,
  entryYearsToExpiry,
  yearsToExpiry,
  atmStrike,
} from "./options";
import type { OptionContract } from "./data/option-contracts";
import { pickContract, listOptionContracts } from "./data/option-contracts";
import { fetchUpstoxCandles } from "./data/upstox";
import { sanitizeToken } from "./http";

export type PremiumSource = "market" | "model";

export interface PremiumQuote {
  premium: number;
  source: PremiumSource;
  strike: number;
  contractLabel?: string;
  instrumentKey?: string;
  dteDays?: number;
}

export interface OptionPricer {
  /** Resolve ATM strike for equity spot */
  strikeFor(spot: number): number;
  /** Premium at equity bar time for a given strike */
  quote(args: {
    timeMs: number;
    spot: number;
    strike: number;
    heldFromMs?: number;
  }): PremiumQuote;
  pricingMode: PremiumSource | "mixed";
  marketContractsUsed: number;
}

/**
 * Build a pricer. When Upstox token is set, loads real option candles for
 * contracts touched in a dry-run; otherwise uses realized-vol model only.
 */
export async function createOptionPricer(opts: {
  symbol: string;
  side: OptionSide;
  equityCandles: Candle[];
  from: string;
  to: string;
  interval: string;
  listedStrikes: number[];
  strikeStep: number;
  lotSize: number;
  preferredDaysToExpiry: number;
  fallbackIv: number;
  accessToken?: string;
  /** Dry-run trades: {time, spot} to prefetch market contracts */
  signalTimes?: { timeMs: number; spot: number }[];
}): Promise<OptionPricer> {
  const side = opts.side;
  const strikes = opts.listedStrikes;
  const step = opts.strikeStep;
  const token = sanitizeToken(opts.accessToken || "");

  const contracts = token
    ? await listOptionContracts(opts.symbol).catch(() => [] as OptionContract[])
    : [];

  // Realized vol from equity (annualized, 252 sessions)
  const closes = opts.equityCandles.map((c) => c.close);
  const rvol = realizedVolSeries(closes, 20);

  // Market series by instrument key
  const marketSeries = new Map<string, Candle[]>();
  let marketContractsUsed = 0;

  if (token && contracts.length && opts.signalTimes?.length) {
    const needed = new Map<string, OptionContract>();
    for (const sig of opts.signalTimes) {
      const strike = atmStrike(sig.spot, step, strikes);
      const c = pickContract({
        contracts,
        side,
        strike,
        tradeTimeMs: sig.timeMs,
        preferredDaysToExpiry: opts.preferredDaysToExpiry,
      });
      if (c) needed.set(c.instrumentKey, c);
    }

    // Cap fetches to avoid rate limits
    const keys = [...needed.values()].slice(0, 24);
    for (const c of keys) {
      try {
        const oc = await fetchUpstoxCandles({
          instrumentKey: c.instrumentKey,
          interval: mapInterval(opts.interval),
          from: opts.from,
          to: opts.to,
          accessToken: token,
        });
        if (oc.length) {
          marketSeries.set(c.instrumentKey, oc);
          marketContractsUsed += 1;
        }
      } catch {
        // fall back to model for this contract
      }
      await sleep(80);
    }
  }

  function strikeFor(spot: number): number {
    return atmStrike(spot, step, strikes);
  }

  function modelQuote(
    timeMs: number,
    spot: number,
    strike: number,
    heldFromMs?: number
  ): PremiumQuote {
    const idx = nearestEquityIndex(opts.equityCandles, timeMs);
    const vol = Math.max(
      rvol[idx] ?? opts.fallbackIv,
      0.12 // floor - India equity options rarely sub 12% IV
    );
    const T =
      heldFromMs != null
        ? yearsToExpiry(opts.preferredDaysToExpiry, timeMs - heldFromMs)
        : entryYearsToExpiry(opts.preferredDaysToExpiry);

    // Market-style: blend BS with intrinsic + ATM rule-of-thumb for India weeklies
    let prem = bsPremium(spot, strike, T, 0.065, vol, side);
    const intrinsic =
      side === "CE" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
    // ATM weekly stock options often ~0.6%-1.2% of spot when IV~18-25%
    const moneyness = Math.abs(spot - strike) / spot;
    if (moneyness < 0.02 && heldFromMs == null) {
      const thumb = spot * vol * Math.sqrt(Math.max(T, 1 / 252)) * 0.4;
      prem = Math.max(intrinsic, 0.55 * prem + 0.45 * thumb);
    }
    // Round to 0.05
    prem = Math.max(Math.round(prem / 0.05) * 0.05, intrinsic, 0.05);

    return {
      premium: prem,
      source: "model",
      strike,
      dteDays: opts.preferredDaysToExpiry,
    };
  }

  function quote(args: {
    timeMs: number;
    spot: number;
    strike: number;
    heldFromMs?: number;
  }): PremiumQuote {
    const { timeMs, spot, strike, heldFromMs } = args;

    if (token && contracts.length) {
      const c = pickContract({
        contracts,
        side,
        strike,
        tradeTimeMs: heldFromMs ?? timeMs,
        preferredDaysToExpiry: opts.preferredDaysToExpiry,
      });
      if (c) {
        const series = marketSeries.get(c.instrumentKey);
        if (series?.length) {
          const px = lookupPremium(series, timeMs);
          if (px != null && px > 0) {
            const dte = (c.expiry - timeMs) / (24 * 60 * 60 * 1000);
            return {
              premium: Math.round(px / 0.05) * 0.05,
              source: "market",
              strike: c.strike,
              contractLabel: c.tradingSymbol,
              instrumentKey: c.instrumentKey,
              dteDays: Math.max(0, dte),
            };
          }
        }
      }
    }

    return modelQuote(timeMs, spot, strike, heldFromMs);
  }

  return {
    strikeFor,
    quote,
    pricingMode: marketContractsUsed > 0 ? "mixed" : "model",
    marketContractsUsed,
  };
}

/** Collect equity signal times for prefetch (model dry-run done outside). */
export function collectSignalSpots(
  candles: Candle[],
  isEntry: (i: number) => boolean,
  oneTradePerDay: boolean
): { timeMs: number; spot: number }[] {
  const out: { timeMs: number; spot: number }[] = [];
  let day = "";
  let used = 0;
  for (let i = 0; i < candles.length; i++) {
    const d = sessionDay(candles[i].time);
    if (d !== day) {
      day = d;
      used = 0;
    }
    if (oneTradePerDay && used >= 1) continue;
    if (isEntry(i)) {
      out.push({ timeMs: candles[i].time, spot: candles[i].close });
      used += 1;
    }
  }
  return out;
}

function lookupPremium(series: Candle[], timeMs: number): number | null {
  // last bar at or before timeMs
  let best: Candle | null = null;
  for (const c of series) {
    if (c.time <= timeMs + 60_000) best = c;
    if (c.time > timeMs + 5 * 60_000) break;
  }
  if (!best && series.length) {
    // nearest overall
    best = series.reduce((a, b) =>
      Math.abs(a.time - timeMs) < Math.abs(b.time - timeMs) ? a : b
    );
  }
  return best ? best.close : null;
}

function nearestEquityIndex(candles: Candle[], timeMs: number): number {
  let best = 0;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].time <= timeMs) best = i;
    else break;
  }
  return best;
}

/** Parkinson/close-to-close hybrid realized vol series (annualized). */
function realizedVolSeries(closes: number[], lookback: number): number[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) {
      rets.push(Math.log(closes[i] / closes[i - 1]));
    } else rets.push(0);

    if (i >= lookback) {
      const window = rets.slice(i - lookback, i);
      const mean = window.reduce((a, b) => a + b, 0) / window.length;
      let v = 0;
      for (const r of window) v += (r - mean) * (r - mean);
      v = Math.sqrt(v / Math.max(window.length - 1, 1));
      // bars: assume ~75 five-min bars per day if 5m; use sqrt(252*75) for 5m
      // Use generic: if lookback is bar-based, scale by bars/day estimate 75
      const annual = v * Math.sqrt(252 * 75);
      out[i] = Math.min(Math.max(annual, 0.08), 1.2);
    }
  }
  // forward-fill
  let last = 0.2;
  const filled: number[] = [];
  for (let i = 0; i < out.length; i++) {
    if (out[i] != null) last = out[i] as number;
    filled.push(last);
  }
  return filled;
}

function mapInterval(
  interval: string
): import("./types").Interval {
  const allowed = ["1m", "5m", "15m", "30m", "60m", "1d"] as const;
  if ((allowed as readonly string[]).includes(interval)) {
    return interval as import("./types").Interval;
  }
  return "5m";
}

function sessionDay(timeMs: number): string {
  const d = new Date(timeMs + 5.5 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
