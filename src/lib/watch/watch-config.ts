/**
 * Market Watch user config — localStorage + optional Firestore (signed-in).
 */
import { doc, getDoc, setDoc } from "firebase/firestore";
import { getFirebase } from "@/lib/firebase/client";
import type { Interval } from "@/lib/types";

export type WatchDataSource = "yahoo" | "upstox";

export type WatchStrategyPref = {
  id: string;
  selected: boolean;
  telegramNotify: boolean;
};

export type MarketWatchConfig = {
  version: 1;
  dataSource: WatchDataSource;
  interval: Interval;
  batchSize: number;
  runOnMarketOpen: boolean;
  telegramChatId: string;
  strategies: WatchStrategyPref[];
  updatedAt: number;
};

const LOCAL_KEY = "tp_market_watch_config_v1";

export function loadLocalWatchConfig(): MarketWatchConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as MarketWatchConfig;
    if (!c || c.version !== 1) return null;
    return c;
  } catch {
    return null;
  }
}

export function saveLocalWatchConfig(config: MarketWatchConfig): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(LOCAL_KEY, JSON.stringify(config));
  // Legacy chat id key (compat)
  if (config.telegramChatId) {
    localStorage.setItem("tp_telegram_chat_id", config.telegramChatId);
  }
}

export async function loadCloudWatchConfig(
  userId: string
): Promise<MarketWatchConfig | null> {
  const fb = getFirebase();
  if (!fb || !userId) return null;
  try {
    const ref = doc(fb.db, "users", userId, "settings", "marketWatch");
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    const data = snap.data() as MarketWatchConfig;
    if (!data || data.version !== 1) return null;
    return data;
  } catch (e) {
    console.warn("[watch-config] cloud load failed:", e);
    return null;
  }
}

export async function saveCloudWatchConfig(
  userId: string,
  config: MarketWatchConfig
): Promise<void> {
  const fb = getFirebase();
  if (!fb || !userId) throw new Error("Sign in required to save to cloud");
  const ref = doc(fb.db, "users", userId, "settings", "marketWatch");
  await setDoc(ref, { ...config, updatedAt: Date.now() }, { merge: true });
}

/** Prefer newer of local vs cloud. */
export async function loadWatchConfig(
  userId?: string | null
): Promise<MarketWatchConfig | null> {
  const local = loadLocalWatchConfig();
  if (!userId) return local;
  const cloud = await loadCloudWatchConfig(userId);
  if (!cloud) return local;
  if (!local) return cloud;
  return (cloud.updatedAt || 0) >= (local.updatedAt || 0) ? cloud : local;
}

export async function saveWatchConfig(
  config: MarketWatchConfig,
  userId?: string | null
): Promise<{ cloud: boolean; local: boolean; cloudError?: string }> {
  const next = { ...config, updatedAt: Date.now(), version: 1 as const };
  saveLocalWatchConfig(next);
  if (!userId) {
    return { cloud: false, local: true };
  }
  try {
    await saveCloudWatchConfig(userId, next);
    return { cloud: true, local: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // permission-denied when Firestore rules omit /settings
    const friendly = /permission|insufficient/i.test(msg)
      ? "Cloud save blocked by Firestore rules. Publish rules for users/{uid}/settings (see docs/FIREBASE.md). Config is still saved on this device."
      : msg;
    return { cloud: false, local: true, cloudError: friendly };
  }
}
