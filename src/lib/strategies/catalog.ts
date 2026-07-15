/**
 * Unified strategy catalog shared by Backtest, Paper, and Market Watch.
 * Merges browser localStorage + Firestore (when signed in).
 */
import type { SavedStrategy } from "../types";
import { listSavedStrategies, saveStrategy } from "../strategy-store";
import { listCloudStrategies } from "../firebase/strategies";
export {
  STRATEGIES_CHANGED_EVENT,
  notifyStrategiesChanged,
} from "./events";

function strategyKey(s: SavedStrategy): string {
  return (s.id || s.name || "").toLowerCase();
}

function nameKey(s: SavedStrategy): string {
  return (s.name || s.strategy?.name || "").trim().toLowerCase();
}

/**
 * Merge local + cloud lists. Cloud wins on same id; otherwise newest by name.
 * Always mirrors cloud rows into localStorage so offline UIs stay populated.
 */
export async function listUnifiedStrategies(
  userId?: string | null
): Promise<SavedStrategy[]> {
  const local = listSavedStrategies();
  let cloud: SavedStrategy[] = [];
  if (userId) {
    try {
      cloud = await listCloudStrategies(userId);
    } catch {
      cloud = [];
    }
  }

  const byId = new Map<string, SavedStrategy>();
  const byName = new Map<string, SavedStrategy>();

  const put = (s: SavedStrategy, prefer = false) => {
    if (!s?.strategy?.entry?.length) return;
    const id = strategyKey(s);
    const nk = nameKey(s);
    const prevId = id ? byId.get(id) : undefined;
    const prevName = nk ? byName.get(nk) : undefined;

    const better = (prev?: SavedStrategy) => {
      if (!prev) return true;
      if (prefer) return true;
      return (s.updatedAt || 0) >= (prev.updatedAt || 0);
    };

    if (id && better(prevId)) byId.set(id, s);
    if (nk && better(prevName)) byName.set(nk, s);
  };

  for (const s of local) put(s, false);
  for (const s of cloud) put(s, true);

  // Prefer id map, fill names not covered
  const out = new Map<string, SavedStrategy>();
  for (const s of byId.values()) {
    out.set(s.id || nameKey(s), s);
  }
  for (const s of byName.values()) {
    const hit = [...out.values()].find(
      (x) => nameKey(x) === nameKey(s)
    );
    if (!hit) out.set(s.id || nameKey(s), s);
    else if ((s.updatedAt || 0) > (hit.updatedAt || 0)) {
      out.set(hit.id || nameKey(hit), s);
    }
  }

  const list = [...out.values()].sort(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
  );

  // Cache into localStorage (silent — no change events / refresh loops)
  for (const s of list) {
    try {
      saveStrategy(s.name, s.strategy, s.id, { silent: true });
    } catch {
      /* ignore */
    }
  }

  return list;
}
