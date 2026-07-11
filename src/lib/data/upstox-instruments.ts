import fs from "fs";
import path from "path";
import zlib from "zlib";
import { promisify } from "util";
import { ensureCacheDir, getCacheDir } from "./cache-dir";

const gunzip = promisify(zlib.gunzip);

const NSE_URL =
  "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";
const BSE_URL =
  "https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // refresh daily (Upstox BOD ~6 AM)

export interface UpstoxInstrument {
  segment: string;
  name: string;
  exchange: string;
  isin?: string;
  instrument_type: string;
  instrument_key: string;
  trading_symbol: string;
  short_name?: string;
  exchange_token?: string;
}

interface SymbolIndex {
  savedAt: number;
  /** trading_symbol → preferred instrument (NSE EQ first) */
  bySymbol: Record<string, UpstoxInstrument>;
}

let memoryIndex: SymbolIndex | null = null;

/**
 * Resolve a human symbol (RELIANCE, RELIANCE.NS, TCS) to Upstox instrument_key.
 * Prefers NSE equity, then BSE equity, then NSE index.
 */
export async function resolveUpstoxInstrumentKey(
  symbol: string,
  exchange: "NSE" | "BSE" | "AUTO" = "AUTO"
): Promise<{
  instrumentKey: string;
  tradingSymbol: string;
  name: string;
  segment: string;
  exchange: string;
}> {
  const normalized = normalizeTradingSymbol(symbol);
  if (!normalized) {
    throw new Error("Please enter a stock symbol (e.g. RELIANCE or TCS).");
  }

  // Already an instrument key
  if (normalized.includes("|") || symbol.includes("|")) {
    const key = symbol.includes("|") ? symbol.trim() : normalized;
    return {
      instrumentKey: key,
      tradingSymbol: key,
      name: key,
      segment: key.split("|")[0] || "",
      exchange: key.startsWith("BSE") ? "BSE" : "NSE",
    };
  }

  const index = await loadSymbolIndex();
  const hit = index.bySymbol[normalized];

  if (!hit) {
    // try without spaces / common aliases
    const alt = index.bySymbol[normalized.replace(/[-_\s]/g, "")];
    if (!alt) {
      throw new Error(
        `Could not find Upstox instrument for "${symbol}". Use NSE trading symbol like RELIANCE, TCS, INFY, SBIN.`
      );
    }
    return mapHit(alt);
  }

  // If user forced BSE via .BO and we stored NSE, re-search BSE-only map key
  if (exchange === "BSE" || symbol.toUpperCase().endsWith(".BO")) {
    const bseKey = `BSE:${normalized}`;
    const bse = index.bySymbol[bseKey];
    if (bse) return mapHit(bse);
  }

  return mapHit(hit);
}

function mapHit(hit: UpstoxInstrument) {
  return {
    instrumentKey: hit.instrument_key,
    tradingSymbol: hit.trading_symbol,
    name: hit.name || hit.short_name || hit.trading_symbol,
    segment: hit.segment,
    exchange: hit.exchange,
  };
}

/** Strip Yahoo-style suffixes and normalize to Upstox trading_symbol form. */
export function normalizeTradingSymbol(symbol: string): string {
  let s = symbol.trim().toUpperCase();
  if (!s) return "";
  // instrument key passthrough handled upstream
  if (s.includes("|")) return s;
  s = s.replace(/\.NS$/i, "").replace(/\.BO$/i, "").replace(/\.BSE$/i, "");
  // NIFTY50 / NIFTY 50 style
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

async function loadSymbolIndex(): Promise<SymbolIndex> {
  if (memoryIndex && Date.now() - memoryIndex.savedAt < CACHE_TTL_MS) {
    return memoryIndex;
  }

  const cachePath = path.join(getCacheDir(), "upstox_symbol_index.json");
  try {
    ensureCacheDir();
    if (fs.existsSync(cachePath)) {
      const raw = JSON.parse(fs.readFileSync(cachePath, "utf8")) as SymbolIndex;
      if (raw?.bySymbol && Date.now() - raw.savedAt < CACHE_TTL_MS) {
        memoryIndex = raw;
        return raw;
      }
    }
  } catch {
    // rebuild
  }

  const [nse, bse] = await Promise.all([
    fetchInstruments(NSE_URL),
    fetchInstruments(BSE_URL).catch(() => [] as UpstoxInstrument[]),
  ]);

  const bySymbol: Record<string, UpstoxInstrument> = {};

  // Lower priority first so higher priority overwrites
  // 1) BSE equity
  for (const inst of bse) {
    if (!isCashEquity(inst) && !isIndex(inst)) continue;
    const sym = (inst.trading_symbol || "").toUpperCase();
    if (!sym) continue;
    // store BSE under BSE: prefix always
    bySymbol[`BSE:${sym}`] = inst;
    // only set primary if empty
    if (!bySymbol[sym]) bySymbol[sym] = inst;
  }

  // 2) NSE equity + index (wins for primary symbol)
  for (const inst of nse) {
    if (!isCashEquity(inst) && !isIndex(inst)) continue;
    const sym = (inst.trading_symbol || "").toUpperCase();
    if (!sym) continue;

    // Prefer EQ over BE over index when multiple
    const existing = bySymbol[sym];
    if (!existing || prefer(inst, existing)) {
      bySymbol[sym] = inst;
    }

    // Short name alias (e.g. company short)
    if (inst.short_name) {
      const sn = inst.short_name.toUpperCase().replace(/\s+/g, " ").trim();
      if (sn && !bySymbol[sn]) bySymbol[sn] = inst;
    }
  }

  // Common index aliases
  alias(bySymbol, "NIFTY", "NIFTY 50");
  alias(bySymbol, "NIFTY50", "NIFTY 50");
  alias(bySymbol, "BANKNIFTY", "NIFTY BANK");
  alias(bySymbol, "FINNIFTY", "NIFTY FIN SERVICE");

  const index: SymbolIndex = { savedAt: Date.now(), bySymbol };
  memoryIndex = index;
  try {
    ensureCacheDir();
    fs.writeFileSync(cachePath, JSON.stringify(index));
  } catch {
    // non-fatal on serverless / read-only FS
  }
  return index;
}

function alias(
  map: Record<string, UpstoxInstrument>,
  from: string,
  to: string
) {
  if (!map[from] && map[to]) map[from] = map[to];
}

function isCashEquity(inst: UpstoxInstrument): boolean {
  return (
    (inst.segment === "NSE_EQ" || inst.segment === "BSE_EQ") &&
    ["EQ", "BE", "SM", "ST"].includes(inst.instrument_type)
  );
}

function isIndex(inst: UpstoxInstrument): boolean {
  return (
    (inst.segment === "NSE_INDEX" || inst.segment === "BSE_INDEX") &&
    inst.instrument_type === "INDEX"
  );
}

/** Prefer NSE EQ over BE over index over BSE */
function prefer(a: UpstoxInstrument, b: UpstoxInstrument): boolean {
  return rank(a) < rank(b);
}

function rank(inst: UpstoxInstrument): number {
  if (inst.segment === "NSE_EQ" && inst.instrument_type === "EQ") return 0;
  if (inst.segment === "NSE_EQ") return 1;
  if (inst.segment === "NSE_INDEX") return 2;
  if (inst.segment === "BSE_EQ" && inst.instrument_type === "EQ") return 3;
  if (inst.segment === "BSE_EQ") return 4;
  return 9;
}

async function fetchInstruments(url: string): Promise<UpstoxInstrument[]> {
  const { asciiHeaders } = await import("../http");
  const res = await fetch(url, {
    headers: asciiHeaders({
      "User-Agent": "TradePulse/1.0",
      Accept: "application/gzip, application/json, */*",
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Failed to download Upstox instruments (${res.status})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  let jsonText: string;
  if (url.endsWith(".gz") || buf[0] === 0x1f) {
    jsonText = (await gunzip(buf)).toString("utf8");
  } else {
    jsonText = buf.toString("utf8");
  }
  const data = JSON.parse(jsonText) as UpstoxInstrument[];
  if (!Array.isArray(data)) {
    throw new Error("Unexpected Upstox instruments format");
  }
  return data;
}


