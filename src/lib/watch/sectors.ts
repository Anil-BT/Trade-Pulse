/**
 * Sector map for NSE equity F&O underlyings.
 *
 * Primary source: `fno-sector-map.json` — complete mapping for the current
 * F&O universe (built from Upstox NSE FO instruments + industry classification).
 * Unknown symbols fall under "Others".
 */
import fnoSectorMap from "./fno-sector-map.json";

export type SectorStrength = {
  sector: string;
  avgChangePct: number;
  /** Stocks scanned so far in this sector */
  count: number;
  /** F&O names mapped to this sector in universe */
  universeCount: number;
  bullish: number;
  bearish: number;
};

/** Display order: major sectors first, then alpha; empty/rare last; Others last. */
const SECTOR_ORDER: string[] = [
  "Banks",
  "NBFC / Finance",
  "Insurance",
  "IT",
  "Auto",
  "Pharma",
  "Healthcare",
  "FMCG",
  "Energy",
  "Power",
  "Metals",
  "Mining",
  "Infra",
  "Cement",
  "Telecom",
  "Retail",
  "Realty",
  "Capital Goods",
  "Defence",
  "Chemicals",
  "Fertilizers",
  "Consumer Durables",
  "Paints / Building",
  "Logistics",
  "Aviation",
  "Hotels",
  "Consumer Services",
  "Media",
  "Textiles",
  "Paper",
  "Oil & Gas Midstream",
  "Conglomerate",
  "Others",
];

const SYMBOL_TO_SECTOR = new Map<string, string>();
const SECTOR_TO_SYMBOLS = new Map<string, string[]>();

function hydrateFromMap() {
  const bySymbol = (fnoSectorMap as { bySymbol?: Record<string, string> })
    .bySymbol;
  const bySector = (fnoSectorMap as { bySector?: Record<string, string[]> })
    .bySector;

  if (bySymbol) {
    for (const [sym, sector] of Object.entries(bySymbol)) {
      SYMBOL_TO_SECTOR.set(sym.toUpperCase(), sector);
    }
  }
  if (bySector) {
    for (const [sector, symbols] of Object.entries(bySector)) {
      SECTOR_TO_SYMBOLS.set(
        sector,
        symbols.map((s) => s.toUpperCase()).sort((a, b) => a.localeCompare(b))
      );
      for (const s of symbols) {
        const key = s.toUpperCase();
        if (!SYMBOL_TO_SECTOR.has(key)) SYMBOL_TO_SECTOR.set(key, sector);
      }
    }
  }
}

hydrateFromMap();

export function sectorOf(symbol: string): string {
  const s = String(symbol || "")
    .toUpperCase()
    .replace(/\.NS$/i, "")
    .trim();
  return SYMBOL_TO_SECTOR.get(s) || "Others";
}

/** F&O symbols assigned to a sector (from downloaded map). */
export function symbolsInSector(sector: string): string[] {
  return SECTOR_TO_SYMBOLS.get(sector) || [];
}

/** All configured sectors in display order (Others last). */
export function allSectors(): string[] {
  const known = new Set<string>([...SECTOR_TO_SYMBOLS.keys(), ...SECTOR_ORDER]);
  const ordered: string[] = [];
  for (const s of SECTOR_ORDER) {
    if (known.has(s) || s === "Others") ordered.push(s);
  }
  for (const s of [...known].sort((a, b) => a.localeCompare(b))) {
    if (!ordered.includes(s)) ordered.push(s);
  }
  if (!ordered.includes("Others")) ordered.push("Others");
  return ordered;
}

/**
 * Sector strength from full F&O quotes (not strategy matches).
 * Always returns every configured sector (empty ones with count 0).
 * Sorted by avg day change desc; zero-count sectors last alphabetically.
 *
 * When rows include turnover (or volume×price), uses turnover-weighted avg
 * (same idea as sector-trend backtest). Falls back to equal-weight.
 */
export function computeSectorStrength(
  rows: { symbol: string; changePct?: number; turnover?: number }[]
): SectorStrength[] {
  const acc = new Map<
    string,
    {
      sum: number;
      wSum: number;
      wRet: number;
      nCh: number;
      n: number;
      bullish: number;
      bearish: number;
    }
  >();
  for (const sector of allSectors()) {
    acc.set(sector, {
      sum: 0,
      wSum: 0,
      wRet: 0,
      nCh: 0,
      n: 0,
      bullish: 0,
      bearish: 0,
    });
  }
  for (const r of rows) {
    const sector = sectorOf(r.symbol);
    const cur = acc.get(sector) || {
      sum: 0,
      wSum: 0,
      wRet: 0,
      nCh: 0,
      n: 0,
      bullish: 0,
      bearish: 0,
    };
    cur.n += 1;
    const ch = Number(r.changePct);
    if (Number.isFinite(ch)) {
      cur.sum += ch;
      cur.nCh += 1;
      if (ch >= 0) cur.bullish += 1;
      else cur.bearish += 1;
      const w = Number(r.turnover);
      if (Number.isFinite(w) && w > 0) {
        cur.wSum += w;
        cur.wRet += ch * w;
      }
    }
    acc.set(sector, cur);
  }
  return [...acc.entries()]
    .map(([sector, v]) => ({
      sector,
      avgChangePct:
        v.wSum > 0
          ? v.wRet / v.wSum
          : v.nCh > 0
            ? v.sum / v.nCh
            : 0,
      count: v.n,
      /** How many F&O names belong to this sector in the universe map */
      universeCount: symbolsInSector(sector).length,
      bullish: v.bullish,
      bearish: v.bearish,
    }))
    // Only sectors that have F&O names (or already have live quotes)
    .filter((s) => s.universeCount > 0 || s.count > 0)
    .sort((a, b) => {
      if (a.count === 0 && b.count === 0) {
        const ai = SECTOR_ORDER.indexOf(a.sector);
        const bi = SECTOR_ORDER.indexOf(b.sector);
        if (ai !== bi && ai >= 0 && bi >= 0) return ai - bi;
        return a.sector.localeCompare(b.sector);
      }
      if (a.count === 0) return 1;
      if (b.count === 0) return -1;
      if (b.avgChangePct !== a.avgChangePct) {
        return b.avgChangePct - a.avgChangePct;
      }
      return a.sector.localeCompare(b.sector);
    });
}
