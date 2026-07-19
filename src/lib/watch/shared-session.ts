/**
 * Shared Market Watch session — one scan for all users.
 * Results live in memory + optional Firestore (Admin/REST).
 */
import {
  firestoreRestGet,
  firestoreRestSet,
  getAdminDbAsync,
  isAdminConfigured,
} from "../firebase/admin";
import {
  isNseSessionOpen,
  sessionStatus,
  todayIst,
} from "../paper/market-hours";
import { STRATEGY_PRESETS } from "../presets";
import type { Interval, StrategyConfig } from "../types";
import { sectorOf } from "./sectors";
import {
  runWatchBatch,
  type WatchBatchResult,
  type WatchDataSource,
} from "./scan-core";
import type { WatchMatch, WatchQuote } from "./match";

export type SharedStickyMatch = WatchMatch & {
  strategyName: string;
  sector?: string;
  /** First seen this session (ms) */
  addedAt: number;
};

export type SharedWatchSession = {
  sessionDay: string;
  status: "running" | "closed";
  generatedAt: string;
  lastTickAt: number;
  interval: Interval;
  source: WatchDataSource;
  strategies: string[];
  rotationOffset: number;
  universeSize: number;
  batchSize: number;
  batchIndex: number;
  batchesPerCycle: number;
  tickCount: number;
  scannedTotal: number;
  matches: SharedStickyMatch[];
  quotes: WatchQuote[];
  note?: string;
  marketLabel?: string;
};

type GlobalBag = {
  __mwSession?: SharedWatchSession | null;
  __mwLatest?: SharedWatchSession | null;
  __mwTickInFlight?: Promise<SharedWatchSession | null> | null;
  __mwLastTickStart?: number;
};

function g(): GlobalBag {
  return globalThis as GlobalBag;
}

const STALE_MS = 55_000;

/** Global strategies used by the shared scanner (not per-user). */
export function sharedWatchStrategies(): StrategyConfig[] {
  return STRATEGY_PRESETS.filter(
    (p) =>
      p.entry?.length &&
      (p.name === "VWAP Bull" ||
        p.name === "Opening Range + EMA9" ||
        p.name.includes("bullish") ||
        p.name.includes("Bull") ||
        p.name.includes("OR +"))
  ).map((p) => structuredClone(p));
}

function emptySession(
  day: string,
  opts?: Partial<SharedWatchSession>
): SharedWatchSession {
  return {
    sessionDay: day,
    status: isNseSessionOpen() ? "running" : "closed",
    generatedAt: new Date().toISOString(),
    lastTickAt: 0,
    interval: "5m",
    source: (process.env.MARKET_WATCH_SOURCE as WatchDataSource) || "yahoo",
    strategies: sharedWatchStrategies().map((s) => s.name),
    rotationOffset: 0,
    universeSize: 0,
    batchSize: 25,
    batchIndex: 0,
    batchesPerCycle: 0,
    tickCount: 0,
    scannedTotal: 0,
    matches: [],
    quotes: [],
    note: "Waiting for first shared scan tick…",
    marketLabel: sessionStatus().label,
    ...opts,
  };
}

function stickyKey(m: { strategyName: string; symbol: string }) {
  return `${m.strategyName}::${m.symbol}`;
}

function mergeSticky(
  prev: SharedStickyMatch[],
  incoming: (WatchMatch & { strategyName: string })[],
  now: number
): SharedStickyMatch[] {
  const map = new Map<string, SharedStickyMatch>();
  for (const m of prev) {
    map.set(stickyKey(m), m);
  }
  for (const m of incoming) {
    const k = stickyKey(m);
    const old = map.get(k);
    map.set(k, {
      ...m,
      sector: sectorOf(m.symbol),
      addedAt: old?.addedAt ?? now,
    });
  }
  return [...map.values()].sort((a, b) => {
    const c = a.strategyName.localeCompare(b.strategyName);
    if (c !== 0) return c;
    return (b.changePct ?? 0) - (a.changePct ?? 0);
  });
}

function mergeQuotes(
  prev: WatchQuote[],
  incoming: WatchQuote[]
): WatchQuote[] {
  const map = new Map<string, WatchQuote>();
  for (const q of prev) map.set(q.symbol, q);
  for (const q of incoming) map.set(q.symbol, q);
  return [...map.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

async function saveDurable(session: SharedWatchSession): Promise<void> {
  // Firestore paths must alternate collection/doc: col/doc only
  const path = `marketWatchSessions/${session.sessionDay}`;
  const payload = {
    ...session,
    // Cap payload size for Firestore
    matches: session.matches.slice(0, 800),
    quotes: session.quotes.slice(0, 500),
  } as unknown as Record<string, unknown>;

  g().__mwSession =
    session.sessionDay === todayIst() ? session : g().__mwSession;
  g().__mwLatest = session;

  try {
    if (isAdminConfigured()) {
      const db = await getAdminDbAsync();
      if (db) {
        await db.doc(path).set(payload, { merge: true });
        await db.doc("marketWatch/current").set(
          {
            sessionDay: session.sessionDay,
            status: session.status,
            lastTickAt: session.lastTickAt,
            updatedAt: Date.now(),
          },
          { merge: true }
        );
        return;
      }
      await firestoreRestSet(path, payload, true);
      await firestoreRestSet(
        "marketWatch/current",
        {
          sessionDay: session.sessionDay,
          status: session.status,
          lastTickAt: session.lastTickAt,
          updatedAt: Date.now(),
        },
        true
      );
    }
  } catch (e) {
    console.error("[market-watch] durable save failed", e);
  }
}

async function loadDurableDay(
  day: string
): Promise<SharedWatchSession | null> {
  try {
    if (isAdminConfigured()) {
      const db = await getAdminDbAsync();
      if (db) {
        const snap = await db.doc(`marketWatchSessions/${day}`).get();
        if (snap.exists) return snap.data() as SharedWatchSession;
      }
      const rest = await firestoreRestGet(`marketWatchSessions/${day}`);
      if (rest && typeof rest.sessionDay === "string") {
        return rest as unknown as SharedWatchSession;
      }
    }
  } catch (e) {
    console.error("[market-watch] durable load failed", e);
  }
  return null;
}

async function loadCurrentPointer(): Promise<string | null> {
  try {
    if (isAdminConfigured()) {
      const db = await getAdminDbAsync();
      if (db) {
        const snap = await db.doc("marketWatch/current").get();
        if (snap.exists) {
          const d = snap.data() as { sessionDay?: string };
          return d.sessionDay || null;
        }
      }
      const rest = await firestoreRestGet("marketWatch/current");
      if (rest && typeof rest.sessionDay === "string") return rest.sessionDay;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Best available session for UI: today if open/exists, else latest closed. */
export async function getSharedWatchSession(): Promise<SharedWatchSession | null> {
  const today = todayIst();
  const mem = g().__mwSession;
  if (mem?.sessionDay === today) {
    return {
      ...mem,
      status: isNseSessionOpen() ? "running" : "closed",
      marketLabel: sessionStatus().label,
    };
  }

  const durableToday = await loadDurableDay(today);
  if (durableToday) {
    g().__mwSession = durableToday;
    return {
      ...durableToday,
      status: isNseSessionOpen() ? "running" : "closed",
      marketLabel: sessionStatus().label,
    };
  }

  const latestMem = g().__mwLatest;
  if (latestMem) {
    return {
      ...latestMem,
      status: "closed" as const,
      marketLabel: sessionStatus().label,
    };
  }

  const ptr = await loadCurrentPointer();
  if (ptr && ptr !== today) {
    const prev = await loadDurableDay(ptr);
    if (prev) {
      g().__mwLatest = prev;
      return { ...prev, status: "closed", marketLabel: sessionStatus().label };
    }
  }

  // Walk back a few weekdays for latest snapshot
  for (let i = 1; i <= 5; i++) {
    const d = new Date(Date.now() + 5.5 * 3600_000 - i * 86400_000);
    const ymd = d.toISOString().slice(0, 10);
    const s = await loadDurableDay(ymd);
    if (s?.matches?.length || s?.quotes?.length) {
      g().__mwLatest = s;
      return { ...s, status: "closed", marketLabel: sessionStatus().label };
    }
  }

  return null;
}

/**
 * Run one shared rotation tick (market open only).
 * Locked so concurrent users/cron share a single scan.
 */
export async function processSharedWatchTick(opts?: {
  force?: boolean;
  source?: WatchDataSource;
  interval?: Interval;
}): Promise<SharedWatchSession | null> {
  const force = Boolean(opts?.force);
  const open = isNseSessionOpen();
  if (!open && !force) {
    // Mark today closed if we have it
    const cur = await getSharedWatchSession();
    if (cur && cur.sessionDay === todayIst() && cur.status === "running") {
      const closed = {
        ...cur,
        status: "closed" as const,
        marketLabel: sessionStatus().label,
        note: (cur.note || "") + " · Session closed.",
      };
      await saveDurable(closed);
      return closed;
    }
    return getSharedWatchSession();
  }

  const inflight = g().__mwTickInFlight;
  if (inflight) {
    return inflight;
  }

  const started = Date.now();
  const lastStart = g().__mwLastTickStart ?? 0;
  if (!force && lastStart && started - lastStart < 15_000) {
    // Debounce rapid kicks
    return getSharedWatchSession();
  }
  g().__mwLastTickStart = started;

  const tickPromise: Promise<SharedWatchSession | null> = (async () => {
    try {
      const today = todayIst();
      const memToday =
        g().__mwSession?.sessionDay === today ? g().__mwSession : null;
      let session: SharedWatchSession =
        memToday || (await loadDurableDay(today)) || emptySession(today);

      if (session.sessionDay !== today) {
        session = emptySession(today);
      }

      const source =
        opts?.source ||
        session.source ||
        ((process.env.MARKET_WATCH_SOURCE as WatchDataSource) ||
          (process.env.UPSTOX_ACCESS_TOKEN ? "upstox" : "yahoo"));
      const interval = opts?.interval || session.interval || "5m";
      const strategies = sharedWatchStrategies();

      let batch: WatchBatchResult;
      try {
        batch = await runWatchBatch({
          strategies,
          interval,
          source,
          rotationOffset: session.rotationOffset || 0,
          matchMode: "session",
          rotateUniverse: true,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        session = {
          ...session,
          lastTickAt: Date.now(),
          note: `Tick failed: ${msg}`,
          marketLabel: sessionStatus().label,
          status: open ? "running" : "closed",
        };
        await saveDurable(session);
        return session;
      }

      const now = Date.now();
      session = {
        sessionDay: today,
        status: open ? "running" : "closed",
        generatedAt: batch.generatedAt,
        lastTickAt: now,
        interval: interval as Interval,
        source: batch.source,
        strategies: batch.strategies,
        rotationOffset: batch.nextOffset,
        universeSize: batch.universeSize,
        batchSize: batch.batchSize,
        batchIndex: batch.batchIndex,
        batchesPerCycle: batch.batchesPerCycle,
        tickCount: (session.tickCount || 0) + 1,
        scannedTotal: (session.scannedTotal || 0) + batch.scanned,
        matches: mergeSticky(session.matches || [], batch.matches, now),
        quotes: mergeQuotes(session.quotes || [], batch.quotes),
        note: batch.note,
        marketLabel: sessionStatus().label,
      };
      await saveDurable(session);
      return session;
    } finally {
      g().__mwTickInFlight = null;
    }
  })();

  g().__mwTickInFlight = tickPromise;
  return tickPromise;
}

/**
 * For UI: return session; if market open and stale, run one shared tick first.
 */
export async function getOrTickSharedWatchSession(opts?: {
  forceTick?: boolean;
}): Promise<{
  session: SharedWatchSession | null;
  ticked: boolean;
  open: boolean;
}> {
  const open = isNseSessionOpen();
  let session = await getSharedWatchSession();
  let ticked = false;

  const stale =
    !session ||
    session.sessionDay !== todayIst() ||
    !session.lastTickAt ||
    Date.now() - session.lastTickAt >= STALE_MS;

  if (opts?.forceTick || (open && stale)) {
    session = await processSharedWatchTick({ force: Boolean(opts?.forceTick) });
    ticked = true;
  } else if (session) {
    session = {
      ...session,
      status: open && session.sessionDay === todayIst() ? "running" : "closed",
      marketLabel: sessionStatus().label,
    };
  }

  return { session, ticked, open };
}
