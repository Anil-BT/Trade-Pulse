/**
 * Saved F&O universe scan reports in Firestore:
 *   users/{uid}/scanResults/{id}
 *
 * Stores successful symbols only (ok / no_trades). Error symbols are skipped
 * so re-open / re-run can trust clean rows.
 *
 * Note: Firestore rejects `undefined` field values — always strip before setDoc.
 */
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  where,
} from "firebase/firestore";
import type { ScanReport, ScanRow, ScanTradeDetail } from "../types";
import { uid } from "../format";
import { getFirebase, isFirebaseConfigured } from "./client";

const COL = "scanResults";

/** Same id used for save + load (fingerprint + date range). */
export function scanResultDocId(
  fingerprint: string,
  from: string,
  to: string
): string {
  return (
    `${fingerprint}_${from}_${to}`.replace(/[^a-zA-Z0-9_-]/g, "_") || uid()
  );
}

export type SavedScanResult = {
  id: string;
  /** Strategy + settings fingerprint (symbol fixed as FNO_UNIVERSE) */
  fingerprint: string;
  strategyName: string;
  from: string;
  to: string;
  interval: string;
  source: string;
  tradeInstrument: string;
  oneTradePerDay: boolean;
  universeSize: number;
  scanned: number;
  /** Rows saved (errors excluded) */
  rows: ScanRow[];
  summary: ScanReport["summary"];
  /** How many symbols had errors and were not saved */
  skippedErrors: number;
  generatedAt: string;
  savedAt: number;
};

export function scanResultsAvailable(): boolean {
  return isFirebaseConfigured();
}

/** Keep only symbols that finished without a hard error. */
export function cleanScanRows(rows: ScanRow[]): ScanRow[] {
  return rows.filter((r) => r.status === "ok" || r.status === "no_trades");
}

/**
 * Deep-remove `undefined` (and drop empty optional objects) so Firestore setDoc
 * never sees Unsupported field value: undefined.
 */
function stripUndefined<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => stripUndefined(item))
      .filter((item) => item !== undefined) as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      const cleaned = stripUndefined(v);
      if (cleaned === undefined) continue;
      out[k] = cleaned;
    }
    return out as T;
  }
  return value;
}

function sanitizeTrade(t: ScanTradeDetail): ScanTradeDetail {
  const row: ScanTradeDetail = {
    entryTime: t.entryTime,
    exitTime: t.exitTime,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    pnl: t.pnl,
    pnlPct: t.pnlPct,
    barsHeld: t.barsHeld,
  };
  if (t.capitalUsed != null) row.capitalUsed = t.capitalUsed;
  if (t.underlyingEntry != null) row.underlyingEntry = t.underlyingEntry;
  if (t.underlyingExit != null) row.underlyingExit = t.underlyingExit;
  if (t.strike != null) row.strike = t.strike;
  if (t.optionSide != null) row.optionSide = t.optionSide;
  if (t.lots != null) row.lots = t.lots;
  if (t.lotSize != null) row.lotSize = t.lotSize;
  if (t.label != null && t.label !== "") row.label = t.label;
  return row;
}

/** Normalize rows: drop undefined optionals; omit empty tradeList. */
function sanitizeRows(rows: ScanRow[], includeTrades: boolean): ScanRow[] {
  return rows.map((r) => {
    const row: ScanRow = {
      symbol: r.symbol,
      trades: r.trades ?? 0,
      winRate: r.winRate ?? 0,
      totalPnl: r.totalPnl ?? 0,
      totalPnlPct: r.totalPnlPct ?? 0,
      finalEquity: r.finalEquity ?? 0,
      status: r.status,
    };
    if (r.lotSize != null) row.lotSize = r.lotSize;
    if (r.equitySignals != null) row.equitySignals = r.equitySignals;
    if (r.message != null && r.message !== "") row.message = r.message;
    // Never write error field for clean rows (may be undefined on ok rows)
    if (includeTrades && r.tradeList?.length) {
      row.tradeList = r.tradeList.map(sanitizeTrade);
    }
    return row;
  });
}

function rebuildSummary(rows: ScanRow[]): ScanReport["summary"] {
  const withTrades = rows.filter((r) => r.trades > 0);
  const winners = withTrades.filter((r) => r.totalPnl > 0).length;
  const losers = withTrades.filter((r) => r.totalPnl < 0).length;
  const totalPnl = rows.reduce((s, r) => s + (r.totalPnl || 0), 0);
  const totalTrades = rows.reduce((s, r) => s + (r.trades || 0), 0);
  return {
    ok: rows.filter((r) => r.status === "ok").length,
    errors: 0,
    withTrades: withTrades.length,
    totalTrades,
    totalPnl,
    avgPnl: withTrades.length ? totalPnl / withTrades.length : 0,
    winners,
    losers,
  };
}

/**
 * Save F&O scan: only symbols without errors.
 * Overwrites same fingerprint+date-range when re-saved.
 */
export async function saveScanResult(
  userId: string,
  report: ScanReport,
  fingerprint: string
): Promise<{ id: string; savedRows: number; skippedErrors: number }> {
  const fb = getFirebase();
  if (!fb || !userId) throw new Error("Sign in to save F&O scan results.");

  const clean = cleanScanRows(report.rows || []);
  const skippedErrors = (report.rows || []).filter(
    (r) => r.status === "error"
  ).length;

  if (!clean.length) {
    throw new Error(
      skippedErrors
        ? `No successful symbols to save (${skippedErrors} had errors).`
        : "No symbols to save."
    );
  }

  // Stable id per strategy + date range so re-save updates the same doc
  const id = scanResultDocId(fingerprint, report.from, report.to);

  const buildPayload = (includeTrades: boolean): Record<string, unknown> =>
    stripUndefined({
      id,
      fingerprint,
      strategyName: report.strategyName || "F&O scan",
      from: report.from,
      to: report.to,
      interval: report.interval,
      source: report.source,
      tradeInstrument: report.tradeInstrument || "equity",
      oneTradePerDay: Boolean(report.oneTradePerDay),
      universeSize: report.universeSize ?? clean.length,
      scanned: report.scanned ?? clean.length,
      rows: sanitizeRows(clean, includeTrades),
      summary: rebuildSummary(clean),
      skippedErrors,
      generatedAt: report.generatedAt || new Date().toISOString(),
      savedAt: Date.now(),
    });

  try {
    await setDoc(doc(fb.db, "users", userId, COL, id), buildPayload(true));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/permission|insufficient|Missing or insufficient/i.test(msg)) {
      throw new Error(
        "Missing or insufficient permissions. In Firebase Console → Firestore → Rules, add match for users/{userId}/scanResults/{docId} (see docs/FIREBASE.md or firestore.rules) and Publish. You must also be signed in."
      );
    }
    // Size limit or residual undefined — retry without trade lists
    if (/size|too large|exceed|undefined/i.test(msg) || clean.length > 80) {
      try {
        await setDoc(
          doc(fb.db, "users", userId, COL, id),
          buildPayload(false)
        );
      } catch (e2) {
        const msg2 = e2 instanceof Error ? e2.message : String(e2);
        if (/permission|insufficient|Missing or insufficient/i.test(msg2)) {
          throw new Error(
            "Missing or insufficient permissions. Publish Firestore rules for scanResults (see firestore.rules)."
          );
        }
        throw e2;
      }
      return {
        id,
        savedRows: clean.length,
        skippedErrors,
      };
    }
    throw e;
  }

  return { id, savedRows: clean.length, skippedErrors };
}

function savedToReport(
  data: SavedScanResult,
  from: string,
  to: string
): ScanReport | null {
  if (!data?.rows?.length) return null;
  const report: ScanReport = {
    generatedAt: data.generatedAt || new Date().toISOString(),
    strategyName: data.strategyName || "F&O scan",
    from: data.from || from,
    to: data.to || to,
    interval: data.interval || "5m",
    source: data.source || "upstox",
    tradeInstrument: data.tradeInstrument || "equity",
    oneTradePerDay: Boolean(data.oneTradePerDay),
    universeSize: data.universeSize ?? data.rows.length,
    scanned: data.scanned ?? data.rows.length,
    summary: data.summary || {
      ok: data.rows.filter((r) => r.status === "ok").length,
      errors: data.skippedErrors ?? 0,
      withTrades: data.rows.filter((r) => (r.trades || 0) > 0).length,
      totalTrades: data.rows.reduce((s, r) => s + (r.trades || 0), 0),
      totalPnl: data.rows.reduce((s, r) => s + (r.totalPnl || 0), 0),
      avgPnl: 0,
      winners: 0,
      losers: 0,
    },
    rows: data.rows,
  };
  if (!report.summary.avgPnl && report.summary.withTrades) {
    report.summary.avgPnl = report.summary.totalPnl / report.summary.withTrades;
  }
  return report;
}

/**
 * Load a previously saved F&O scan for the same fingerprint + date range.
 * Tries direct doc ids (including alternate fingerprints), then a query fallback.
 * Returns null on miss / permission / network errors (caller falls back to live scan).
 */
export async function loadScanResult(
  userId: string,
  fingerprint: string,
  from: string,
  to: string,
  /** Also try these fingerprints (legacy FNO_UNIVERSE keys, etc.) */
  altFingerprints: string[] = []
): Promise<ScanReport | null> {
  const fb = getFirebase();
  if (!fb || !userId || !fingerprint) return null;

  const fps = [...new Set([fingerprint, ...altFingerprints].filter(Boolean))];

  try {
    // 1) Direct doc id(s)
    for (const fp of fps) {
      const id = scanResultDocId(fp, from, to);
      const snap = await getDoc(doc(fb.db, "users", userId, COL, id));
      if (!snap.exists()) continue;
      const report = savedToReport(snap.data() as SavedScanResult, from, to);
      if (report) return report;
    }

    // 2) Query by fingerprint + match date range (handles id quirks)
    for (const fp of fps) {
      try {
        const q = query(
          collection(fb.db, "users", userId, COL),
          where("fingerprint", "==", fp),
          limit(25)
        );
        const snap = await getDocs(q);
        for (const d of snap.docs) {
          const data = d.data() as SavedScanResult;
          if (data.from === from && data.to === to) {
            const report = savedToReport(data, from, to);
            if (report) return report;
          }
        }
      } catch {
        // missing index or rules — ignore, try next
      }
    }

    // 3) Last resort: recent saves with same dates (any fingerprint) —
    //    only when a single recent doc matches from/to exactly
    try {
      const q = query(
        collection(fb.db, "users", userId, COL),
        orderBy("savedAt", "desc"),
        limit(15)
      );
      const snap = await getDocs(q);
      for (const d of snap.docs) {
        const data = d.data() as SavedScanResult;
        if (data.from === from && data.to === to && fps.includes(data.fingerprint)) {
          const report = savedToReport(data, from, to);
          if (report) return report;
        }
      }
    } catch {
      // orderBy may need index; ignore
    }

    return null;
  } catch {
    return null;
  }
}

export type ScanResultListItem = Pick<
  SavedScanResult,
  | "id"
  | "strategyName"
  | "from"
  | "to"
  | "savedAt"
  | "summary"
  | "skippedErrors"
  | "scanned"
>;

/** Recent saved F&O scans (for future load UI). */
export async function listScanResults(
  userId: string,
  max = 20
): Promise<ScanResultListItem[]> {
  const fb = getFirebase();
  if (!fb || !userId) return [];
  try {
    const q = query(
      collection(fb.db, "users", userId, COL),
      orderBy("savedAt", "desc"),
      limit(max)
    );
    const snap = await getDocs(q);
    const out: ScanResultListItem[] = [];
    snap.forEach((d) => {
      const data = d.data() as SavedScanResult;
      out.push({
        id: d.id,
        strategyName: data.strategyName,
        from: data.from,
        to: data.to,
        savedAt: data.savedAt,
        summary: data.summary,
        skippedErrors: data.skippedErrors ?? 0,
        scanned: data.scanned,
      });
    });
    return out;
  } catch {
    return [];
  }
}
