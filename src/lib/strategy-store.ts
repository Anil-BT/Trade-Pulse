/**
 * Named strategies — browser localStorage (works offline / without Firebase).
 * When signed in, StrategyLibrary also uses Firestore (see lib/firebase/strategies.ts).
 * Backtest / Paper / Market Watch share this list via useSavedStrategies.
 */
import type { SavedStrategy, StrategyConfig } from "./types";
import { uid } from "./format";
import { notifyStrategiesChanged } from "./strategies/events";

const KEY = "tradepulse_saved_strategies_v1";

function readAll(): SavedStrategy[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as SavedStrategy[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeAll(list: SavedStrategy[], opts?: { silent?: boolean }) {
  if (typeof window === "undefined") return;
  localStorage.setItem(KEY, JSON.stringify(list));
  if (!opts?.silent) notifyStrategiesChanged();
}

export function listSavedStrategies(): SavedStrategy[] {
  return readAll().sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Upsert a named strategy into localStorage.
 * `silent: true` skips the cross-page change event (used when caching cloud → local).
 */
export function saveStrategy(
  name: string,
  strategy: StrategyConfig,
  existingId?: string,
  opts?: { silent?: boolean }
): SavedStrategy {
  const list = readAll();
  const now = Date.now();
  const cleanName = name.trim() || strategy.name || "Untitled strategy";
  const silent = Boolean(opts?.silent);
  const nextStrategy = structuredClone({ ...strategy, name: cleanName });

  if (existingId) {
    const idx = list.findIndex((s) => s.id === existingId);
    if (idx >= 0) {
      const prev = list[idx];
      list[idx] = {
        ...prev,
        name: cleanName,
        strategy: nextStrategy,
        updatedAt: silent ? prev.updatedAt || now : now,
      };
      writeAll(list, { silent });
      return list[idx];
    }
  }

  // Upsert by name (case-insensitive)
  const byName = list.findIndex(
    (s) => s.name.toLowerCase() === cleanName.toLowerCase()
  );
  if (byName >= 0) {
    const prev = list[byName];
    list[byName] = {
      ...prev,
      name: cleanName,
      strategy: nextStrategy,
      updatedAt: silent ? prev.updatedAt || now : now,
    };
    writeAll(list, { silent });
    return list[byName];
  }

  const row: SavedStrategy = {
    id: existingId || uid(),
    name: cleanName,
    strategy: nextStrategy,
    createdAt: now,
    updatedAt: now,
  };
  list.push(row);
  writeAll(list, { silent });
  return row;
}

export function deleteSavedStrategy(id: string) {
  writeAll(readAll().filter((s) => s.id !== id));
}

export function getSavedStrategy(id: string): SavedStrategy | null {
  return readAll().find((s) => s.id === id) || null;
}
