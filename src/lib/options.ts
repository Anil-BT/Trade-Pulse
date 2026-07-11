/**
 * ATM options helpers.
 *
 * Strategy signals always use equity OHLC/indicators.
 * Execution sizes & P&L use these option estimates.
 *
 * Premium model: Black–Scholes with NSE-style 0.05 tick rounding,
 * trading-day time decay (252d year), and intrinsic floor.
 */

export type OptionSide = "CE" | "PE";

export interface OptionsConfig {
  enabled: boolean;
  side: OptionSide;
  /** Units per lot from NSE F&O (e.g. RELIANCE = 500). */
  lotSize: number;
  /** Strike interval; 0 = auto. */
  strikeStep: number;
  /** Listed NSE FO strikes for nearest expiry (preferred for ATM). */
  listedStrikes?: number[];
  /** Annualized IV (e.g. 0.20 = 20%). */
  iv: number;
  /** Calendar days to expiry assumed at entry. */
  daysToExpiry: number;
  riskFreeRate?: number;
}

export function defaultOptionsConfig(): OptionsConfig {
  return {
    enabled: false,
    side: "CE",
    lotSize: 0, // 0 = resolve from NSE F&O
    strikeStep: 0,
    listedStrikes: [],
    iv: 0.18,
    daysToExpiry: 7,
    riskFreeRate: 0.065,
  };
}

/**
 * ATM strike: prefer closest *listed* FO strike to equity spot.
 * Fallback: round to strike step.
 */
export function atmStrike(
  spot: number,
  step?: number,
  listedStrikes?: number[]
): number {
  if (listedStrikes && listedStrikes.length > 0) {
    let best = listedStrikes[0];
    let bestDist = Math.abs(spot - best);
    for (const k of listedStrikes) {
      const d = Math.abs(spot - k);
      if (d < bestDist - 1e-9) {
        best = k;
        bestDist = d;
      } else if (Math.abs(d - bestDist) < 1e-9 && k <= spot && best > spot) {
        best = k; // tie → strike at/below spot
      }
    }
    return best;
  }

  const s = step && step > 0 ? step : autoStrikeStep(spot);
  if (s <= 0) return Math.round(spot);
  // half-up rounding (avoid JS banker's quirks on .5)
  const rounded = Math.floor(spot / s + 0.5) * s;
  return Math.round(rounded * 100) / 100;
}

export function autoStrikeStep(spot: number): number {
  if (spot < 50) return 1;
  if (spot < 100) return 2.5;
  if (spot < 250) return 5;
  if (spot < 500) return 5;
  if (spot < 1000) return 10;
  if (spot < 2000) return 10;
  if (spot < 5000) return 20;
  if (spot < 20000) return 50;
  return 100;
}

/**
 * Option premium (per unit) via Black–Scholes.
 * Returns value rounded to NSE 0.05 tick, never below intrinsic.
 */
export function optionPremium(
  S: number,
  K: number,
  yearsToExp: number,
  r: number,
  sigma: number,
  side: OptionSide
): number {
  if (S <= 0 || K <= 0) return 0;

  const intrinsic =
    side === "CE" ? Math.max(S - K, 0) : Math.max(K - S, 0);

  // Floor residual life ~ one 5m bar on a 252d trading year
  const t = Math.max(yearsToExp, 1 / (252 * 75));
  const vol = Math.max(sigma, 0.05);

  const sqrtT = Math.sqrt(t);
  const d1 =
    (Math.log(S / K) + (r + (vol * vol) / 2) * t) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;

  let theoretical: number;
  if (side === "CE") {
    theoretical = S * normCdf(d1) - K * Math.exp(-r * t) * normCdf(d2);
  } else {
    theoretical = K * Math.exp(-r * t) * normCdf(-d2) - S * normCdf(-d1);
  }

  // Near-ATM: average with Brenner–Subrahmanyam ≈ 0.4 S σ √T (more stable weeklies)
  const moneyness = Math.abs(S - K) / S;
  if (moneyness < 0.015) {
    const atmApprox = 0.39894 * S * vol * sqrtT;
    theoretical = 0.6 * theoretical + 0.4 * atmApprox;
  }

  const premium = Math.max(theoretical, intrinsic, 0.05);
  return roundTick(premium, 0.05);
}

/**
 * Time to expiry in years using trading calendar (252 days).
 * Intraday holding reduces T by fraction of session (~375 minutes).
 */
export function yearsToExpiry(
  entryDaysToExpiry: number,
  heldMs: number
): number {
  const SESSION_MS = 6.25 * 60 * 60 * 1000; // ~09:15–15:30
  const heldSessions = heldMs / SESSION_MS;
  // Convert calendar DTE to trading-day fraction (~5/7 of calendar week)
  const entryTradingDays = entryDaysToExpiry * (5 / 7);
  const remainTradingDays = Math.max(entryTradingDays - heldSessions, 1 / 75);
  return remainTradingDays / 252;
}

/** Years from calendar DTE at entry (no hold yet). */
export function entryYearsToExpiry(daysToExpiry: number): number {
  const tradingDays = Math.max(daysToExpiry * (5 / 7), 0.5);
  return tradingDays / 252;
}

export function roundTick(price: number, tick = 0.05): number {
  if (tick <= 0) return Math.round(price * 100) / 100;
  return Math.round(price / tick) * tick;
}

function normCdf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y =
    1 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) *
      t *
      Math.exp((-x * x) / 2);
  return 0.5 * (1 + sign * y);
}

export function formatOptionLabel(
  symbol: string,
  strike: number,
  side: OptionSide
): string {
  return `${symbol} ${strike} ${side}`;
}

/** Cost of one lot = premium × lotSize. */
export function lotPremium(premium: number, lotSize: number): number {
  return roundTick(premium * lotSize, 0.05);
}
