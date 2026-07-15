"use client";

import { useCallback, useEffect, useState } from "react";
import type { SavedStrategy, StrategyConfig } from "@/lib/types";
import {
  deleteSavedStrategy,
  listSavedStrategies,
  saveStrategy,
} from "@/lib/strategy-store";
import { useAuth } from "@/lib/firebase/auth-context";
import {
  deleteCloudStrategy,
  migrateLocalToCloud,
  saveCloudStrategy,
} from "@/lib/firebase/strategies";
import { listUnifiedStrategies } from "@/lib/strategies/catalog";
import { notifyStrategiesChanged } from "@/lib/strategies/events";

export function StrategyLibrary({
  strategy,
  onLoad,
  onRenamed,
}: {
  strategy: StrategyConfig;
  onLoad: (s: StrategyConfig) => void;
  onRenamed?: (name: string) => void;
}) {
  const { user, configured } = useAuth();
  const [saved, setSaved] = useState<SavedStrategy[]>([]);
  const [name, setName] = useState(strategy.name || "");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const cloud = Boolean(configured && user);

  const refresh = useCallback(async () => {
    try {
      setSaved(await listUnifiedStrategies(user?.uid ?? null));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed to load strategies");
      setSaved(listSavedStrategies());
    }
  }, [user?.uid]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // First cloud login: push browser strategies if cloud is empty
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const n = await migrateLocalToCloud(user.uid, listSavedStrategies());
        if (!cancelled && n > 0) {
          setMsg(`Synced ${n} local strateg${n === 1 ? "y" : "ies"} to cloud`);
          setTimeout(() => setMsg(null), 3000);
          await refresh();
        }
      } catch {
        // ignore migration errors
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, refresh]);

  useEffect(() => {
    setName(strategy.name || "");
  }, [strategy.name]);

  async function handleSave() {
    setBusy(true);
    setMsg(null);
    try {
      if (user) {
        const row = await saveCloudStrategy(
          user.uid,
          name || strategy.name,
          strategy
        );
        // also keep a local backup
        saveStrategy(row.name, row.strategy, row.id);
        setMsg(`Saved “${row.name}” — available in Paper & Market Watch`);
        onRenamed?.(row.name);
      } else {
        const row = saveStrategy(name || strategy.name, strategy);
        setMsg(
          configured
            ? `Saved “${row.name}” on this device (sign in to sync). Available in Paper & Market Watch.`
            : `Saved “${row.name}” — available in Paper & Market Watch`
        );
        onRenamed?.(row.name);
      }
      notifyStrategiesChanged();
      await refresh();
      setTimeout(() => setMsg(null), 2500);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  function handleLoad(id: string) {
    const row = saved.find((s) => s.id === id);
    if (!row) return;
    onLoad(structuredClone(row.strategy));
    setMsg(`Loaded “${row.name}”`);
    setTimeout(() => setMsg(null), 2000);
  }

  async function handleDelete(id: string) {
    const row = saved.find((s) => s.id === id);
    if (!row) return;
    if (!confirm(`Delete strategy “${row.name}”?`)) return;
    setBusy(true);
    try {
      if (user) {
        await deleteCloudStrategy(user.uid, id);
      }
      deleteSavedStrategy(id);
      notifyStrategiesChanged();
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-2xl border border-neutral-200 bg-neutral-50/80 p-4">
      <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
        Save strategy
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Strategy name"
          className="field-input flex-1"
        />
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={busy}
          className="rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
        >
          Save
        </button>
      </div>
      {msg && <p className="text-xs text-neutral-600">{msg}</p>}
      <p className="text-[11px] text-neutral-400">
        {cloud
          ? "Synced to Firebase — same list appears in Paper Trading and Market Watch."
          : configured
            ? "Saved on this device (also Paper & Market Watch). Sign in to sync across devices."
            : "Saved on this device — also listed in Paper Trading and Market Watch."}
      </p>

      {saved.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
            Your strategies
          </p>
          <ul className="divide-y divide-neutral-200 overflow-hidden rounded-xl border border-neutral-200 bg-white">
            {saved.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center gap-2 px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{s.name}</p>
                  <p className="text-[10px] text-neutral-400">
                    {s.strategy.entry.length} entry · {s.strategy.exit.length}{" "}
                    exit ·{" "}
                    {new Date(s.updatedAt).toLocaleString("en-IN", {
                      day: "2-digit",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleLoad(s.id)}
                  className="rounded-full border border-neutral-300 px-3 py-1 text-xs font-medium hover:border-black"
                >
                  Load
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete(s.id)}
                  className="rounded-full px-2 py-1 text-xs text-neutral-500 hover:text-black"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
