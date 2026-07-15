/**
 * Keep paper-session payloads safe for headers, Firestore, and JSON.
 */

export function asciiSafe(s: unknown, max = 2000): string {
  try {
    let t = String(s ?? "");
    // Avoid String#normalize — unpaired surrogates can throw in some engines
    t = t
      .replace(/[\u2010-\u2015]/g, "-")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/\u2026/g, "...")
      .replace(/[^\x20-\x7E\n\t]/g, "");
    if (t.length > max) t = t.slice(0, max);
    return t;
  } catch {
    return "";
  }
}

/**
 * Firebase ID tokens (JWT) — only strip whitespace/BOM.
 * Do NOT use sanitizeToken() on JWTs (too aggressive if rules change).
 */
export function cleanIdToken(token: string): string {
  return String(token ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\s+/g, "")
    .trim();
}

/** Drop undefined / non-finite numbers; optional light string trim. */
export function cleanForStorage<T>(value: T, asciiStrings = false): T {
  try {
    return JSON.parse(
      JSON.stringify(value, (_k, v) => {
        if (v === undefined) return undefined; // omitted
        if (typeof v === "number" && !Number.isFinite(v)) return null;
        if (typeof v === "bigint") return Number(v);
        if (typeof v === "function" || typeof v === "symbol") return undefined;
        if (asciiStrings && typeof v === "string") return asciiSafe(v, 50_000);
        return v;
      })
    ) as T;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      /invalid string length/i.test(msg)
        ? "Payload too large (Invalid string length). Try fewer symbols or a simpler strategy."
        : `Config serialize failed: ${msg}`
    );
  }
}

/** Shrink session before JSON/Firestore so prod never hits string-length limits. */
export function compactSession(doc: {
  report?: { rows?: unknown[] } | null;
  strategyResults?: {
    strategyName: string;
    slot: 1 | 2;
    report: { rows?: unknown[]; [k: string]: unknown };
    openPositions?: unknown[];
  }[];
  openPositions?: unknown[];
  eventLog?: string[];
  [k: string]: unknown;
}): typeof doc {
  const MAX_ROWS = 200;
  const MAX_LOG = 30;
  const MAX_TRADES_PER_ROW = 8;

  const trimRow = (row: unknown): unknown => {
    if (!row || typeof row !== "object") return row;
    const r = row as Record<string, unknown>;
    const list = r.tradeList;
    if (!Array.isArray(list) || list.length <= MAX_TRADES_PER_ROW) return r;
    return {
      ...r,
      tradeList: list.slice(-MAX_TRADES_PER_ROW),
      tradeListTruncated: list.length,
    };
  };

  const trimReport = <T extends { rows?: unknown[] }>(r: T | null | undefined) => {
    if (!r) return r;
    let rows = Array.isArray(r.rows) ? r.rows.map(trimRow) : r.rows;
    if (Array.isArray(rows) && rows.length > MAX_ROWS) {
      // Prefer rows with trades / opens first, then fill
      const scored = [...rows].sort((a, b) => {
        const ar = a as { trades?: number; message?: string };
        const br = b as { trades?: number; message?: string };
        const as =
          (Number(ar.trades) || 0) * 10 +
          (String(ar.message || "").includes("OPEN") ? 5 : 0);
        const bs =
          (Number(br.trades) || 0) * 10 +
          (String(br.message || "").includes("OPEN") ? 5 : 0);
        return bs - as;
      });
      rows = scored.slice(0, MAX_ROWS);
    }
    return { ...r, rows };
  };

  return {
    ...doc,
    report: trimReport(doc.report as { rows?: unknown[] }) as typeof doc.report,
    openPositions: Array.isArray(doc.openPositions)
      ? doc.openPositions.slice(0, 120)
      : doc.openPositions,
    eventLog: Array.isArray(doc.eventLog)
      ? doc.eventLog.slice(0, MAX_LOG).map((l) => asciiSafe(l, 400))
      : doc.eventLog,
    strategyResults: Array.isArray(doc.strategyResults)
      ? doc.strategyResults.map((sr) => ({
          strategyName: sr.strategyName,
          slot: sr.slot,
          report: trimReport(sr.report) as typeof sr.report,
          openPositions: (sr.openPositions || []).slice(0, 80),
        }))
      : doc.strategyResults,
  };
}

export function isRateLimitError(msg: string): boolean {
  return /429|rate.?limit|1015|being rate.limited/i.test(msg);
}
