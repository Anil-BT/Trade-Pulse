/**
 * Resolve NSE F&O option contracts (instrument keys) for ATM pricing.
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { promisify } from "util";
import { normalizeTradingSymbol } from "./upstox-instruments";
import { asciiHeaders } from "../http";

const gunzip = promisify(zlib.gunzip);
const NSE_URL =
  "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";
const CACHE_DIR = path.join(process.cwd(), ".data-cache");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface OptionContract {
  instrumentKey: string;
  tradingSymbol: string;
  underlying: string;
  strike: number;
  side: "CE" | "PE";
  expiry: number; // ms
  lotSize: number;
  weekly?: boolean;
}

interface ContractCache {
  savedAt: number;
  /** underlying -> contracts */
  byUnderlying: Record<string, OptionContract[]>;
}

let memory: ContractCache | null = null;

export async function listOptionContracts(
  underlying: string
): Promise<OptionContract[]> {
  const u = normalizeTradingSymbol(underlying);
  const cache = await loadContractCache();
  return cache.byUnderlying[u] || [];
}

/**
 * Pick the option contract for ATM trading on a given trade day.
 * Prefers expiry with DTE closest to preferredDays (default 7), still in future relative to tradeTime.
 */
export function pickContract(opts: {
  contracts: OptionContract[];
  side: "CE" | "PE";
  strike: number;
  tradeTimeMs: number;
  preferredDaysToExpiry?: number;
}): OptionContract | null {
  const preferred = opts.preferredDaysToExpiry ?? 7;
  const dayMs = 24 * 60 * 60 * 1000;
  const candidates = opts.contracts.filter(
    (c) =>
      c.side === opts.side &&
      Math.abs(c.strike - opts.strike) < 0.01 &&
      c.expiry > opts.tradeTimeMs + dayMs * 0.25 // still alive
  );
  if (!candidates.length) {
    // nearest strike same side still alive
    const alive = opts.contracts.filter(
      (c) => c.side === opts.side && c.expiry > opts.tradeTimeMs + dayMs * 0.25
    );
    if (!alive.length) return null;
    alive.sort(
      (a, b) =>
        Math.abs(a.strike - opts.strike) - Math.abs(b.strike - opts.strike)
    );
    const strike = alive[0].strike;
    const sameStrike = alive.filter((c) => Math.abs(c.strike - strike) < 0.01);
    return pickBestExpiry(sameStrike, opts.tradeTimeMs, preferred);
  }
  return pickBestExpiry(candidates, opts.tradeTimeMs, preferred);
}

function pickBestExpiry(
  contracts: OptionContract[],
  tradeTimeMs: number,
  preferredDays: number
): OptionContract {
  const dayMs = 24 * 60 * 60 * 1000;
  let best = contracts[0];
  let bestScore = Infinity;
  for (const c of contracts) {
    const dte = (c.expiry - tradeTimeMs) / dayMs;
    const score = Math.abs(dte - preferredDays);
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

async function loadContractCache(): Promise<ContractCache> {
  if (memory && Date.now() - memory.savedAt < CACHE_TTL_MS) return memory;

  const cachePath = path.join(CACHE_DIR, "upstox_option_contracts_v1.json");
  try {
    if (fs.existsSync(cachePath)) {
      const raw = JSON.parse(fs.readFileSync(cachePath, "utf8")) as ContractCache;
      if (raw?.byUnderlying && Date.now() - raw.savedAt < CACHE_TTL_MS) {
        memory = raw;
        return raw;
      }
    }
  } catch {
    // rebuild
  }

  const res = await fetch(NSE_URL, {
    headers: asciiHeaders({
      "User-Agent": "TradePulse/1.0",
      Accept: "application/gzip, application/json, */*",
    }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Failed to load FO contracts (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const text =
    buf[0] === 0x1f
      ? (await gunzip(buf)).toString("utf8")
      : buf.toString("utf8");
  const data = JSON.parse(text) as Array<{
    instrument_type?: string;
    underlying_type?: string;
    underlying_symbol?: string;
    instrument_key?: string;
    trading_symbol?: string;
    strike_price?: number;
    expiry?: number;
    lot_size?: number;
    weekly?: boolean;
    segment?: string;
  }>;

  const byUnderlying: Record<string, OptionContract[]> = {};
  for (const row of data) {
    if (row.instrument_type !== "CE" && row.instrument_type !== "PE") continue;
    if ((row.underlying_type || "").toUpperCase() !== "EQUITY") continue;
    if (row.segment && row.segment !== "NSE_FO") continue;
    const u = (row.underlying_symbol || "").toUpperCase();
    if (
      !u ||
      !row.instrument_key ||
      !row.strike_price ||
      !row.expiry ||
      !row.lot_size
    )
      continue;

    const c: OptionContract = {
      instrumentKey: row.instrument_key,
      tradingSymbol: row.trading_symbol || "",
      underlying: u,
      strike: Number(row.strike_price),
      side: row.instrument_type as "CE" | "PE",
      expiry: Number(row.expiry),
      lotSize: Number(row.lot_size),
      weekly: Boolean(row.weekly),
    };
    if (!byUnderlying[u]) byUnderlying[u] = [];
    byUnderlying[u].push(c);
  }

  const cache: ContractCache = { savedAt: Date.now(), byUnderlying };
  memory = cache;
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    // store compact - only underlyings we need can be large; full is OK for local
    fs.writeFileSync(cachePath, JSON.stringify(cache));
  } catch {
    // non-fatal
  }
  return cache;
}
