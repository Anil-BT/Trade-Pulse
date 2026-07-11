/**
 * Named strategies — browser localStorage (works on Vercel; no server disk).
 * Later can swap to Firebase under the same API.
 */
import type { SavedStrategy, StrategyConfig } from "./types";
import { uid } from "./format";

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

function writeAll(list: SavedStrategy[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(KEY, JSON.stringify(list));
}

export function listSavedStrategies(): SavedStrategy[] {
  return readAll().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function saveStrategy(
  name: string,
  strategy: StrategyConfig,
  existingId?: string
): SavedStrategy {
  const list = readAll();
  const now = Date.now();
  const cleanName = name.trim() || strategy.name || "Untitled strategy";

  if (existingId) {
    const idx = list.findIndex((s) => s.id === existingId);
    if (idx >= 0) {
      list[idx] = {
        ...list[idx],
        name: cleanName,
        strategy: structuredClone({ ...strategy, name: cleanName }),
        updatedAt: now,
      };
      writeAll(list);
      return list[idx];
    }
  }

  // Upsert by name (case-insensitive)
  const byName = list.findIndex(
    (s) => s.name.toLowerCase() === cleanName.toLowerCase()
  );
  if (byName >= 0) {
    list[byName] = {
      ...list[byName],
      name: cleanName,
      strategy: structuredClone({ ...strategy, name: cleanName }),
      updatedAt: now,
    };
    writeAll(list);
    return list[byName];
  }

  const row: SavedStrategy = {
    id: uid(),
    name: cleanName,
    strategy: structuredClone({ ...strategy, name: cleanName }),
    createdAt: now,
    updatedAt: now,
  };
  list.push(row);
  writeAll(list);
  return row;
}

export function deleteSavedStrategy(id: string) {
  writeAll(readAll().filter((s) => s.id !== id));
}

export function getSavedStrategy(id: string): SavedStrategy | null {
  return readAll().find((s) => s.id === id) || null;
}
