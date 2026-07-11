import fs from "fs";
import path from "path";
import zlib from "zlib";
import { promisify } from "util";
import { normalizeTradingSymbol } from "./upstox-instruments";

const gunzip = promisify(zlib.gunzip);
const NSE_URL =
  "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";
const CACHE_DIR = path.join(process.cwd(), ".data-cache");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface FnoMeta {
  symbol: string;
  lotSize: number;
  strikeStep: number;
  /** Listed strikes for nearest expiry (for true ATM). */
  strikes: number[];
  nearestExpiry?: number;
  source: "nse_fo" | "fallback";
}

interface FoCache {
  savedAt: number;
  byUnderlying: Record<string, FnoMeta>;
}

let memory: FoCache | null = null;

/**
 * Resolve official NSE F&O lot size + listed strikes for an underlying
 * from Upstox BOD instruments (cached daily).
 */
export async function resolveFnoMeta(symbol: string): Promise<FnoMeta> {
  const sym = normalizeTradingSymbol(symbol);
  if (!sym) return fallbackMeta(symbol || "UNKNOWN");

  const key = mapIndexAlias(sym);
  const cache = await loadFoCache();
  const hit = cache.byUnderlying[key];
  if (hit) return { ...hit, symbol: key, strikes: [...(hit.strikes || [])] };

  return fallbackMeta(key);
}

/** Index underlyings (not equity stocks). */
const INDEX_UNDERLYINGS = new Set([
  "NIFTY",
  "BANKNIFTY",
  "FINNIFTY",
  "MIDCPNIFTY",
  "NIFTYNXT50",
  "NIFTY 50",
  "NIFTY50",
  "NIFTY BANK",
  "SENSEX",
  "BANKEX",
]);

/**
 * Commodities / currency underlyings that must not appear in equity F&O scan.
 * (MCX / CDS style names that can leak into NSE master groupings.)
 */
const NON_EQUITY_UNDERLYINGS = new Set([
  "GOLD",
  "GOLDM",
  "GOLDPETAL",
  "SILVER",
  "SILVERM",
  "SILVERMIC",
  "CRUDEOIL",
  "CRUDEOILM",
  "NATURALGAS",
  "NATGASMINI",
  "COPPER",
  "ZINC",
  "ZINCMINI",
  "ALUMINIUM",
  "ALUMINI",
  "LEAD",
  "LEADMINI",
  "NICKEL",
  "MENTHAOIL",
  "COTTON",
  "CPO",
  "USDINR",
  "EURINR",
  "GBPINR",
  "JPYINR",
  "USDJPY",
  "EURUSD",
  "GBPUSD",
]);

function isEquityFnoSymbol(symbol: string): boolean {
  const s = symbol.toUpperCase().trim();
  if (!s) return false;
  if (INDEX_UNDERLYINGS.has(s)) return false;
  if (NON_EQUITY_UNDERLYINGS.has(s)) return false;
  // currency pair pattern
  if (/^[A-Z]{3}INR$/.test(s) || /^[A-Z]{6}$/.test(s) && s.includes("USD")) {
    if (s.endsWith("INR") || s.startsWith("USD") || s.endsWith("USD")) return false;
  }
  return true;
}

/** All equity F&O underlyings only (no index / commodity / currency). */
export async function listFnoEquitySymbols(): Promise<
  { symbol: string; lotSize: number; strikeStep: number }[]
> {
  const cache = await loadFoCache();
  const rows = Object.values(cache.byUnderlying)
    .filter((m) => m.symbol && isEquityFnoSymbol(m.symbol))
    .filter((m, i, arr) => arr.findIndex((x) => x.symbol === m.symbol) === i)
    .map((m) => ({
      symbol: m.symbol,
      lotSize: m.lotSize,
      strikeStep: m.strikeStep,
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  return rows;
}

/**
 * True ATM = listed strike closest to spot (from NSE FO chain).
 * Ties: prefer the strike at/below spot (common for CE ATM convention).
 */
export function pickAtmStrike(
  spot: number,
  strikes: number[] | undefined,
  stepFallback = 0
): number {
  if (strikes && strikes.length) {
    let best = strikes[0];
    let bestDist = Math.abs(spot - best);
    for (const k of strikes) {
      const d = Math.abs(spot - k);
      if (d < bestDist - 1e-9) {
        best = k;
        bestDist = d;
      } else if (Math.abs(d - bestDist) < 1e-9) {
        // tie → prefer strike ≤ spot
        if (k <= spot && best > spot) best = k;
      }
    }
    return best;
  }

  const step =
    stepFallback > 0
      ? stepFallback
      : spot < 100
        ? 2.5
        : spot < 500
          ? 5
          : spot < 2000
            ? 10
            : spot < 5000
              ? 20
              : 50;
  // round half away from zero in a stable way for ATM
  const n = spot / step;
  const rounded = Math.floor(n + 0.5) * step;
  return Math.round(rounded * 100) / 100;
}

async function loadFoCache(): Promise<FoCache> {
  if (memory && Date.now() - memory.savedAt < CACHE_TTL_MS) return memory;

  // v3 = equity-only FO underlyings (no commodity/currency)
  const cachePath = path.join(CACHE_DIR, "upstox_fno_meta_v3.json");
  try {
    if (fs.existsSync(cachePath)) {
      const raw = JSON.parse(fs.readFileSync(cachePath, "utf8")) as FoCache;
      if (raw?.byUnderlying && Date.now() - raw.savedAt < CACHE_TTL_MS) {
        const sample = Object.values(raw.byUnderlying)[0] as FnoMeta | undefined;
        if (sample && Array.isArray(sample.strikes)) {
          memory = raw;
          return raw;
        }
      }
    }
  } catch {
    // rebuild
  }

  const instruments = await fetchNseInstruments();
  const byUnderlying: Record<string, FnoMeta> = {};

  type Row = {
    underlying_symbol?: string;
    underlying_type?: string;
    asset_type?: string;
    lot_size?: number;
    strike_price?: number;
    expiry?: number;
    instrument_type?: string;
    segment?: string;
  };

  const groups = new Map<string, Row[]>();
  for (const row of instruments as Row[]) {
    if (row.instrument_type !== "CE" && row.instrument_type !== "PE") continue;
    // Equity stock options only
    const ut = (row.underlying_type || row.asset_type || "").toUpperCase();
    if (ut && ut !== "EQUITY") continue;
    if (row.segment && row.segment !== "NSE_FO" && row.segment !== "BSE_FO") {
      continue;
    }
    const u = (row.underlying_symbol || "").toUpperCase();
    if (!u || !row.lot_size || !row.strike_price || !row.expiry) continue;
    if (!isEquityFnoSymbol(u)) continue;
    if (!groups.has(u)) groups.set(u, []);
    groups.get(u)!.push(row);
  }

  for (const [u, rows] of groups) {
    const byExp = new Map<number, Row[]>();
    for (const r of rows) {
      const e = r.expiry!;
      if (!byExp.has(e)) byExp.set(e, []);
      byExp.get(e)!.push(r);
    }
    const expiries = [...byExp.keys()].sort((a, b) => a - b);
    const now = Date.now();
    const chosen =
      expiries.find((e) => e >= now) ?? expiries[expiries.length - 1];
    const chosenRows = byExp.get(chosen) || rows;
    const lotSize = Number(chosenRows[0]?.lot_size) || 0;
    const strikes = [
      ...new Set(
        chosenRows
          .map((r) => Number(r.strike_price))
          .filter((s) => Number.isFinite(s) && s > 0)
      ),
    ].sort((a, b) => a - b);

    const step = medianStrikeStep(strikes);
    if (lotSize > 0) {
      byUnderlying[u] = {
        symbol: u,
        lotSize,
        strikeStep: step || 0,
        strikes,
        nearestExpiry: chosen,
        source: "nse_fo",
      };
    }
  }

  if (byUnderlying["NIFTY"]) {
    byUnderlying["NIFTY 50"] = byUnderlying["NIFTY"];
    byUnderlying["NIFTY50"] = byUnderlying["NIFTY"];
  }
  if (byUnderlying["BANKNIFTY"]) {
    byUnderlying["NIFTY BANK"] = byUnderlying["BANKNIFTY"];
  }

  const cache: FoCache = { savedAt: Date.now(), byUnderlying };
  memory = cache;
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache));
  } catch {
    // non-fatal
  }
  return cache;
}

function medianStrikeStep(strikes: number[]): number {
  if (strikes.length < 2) return 0;
  const counts = new Map<number, number>();
  for (let i = 1; i < strikes.length; i++) {
    const d = Math.round((strikes[i] - strikes[i - 1]) * 100) / 100;
    if (d > 0) counts.set(d, (counts.get(d) || 0) + 1);
  }
  let best = 0;
  let bestN = 0;
  for (const [d, n] of counts) {
    if (n > bestN) {
      best = d;
      bestN = n;
    }
  }
  return best;
}

function mapIndexAlias(sym: string): string {
  if (sym === "NIFTY50" || sym === "NIFTY 50") return "NIFTY";
  if (sym === "NIFTY BANK") return "BANKNIFTY";
  return sym;
}

function fallbackMeta(symbol: string): FnoMeta {
  const known: Record<string, { lot: number; step: number }> = {
    RELIANCE: { lot: 500, step: 10 },
    TCS: { lot: 225, step: 20 },
    INFY: { lot: 400, step: 10 },
    HDFCBANK: { lot: 650, step: 10 },
    SBIN: { lot: 750, step: 5 },
    ITC: { lot: 1725, step: 2.5 },
    NIFTY: { lot: 65, step: 50 },
    BANKNIFTY: { lot: 30, step: 100 },
  };
  const k = known[symbol];
  const step = k?.step ?? 10;
  const mid = 1000;
  // synthetic ladder for fallback ATM
  const strikes: number[] = [];
  for (let s = mid - 20 * step; s <= mid + 20 * step; s += step) {
    strikes.push(s);
  }
  return {
    symbol,
    lotSize: k?.lot ?? 50,
    strikeStep: step,
    strikes,
    source: "fallback",
  };
}

async function fetchNseInstruments(): Promise<unknown[]> {
  const { asciiHeaders } = await import("../http");
  // Headers must be pure ASCII ByteString (no em-dashes etc.)
  const res = await fetch(NSE_URL, {
    headers: asciiHeaders({
      "User-Agent": "TradePulse/1.0",
      Accept: "application/gzip, application/json, */*",
    }),
    cache: "no-store",
  });
  if (!res.ok)
    throw new Error(`Failed to download NSE instruments (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const text =
    buf[0] === 0x1f
      ? (await gunzip(buf)).toString("utf8")
      : buf.toString("utf8");
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error("Unexpected instruments format");
  return data;
}
