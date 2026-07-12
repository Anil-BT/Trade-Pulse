import fs from "fs";
import path from "path";
import zlib from "zlib";
import { promisify } from "util";
import { ensureCacheDir, getCacheDir } from "./cache-dir";
import { lookupStaticUpstoxKey } from "./upstox-static-keys";

const gunzip = promisify(zlib.gunzip);

const NSE_URL =
  "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // refresh daily (Upstox BOD ~6 AM)
const FETCH_TIMEOUT_MS = 25_000;

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

  // Prefer live instrument master (ISINs change after demergers / corp actions).
  // Static map is only a fallback when master download fails.
  try {
    const index = await loadSymbolIndex();
    const candidates = [
      normalized,
      normalized.replace(/[-_\s]/g, ""),
      // Tata Motors rename
      normalized === "TATAMOTORS" ? "TMCV" : "",
      normalized === "TATAMOTORS" ? "TMPV" : "",
    ].filter(Boolean);

    for (const cand of candidates) {
      const hit = index.bySymbol[cand];
      if (hit) {
        if (exchange === "BSE" || symbol.toUpperCase().endsWith(".BO")) {
          const bse = index.bySymbol[`BSE:${cand}`];
          if (bse) return mapHit(bse);
        }
        return mapHit(hit);
      }
    }
  } catch {
    // fall through to static
  }

  if (exchange !== "BSE" && !symbol.toUpperCase().endsWith(".BO")) {
    const staticHit = lookupStaticUpstoxKey(normalized);
    if (staticHit) {
      return {
        instrumentKey: staticHit.instrumentKey,
        tradingSymbol: staticHit.tradingSymbol,
        name: staticHit.name,
        segment: "NSE_EQ",
        exchange: "NSE",
      };
    }
  }

  throw new Error(
    `Could not find Upstox instrument for "${symbol}". Use NSE trading symbol (e.g. RELIANCE, TCS) or full key NSE_EQ|ISIN. Note: TATAMOTORS is now TMCV / TMPV.`
  );
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

  // v2: force refresh after static-key / demerger fixes
  const cachePath = path.join(getCacheDir(), "upstox_symbol_index_v2.json");
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

  // NSE first (most lookups). Skip BSE unless needed — saves cold-start time on Vercel.
  const nse = await fetchInstruments(NSE_URL);

  const bySymbol: Record<string, UpstoxInstrument> = {};

  for (const inst of nse) {
    if (!isCashEquity(inst) && !isIndex(inst)) continue;
    const sym = (inst.trading_symbol || "").toUpperCase();
    if (!sym) continue;

    const existing = bySymbol[sym];
    if (!existing || prefer(inst, existing)) {
      bySymbol[sym] = inst;
    }

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

  // Compact cache: only fields we need (full master is huge)
  const compact: Record<string, UpstoxInstrument> = {};
  for (const [k, v] of Object.entries(bySymbol)) {
    compact[k] = {
      segment: v.segment,
      name: v.name,
      exchange: v.exchange,
      instrument_type: v.instrument_type,
      instrument_key: v.instrument_key,
      trading_symbol: v.trading_symbol,
      short_name: v.short_name,
    };
  }

  const index: SymbolIndex = { savedAt: Date.now(), bySymbol: compact };
  memoryIndex = index;
  try {
    ensureCacheDir();
    // Cap write size — if somehow still huge, skip disk
    const payload = JSON.stringify(index);
    if (payload.length < 8_000_000) {
      fs.writeFileSync(cachePath, payload);
    }
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
  let lastErr = "unknown";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(url, {
        headers: asciiHeaders({
          "User-Agent": "TradePulse/1.0",
          Accept: "application/gzip, application/json, */*",
        }),
        cache: "no-store",
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        continue;
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
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw new Error(`Failed to download Upstox instruments: ${lastErr}`);
}


