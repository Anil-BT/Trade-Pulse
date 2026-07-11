import fs from "fs";
import path from "path";
import type { Candle } from "../types";
import { filterCandlesByRange } from "./dates";

const CACHE_DIR = path.join(process.cwd(), ".data-cache");

function ensureDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function safeName(key: string): string {
  return key.replace(/[^a-zA-Z0-9._|=-]/g, "_");
}

function keyPath(key: string): string {
  return path.join(CACHE_DIR, `${safeName(key)}.json`);
}

export function readCache(key: string, maxAgeMs = 12 * 60 * 60 * 1000): Candle[] | null {
  try {
    ensureDir();
    const p = keyPath(key);
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as {
      savedAt: number;
      candles: Candle[];
    };
    if (Date.now() - raw.savedAt > maxAgeMs) return null;
    return raw.candles;
  } catch {
    return null;
  }
}

/**
 * Slice candles from any cached file for the same source/symbol/interval
 * that overlaps [startMs, endMs]. Lets a 1-day query reuse a month-long cache.
 */
export function readCacheCovering(opts: {
  source: string;
  symbol: string;
  interval: string;
  startMs: number;
  endMs: number;
  maxAgeMs?: number;
}): Candle[] | null {
  try {
    ensureDir();
    const maxAge = opts.maxAgeMs ?? 12 * 60 * 60 * 1000;
    const prefix = safeName(
      `${opts.source}_${opts.symbol.toUpperCase()}_${opts.interval}_`
    );

    let best: Candle[] | null = null;
    let bestCount = 0;

    for (const file of fs.readdirSync(CACHE_DIR)) {
      if (!file.endsWith(".json")) continue;
      if (!file.startsWith(prefix) && !file.startsWith(safeName(prefix))) continue;

      let raw: { savedAt: number; candles: Candle[] };
      try {
        raw = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), "utf8"));
      } catch {
        continue;
      }
      if (Date.now() - raw.savedAt > maxAge) continue;
      if (!raw.candles?.length) continue;

      const sliced = filterCandlesByRange(raw.candles, opts.startMs, opts.endMs);
      if (sliced.length > bestCount) {
        best = sliced;
        bestCount = sliced.length;
      }
    }

    return bestCount > 0 ? best : null;
  } catch {
    return null;
  }
}

export function writeCache(key: string, candles: Candle[]) {
  try {
    ensureDir();
    fs.writeFileSync(
      keyPath(key),
      JSON.stringify({ savedAt: Date.now(), candles }),
      "utf8"
    );
  } catch {
    // non-fatal
  }
}
