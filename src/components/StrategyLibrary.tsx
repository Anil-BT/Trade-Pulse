"use client";

import { useEffect, useState } from "react";
import type { SavedStrategy, StrategyConfig } from "@/lib/types";
import {
  deleteSavedStrategy,
  listSavedStrategies,
  saveStrategy,
} from "@/lib/strategy-store";

export function StrategyLibrary({
  strategy,
  onLoad,
  onRenamed,
}: {
  strategy: StrategyConfig;
  onLoad: (s: StrategyConfig) => void;
  onRenamed?: (name: string) => void;
}) {
  const [saved, setSaved] = useState<SavedStrategy[]>([]);
  const [name, setName] = useState(strategy.name || "");
  const [msg, setMsg] = useState<string | null>(null);

  function refresh() {
    setSaved(listSavedStrategies());
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    setName(strategy.name || "");
  }, [strategy.name]);

  function handleSave() {
    const row = saveStrategy(name || strategy.name, strategy);
    setMsg(`Saved “${row.name}”`);
    onRenamed?.(row.name);
    refresh();
    setTimeout(() => setMsg(null), 2500);
  }

  function handleLoad(id: string) {
    const row = saved.find((s) => s.id === id);
    if (!row) return;
    onLoad(structuredClone(row.strategy));
    setMsg(`Loaded “${row.name}”`);
    setTimeout(() => setMsg(null), 2000);
  }

  function handleDelete(id: string) {
    const row = saved.find((s) => s.id === id);
    if (!row) return;
    if (!confirm(`Delete strategy “${row.name}”?`)) return;
    deleteSavedStrategy(id);
    refresh();
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
          onClick={handleSave}
          className="rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white hover:bg-neutral-800"
        >
          Save
        </button>
      </div>
      {msg && <p className="text-xs text-neutral-600">{msg}</p>}
      <p className="text-[11px] text-neutral-400">
        Saved in this browser (localStorage). Firebase sync can be added later.
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
                  onClick={() => handleDelete(s.id)}
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
