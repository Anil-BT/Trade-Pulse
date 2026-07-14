/**
 * Stable fingerprint for day-level backtest cache keys.
 * Same strategy + symbol + settings + day → same cache hit.
 */
import type {
  BacktestRequest,
  EntryTimeWindow,
  OptionsTradeSettings,
  StrategyConfig,
} from "./types";

export type CacheSettings = {
  symbol: string;
  interval: string;
  source: string;
  tradeInstrument: string;
  strategy: StrategyConfig;
  oneTradePerDay?: boolean;
  entryTimeWindows?: EntryTimeWindow[];
  maxRiskPerTrade?: BacktestRequest["maxRiskPerTrade"];
  options?: OptionsTradeSettings;
  positionSizePct?: number;
  /** Lot size matters for options results */
  initialCapital?: number;
  /**
   * F&O universe scope — included so "all F&O" and "max N" caches stay separate.
   * e.g. "FNO_ALL" | "FNO_50" | omit for single-symbol day cache
   */
  scanScope?: string;
};

export function buildCacheFingerprint(s: CacheSettings): string {
  const payload = {
    symbol: s.symbol.trim().toUpperCase().replace(/\.NS$/i, ""),
    scanScope: s.scanScope || null,
    interval: s.interval,
    source: s.source,
    tradeInstrument: s.tradeInstrument || "equity",
    oneTradePerDay: Boolean(s.oneTradePerDay),
    positionSizePct: s.positionSizePct ?? 25,
    initialCapital: s.initialCapital ?? 100000,
    entryTimeWindows: s.entryTimeWindows || null,
    maxRiskPerTrade: s.maxRiskPerTrade?.enabled
      ? {
          mode: s.maxRiskPerTrade.mode,
          pct: s.maxRiskPerTrade.pct,
          amount: s.maxRiskPerTrade.amount,
        }
      : null,
    options:
      s.tradeInstrument === "options_atm" && s.options
        ? {
            side: s.options.side,
            lotSize: s.options.lotSize,
            strikeStep: s.options.strikeStep,
            iv: s.options.iv,
            daysToExpiry: s.options.daysToExpiry,
          }
        : null,
    strategy: {
      name: s.strategy.name,
      entryLogic: s.strategy.entryLogic ?? "and",
      exitLogic: s.strategy.exitLogic ?? "and",
      trailStopToCost: s.strategy.trailStopToCost?.enabled
        ? {
            enabled: true,
            profitPctOfCapital:
              s.strategy.trailStopToCost.profitPctOfCapital ?? 20,
          }
        : null,
      entry: s.strategy.entry.map((c) => ({
        left: c.left,
        op: c.op,
        right: c.right,
      })),
      exit: s.strategy.exit.map((c) => ({
        left: c.left,
        op: c.op,
        right: c.right,
      })),
    },
  };
  return simpleHash(stableStringify(payload));
}

/**
 * Fingerprint for multi-symbol F&O scan cache (not single stock).
 * - scanAll → FNO_ALL
 * - else → FNO_{maxSymbols}
 * Also returns legacy keys so older saves still hit.
 */
export function buildFnoScanFingerprints(opts: {
  base: Omit<CacheSettings, "symbol" | "scanScope">;
  scanAll: boolean;
  maxSymbols: number;
}): { primary: string; candidates: string[] } {
  const maxN = Math.min(400, Math.max(1, opts.maxSymbols || 50));
  const scope = opts.scanAll ? "FNO_ALL" : `FNO_${maxN}`;

  const primary = buildCacheFingerprint({
    ...opts.base,
    symbol: "FNO_UNIVERSE",
    scanScope: scope,
  });

  // Legacy saves used symbol FNO_UNIVERSE with no scanScope
  const legacyUniverse = buildCacheFingerprint({
    ...opts.base,
    symbol: "FNO_UNIVERSE",
  });

  const candidates = [...new Set([primary, legacyUniverse])];
  return { primary, candidates };
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Fast non-crypto hash → hex string for doc ids */
function simpleHash(str: string): string {
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, "0");
}

export function dayCacheDocId(fingerprint: string, day: string): string {
  // Firestore doc ids: no slashes
  return `${fingerprint}_${day}`;
}
