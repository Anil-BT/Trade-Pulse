/**
 * Day-level backtest cache in Firestore:
 *   users/{uid}/dayCaches/{fingerprint_YYYY-MM-DD}
 *
 * Stores trades (+ light candles) so re-runs of the same strategy/day
 * skip broker APIs (Upstox / Dhan / Kite).
 */
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import type { Candle, Trade } from "../types";
import { getFirebase, isFirebaseConfigured } from "./client";
import { dayCacheDocId } from "../fingerprint";

export type DayCacheRecord = {
  fingerprint: string;
  day: string; // YYYY-MM-DD IST session
  symbol: string;
  interval: string;
  source: string;
  trades: Trade[];
  /** Optional session candles for charts (may be downsampled) */
  candles?: Candle[];
  savedAt: number;
  strategyName?: string;
};

const COL = "dayCaches";

export function dayCacheAvailable(): boolean {
  return isFirebaseConfigured();
}

export async function loadDayCache(
  userId: string,
  fingerprint: string,
  day: string
): Promise<DayCacheRecord | null> {
  const fb = getFirebase();
  if (!fb || !userId) return null;
  try {
    const ref = doc(fb.db, "users", userId, COL, dayCacheDocId(fingerprint, day));
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    const data = snap.data() as DayCacheRecord;
    if (!data?.trades) return null;
    return data;
  } catch {
    return null;
  }
}

export async function loadDaysFromCache(
  userId: string,
  fingerprint: string,
  days: string[]
): Promise<Map<string, DayCacheRecord>> {
  const map = new Map<string, DayCacheRecord>();
  // Parallel but capped
  const batchSize = 8;
  for (let i = 0; i < days.length; i += batchSize) {
    const slice = days.slice(i, i + batchSize);
    const results = await Promise.all(
      slice.map((d) => loadDayCache(userId, fingerprint, d))
    );
    results.forEach((r, j) => {
      if (r) map.set(slice[j], r);
    });
  }
  return map;
}

export async function saveDayCache(
  userId: string,
  record: DayCacheRecord
): Promise<void> {
  const fb = getFirebase();
  if (!fb || !userId) throw new Error("Sign in to save results to cloud.");
  const id = dayCacheDocId(record.fingerprint, record.day);
  await setDoc(doc(fb.db, "users", userId, COL, id), {
    ...record,
    savedAt: Date.now(),
  });
}

/** Save multiple days (e.g. after a full backtest). Batched. */
export async function saveDayCaches(
  userId: string,
  records: DayCacheRecord[]
): Promise<number> {
  const fb = getFirebase();
  if (!fb || !userId) throw new Error("Sign in to save results to cloud.");
  if (!records.length) return 0;

  let n = 0;
  // Firestore batch limit 500
  for (let i = 0; i < records.length; i += 400) {
    const batch = writeBatch(fb.db);
    const slice = records.slice(i, i + 400);
    for (const r of slice) {
      const id = dayCacheDocId(r.fingerprint, r.day);
      batch.set(doc(fb.db, "users", userId, COL, id), {
        ...r,
        savedAt: Date.now(),
      });
      n += 1;
    }
    await batch.commit();
  }
  return n;
}

/** Optional: list all cached days for a fingerprint (debug / future UI) */
export async function listCachedDays(
  userId: string,
  fingerprint: string
): Promise<string[]> {
  const fb = getFirebase();
  if (!fb || !userId) return [];
  try {
    const q = query(
      collection(fb.db, "users", userId, COL),
      where("fingerprint", "==", fingerprint)
    );
    const snap = await getDocs(q);
    const days: string[] = [];
    snap.forEach((d) => {
      const day = (d.data() as DayCacheRecord).day;
      if (day) days.push(day);
    });
    return days.sort();
  } catch {
    return [];
  }
}
