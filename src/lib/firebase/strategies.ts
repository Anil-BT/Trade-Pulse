/**
 * Per-user strategy documents in Firestore:
 *   users/{uid}/strategies/{id}
 */
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  setDoc,
  type Firestore,
} from "firebase/firestore";
import type { SavedStrategy, StrategyConfig } from "../types";
import { uid } from "../format";
import { getFirebase } from "./client";

function col(db: Firestore, userId: string) {
  return collection(db, "users", userId, "strategies");
}

export async function listCloudStrategies(
  userId: string
): Promise<SavedStrategy[]> {
  const fb = getFirebase();
  if (!fb) return [];
  const snap = await getDocs(col(fb.db, userId));
  const list: SavedStrategy[] = [];
  snap.forEach((d) => {
    const data = d.data() as Omit<SavedStrategy, "id">;
    if (!data?.strategy) return;
    list.push({
      id: d.id,
      name: data.name || "Untitled",
      strategy: data.strategy,
      createdAt: data.createdAt || 0,
      updatedAt: data.updatedAt || 0,
    });
  });
  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveCloudStrategy(
  userId: string,
  name: string,
  strategy: StrategyConfig,
  existingId?: string
): Promise<SavedStrategy> {
  const fb = getFirebase();
  if (!fb) throw new Error("Firebase not configured");

  const now = Date.now();
  const cleanName = name.trim() || strategy.name || "Untitled strategy";
  const existing = await listCloudStrategies(userId);

  let id = existingId;
  if (!id) {
    const byName = existing.find(
      (s) => s.name.toLowerCase() === cleanName.toLowerCase()
    );
    id = byName?.id;
  }
  if (!id) id = uid();

  const prev = existing.find((s) => s.id === id);
  const row: SavedStrategy = {
    id,
    name: cleanName,
    strategy: structuredClone({ ...strategy, name: cleanName }),
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };

  await setDoc(doc(fb.db, "users", userId, "strategies", id), {
    name: row.name,
    strategy: row.strategy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  return row;
}

export async function deleteCloudStrategy(userId: string, id: string) {
  const fb = getFirebase();
  if (!fb) return;
  await deleteDoc(doc(fb.db, "users", userId, "strategies", id));
}

/**
 * One-time: push local strategies into cloud if cloud is empty.
 * Does not overwrite existing cloud docs.
 */
export async function migrateLocalToCloud(
  userId: string,
  local: SavedStrategy[]
): Promise<number> {
  if (!local.length) return 0;
  const cloud = await listCloudStrategies(userId);
  if (cloud.length > 0) return 0;

  let n = 0;
  for (const s of local) {
    await saveCloudStrategy(userId, s.name, s.strategy, s.id);
    n += 1;
  }
  return n;
}
