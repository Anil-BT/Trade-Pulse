/**
 * Resolve NSE equity trading symbol → Kite instrument_token.
 * Master: https://api.kite.trade/instruments (CSV, no auth)
 */
import fs from "fs";
import path from "path";
import { ensureCacheDir, getCacheDir } from "./cache-dir";

const MASTER_URL = "https://api.kite.trade/instruments";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type KiteInstrument = {
  instrumentToken: number;
  tradingSymbol: string;
  exchange: string;
  name: string;
};

type Index = {
  savedAt: number;
  bySymbol: Record<string, KiteInstrument>;
};

let memory: Index | null = null;

export async function resolveKiteInstrumentToken(
  symbol: string
): Promise<KiteInstrument> {
  const key = normalizeSymbol(symbol);
  if (!key) throw new Error("Symbol is required for Kite");

  if (/^\d+$/.test(key)) {
    return {
      instrumentToken: Number(key),
      tradingSymbol: key,
      exchange: "NSE",
      name: key,
    };
  }

  const idx = await loadIndex();
  const hit = idx.bySymbol[key] || idx.bySymbol[`NSE:${key}`];
  if (!hit) {
    throw new Error(
      `Kite: no NSE equity instrument for “${key}”. Use the NSE trading symbol (e.g. RELIANCE).`
    );
  }
  return hit;
}

function normalizeSymbol(symbol: string): string {
  return symbol
    .trim()
    .toUpperCase()
    .replace(/\.NS$/i, "")
    .replace(/\.BO$/i, "")
    .replace(/^NSE:/i, "")
    .replace(/\s+/g, "");
}

async function loadIndex(): Promise<Index> {
  if (memory && Date.now() - memory.savedAt < CACHE_TTL_MS) return memory;

  const cachePath = path.join(getCacheDir(), "kite_nse_eq_index_v1.json");
  try {
    ensureCacheDir();
    if (fs.existsSync(cachePath)) {
      const raw = JSON.parse(fs.readFileSync(cachePath, "utf8")) as Index;
      if (raw?.bySymbol && Date.now() - raw.savedAt < CACHE_TTL_MS) {
        memory = raw;
        return raw;
      }
    }
  } catch {
    // rebuild
  }

  const res = await fetch(MASTER_URL, {
    headers: { Accept: "text/csv,*/*", "User-Agent": "TradePulse/1.0" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Failed to download Kite instruments (${res.status})`);
  }
  const text = await res.text();
  const bySymbol = parseInstrumentsCsv(text);

  const index: Index = { savedAt: Date.now(), bySymbol };
  memory = index;
  try {
    ensureCacheDir();
    fs.writeFileSync(cachePath, JSON.stringify(index));
  } catch {
    // non-fatal
  }
  return index;
}

function parseInstrumentsCsv(text: string): Record<string, KiteInstrument> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return {};

  const header = splitCsv(lines[0]).map((h) => h.trim().toLowerCase());
  const i = (name: string) => header.indexOf(name);

  const iToken = i("instrument_token");
  const iTs = i("tradingsymbol");
  const iEx = i("exchange");
  const iSeg = i("segment");
  const iType = i("instrument_type");
  const iName = i("name");

  if (iToken < 0 || iTs < 0) {
    throw new Error("Kite instruments CSV missing expected columns");
  }

  const bySymbol: Record<string, KiteInstrument> = {};

  for (let li = 1; li < lines.length; li++) {
    const cols = splitCsv(lines[li]);
    const exchange = (iEx >= 0 ? cols[iEx] : "").trim().toUpperCase();
    const segment = (iSeg >= 0 ? cols[iSeg] : "").trim().toUpperCase();
    const type = (iType >= 0 ? cols[iType] : "").trim().toUpperCase();
    if (exchange !== "NSE") continue;
    // Equity cash: segment NSE, instrument_type EQ
    if (segment && segment !== "NSE") continue;
    if (type && type !== "EQ") continue;

    const token = Number(cols[iToken]);
    const tradingSymbol = (cols[iTs] || "").trim().toUpperCase();
    if (!token || !tradingSymbol) continue;

    const row: KiteInstrument = {
      instrumentToken: token,
      tradingSymbol,
      exchange: "NSE",
      name: (iName >= 0 ? cols[iName] : tradingSymbol) || tradingSymbol,
    };
    bySymbol[tradingSymbol] = row;
    bySymbol[`NSE:${tradingSymbol}`] = row;
  }

  return bySymbol;
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQ = !inQ;
      continue;
    }
    if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}
