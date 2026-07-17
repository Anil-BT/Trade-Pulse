/**
 * Sector-trend ranking for a configurable IST morning window.
 *
 * Strength (recommended):
 *  1) Per stock: return % + turnover in window
 *  2) Sector score = turnover-weighted avg return (fallback equal-weight)
 *  3) Optional min stocks + min breadth (same-side %)
 *  4) Rank by |score| (bar length); colour = sign(score)
 *  5) Top N sectors (bull / bear / mix) → bull or bear strategy routing
 */
import type { Candle, SectorTrendDayPick } from "./types";
import { sectorOf, symbolsInSector, allSectors } from "./watch/sectors";

export type SectorTrendDirection = "bullish" | "bearish";
export type SectorTrendMode = "auto" | SectorTrendDirection;
export type SectorWeightMode = "turnover" | "equal";

export type SectorTrendConfig = {
  /** IST HH:mm window start (inclusive), default 09:15 */
  windowStart?: string;
  /** IST HH:mm window end (exclusive), default 09:45 */
  windowEnd?: string;
  topSectors?: number;
  topStocksPerSector?: number;
  /**
   * auto = top N by bar length; each sector’s colour sets bull/bear
   * bullish / bearish = only that colour
   */
  mode?: SectorTrendMode;
  /**
   * Min |score| % to count as a trending bar (skip flat).
   * Default 0.
   */
  biasThreshold?: number;
  /**
   * How to average stock returns into a sector score.
   * turnover = liquidity-weighted (recommended); equal = simple mean.
   */
  weightMode?: SectorWeightMode;
  /** Min stocks with valid data in sector (default 3). */
  minStocks?: number;
  /**
   * Min share of stocks on the same side as sector score (0–100).
   * e.g. 55 = at least 55% green if sector is bullish. Default 55.
   * Set 0 to disable.
   */
  minBreadthPct?: number;
};

const DEFAULT_START = "09:15";
const DEFAULT_END = "09:45";
const NSE_OPEN_MINS = 9 * 60 + 15;

/** Force-map renames missing from fno-sector-map.json */
const SECTOR_FORCE: Record<string, string> = {
  TMCV: "Auto",
  TMPV: "Auto",
  TATAMOTORS: "Auto",
  MANDM: "Auto",
};

export function parseHmToMinutes(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(hm || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) {
    return null;
  }
  return h * 60 + min;
}

export function formatMinsToHm(mins: number): string {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.floor(mins)));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function resolveWindowMins(cfg?: SectorTrendConfig): {
  startMins: number;
  endMins: number;
  startLabel: string;
  endLabel: string;
} {
  const startMins =
    parseHmToMinutes(cfg?.windowStart || DEFAULT_START) ?? NSE_OPEN_MINS;
  let endMins = parseHmToMinutes(cfg?.windowEnd || DEFAULT_END) ?? 9 * 60 + 45;
  if (endMins <= startMins) endMins = startMins + 30;
  return {
    startMins,
    endMins,
    startLabel: formatMinsToHm(startMins),
    endLabel: formatMinsToHm(endMins),
  };
}

function sessionDayKey(timeMs: number): string {
  const d = new Date(timeMs + 5.5 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function istMinutes(timeMs: number): number {
  const d = new Date(timeMs + 5.5 * 60 * 60 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export type WindowDayStats = {
  changePct: number;
  /** Σ (close × volume) in window — proxy for turnover */
  turnover: number;
  volume: number;
  bars: number;
};

/**
 * Per IST day: return % + turnover in [start, end).
 * Falls back to open→windowEnd / first 30m if empty.
 */
export function morningWindowStats(
  candles: Candle[],
  windowStartMins?: number,
  windowEndMins?: number
): Map<string, WindowDayStats> {
  const start = windowStartMins ?? NSE_OPEN_MINS;
  const end = windowEndMins ?? 9 * 60 + 45;
  return windowStatsImpl(candles, start, end, true);
}

/** @deprecated use morningWindowStats — kept for callers needing only % */
export function morningWindowReturns(
  candles: Candle[],
  windowStartMins?: number,
  windowEndMins?: number
): Map<string, number> {
  const stats = morningWindowStats(candles, windowStartMins, windowEndMins);
  const out = new Map<string, number>();
  for (const [d, s] of stats) out.set(d, s.changePct);
  return out;
}

function windowStatsImpl(
  candles: Candle[],
  start: number,
  end: number,
  allowFallback: boolean
): Map<string, WindowDayStats> {
  type Acc = {
    open: number;
    close: number;
    turnover: number;
    volume: number;
    n: number;
  };
  const byDay = new Map<string, Acc>();

  for (const c of candles) {
    const m = istMinutes(c.time);
    if (m < start || m >= end) continue;
    const day = sessionDayKey(c.time);
    const vol = Number.isFinite(c.volume) && c.volume > 0 ? c.volume : 0;
    const px = Number.isFinite(c.close) ? c.close : 0;
    const to = vol > 0 && px > 0 ? px * vol : 0;
    let a = byDay.get(day);
    if (!a) {
      a = {
        open: c.open,
        close: c.close,
        turnover: to,
        volume: vol,
        n: 1,
      };
      byDay.set(day, a);
    } else {
      a.close = c.close;
      a.turnover += to;
      a.volume += vol;
      a.n += 1;
    }
  }

  if (allowFallback && byDay.size === 0 && start > NSE_OPEN_MINS) {
    return windowStatsImpl(candles, NSE_OPEN_MINS, end, false);
  }
  if (allowFallback && byDay.size === 0) {
    return windowStatsImpl(
      candles,
      NSE_OPEN_MINS,
      NSE_OPEN_MINS + 30,
      false
    );
  }

  const out = new Map<string, WindowDayStats>();
  for (const [day, a] of byDay) {
    if (!(a.open > 0) || a.n < 1) continue;
    out.set(day, {
      changePct: ((a.close - a.open) / a.open) * 100,
      turnover: a.turnover,
      volume: a.volume,
      bars: a.n,
    });
  }
  return out;
}

export type StockDayReturn = {
  symbol: string;
  date: string;
  changePct: number;
  sector: string;
  /** Window turnover (₹-ish proxy); 0 if unknown */
  turnover?: number;
};

export type SectorBarScore = {
  sector: string;
  /** Signed sector return % (weighted or equal) */
  avgChangePct: number;
  /** |avgChangePct| — bar length */
  strength: number;
  count: number;
  bullish: number;
  bearish: number;
  /** % of stocks on the majority / same side as score (0–100) */
  breadthPct: number;
  direction: SectorTrendDirection;
  weightModeUsed: SectorWeightMode;
};

/**
 * Score one sector from member stock returns.
 * Turnover-weighted when weightMode=turnover and any turnover > 0.
 */
export function scoreSectorMembers(
  members: { changePct: number; turnover?: number }[],
  opts?: {
    weightMode?: SectorWeightMode;
    minStocks?: number;
    minBreadthPct?: number;
    minStrength?: number;
  }
): SectorBarScore | null {
  const weightMode: SectorWeightMode = opts?.weightMode ?? "turnover";
  const minStocks = Math.max(1, Math.floor(opts?.minStocks ?? 2));
  const minBreadth = Math.max(0, Math.min(100, opts?.minBreadthPct ?? 0));
  const minStrength = Math.max(0, opts?.minStrength ?? 0);

  const valid = members.filter((m) => Number.isFinite(m.changePct));
  if (valid.length < minStocks) return null;

  let bullish = 0;
  let bearish = 0;
  for (const m of valid) {
    if (m.changePct >= 0) bullish += 1;
    else bearish += 1;
  }

  const totalTo = valid.reduce(
    (s, m) => s + (Number.isFinite(m.turnover) && (m.turnover as number) > 0
      ? (m.turnover as number)
      : 0),
    0
  );

  let avgChangePct: number;
  let weightModeUsed: SectorWeightMode = "equal";
  if (weightMode === "turnover" && totalTo > 0) {
    weightModeUsed = "turnover";
    let wSum = 0;
    let rSum = 0;
    for (const m of valid) {
      const w =
        Number.isFinite(m.turnover) && (m.turnover as number) > 0
          ? (m.turnover as number)
          : 0;
      if (w <= 0) continue;
      rSum += m.changePct * w;
      wSum += w;
    }
    avgChangePct = wSum > 0 ? rSum / wSum : valid.reduce((s, m) => s + m.changePct, 0) / valid.length;
    if (wSum <= 0) {
      weightModeUsed = "equal";
      avgChangePct =
        valid.reduce((s, m) => s + m.changePct, 0) / valid.length;
    }
  } else {
    avgChangePct =
      valid.reduce((s, m) => s + m.changePct, 0) / valid.length;
  }

  const strength = Math.abs(avgChangePct);
  if (minStrength > 0 && strength < minStrength) return null;

  const direction: SectorTrendDirection =
    avgChangePct >= 0 ? "bullish" : "bearish";
  const sameSide = direction === "bullish" ? bullish : bearish;
  const breadthPct = (sameSide / valid.length) * 100;
  if (minBreadth > 0 && breadthPct < minBreadth) return null;

  return {
    sector: "",
    avgChangePct,
    strength,
    count: valid.length,
    bullish,
    bearish,
    breadthPct,
    direction,
    weightModeUsed,
  };
}

export type SectorTrendPickResult = {
  dayPicks: SectorTrendDayPick[];
  allowedBullBySymbol: Map<string, string[]>;
  allowedBearBySymbol: Map<string, string[]>;
  bullDays: number;
  bearDays: number;
};

/**
 * Build daily sector/stock picks with turnover-weighted strength + breadth.
 */
export function buildSectorTrendPicks(
  stockDays: StockDayReturn[],
  cfg: SectorTrendConfig = {}
): SectorTrendPickResult {
  const topSectors = Math.max(1, Math.floor(cfg.topSectors ?? 2));
  const topStocks = Math.max(1, Math.floor(cfg.topStocksPerSector ?? 3));
  const mode: SectorTrendMode = cfg.mode ?? "auto";
  const minStrength = Math.max(
    0,
    Number.isFinite(cfg.biasThreshold)
      ? Math.abs(cfg.biasThreshold as number)
      : 0
  );
  const weightMode: SectorWeightMode = cfg.weightMode ?? "turnover";
  // Defaults tuned so sectors with 2 liquid F&O names still qualify
  const minStocks = Math.max(1, Math.floor(cfg.minStocks ?? 2));
  const minBreadthPct = Math.max(
    0,
    Math.min(
      100,
      Number.isFinite(cfg.minBreadthPct) ? Number(cfg.minBreadthPct) : 0
    )
  );

  const byDate = new Map<string, StockDayReturn[]>();
  for (const r of stockDays) {
    const list = byDate.get(r.date) || [];
    list.push(r);
    byDate.set(r.date, list);
  }

  const dayPicks: SectorTrendDayPick[] = [];
  const bullSets = new Map<string, Set<string>>();
  const bearSets = new Map<string, Set<string>>();
  let bullDays = 0;
  let bearDays = 0;

  const addAllowed = (
    map: Map<string, Set<string>>,
    symbol: string,
    date: string
  ) => {
    let set = map.get(symbol);
    if (!set) {
      set = new Set();
      map.set(symbol, set);
    }
    set.add(date);
  };

  const byStrength = (a: SectorBarScore, b: SectorBarScore) => {
    if (b.strength !== a.strength) return b.strength - a.strength;
    if (b.count !== a.count) return b.count - a.count;
    if (b.breadthPct !== a.breadthPct) return b.breadthPct - a.breadthPct;
    return a.sector.localeCompare(b.sector);
  };

  const dates = [...byDate.keys()].sort();
  for (const date of dates) {
    const rows = byDate.get(date) || [];
    const stocksBySector = new Map<string, StockDayReturn[]>();
    for (const r of rows) {
      const sector = r.sector || "Others";
      const list = stocksBySector.get(sector) || [];
      list.push(r);
      stocksBySector.set(sector, list);
    }

    const sectorBars: SectorBarScore[] = [];
    for (const [sector, members] of stocksBySector) {
      const scored = scoreSectorMembers(members, {
        weightMode,
        minStocks,
        minBreadthPct,
        minStrength,
      });
      if (!scored) continue;
      sectorBars.push({ ...scored, sector });
    }

    const mapped = sectorBars.filter((s) => s.sector !== "Others");
    let candidates = mapped.length > 0 ? mapped : sectorBars;

    if (mode === "bullish") {
      candidates = candidates.filter((s) => s.direction === "bullish");
    } else if (mode === "bearish") {
      candidates = candidates.filter((s) => s.direction === "bearish");
    }

    candidates = [...candidates].sort(byStrength);
    const picked = candidates.slice(0, topSectors);
    if (!picked.length) continue;

    const topBias =
      picked.reduce((s, x) => s + x.avgChangePct, 0) / picked.length;
    const hasBull = picked.some((p) => p.direction === "bullish");
    const hasBear = picked.some((p) => p.direction === "bearish");
    const dayDirection: SectorTrendDayPick["direction"] =
      hasBull && hasBear ? "mixed" : hasBull ? "bullish" : "bearish";

    if (hasBull) bullDays += 1;
    if (hasBear) bearDays += 1;

    const dayEntry: SectorTrendDayPick = {
      date,
      direction: dayDirection,
      topSectorsAvgPct: topBias,
      sectors: [],
    };

    for (const sec of picked) {
      const members = stocksBySector.get(sec.sector) || [];
      // Prefer same-side stocks (green sector → gainers, red → losers), then fill
      const sameSide = members.filter((m) =>
        sec.direction === "bullish" ? m.changePct >= 0 : m.changePct <= 0
      );
      const pool = sameSide.length > 0 ? sameSide : members;
      const sorted = [...pool].sort((a, b) => {
        if (sec.direction === "bullish") {
          if (b.changePct !== a.changePct) return b.changePct - a.changePct;
        } else {
          if (a.changePct !== b.changePct) return a.changePct - b.changePct;
        }
        return (b.turnover || 0) - (a.turnover || 0);
      });
      // If same-side < topStocks, fill from remaining opposite-side (still best |move|)
      if (sorted.length < topStocks && sameSide.length > 0) {
        const rest = members
          .filter((m) => !sameSide.includes(m))
          .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
        sorted.push(...rest);
      }
      const seen = new Set<string>();
      const unique: StockDayReturn[] = [];
      for (const t of sorted) {
        const key = t.symbol.toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(t);
        if (unique.length >= topStocks) break;
      }
      if (!unique.length) continue;

      dayEntry.sectors.push({
        sector: sec.sector,
        avgChangePct: sec.avgChangePct,
        strength: sec.strength,
        direction: sec.direction,
        stocks: unique.map((t) => ({
          symbol: t.symbol,
          changePct: t.changePct,
        })),
      });

      for (const t of unique) {
        if (sec.direction === "bullish") addAllowed(bullSets, t.symbol, date);
        else addAllowed(bearSets, t.symbol, date);
      }
    }

    if (dayEntry.sectors.length > 0) {
      dayPicks.push(dayEntry);
    }
  }

  const toMap = (sets: Map<string, Set<string>>) => {
    const out = new Map<string, string[]>();
    for (const [sym, set] of sets) out.set(sym, [...set].sort());
    return out;
  };

  return {
    dayPicks,
    allowedBullBySymbol: toMap(bullSets),
    allowedBearBySymbol: toMap(bearSets),
    bullDays,
    bearDays,
  };
}

export function stockSector(symbol: string): string {
  const raw = String(symbol || "")
    .toUpperCase()
    .replace(/\.NS$/i, "")
    .trim();
  if (SECTOR_FORCE[raw]) return SECTOR_FORCE[raw];
  return sectorOf(raw);
}

/**
 * Balanced F&O sample: round-robin across sectors.
 */
export function pickBalancedUniverse(
  all: { symbol: string; lotSize: number; strikeStep: number }[],
  maxSymbols: number
): { symbol: string; lotSize: number; strikeStep: number }[] {
  const cap = Math.min(Math.max(1, maxSymbols), all.length);
  if (cap >= all.length) return [...all];

  const bySector = new Map<
    string,
    { symbol: string; lotSize: number; strikeStep: number }[]
  >();
  for (const item of all) {
    const sec = stockSector(item.symbol);
    const list = bySector.get(sec) || [];
    list.push(item);
    bySector.set(sec, list);
  }

  const sectorKeys = [
    ...allSectors().filter((s) => (bySector.get(s) || []).length > 0),
    ...[...bySector.keys()].filter((s) => !allSectors().includes(s)),
  ];

  const out: { symbol: string; lotSize: number; strikeStep: number }[] = [];
  const used = new Set<string>();
  let guard = 0;
  while (out.length < cap && guard < cap * 20) {
    guard += 1;
    let added = false;
    for (const sec of sectorKeys) {
      if (out.length >= cap) break;
      const list = bySector.get(sec) || [];
      while (list.length) {
        const next = list.shift()!;
        const key = next.symbol.toUpperCase();
        if (used.has(key)) continue;
        used.add(key);
        out.push(next);
        added = true;
        break;
      }
    }
    if (!added) break;
  }

  if (out.length < cap) {
    for (const item of all) {
      if (out.length >= cap) break;
      const key = item.symbol.toUpperCase();
      if (used.has(key)) continue;
      used.add(key);
      out.push(item);
    }
  }
  return out;
}

export function sectorUniverseHint(): string {
  const n = allSectors().filter((s) => symbolsInSector(s).length > 0).length;
  return `${n} mapped sectors`;
}
