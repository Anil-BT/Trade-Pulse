"use client";

import type { StrategyConfig } from "@/lib/types";

/** Per-lot take-profit / trailing SL / trail-to-cost / strategy-exit flags. */
export function TrailStopFields({
  strategy,
  onChange,
  disabled = false,
  lotsHint = "Lots per trade is under Trade rules.",
}: {
  strategy: StrategyConfig;
  onChange: (
    s: StrategyConfig | ((prev: StrategyConfig) => StrategyConfig)
  ) => void;
  disabled?: boolean;
  /** Shown under the section title */
  lotsHint?: string;
}) {
  const nLots = Math.min(5, Math.max(1, strategy.positionLots || 1));
  const rules = strategy.lotRules || [];

  function updateLot(
    idx: number,
    patch: Partial<NonNullable<StrategyConfig["lotRules"]>[0]>
  ) {
    if (disabled) return;
    onChange((s) => {
      const n = Math.min(5, Math.max(1, s.positionLots || 1));
      const next = [...(s.lotRules || [])];
      while (next.length < n) {
        next.push({
          trailPct: undefined,
          trailToCost: false,
          exitOnSignal: true,
        });
      }
      next[idx] = { ...next[idx], ...patch };
      return { ...s, positionLots: n, lotRules: next.slice(0, n) };
    });
  }

  return (
    <div className="mb-4 space-y-3 rounded-2xl border border-neutral-200 bg-neutral-50/80 p-4">
      <p className="text-sm font-medium text-black">
        Per-lot take-profit / trailing / exits
      </p>
      <p className="text-xs text-neutral-500">
        {lotsHint} Scale-out example: lot 1 take-profit 20%, lot 2 trail to cost
        (arms after lot 1 books) and/or trailing SL.
      </p>
      {Array.from({ length: nLots }, (_, idx) => {
        const rule = rules[idx] || {};
        const trailOn = rule.trailPct != null && rule.trailPct > 0;
        const tpOn = rule.takeProfitPct != null && rule.takeProfitPct > 0;
        return (
          <div
            key={idx}
            className="rounded-xl border border-neutral-200 bg-white p-3"
          >
            <p className="mb-2 text-xs font-semibold tracking-wide text-neutral-600 uppercase">
              Lot {idx + 1}
            </p>
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                disabled={disabled}
                checked={tpOn}
                onChange={(e) =>
                  updateLot(idx, {
                    takeProfitPct: e.target.checked
                      ? rule.takeProfitPct || 20
                      : 0,
                  })
                }
                className="mt-0.5 h-4 w-4 accent-black"
              />
              <span className="flex-1 text-sm">
                Take-profit %
                {tpOn && (
                  <span className="mt-1 flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={500}
                      step={1}
                      disabled={disabled}
                      value={rule.takeProfitPct || 20}
                      onChange={(e) =>
                        updateLot(idx, {
                          takeProfitPct: Math.min(
                            500,
                            Math.max(1, Number(e.target.value) || 1)
                          ),
                        })
                      }
                      className="field-input w-20"
                    />
                    <span className="text-xs text-neutral-500">
                      close lot when mark ≥ entry + this %
                    </span>
                  </span>
                )}
              </span>
            </label>
            <label className="mt-2 flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                disabled={disabled}
                checked={trailOn}
                onChange={(e) =>
                  updateLot(idx, {
                    trailPct: e.target.checked ? rule.trailPct || 1 : 0,
                  })
                }
                className="mt-0.5 h-4 w-4 accent-black"
              />
              <span className="flex-1 text-sm">
                Trailing SL %
                {trailOn && (
                  <span className="mt-1 flex items-center gap-2">
                    <input
                      type="number"
                      min={0.1}
                      max={50}
                      step={0.1}
                      disabled={disabled}
                      value={rule.trailPct || 1}
                      onChange={(e) =>
                        updateLot(idx, {
                          trailPct: Math.min(
                            50,
                            Math.max(0.1, Number(e.target.value) || 0.1)
                          ),
                        })
                      }
                      className="field-input w-20"
                    />
                    <span className="text-xs text-neutral-500">
                      % below peak
                    </span>
                  </span>
                )}
              </span>
            </label>
            <label className="mt-2 flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                disabled={disabled}
                checked={Boolean(rule.trailToCost)}
                onChange={(e) =>
                  updateLot(idx, {
                    trailToCost: e.target.checked,
                    armToCostOnPartialTp:
                      e.target.checked && nLots > 1
                        ? rule.armToCostOnPartialTp !== false
                        : rule.armToCostOnPartialTp,
                  })
                }
                className="mt-0.5 h-4 w-4 accent-black"
              />
              <span className="flex-1 text-sm">
                Trail to cost (breakeven)
                {rule.trailToCost && (
                  <span className="mt-1 flex flex-col gap-1">
                    <span className="flex items-center gap-2">
                      <input
                        type="number"
                        min={1}
                        max={100}
                        disabled={disabled}
                        value={rule.trailToCostProfitPctOfCapital ?? 20}
                        onChange={(e) =>
                          updateLot(idx, {
                            trailToCostProfitPctOfCapital: Math.min(
                              100,
                              Math.max(1, Number(e.target.value) || 1)
                            ),
                          })
                        }
                        className="field-input w-20"
                      />
                      <span className="text-xs text-neutral-500">
                        % of capital (this lot&apos;s share) to arm BE
                      </span>
                    </span>
                    {nLots > 1 && (
                      <label className="flex cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          disabled={disabled}
                          checked={rule.armToCostOnPartialTp !== false}
                          onChange={(e) =>
                            updateLot(idx, {
                              armToCostOnPartialTp: e.target.checked,
                            })
                          }
                          className="h-4 w-4 accent-black"
                        />
                        <span className="text-xs text-neutral-600">
                          Arm BE when another lot takes profit
                        </span>
                      </label>
                    )}
                  </span>
                )}
              </span>
            </label>
            <label className="mt-2 flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                disabled={disabled}
                checked={rule.exitOnSignal !== false}
                onChange={(e) =>
                  updateLot(idx, { exitOnSignal: e.target.checked })
                }
                className="h-4 w-4 accent-black"
              />
              <span className="text-sm">Exit on strategy signal</span>
            </label>
          </div>
        );
      })}
    </div>
  );
}
