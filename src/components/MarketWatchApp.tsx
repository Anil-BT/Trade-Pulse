"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { STRATEGY_PRESETS } from "@/lib/presets";
import { formatTime, uid } from "@/lib/format";
import {
  parseApiJson,
  safeErrorMessage,
  sanitizeToken,
} from "@/lib/http";
import {
  computeSectorStrength,
  sectorOf,
  symbolsInSector,
  type SectorStrength,
} from "@/lib/watch/sectors";
import {
  loadWatchConfig,
  saveWatchConfig,
  type MarketWatchConfig,
  type WatchStrategyPref,
} from "@/lib/watch/watch-config";
import { sessionStatus } from "@/lib/paper/market-hours";
import { useSavedStrategies } from "@/lib/hooks/use-saved-strategies";
import { useAuth } from "@/lib/firebase/auth-context";
import type { Interval, StrategyConfig } from "@/lib/types";

const INTERVALS: { value: Interval; label: string }[] = [
  { value: "1m", label: "1 min" },
  { value: "5m", label: "5 min" },
  { value: "15m", label: "15 min" },
];

type WatchMatch = {
  symbol: string;
  strategyName: string;
  price: number;
  barTime: number;
  entryMatch: boolean;
  exitMatch: boolean;
  changePct?: number;
  /** Realized vol annualized % */
  rvol?: number;
  message?: string;
  /** First time this symbol matched this strategy (sticky) */
  addedAt?: number;
  sector?: string;
};

/** Full-universe F&O quote (sector graph — no strategy filter). */
type WatchQuote = {
  symbol: string;
  price: number;
  barTime: number;
  changePct?: number;
  /** Session turnover proxy for liquidity-weighted sector bars */
  turnover?: number;
};

type WatchSource = "yahoo" | "upstox";

type ScanResponse = {
  generatedAt: string;
  today: string;
  interval: string;
  source?: WatchSource;
  delayed?: boolean;
  strategies: string[];
  matchMode?: "session" | "last";
  universeSize: number;
  scanned: number;
  matchCount: number;
  quoteCount?: number;
  rateLimited?: number;
  errors?: number;
  matches: WatchMatch[];
  quotes?: WatchQuote[];
  batchSymbols?: string[];
  nextOffset?: number;
  batchSize?: number;
  batchIndex?: number;
  batchesPerCycle?: number;
  note?: string;
  error?: string;
};

type StrategyPick = {
  id: string;
  strategy: StrategyConfig;
  source: "preset" | "saved";
  selected: boolean;
  /** Send Telegram once when a new sticky signal is created for this strategy */
  telegramNotify?: boolean;
};

const TG_NOTIFIED_KEY = "tp_telegram_notified_v1";

function applyStrategyPrefs(
  list: StrategyPick[],
  prefs: WatchStrategyPref[] | undefined
): StrategyPick[] {
  if (!prefs?.length) return list;
  const map = new Map(prefs.map((p) => [p.id, p]));
  return list.map((p) => {
    const pr = map.get(p.id);
    if (!pr) return p;
    return {
      ...p,
      selected: Boolean(pr.selected),
      telegramNotify: Boolean(pr.telegramNotify),
    };
  });
}

type StickyCell = WatchMatch & {
  addedAt: number;
  sector: string;
};

function cloneStrategy(s: StrategyConfig): StrategyConfig {
  return structuredClone({
    ...s,
    entry: s.entry.map((c) => ({ ...c, id: c.id || uid() })),
    exit: s.exit.map((c) => ({ ...c, id: c.id || uid() })),
  });
}

function cellKey(m: { strategyName: string; symbol: string }) {
  return `${m.strategyName}::${m.symbol}`;
}

/** Sticky merge: never remove; only update price / % when re-seen. */
function mergeSticky(
  prev: Map<string, StickyCell>,
  batchMatches: WatchMatch[],
  now: number
): { next: Map<string, StickyCell>; added: StickyCell[] } {
  const next = new Map(prev);
  const added: StickyCell[] = [];
  for (const m of batchMatches) {
    const k = cellKey(m);
    const existing = next.get(k);
    if (existing) {
      next.set(k, {
        ...existing,
        price: m.price,
        barTime: m.barTime,
        changePct: m.changePct,
        rvol: m.rvol ?? existing.rvol,
        exitMatch: m.exitMatch,
        message: m.message,
        sector: sectorOf(m.symbol),
      });
    } else {
      const cell: StickyCell = {
        ...m,
        addedAt: now,
        sector: sectorOf(m.symbol),
      };
      next.set(k, cell);
      added.push(cell);
    }
  }
  return { next, added };
}

function loadNotifiedKeys(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = sessionStorage.getItem(TG_NOTIFIED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as { day?: string; keys?: string[] };
    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "Asia/Kolkata",
    });
    if (parsed.day !== today) return new Set();
    return new Set(parsed.keys || []);
  } catch {
    return new Set();
  }
}

function saveNotifiedKeys(keys: Set<string>) {
  if (typeof window === "undefined") return;
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "Asia/Kolkata",
  });
  sessionStorage.setItem(
    TG_NOTIFIED_KEY,
    JSON.stringify({ day: today, keys: [...keys] })
  );
}

/** Sticky full-universe quotes for sector strength (keyed by symbol). */
function mergeQuotes(
  prev: Map<string, WatchQuote>,
  batch: WatchQuote[]
): Map<string, WatchQuote> {
  const next = new Map(prev);
  for (const q of batch) {
    const sym = String(q.symbol || "")
      .toUpperCase()
      .replace(/\.NS$/i, "");
    if (!sym) continue;
    next.set(sym, {
      symbol: sym,
      price: q.price,
      barTime: q.barTime,
      changePct: q.changePct,
      turnover: q.turnover,
    });
  }
  return next;
}

/** One row in the sector screener table (all F&O names in a sector). */
type SectorStockRow = {
  symbol: string;
  price: number;
  changePct?: number;
  sector: string;
  barTime: number;
  rvol?: number;
  /** True when this name has a live quote this session */
  priced: boolean;
  /** Strategy names that currently match (sticky) */
  matchStrategies: string[];
};

/**
 * Multi-strategy F&O scanner (sortable tables).
 * - Config strategies once; runs while market open
 * - Sticky rows: once matched, stay until cleared
 * - Click sector bar → full sector stock table (like screener)
 * - Click any column header to sort
 */
export function MarketWatchApp() {
  const { user } = useAuth();
  const [dataSource, setDataSource] = useState<WatchSource>("yahoo");
  const [upstoxToken, setUpstoxToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [interval, setIntervalBar] = useState<Interval>("5m");
  const [batchSize, setBatchSize] = useState(25);
  const [runOnMarketOpen, setRunOnMarketOpen] = useState(true);
  const [statusLine, setStatusLine] = useState(sessionStatus().label);
  const [configNote, setConfigNote] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const watchConfigRef = useRef<MarketWatchConfig | null>(null);
  const configAppliedRef = useRef(false);

  const [picks, setPicks] = useState<StrategyPick[]>(() =>
    STRATEGY_PRESETS.map((p) => ({
      id: `preset:${p.name}`,
      strategy: cloneStrategy(p),
      source: "preset" as const,
      selected:
        p.name === "VWAP Bull" ||
        p.name === "Opening Range + EMA9" ||
        p.name.includes("bullish"),
    }))
  );

  /** Strategies saved from Backtest (local + cloud) */
  const { saved: savedStrategies, loading: savedLoading } =
    useSavedStrategies();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<ScanResponse | null>(null);
  const [sticky, setSticky] = useState<Map<string, StickyCell>>(() => new Map());
  /** Full F&O universe day quotes for sector graph (independent of strategies). */
  const [universeQuotes, setUniverseQuotes] = useState<Map<string, WatchQuote>>(
    () => new Map()
  );
  const [rotationOffset, setRotationOffset] = useState(0);
  const [sectorFilter, setSectorFilter] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(true);
  const [telegramChatId, setTelegramChatId] = useState("");
  const [telegramConfigured, setTelegramConfigured] = useState<boolean | null>(
    null
  );
  const [telegramNote, setTelegramNote] = useState<string | null>(null);
  const notifiedRef = useRef<Set<string>>(new Set());
  const telegramNotifyNamesRef = useRef<Set<string>>(new Set());
  type SortKey =
    | "symbol"
    | "price"
    | "changePct"
    | "sector"
    | "rvol"
    | "addedAt"
    | "barTime";
  type TableSort = { key: SortKey; dir: "asc" | "desc" };
  const DEFAULT_TABLE_SORT: TableSort = { key: "changePct", dir: "desc" };
  /** Per-table sort — sector table + each strategy table independent */
  const [tableSorts, setTableSorts] = useState<Record<string, TableSort>>({});

  function getTableSort(tableId: string): TableSort {
    return tableSorts[tableId] || DEFAULT_TABLE_SORT;
  }

  const rotationOffsetRef = useRef(0);
  const busyRef = useRef(false);
  const stickyRef = useRef(sticky);
  const selectedRef = useRef<StrategyConfig[]>([]);
  /** Strategy ids selected on previous render — detect newly checked strategies */
  const prevSelectedIdsRef = useRef<Set<string>>(new Set());
  const backfillRunningRef = useRef(false);
  const [backfillNote, setBackfillNote] = useState<string | null>(null);

  // Merge / refresh user strategies from Backtest.
  // Preserve live checkbox state (selected + telegram). Never re-apply saved
  // watch config here — that ran on every focus/refresh and undid toggles.
  useEffect(() => {
    setPicks((prev) => {
      const prevById = new Map(prev.map((x) => [x.id, x]));
      const prefsById = new Map(
        (watchConfigRef.current?.strategies ?? []).map(
          (p) => [p.id, p] as const
        )
      );

      const defaultSelected = (name: string) =>
        name === "VWAP Bull" ||
        name === "Opening Range + EMA9" ||
        name.includes("bullish");

      /** Existing row → keep user toggles. New row → config pref or default. */
      const flagsFor = (id: string, fallbackSelected: boolean) => {
        const was = prevById.get(id);
        if (was) {
          return {
            selected: was.selected,
            telegramNotify: Boolean(was.telegramNotify),
          };
        }
        const pref = prefsById.get(id);
        if (pref) {
          return {
            selected: Boolean(pref.selected),
            telegramNotify: Boolean(pref.telegramNotify),
          };
        }
        return { selected: fallbackSelected, telegramNotify: false };
      };

      const presets: StrategyPick[] = STRATEGY_PRESETS.map((p) => {
        const id = `preset:${p.name}`;
        const was = prevById.get(id);
        return {
          id,
          strategy: was?.strategy ?? cloneStrategy(p),
          source: "preset" as const,
          ...flagsFor(id, defaultSelected(p.name)),
        };
      });

      const savedPicks: StrategyPick[] = savedStrategies
        .filter((s) => s.strategy?.entry?.length)
        .map((s) => {
          const id = `saved:${s.id || s.name}`;
          return {
            id,
            strategy: cloneStrategy({
              ...s.strategy,
              name: s.name || s.strategy.name,
            }),
            source: "saved" as const,
            ...flagsFor(id, false),
          };
        });

      return [...presets, ...savedPicks];
    });
  }, [savedStrategies]);

  // Load permanent config once per user (localStorage + cloud when signed in).
  // Applies strategy checkboxes only on this load — not on later strategy list refreshes.
  useEffect(() => {
    let cancelled = false;
    configAppliedRef.current = false;
    (async () => {
      try {
        const cfg = await loadWatchConfig(user?.uid ?? null);
        if (cancelled || !cfg) return;
        watchConfigRef.current = cfg;
        setDataSource(cfg.dataSource === "upstox" ? "upstox" : "yahoo");
        setIntervalBar((cfg.interval as Interval) || "5m");
        setBatchSize(cfg.batchSize || 25);
        setRunOnMarketOpen(cfg.runOnMarketOpen !== false);
        if (cfg.telegramChatId) setTelegramChatId(cfg.telegramChatId);
        if (!configAppliedRef.current) {
          setPicks((prev) => applyStrategyPrefs(prev, cfg.strategies));
          configAppliedRef.current = true;
        }
        setConfigNote(
          user?.uid
            ? "Loaded your saved Market Watch config (cloud)."
            : "Loaded saved Market Watch config (this device)."
        );
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.uid]);

  const selectedStrategies = useMemo(
    () => picks.filter((p) => p.selected).map((p) => p.strategy),
    [picks]
  );

  useEffect(() => {
    selectedRef.current = selectedStrategies;
  }, [selectedStrategies]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    rotationOffsetRef.current = rotationOffset;
  }, [rotationOffset]);

  useEffect(() => {
    stickyRef.current = sticky;
  }, [sticky]);

  useEffect(() => {
    setBatchSize(dataSource === "yahoo" ? 25 : 40);
    setRotationOffset(0);
    rotationOffsetRef.current = 0;
    // New feed — rebuild universe quotes from scratch
    setUniverseQuotes(new Map());
  }, [dataSource]);

  // Market status line
  useEffect(() => {
    const t = setInterval(() => setStatusLine(sessionStatus().label), 30_000);
    return () => clearInterval(t);
  }, []);

  // Telegram: notified keys + bot configured on server?
  useEffect(() => {
    notifiedRef.current = loadNotifiedKeys();
    void fetch("/api/notify/telegram")
      .then((r) => r.json())
      .then((d: { configured?: boolean; defaultChatId?: boolean }) => {
        setTelegramConfigured(Boolean(d.configured));
        if (d.defaultChatId && !telegramChatId) {
          setTelegramNote(
            "TELEGRAM_CHAT_ID is set on server (optional override below)."
          );
        }
      })
      .catch(() => setTelegramConfigured(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot probe
  }, []);

  useEffect(() => {
    telegramNotifyNamesRef.current = new Set(
      picks
        .filter((p) => p.selected && p.telegramNotify)
        .map((p) => p.strategy.name)
    );
  }, [picks]);

  async function sendTelegram(text: string): Promise<boolean> {
    try {
      const res = await fetch("/api/notify/telegram", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          text,
          chatId: telegramChatId.trim() || undefined,
        }),
      });
      const data = await parseApiJson<{ error?: string; ok?: boolean }>(res);
      if (!res.ok) {
        setTelegramNote(data.error || `Telegram failed (${res.status})`);
        return false;
      }
      return true;
    } catch (e) {
      setTelegramNote(safeErrorMessage(e) || "Telegram send failed");
      return false;
    }
  }

  /** Notify Telegram once per new sticky signal (strategy + symbol + day). */
  async function notifyNewSignals(added: StickyCell[]) {
    const allow = telegramNotifyNamesRef.current;
    if (!allow.size || !added.length) return;

    const fresh = added.filter((c) => {
      if (!allow.has(c.strategyName)) return false;
      const k = cellKey(c);
      if (notifiedRef.current.has(k)) return false;
      return true;
    });
    if (!fresh.length) return;

    // Mark before send so retries / parallel scans don't double-fire
    for (const c of fresh) {
      notifiedRef.current.add(cellKey(c));
    }
    saveNotifiedKeys(notifiedRef.current);

    // One message per strategy batch (cleaner in groups)
    const byStrat = new Map<string, StickyCell[]>();
    for (const c of fresh) {
      const list = byStrat.get(c.strategyName) || [];
      list.push(c);
      byStrat.set(c.strategyName, list);
    }

    for (const [strat, rows] of byStrat) {
      const lines = rows.map((c) => {
        const ch =
          c.changePct != null
            ? `${c.changePct >= 0 ? "+" : ""}${c.changePct.toFixed(2)}%`
            : "—";
        const px =
          c.price > 0
            ? `₹${c.price.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
            : "—";
        return `• ${c.symbol}  ${px}  ${ch}  ${c.sector || ""}`;
      });
      const text = [
        `TradePulse signal · ${strat}`,
        `New match${rows.length > 1 ? "es" : ""} (once):`,
        ...lines,
        ``,
        `Interval ${interval} · ${dataSource}`,
      ].join("\n");
      const ok = await sendTelegram(text);
      if (ok) {
        setTelegramNote(
          `Telegram: sent ${rows.length} new signal(s) for ${strat}`
        );
      }
    }
  }

  /**
   * Shared Market Watch: one server session for all users.
   * UI never starts its own scan — only reads (and server may tick if stale).
   */
  const pollSharedSession = useCallback(
    async (opts?: { forceTick?: boolean }) => {
      if (busyRef.current && !opts?.forceTick) return;
      setBusy(true);
      setError(null);
      try {
        const qs = opts?.forceTick ? "?forceTick=1" : "";
        const res = await fetch(`/api/watch/session${qs}`, {
          method: "GET",
          headers: { Accept: "application/json" },
        });
        const data = await parseApiJson<{
          error?: string;
          open?: boolean;
          marketLabel?: string;
          ticked?: boolean;
          note?: string;
          session?: {
            sessionDay: string;
            status: string;
            lastTickAt: number;
            interval: string;
            source?: WatchSource;
            strategies?: string[];
            universeSize?: number;
            batchIndex?: number;
            batchesPerCycle?: number;
            batchSize?: number;
            tickCount?: number;
            scannedTotal?: number;
            matches?: WatchMatch[];
            quotes?: WatchQuote[];
            note?: string;
            rotationOffset?: number;
          } | null;
        }>(res);
        if (!res.ok) throw new Error(data.error || `Session load failed (${res.status})`);

        if (data.marketLabel) setStatusLine(data.marketLabel);
        else setStatusLine(sessionStatus().label);

        const s = data.session;
        if (!s) {
          setBackfillNote(
            data.note ||
              "No shared session yet. Server scans during NSE hours for all users."
          );
          return;
        }

        setMeta({
          generatedAt: new Date(s.lastTickAt || Date.now()).toISOString(),
          today: s.sessionDay,
          interval: s.interval || interval,
          source: s.source,
          strategies: s.strategies || [],
          universeSize: s.universeSize || 0,
          scanned: s.scannedTotal || 0,
          matchCount: s.matches?.length || 0,
          quoteCount: s.quotes?.length || 0,
          matches: s.matches || [],
          quotes: s.quotes || [],
          batchIndex: s.batchIndex,
          batchesPerCycle: s.batchesPerCycle,
          batchSize: s.batchSize,
          nextOffset: s.rotationOffset,
          note: s.note,
        });

        if (s.source) setDataSource(s.source);

        // Full replace from shared snapshot (not client-owned scan)
        const qMap = new Map<string, WatchQuote>();
        for (const q of s.quotes || []) qMap.set(q.symbol, q);
        setUniverseQuotes(qMap);

        const selectedNames = new Set(
          selectedRef.current.map((x) => x.name)
        );
        const now = Date.now();
        // Only show strategies the user has checked — data is still shared
        const filtered = (s.matches || []).filter(
          (m) => !selectedNames.size || selectedNames.has(m.strategyName)
        );
        const { next, added } = mergeSticky(
          new Map(), // rebuild from shared sticky (session-level)
          filtered.map((m) => ({
            ...m,
            // preserve addedAt if server sent it
            ...(typeof (m as StickyCell).addedAt === "number"
              ? {}
              : {}),
          })),
          now
        );
        // Restore addedAt from server when present
        for (const m of s.matches || []) {
          const k = cellKey(m);
          const cell = next.get(k);
          const serverAdded = (m as { addedAt?: number }).addedAt;
          if (cell && serverAdded) {
            next.set(k, { ...cell, addedAt: serverAdded });
          }
        }
        // Filter sticky to selected strategies only for display
        if (selectedNames.size) {
          for (const [k, v] of next) {
            if (!selectedNames.has(v.strategyName)) next.delete(k);
          }
        }
        // Telegram: only first-time for this browser session
        const prevKeys = new Set(stickyRef.current.keys());
        const newlyAdded = added.filter((c) => !prevKeys.has(cellKey(c)));
        stickyRef.current = next;
        setSticky(next);
        if (newlyAdded.length) void notifyNewSignals(newlyAdded);

        if (typeof s.rotationOffset === "number") {
          setRotationOffset(s.rotationOffset);
          rotationOffsetRef.current = s.rotationOffset;
        }

        const open = Boolean(data.open);
        setBackfillNote(
          open
            ? `Shared session ${s.sessionDay} · tick #${s.tickCount || 0} · batch ${s.batchIndex || "—"}/${s.batchesPerCycle || "—"} · one scan for all users`
            : `Market closed · showing session ${s.sessionDay} (${s.matches?.length || 0} matches, ${s.quotes?.length || 0} quotes)`
        );
      } catch (e) {
        setError(safeErrorMessage(e) || "Failed to load shared market watch");
      } finally {
        setBusy(false);
      }
    },
    [interval]
  );

  // Poll shared session only — never start a per-user scan on open
  useEffect(() => {
    void pollSharedSession();
    const t = setInterval(() => {
      void pollSharedSession();
      setStatusLine(sessionStatus().label);
    }, 30_000);
    return () => clearInterval(t);
  }, [pollSharedSession]);

  const cells = useMemo(() => [...sticky.values()], [sticky]);

  const sectorStrength: SectorStrength[] = useMemo(
    () => computeSectorStrength([...universeQuotes.values()]),
    [universeQuotes]
  );

  const quotesCovered = universeQuotes.size;

  /** All F&O names in the selected sector (map + live quotes + match tags). */
  const sectorStockRows: SectorStockRow[] = useMemo(() => {
    if (!sectorFilter) return [];
    const symbols = symbolsInSector(sectorFilter);
    // Also include any quoted/matched names in this sector not in map (Others edge)
    const extra = new Set<string>();
    for (const q of universeQuotes.values()) {
      if (sectorOf(q.symbol) === sectorFilter) extra.add(q.symbol);
    }
    for (const c of cells) {
      if (c.sector === sectorFilter) extra.add(c.symbol);
    }
    const all = [
      ...new Set([...symbols, ...extra].map((s) => s.toUpperCase())),
    ].sort((a, b) => a.localeCompare(b));

    const matchesBySym = new Map<string, string[]>();
    const rvolBySym = new Map<string, number>();
    for (const c of cells) {
      if (c.sector !== sectorFilter) continue;
      const list = matchesBySym.get(c.symbol) || [];
      list.push(c.strategyName);
      matchesBySym.set(c.symbol, list);
      if (c.rvol != null && Number.isFinite(c.rvol)) {
        rvolBySym.set(c.symbol, c.rvol);
      }
    }

    return all.map((symbol) => {
      const q = universeQuotes.get(symbol);
      return {
        symbol,
        price: q?.price ?? 0,
        changePct: q?.changePct,
        sector: sectorFilter,
        barTime: q?.barTime ?? 0,
        rvol: rvolBySym.get(symbol),
        priced: Boolean(q && q.price > 0),
        matchStrategies: matchesBySym.get(symbol) || [],
      };
    });
  }, [sectorFilter, universeQuotes, cells]);

  function toggleSort(tableId: string, key: SortKey) {
    setTableSorts((prev) => {
      const cur = prev[tableId] || DEFAULT_TABLE_SORT;
      if (cur.key === key) {
        return {
          ...prev,
          [tableId]: { key, dir: cur.dir === "asc" ? "desc" : "asc" },
        };
      }
      return {
        ...prev,
        [tableId]: {
          key,
          dir: key === "symbol" || key === "sector" ? "asc" : "desc",
        },
      };
    });
  }

  function sortRows(list: StickyCell[], sort: TableSort): StickyCell[] {
    const dir = sort.dir === "asc" ? 1 : -1;
    const sortKey = sort.key;
    return [...list].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (sortKey === "symbol" || sortKey === "sector") {
        return dir * String(av ?? "").localeCompare(String(bv ?? ""));
      }
      const an = Number(av);
      const bn = Number(bv);
      const aOk = Number.isFinite(an);
      const bOk = Number.isFinite(bn);
      if (!aOk && !bOk) return a.symbol.localeCompare(b.symbol);
      if (!aOk) return 1;
      if (!bOk) return -1;
      if (an !== bn) return dir * (an - bn);
      return a.symbol.localeCompare(b.symbol);
    });
  }

  function sortSectorRows(
    list: SectorStockRow[],
    sort: TableSort
  ): SectorStockRow[] {
    const dir = sort.dir === "asc" ? 1 : -1;
    const key: SortKey =
      sort.key === "addedAt" ? "changePct" : sort.key;
    return [...list].sort((a, b) => {
      if (key === "symbol" || key === "sector") {
        return dir * String(a[key] ?? "").localeCompare(String(b[key] ?? ""));
      }
      // Prefer priced names first when sorting by price / %
      if (key === "price" || key === "changePct" || key === "barTime") {
        if (a.priced !== b.priced) return a.priced ? -1 : 1;
      }
      const av = a[key as keyof SectorStockRow];
      const bv = b[key as keyof SectorStockRow];
      const an = Number(av);
      const bn = Number(bv);
      const aOk = Number.isFinite(an);
      const bOk = Number.isFinite(bn);
      if (!aOk && !bOk) return a.symbol.localeCompare(b.symbol);
      if (!aOk) return 1;
      if (!bOk) return -1;
      if (an !== bn) return dir * (an - bn);
      return a.symbol.localeCompare(b.symbol);
    });
  }

  const sectorTableId = "sector";
  const sectorSort = getTableSort(sectorTableId);

  const sectorTableSorted = useMemo(
    () => sortSectorRows(sectorStockRows, sectorSort),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sort via sectorSort
    [sectorStockRows, sectorSort.key, sectorSort.dir]
  );

  const byStrategy = useMemo(() => {
    const map = new Map<string, StickyCell[]>();
    for (const c of cells) {
      if (sectorFilter && c.sector !== sectorFilter) continue;
      const list = map.get(c.strategyName) || [];
      list.push(c);
      map.set(c.strategyName, list);
    }
    for (const [k, list] of map) {
      map.set(k, sortRows(list, getTableSort(`strategy:${k}`)));
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per-table sort
  }, [cells, sectorFilter, tableSorts]);

  // Order strategy sections by selected order
  const strategyOrder = useMemo(
    () => selectedStrategies.map((s) => s.name),
    [selectedStrategies]
  );

  function togglePick(id: string) {
    setPicks((prev) =>
      prev.map((p) => (p.id === id ? { ...p, selected: !p.selected } : p))
    );
    // Backfill is triggered by the picks effect when a strategy is turned on
  }

  function toggleTelegramNotify(strategyName: string) {
    setPicks((prev) =>
      prev.map((p) =>
        p.strategy.name === strategyName
          ? { ...p, telegramNotify: !p.telegramNotify }
          : p
      )
    );
  }

  function telegramEnabledFor(strategyName: string): boolean {
    return Boolean(
      picks.find((p) => p.strategy.name === strategyName)?.telegramNotify
    );
  }

  async function handleSaveConfig() {
    setSaveBusy(true);
    setConfigNote(null);
    try {
      const config: MarketWatchConfig = {
        version: 1,
        dataSource,
        interval,
        batchSize,
        runOnMarketOpen,
        telegramChatId: telegramChatId.trim(),
        strategies: picks.map((p) => ({
          id: p.id,
          selected: p.selected,
          telegramNotify: Boolean(p.telegramNotify),
        })),
        updatedAt: Date.now(),
      };
      watchConfigRef.current = config;
      const r = await saveWatchConfig(config, user?.uid ?? null);
      if (r.cloud) {
        setConfigNote(
          "Saved permanently for your account (cloud + this device)."
        );
      } else if (r.cloudError) {
        setConfigNote(r.cloudError);
      } else if (user) {
        setConfigNote("Saved on this device (cloud sync unavailable).");
      } else {
        setConfigNote(
          "Saved on this device. Sign in to sync across browsers."
        );
      }
      setTelegramNote(null);
    } catch (e) {
      setConfigNote(safeErrorMessage(e) || "Save failed");
    } finally {
      setSaveBusy(false);
    }
  }

  function clearMatches() {
    setSticky(new Map());
    stickyRef.current = new Map();
    setUniverseQuotes(new Map());
    setRotationOffset(0);
    rotationOffsetRef.current = 0;
    setSectorFilter(null);
  }

  const chartHeight = Math.max(360, sectorStrength.length * 22 + 48);

  return (
    <div className="mx-auto max-w-6xl px-5 pb-24 pt-10 sm:px-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <p className="mb-2 text-xs font-medium tracking-[0.2em] text-neutral-500 uppercase">
            Market watch
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-black sm:text-4xl">
            Live strategy watch
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-neutral-600">
            <strong>Shared server scan</strong> during NSE hours for all users
            (not per browser). Opening this tab only loads results. Click a{" "}
            <strong>sector bar</strong> for stocks; strategy tables show sticky
            matches from today&apos;s session. When the market is closed, the
            latest session stays on screen.
          </p>
          <p className="mt-2 text-xs text-neutral-500">
            {statusLine}
            {meta
              ? ` · batch ${meta.batchIndex}/${meta.batchesPerCycle} · universe ${meta.universeSize} · F&O priced ${quotesCovered}/${meta.universeSize} · ${meta.source || dataSource}`
              : quotesCovered
                ? ` · F&O priced ${quotesCovered}`
                : ""}
            {busy ? " · loading…" : ""}
          </p>
          {backfillNote && (
            <p className="mt-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-950">
              {backfillNote}
            </p>
          )}
          {configNote && (
            <p className="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-950">
              {configNote}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setConfigOpen((v) => !v)}
            className="rounded-full border border-neutral-300 px-4 py-2 text-sm font-medium hover:border-black"
          >
            {configOpen ? "Hide config" : "Configure"}
          </button>
          <button
            type="button"
            disabled={saveBusy}
            onClick={() => void handleSaveConfig()}
            className="rounded-full bg-black px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
          >
            {saveBusy ? "Saving…" : "Save config"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void pollSharedSession()}
            className="rounded-full border border-neutral-300 px-4 py-2 text-sm font-medium hover:border-black disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
      </header>

      <div className="mb-5 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-2.5 text-xs text-sky-950">
        <strong>Shared watch</strong> — one F&amp;O rotation for everyone
        (server + cron). Your checkboxes only filter which strategy tables you
        see. Source:{" "}
        <strong>{meta?.source || dataSource}</strong>
        {dataSource === "yahoo" || meta?.source === "yahoo"
          ? " (Yahoo may be delayed)."
          : " (Upstox live when server token is set)."}
      </div>

      {error && (
        <p className="mb-4 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-800">
          {error}
        </p>
      )}

      {/* Config panel */}
      {configOpen && (
        <section className="mb-8 grid gap-4 rounded-3xl border border-neutral-200 bg-white p-5 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <p className="mb-2 text-xs font-medium tracking-wide text-neutral-500 uppercase">
              Data source
            </p>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  { id: "yahoo" as const, label: "Yahoo (free)" },
                  { id: "upstox" as const, label: "Upstox (live)" },
                ] as const
              ).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setDataSource(s.id)}
                  className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                    dataSource === s.id
                      ? "bg-black text-white"
                      : "bg-neutral-100 text-neutral-700"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            {dataSource === "upstox" && (
              <div className="mt-3 flex gap-2">
                <input
                  type={showToken ? "text" : "password"}
                  value={upstoxToken}
                  onChange={(e) => setUpstoxToken(e.target.value)}
                  placeholder="Upstox token"
                  className="field-input flex-1 text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowToken((v) => !v)}
                  className="rounded-full border px-3 text-xs"
                >
                  {showToken ? "Hide" : "Show"}
                </button>
              </div>
            )}
          </div>

          <div>
            <p className="mb-2 text-xs font-medium tracking-wide text-neutral-500 uppercase">
              Interval &amp; batch
            </p>
            <select
              value={interval}
              onChange={(e) => setIntervalBar(e.target.value as Interval)}
              className="field-input mb-2 text-sm"
            >
              {INTERVALS.map((i) => (
                <option key={i.value} value={i.value}>
                  {i.label}
                </option>
              ))}
            </select>
            <label className="block text-xs text-neutral-500">
              Batch / minute
              <input
                type="number"
                min={5}
                max={50}
                value={batchSize}
                onChange={(e) =>
                  setBatchSize(
                    Math.min(50, Math.max(5, Number(e.target.value) || 25))
                  )
                }
                className="field-input mt-1 text-sm"
              />
            </label>
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={runOnMarketOpen}
                onChange={(e) => setRunOnMarketOpen(e.target.checked)}
                className="accent-black"
              />
              Auto-run only in market hours (09:15–15:30 IST)
            </label>
          </div>

          <div className="sm:col-span-2 lg:col-span-1">
            <p className="mb-2 text-xs font-medium tracking-wide text-neutral-500 uppercase">
              Telegram alerts
            </p>
            <p className="mb-2 text-[11px] text-neutral-400">
              {telegramConfigured === null
                ? "Checking bot…"
                : telegramConfigured
                  ? "Bot token OK. Enable Telegram once on a table, then Save config. Sends once per new signal."
                  : "Set TELEGRAM_BOT_TOKEN in Vercel env (Production) and redeploy."}
            </p>
            <label className="block text-xs text-neutral-500">
              Chat / group ID
              <input
                value={telegramChatId}
                onChange={(e) => setTelegramChatId(e.target.value)}
                placeholder="e.g. -100123… or empty = TELEGRAM_CHAT_ID env"
                className="field-input mt-1 text-sm"
              />
            </label>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={!telegramConfigured}
                onClick={() => {
                  void (async () => {
                    const ok = await sendTelegram(
                      `TradePulse test · Market Watch · ${new Date().toLocaleTimeString("en-IN")}`
                    );
                    if (ok) {
                      setTelegramNote("Telegram test message sent.");
                    }
                  })();
                }}
                className="rounded-full border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:border-black disabled:opacity-50"
              >
                Send test message
              </button>
              <button
                type="button"
                disabled={saveBusy}
                onClick={() => void handleSaveConfig()}
                className="rounded-full bg-black px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
              >
                {saveBusy ? "Saving…" : "Save config"}
              </button>
            </div>
            {telegramNote && (
              <p
                className={`mt-2 text-[11px] ${
                  /fail|error|not set|required/i.test(telegramNote)
                    ? "text-red-700"
                    : "text-neutral-600"
                }`}
              >
                {telegramNote}
              </p>
            )}
          </div>

          <div className="sm:col-span-2 lg:col-span-1">
            <p className="mb-2 text-xs font-medium tracking-wide text-neutral-500 uppercase">
              Strategies (tables below)
            </p>
            <p className="mb-2 text-[11px] text-neutral-400">
              Presets + strategies you save in Backtest
              {savedLoading ? " · loading…" : ""}
              {!savedLoading && savedStrategies.length
                ? ` · ${savedStrategies.length} saved`
                : ""}
            </p>
            <ul className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
              {picks.map((p) => (
                <li key={p.id}>
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={p.selected}
                      onChange={() => togglePick(p.id)}
                      className="accent-black"
                    />
                    <span className="truncate font-medium">{p.strategy.name}</span>
                    <span className="text-[10px] text-neutral-400">
                      {p.source === "saved" ? "yours" : "preset"}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {!savedLoading && !savedStrategies.length && (
              <p className="mt-2 text-[11px] text-neutral-400">
                No saved strategies yet — open Backtest, edit a strategy, click{" "}
                <strong>Save</strong>.
              </p>
            )}
          </div>
        </section>
      )}

      {/* Sector strength — all sectors, full F&O universe (not strategy matches) */}
      <section className="mb-8 rounded-3xl border border-neutral-200 bg-white p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-medium tracking-wide text-neutral-500 uppercase">
              Sector strength
            </h2>
            <p className="mt-0.5 text-xs text-neutral-400">
              All sectors · avg day % from all F&amp;O stocks scanned (
              {quotesCovered} priced
              {meta?.universeSize ? ` / ${meta.universeSize}` : ""})
            </p>
          </div>
          {sectorFilter && (
            <button
              type="button"
              onClick={() => setSectorFilter(null)}
              className="text-xs font-medium text-neutral-600 underline hover:text-black"
            >
              Clear sector filter ({sectorFilter})
            </button>
          )}
        </div>
        <div
          className="w-full overflow-x-auto"
          style={{ height: chartHeight }}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              layout="vertical"
              data={sectorStrength}
              margin={{ top: 4, right: 16, left: 4, bottom: 4 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" horizontal={false} />
              <XAxis
                type="number"
                tick={{ fontSize: 11, fill: "#737373" }}
                tickFormatter={(v) => `${Number(v).toFixed(1)}%`}
              />
              <YAxis
                type="category"
                dataKey="sector"
                width={118}
                tick={{ fontSize: 10, fill: "#525252" }}
                interval={0}
              />
              <Tooltip
                formatter={(value, _n, item) => {
                  const p = item?.payload as SectorStrength | undefined;
                  const priced = p?.count ?? 0;
                  const uni = p?.universeCount ?? 0;
                  return [
                    `${Number(value ?? 0).toFixed(2)}% avg day · priced ${priced}/${uni} F&O · ↑${p?.bullish ?? 0} ↓${p?.bearish ?? 0}`,
                    "Strength",
                  ];
                }}
                labelFormatter={(l) => String(l)}
                contentStyle={{
                  fontSize: 12,
                  borderRadius: 12,
                  border: "1px solid #e5e5e5",
                }}
              />
              <Bar
                dataKey="avgChangePct"
                name="Avg day %"
                radius={[0, 4, 4, 0]}
                cursor="pointer"
                barSize={14}
                onClick={(state) => {
                  const sector =
                    state &&
                    typeof state === "object" &&
                    "sector" in state
                      ? String((state as { sector?: string }).sector || "")
                      : "";
                  if (!sector) return;
                  setSectorFilter((cur) =>
                    cur === sector ? null : sector
                  );
                }}
              >
                {sectorStrength.map((s) => (
                  <Cell
                    key={s.sector}
                    fill={
                      sectorFilter === s.sector
                        ? "#171717"
                        : s.count === 0
                          ? "#e5e5e5"
                          : s.avgChangePct >= 0
                            ? "#10b981"
                            : "#f43f5e"
                    }
                    opacity={
                      sectorFilter && sectorFilter !== s.sector ? 0.3 : 1
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-2 text-[11px] text-neutral-400">
          Horizontal scale = avg session day %. Click a bar to open that
          sector&apos;s stock table (all F&amp;O names in the sector). Grey =
          none priced yet this cycle.
        </p>
      </section>

      {/* Sector stock table — all F&O names in selected sector */}
      {sectorFilter && (
        <section className="mb-8 rounded-3xl border-2 border-neutral-900 bg-white p-5">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold tracking-tight text-black">
                {sectorFilter}
              </h2>
              <p className="mt-0.5 text-xs text-neutral-500">
                {sectorTableSorted.length} F&amp;O stock
                {sectorTableSorted.length === 1 ? "" : "s"}
                {" · "}
                {sectorTableSorted.filter((r) => r.priced).length} priced
                {" · click headers to sort"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSectorFilter(null)}
              className="rounded-full border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:border-black"
            >
              Close sector table
            </button>
          </div>

          {sectorTableSorted.length === 0 ? (
            <p className="py-8 text-center text-sm text-neutral-400">
              No F&amp;O names mapped to {sectorFilter}.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-left text-xs text-neutral-500 uppercase">
                    {(
                      [
                        {
                          key: "symbol" as const,
                          label: "Stock",
                          align: "left",
                        },
                        {
                          key: "price" as const,
                          label: "Price",
                          align: "right",
                        },
                        {
                          key: "changePct" as const,
                          label: "% chg",
                          align: "right",
                        },
                        {
                          key: "sector" as const,
                          label: "Sector",
                          align: "left",
                        },
                        {
                          key: "rvol" as const,
                          label: "Rvol",
                          align: "right",
                        },
                        {
                          key: "barTime" as const,
                          label: "Bar time",
                          align: "left",
                        },
                      ] as const
                    ).map((col) => {
                      const active = sectorSort.key === col.key;
                      return (
                        <th
                          key={col.key}
                          className={`px-3 py-2.5 font-medium ${
                            col.align === "right" ? "text-right" : "text-left"
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => toggleSort(sectorTableId, col.key)}
                            className={`inline-flex items-center gap-1 hover:text-black ${
                              active ? "text-black" : ""
                            } ${col.align === "right" ? "ml-auto" : ""}`}
                          >
                            {col.label}
                            <span className="text-[10px] text-neutral-400">
                              {active
                                ? sectorSort.dir === "asc"
                                  ? "▲"
                                  : "▼"
                                : "↕"}
                            </span>
                          </button>
                        </th>
                      );
                    })}
                    <th className="px-3 py-2.5 text-left font-medium">
                      Strategy match
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sectorTableSorted.map((r) => {
                    const ch = r.changePct;
                    const chCls =
                      ch == null
                        ? "text-neutral-500"
                        : ch >= 0
                          ? "text-emerald-700"
                          : "text-rose-600";
                    return (
                      <tr
                        key={r.symbol}
                        className={`border-b border-neutral-100 hover:bg-neutral-50/80 ${
                          !r.priced ? "opacity-60" : ""
                        }`}
                      >
                        <td className="px-3 py-2.5 font-semibold text-black whitespace-nowrap">
                          {r.symbol}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-neutral-800">
                          {r.priced
                            ? `₹${r.price.toLocaleString("en-IN", {
                                maximumFractionDigits: 2,
                                minimumFractionDigits: 2,
                              })}`
                            : "—"}
                        </td>
                        <td
                          className={`px-3 py-2.5 text-right tabular-nums font-medium ${chCls}`}
                        >
                          {ch != null
                            ? `${ch >= 0 ? "+" : ""}${ch.toFixed(2)}%`
                            : "—"}
                        </td>
                        <td className="px-3 py-2.5 text-neutral-700">
                          {r.sector}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-neutral-700">
                          {r.rvol != null ? `${r.rvol.toFixed(1)}%` : "—"}
                        </td>
                        <td className="px-3 py-2.5 text-xs whitespace-nowrap text-neutral-600">
                          {r.barTime ? formatTime(r.barTime) : "—"}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-neutral-600">
                          {r.matchStrategies.length
                            ? r.matchStrategies.join(", ")
                            : r.priced
                              ? "—"
                              : "not scanned yet"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-[11px] text-neutral-400">
            Full F&amp;O list for this sector. Price / % update as the universe
            rotates. Strategy match shows sticky signals if a selected strategy
            fired today.
          </p>
        </section>
      )}

      {/* Sortable tables — one per strategy */}
      <div className="space-y-8">
        {strategyOrder.map((name) => {
          const list = byStrategy.get(name) || [];
          const tableId = `strategy:${name}`;
          const sort = getTableSort(tableId);
          return (
            <section
              key={name}
              className="rounded-3xl border border-neutral-200 bg-white p-5"
            >
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-base font-semibold tracking-tight text-black">
                    {name}
                  </h2>
                  <p className="text-xs text-neutral-500">
                    {list.length} stock{list.length === 1 ? "" : "s"}
                    {sectorFilter ? ` · ${sectorFilter}` : ""}
                    {" · sticky · sort this table only"}
                  </p>
                </div>
                <label
                  className={`flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium ${
                    telegramEnabledFor(name)
                      ? "border-sky-600 bg-sky-50 text-sky-900"
                      : "border-neutral-300 text-neutral-600"
                  }`}
                  title="Send Telegram once when a new signal is added to this table"
                >
                  <input
                    type="checkbox"
                    checked={telegramEnabledFor(name)}
                    onChange={() => toggleTelegramNotify(name)}
                    className="accent-sky-600"
                  />
                  Telegram once
                </label>
              </div>

              {list.length === 0 ? (
                <p className="py-8 text-center text-sm text-neutral-400">
                  No matches yet for this strategy
                  {sectorFilter ? ` in ${sectorFilter}` : ""}.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead>
                      <tr className="border-b border-neutral-200 text-left text-xs text-neutral-500 uppercase">
                        {(
                          [
                            { key: "symbol" as const, label: "Stock", align: "left" },
                            { key: "price" as const, label: "Price", align: "right" },
                            {
                              key: "changePct" as const,
                              label: "% chg",
                              align: "right",
                            },
                            {
                              key: "sector" as const,
                              label: "Sector",
                              align: "left",
                            },
                            { key: "rvol" as const, label: "Rvol", align: "right" },
                            {
                              key: "barTime" as const,
                              label: "Signal",
                              align: "left",
                            },
                            {
                              key: "addedAt" as const,
                              label: "Added",
                              align: "left",
                            },
                          ] as const
                        ).map((col) => {
                          const active = sort.key === col.key;
                          return (
                            <th
                              key={col.key}
                              className={`px-3 py-2.5 font-medium ${
                                col.align === "right" ? "text-right" : "text-left"
                              }`}
                            >
                              <button
                                type="button"
                                onClick={() => toggleSort(tableId, col.key)}
                                className={`inline-flex items-center gap-1 hover:text-black ${
                                  active ? "text-black" : ""
                                } ${col.align === "right" ? "ml-auto" : ""}`}
                              >
                                {col.label}
                                <span className="text-[10px] text-neutral-400">
                                  {active
                                    ? sort.dir === "asc"
                                      ? "▲"
                                      : "▼"
                                    : "↕"}
                                </span>
                              </button>
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((c) => {
                        const ch = c.changePct;
                        const chCls =
                          ch == null
                            ? "text-neutral-500"
                            : ch >= 0
                              ? "text-emerald-700"
                              : "text-rose-600";
                        return (
                          <tr
                            key={cellKey(c)}
                            className="border-b border-neutral-100 hover:bg-neutral-50/80"
                          >
                            <td className="px-3 py-2.5 font-semibold text-black whitespace-nowrap">
                              {c.symbol}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-neutral-800">
                              ₹
                              {c.price.toLocaleString("en-IN", {
                                maximumFractionDigits: 2,
                                minimumFractionDigits: 2,
                              })}
                            </td>
                            <td
                              className={`px-3 py-2.5 text-right tabular-nums font-medium ${chCls}`}
                            >
                              {ch != null
                                ? `${ch >= 0 ? "+" : ""}${ch.toFixed(2)}%`
                                : "—"}
                            </td>
                            <td className="px-3 py-2.5 text-neutral-700">
                              {c.sector}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-neutral-700">
                              {c.rvol != null ? `${c.rvol.toFixed(1)}%` : "—"}
                            </td>
                            <td className="px-3 py-2.5 text-xs whitespace-nowrap text-neutral-600">
                              {c.barTime ? formatTime(c.barTime) : "—"}
                            </td>
                            <td className="px-3 py-2.5 text-xs whitespace-nowrap text-neutral-500">
                              {c.addedAt ? formatTime(c.addedAt) : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })}

        {!strategyOrder.length && (
          <div className="rounded-3xl border border-dashed border-neutral-300 bg-white px-6 py-16 text-center text-sm text-neutral-500">
            Select strategies in Configure. Watch starts automatically when the
            market is open.
          </div>
        )}
      </div>

      <p className="mt-6 text-[11px] text-neutral-400">
        Each table sorts independently. Selecting a strategy backfills full
        F&amp;O using today&apos;s bars from the open. Signal = first entry bar
        today; % chg = session day move; Rvol = annualized realized vol. Rows
        stay once matched (sticky).
      </p>
    </div>
  );
}
