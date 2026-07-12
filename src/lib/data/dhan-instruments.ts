/**
 * Resolve NSE equity trading symbol → Dhan securityId.
 * Master: https://images.dhan.co/api-data/api-scrip-master.csv
 */
import fs from "fs";
import path from "path";
import { ensureCacheDir, getCacheDir } from "./cache-dir";

const MASTER_URL = "https://images.dhan.co/api-data/api-scrip-master.csv";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type DhanInstrument = {
  securityId: string;
  tradingSymbol: string;
  exchangeSegment: string;
  instrument: string;
};

type Index = {
  savedAt: number;
  bySymbol: Record<string, DhanInstrument>;
};

let memory: Index | null = null;

export async function resolveDhanSecurityId(
  symbol: string
): Promise<DhanInstrument> {
  const key = normalizeSymbol(symbol);
  if (!key) throw new Error("Symbol is required for Dhan");

  // Allow raw security id if user pastes a number
  if (/^\d+$/.test(key)) {
    return {
      securityId: key,
      tradingSymbol: key,
      exchangeSegment: "NSE_EQ",
      instrument: "EQUITY",
    };
  }

  const idx = await loadIndex();
  const hit =
    idx.bySymbol[key] ||
    idx.bySymbol[`NSE:${key}`] ||
    idx.bySymbol[key.replace(/-EQ$/i, "")];

  if (!hit) {
    throw new Error(
      `Dhan: no NSE equity instrument for “${key}”. Use the NSE trading symbol (e.g. RELIANCE).`
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

  const cachePath = path.join(getCacheDir(), "dhan_nse_eq_index_v1.json");
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
    throw new Error(`Failed to download Dhan instrument master (${res.status})`);
  }
  const text = await res.text();
  const bySymbol = parseMasterCsv(text);

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

function parseMasterCsv(text: string): Record<string, DhanInstrument> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return {};

  const header = splitCsvLine(lines[0]).map((h) => h.trim().toUpperCase());
  const col = (...names: string[]) => {
    for (const n of names) {
      const i = header.indexOf(n.toUpperCase());
      if (i >= 0) return i;
    }
    return -1;
  };

  const iSec = col("SEM_SMST_SECURITY_ID", "SECURITY_ID", "SECURITYID");
  const iExch = col("SEM_EXM_EXCH_ID", "EXCH_ID", "EXCHANGE");
  const iSeg = col("SEM_SEGMENT", "SEGMENT");
  const iInst = col("SEM_INSTRUMENT_NAME", "INSTRUMENT", "INSTRUMENT_TYPE");
  const iSym = col(
    "SEM_TRADING_SYMBOL",
    "SM_SYMBOL_NAME",
    "SYMBOL_NAME",
    "TRADING_SYMBOL",
    "SEM_CUSTOM_SYMBOL"
  );
  const iSeries = col("SEM_SERIES", "SERIES");

  if (iSec < 0 || iSym < 0) {
    throw new Error("Dhan master CSV: missing security id / symbol columns");
  }

  const bySymbol: Record<string, DhanInstrument> = {};

  for (let li = 1; li < lines.length; li++) {
    const cols = splitCsvLine(lines[li]);
    const securityId = (cols[iSec] || "").trim();
    const tradingSymbol = (cols[iSym] || "").trim().toUpperCase();
    if (!securityId || !tradingSymbol) continue;

    const exch = (iExch >= 0 ? cols[iExch] : "NSE") || "NSE";
    const seg = (iSeg >= 0 ? cols[iSeg] : "E") || "E";
    const inst = (iInst >= 0 ? cols[iInst] : "EQUITY") || "EQUITY";
    const series = (iSeries >= 0 ? cols[iSeries] : "EQ") || "EQ";

    // NSE equity cash only
    if (!/^NSE$/i.test(exch)) continue;
    const isEquitySeg = /^E$/i.test(seg) || /EQ/i.test(seg);
    const isEquityInst =
      /EQUITY/i.test(inst) || /ES/i.test(inst) || inst === "";
    if (!isEquitySeg && !isEquityInst) continue;
    // Prefer EQ series when present
    if (series && !/^(EQ|BE|BZ|SM|ST|A|B)$/i.test(series)) continue;

    const row: DhanInstrument = {
      securityId,
      tradingSymbol: tradingSymbol.replace(/-EQ$/i, ""),
      exchangeSegment: "NSE_EQ",
      instrument: "EQUITY",
    };

    // First EQ wins; allow overwrite for clean EQ over others
    const k = row.tradingSymbol;
    if (!bySymbol[k] || /^EQ$/i.test(series)) {
      bySymbol[k] = row;
      bySymbol[`NSE:${k}`] = row;
    }
  }

  return bySymbol;
}

function splitCsvLine(line: string): string[] {
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
