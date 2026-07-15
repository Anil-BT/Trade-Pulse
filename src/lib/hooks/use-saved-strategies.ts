"use client";

import { useCallback, useEffect, useState } from "react";
import type { SavedStrategy } from "@/lib/types";
import { useAuth } from "@/lib/firebase/auth-context";
import { listUnifiedStrategies } from "@/lib/strategies/catalog";
import { STRATEGIES_CHANGED_EVENT } from "@/lib/strategies/events";

/**
 * Live list of user-created strategies (local + cloud).
 * Shared by Backtest library, Paper Trading, and Market Watch.
 */
export function useSavedStrategies(): {
  saved: SavedStrategy[];
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const { user } = useAuth();
  const [saved, setSaved] = useState<SavedStrategy[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listUnifiedStrategies(user?.uid ?? null);
      setSaved(list);
    } catch {
      setSaved([]);
    } finally {
      setLoading(false);
    }
  }, [user?.uid]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Cross-page / same-tab updates after Save in Backtest
  useEffect(() => {
    const onChange = () => {
      void refresh();
    };
    const onFocus = () => {
      void refresh();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === "tradepulse_saved_strategies_v1") void refresh();
    };
    window.addEventListener(STRATEGIES_CHANGED_EVENT, onChange);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") onFocus();
    });
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(STRATEGIES_CHANGED_EVENT, onChange);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("storage", onStorage);
    };
  }, [refresh]);

  return { saved, loading, refresh };
}
