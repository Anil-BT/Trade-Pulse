/**
 * Durable paper-session store:
 * - In-process Map (dev / same serverless instance only)
 * - Firestore via Admin SDK, or REST fallback (no ERR_REQUIRE_ESM)
 */
import {
  durableAdminHint,
  firestoreRestGet,
  firestoreRestQuery,
  firestoreRestSet,
  getAdminDbAsync,
  getAdminLoadError,
  getGoogleAccessToken,
  isAdminConfigured,
  isDurableStoreReadyAsync,
  parseServiceAccount,
} from "../firebase/admin";
import { cleanForStorage, compactSession } from "./sanitize";
import type { PaperSessionDoc, PaperSessionStatus } from "./session-types";

const COL = "paperSessions";

type GlobalBag = {
  __paperSessions?: Map<string, PaperSessionDoc>;
  __paperTimers?: Map<string, ReturnType<typeof setInterval>>;
};

function g(): GlobalBag {
  return globalThis as GlobalBag;
}

function mem(): Map<string, PaperSessionDoc> {
  const x = g();
  if (!x.__paperSessions) x.__paperSessions = new Map();
  return x.__paperSessions;
}

export function memTimers(): Map<string, ReturnType<typeof setInterval>> {
  const x = g();
  if (!x.__paperTimers) x.__paperTimers = new Map();
  return x.__paperTimers;
}

export type SaveSessionResult = {
  ok: boolean;
  durable: boolean;
  error?: string;
};

function isTerminalStatus(status: string | undefined | null): boolean {
  return status === "stopped" || status === "ended";
}

export async function isDurableStoreReady(): Promise<boolean> {
  return isDurableStoreReadyAsync();
}

export function durableStoreHint(): string {
  if (!isAdminConfigured()) {
    return "Set FIREBASE_SERVICE_ACCOUNT_JSON in Vercel env (service account JSON). Client Firebase alone is not enough for paper status.";
  }
  const err = getAdminLoadError();
  if (err) return durableAdminHint() || `Firebase Admin failed: ${err}`;
  return durableAdminHint();
}

async function canUseRest(): Promise<boolean> {
  if (!parseServiceAccount()) return false;
  const t = await getGoogleAccessToken();
  return Boolean(t);
}

export async function saveSession(doc: PaperSessionDoc): Promise<SaveSessionResult> {
  mem().set(doc.id, doc);

  let clean: PaperSessionDoc;
  try {
    const compacted = compactSession(doc as never) as PaperSessionDoc;
    clean = cleanForStorage(compacted, false);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Session serialize failed";
    console.error("[paper-session] serialize failed:", msg);
    return { ok: false, durable: false, error: msg };
  }

  // If memory already terminal, never write a resurrected "running" payload
  const memNow = mem().get(doc.id);
  let toWrite = clean;
  if (
    isTerminalStatus(memNow?.status) &&
    !isTerminalStatus(clean.status)
  ) {
    toWrite = {
      ...clean,
      status: memNow!.status,
      workerNote: memNow!.workerNote || clean.workerNote,
    };
  }

  mem().set(doc.id, { ...toWrite, upstoxAccessToken: doc.upstoxAccessToken });

  const payload = {
    ...toWrite,
    upstoxAccessToken: doc.upstoxAccessToken || null,
  };

  // Prefer Admin SDK
  const db = await getAdminDbAsync();
  if (db) {
    try {
      // Guard: if cloud is already stopped, only allow terminal writes
      if (!isTerminalStatus(toWrite.status)) {
        const existing = await db
          .collection("users")
          .doc(doc.userId)
          .collection(COL)
          .doc(doc.id)
          .get();
        if (existing.exists) {
          const cur = existing.data() as { status?: string };
          if (isTerminalStatus(cur?.status)) {
            return { ok: true, durable: true }; // refuse to revive
          }
        }
      }
      await db
        .collection("users")
        .doc(doc.userId)
        .collection(COL)
        .doc(doc.id)
        .set(payload, { merge: true });
      await db.collection("paperSessionIndex").doc(doc.id).set(
        {
          userId: doc.userId,
          sessionId: doc.id,
          status: toWrite.status,
          updatedAt: toWrite.updatedAt || Date.now(),
          endsAt: toWrite.endsAt || null,
          sessionDay: toWrite.sessionDay || null,
        },
        { merge: true }
      );
      return { ok: true, durable: true };
    } catch (e) {
      console.error(
        "[paper-session] Admin write failed, trying REST:",
        e instanceof Error ? e.message : e
      );
    }
  }

  // REST fallback (no firebase-admin / jose)
  if (await canUseRest()) {
    if (!isTerminalStatus(toWrite.status)) {
      const existing = await firestoreRestGet(
        `users/${doc.userId}/${COL}/${doc.id}`
      );
      if (existing && isTerminalStatus(String(existing.status || ""))) {
        return { ok: true, durable: true };
      }
    }
    const ok1 = await firestoreRestSet(
      `users/${doc.userId}/${COL}/${doc.id}`,
      payload as Record<string, unknown>,
      true
    );
    const ok2 = await firestoreRestSet(
      `paperSessionIndex/${doc.id}`,
      {
        userId: doc.userId,
        sessionId: doc.id,
        status: toWrite.status,
        updatedAt: toWrite.updatedAt || Date.now(),
        endsAt: toWrite.endsAt || null,
        sessionDay: toWrite.sessionDay || null,
      },
      true
    );
    if (ok1 && ok2) return { ok: true, durable: true };
    return {
      ok: false,
      durable: false,
      error: getAdminLoadError() || "Firestore REST save failed",
    };
  }

  return {
    ok: true,
    durable: false,
    error: durableStoreHint() || "No Firestore backend",
  };
}

/**
 * Patch status to stopped and update index.
 * Returns whether a durable write succeeded (Admin and/or REST).
 */
export async function markSessionStopped(
  userId: string,
  sessionId: string,
  note: string
): Promise<{ ok: boolean; durable: boolean; error?: string }> {
  const now = Date.now();
  // Always update memory first so same-instance worker/status see stop
  const m = mem().get(sessionId);
  if (m && (!m.userId || m.userId === userId)) {
    m.status = "stopped";
    m.updatedAt = now;
    m.workerNote = note;
    m.lastWorkerAt = now;
    m.userId = userId;
  } else {
    mem().set(sessionId, {
      id: sessionId,
      userId,
      status: "stopped",
      upstoxAccessToken: m?.upstoxAccessToken || "",
      config: m?.config || ({} as PaperSessionDoc["config"]),
      sessionDay: m?.sessionDay || "",
      startedAt: m?.startedAt || now,
      updatedAt: now,
      endsAt: m?.endsAt || now,
      workerNote: note,
      lastWorkerAt: now,
      tickCount: m?.tickCount || 0,
      report: m?.report ?? null,
      openPositions: m?.openPositions || [],
      strategyResults: m?.strategyResults || [],
      eventLog: m?.eventLog || [],
    });
  }
  const t = memTimers().get(sessionId);
  if (t) {
    clearInterval(t);
    memTimers().delete(sessionId);
  }

  const patch = {
    status: "stopped" as const,
    updatedAt: now,
    workerNote: note,
    lastWorkerAt: now,
  };

  let wrote = false;
  let lastErr = "";
  const db = await getAdminDbAsync();
  if (db) {
    try {
      await db
        .collection("users")
        .doc(userId)
        .collection(COL)
        .doc(sessionId)
        .set(patch, { merge: true });
      await db.collection("paperSessionIndex").doc(sessionId).set(
        {
          userId,
          sessionId,
          status: "stopped",
          updatedAt: now,
        },
        { merge: true }
      );
      wrote = true;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : "admin stop write failed";
      console.error("[paper-session] mark stopped admin failed:", e);
    }
  }

  // Always try REST as well when Admin missing OR as second path if Admin failed
  if (!wrote) {
    if (await canUseRest()) {
      const ok1 = await firestoreRestSet(
        `users/${userId}/${COL}/${sessionId}`,
        patch,
        true
      );
      const ok2 = await firestoreRestSet(
        `paperSessionIndex/${sessionId}`,
        { userId, sessionId, status: "stopped", updatedAt: now },
        true
      );
      wrote = ok1 && ok2;
      if (!wrote) lastErr = "Firestore REST stop write failed";
    } else if (!db) {
      lastErr = durableStoreHint() || "No durable store for stop";
    }
  }

  if (!wrote) {
    console.error("[paper-session] mark stopped durable failed", sessionId, lastErr);
    return { ok: false, durable: false, error: lastErr || "Stop write failed" };
  }
  return { ok: true, durable: true };
}

export async function getSession(
  userId: string,
  sessionId: string,
  opts?: { preferCloud?: boolean }
): Promise<PaperSessionDoc | null> {
  const m = mem().get(sessionId);
  // Memory hit only when not forcing cloud re-read
  if (!opts?.preferCloud && m && m.userId === userId) return m;

  const db = await getAdminDbAsync();
  if (db) {
    try {
      const snap = await db
        .collection("users")
        .doc(userId)
        .collection(COL)
        .doc(sessionId)
        .get();
      if (snap.exists) {
        const data = snap.data() as PaperSessionDoc;
        const existing = mem().get(sessionId);
        // Prefer terminal status from cloud over stale mem running
        const merged: PaperSessionDoc = {
          ...data,
          id: data.id || sessionId,
          userId: data.userId || userId,
          upstoxAccessToken:
            data.upstoxAccessToken || existing?.upstoxAccessToken || "",
        };
        if (
          isTerminalStatus(existing?.status) &&
          !isTerminalStatus(merged.status)
        ) {
          // Local stop already applied; keep terminal until cloud catches up
          merged.status = existing!.status;
          merged.workerNote = existing!.workerNote || merged.workerNote;
        }
        mem().set(sessionId, merged);
        return mem().get(sessionId) || null;
      }
    } catch (e) {
      console.error("[paper-session] getSession admin failed:", e);
    }
  }

  if (await canUseRest()) {
    const data = await firestoreRestGet(
      `users/${userId}/${COL}/${sessionId}`
    );
    if (data) {
      const existing = mem().get(sessionId);
      const doc: PaperSessionDoc = {
        ...(data as unknown as PaperSessionDoc),
        id: (data.id as string) || sessionId,
        userId: (data.userId as string) || userId,
        upstoxAccessToken:
          (data.upstoxAccessToken as string) ||
          existing?.upstoxAccessToken ||
          "",
      };
      if (
        isTerminalStatus(existing?.status) &&
        !isTerminalStatus(doc.status)
      ) {
        doc.status = existing!.status;
        doc.workerNote = existing!.workerNote || doc.workerNote;
      }
      mem().set(sessionId, doc);
      return doc;
    }
  }

  return m && m.userId === userId ? m : null;
}

/**
 * Active = status running in **cloud** (or verified cloud).
 * Never trust in-memory alone — that revives stopped sessions on warm Vercel instances.
 */
export async function getActiveSession(
  userId: string
): Promise<PaperSessionDoc | null> {
  // Clear stale in-memory "running" that cloud already stopped
  for (const s of mem().values()) {
    if (s.userId === userId && s.status === "running") {
      const cloud = await getSession(userId, s.id, { preferCloud: true });
      if (!cloud || cloud.status !== "running") {
        if (cloud) mem().set(s.id, cloud);
        else {
          s.status = "stopped";
          s.workerNote = s.workerNote || "Stopped (stale memory cleared)";
        }
      }
    }
  }

  const db = await getAdminDbAsync();
  if (db) {
    try {
      let best: PaperSessionDoc | null = null;
      try {
        const snap = await db
          .collection("users")
          .doc(userId)
          .collection(COL)
          .where("status", "==", "running")
          .orderBy("startedAt", "desc")
          .limit(5)
          .get();
        snap.forEach((d) => {
          const data = d.data() as PaperSessionDoc;
          if (!best || (data.startedAt || 0) > (best.startedAt || 0)) {
            best = { ...data, id: data.id || d.id };
          }
        });
      } catch {
        const snap = await db
          .collection("users")
          .doc(userId)
          .collection(COL)
          .where("status", "==", "running")
          .limit(5)
          .get();
        snap.forEach((d) => {
          const data = { ...(d.data() as PaperSessionDoc), id: d.id };
          if (!best || (data.startedAt || 0) > (best.startedAt || 0)) {
            best = data;
          }
        });
      }
      if (best) {
        const b = best as PaperSessionDoc;
        const existing = mem().get(b.id);
        // Never return if memory already terminal for this id
        if (isTerminalStatus(existing?.status)) {
          return null;
        }
        mem().set(b.id, {
          ...b,
          upstoxAccessToken:
            b.upstoxAccessToken || existing?.upstoxAccessToken || "",
        });
        return mem().get(b.id) || b;
      }
      return null;
    } catch (e) {
      console.error("[paper-session] getActiveSession admin failed:", e);
    }
  }

  if (await canUseRest()) {
    const rows = await firestoreRestQuery(
      `users/${userId}`,
      COL,
      "status",
      "EQUAL",
      "running",
      5
    );
    let best: PaperSessionDoc | null = null;
    for (const row of rows) {
      const data = row as unknown as PaperSessionDoc;
      if (!best || (data.startedAt || 0) > (best.startedAt || 0)) {
        best = { ...data, id: data.id || (row.id as string) };
      }
    }
    if (best) {
      const existing = mem().get(best.id);
      if (isTerminalStatus(existing?.status)) return null;
      mem().set(best.id, {
        ...best,
        userId: best.userId || userId,
        upstoxAccessToken:
          best.upstoxAccessToken || existing?.upstoxAccessToken || "",
      });
      return mem().get(best.id) || best;
    }
  }

  return null;
}

/** Stop every running session for this user (zombies from prior failed stops). */
export async function stopAllRunningSessions(
  userId: string,
  note = "Stopped by user"
): Promise<{ stoppedIds: string[]; errors: string[] }> {
  const stoppedIds: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  // From memory
  for (const s of mem().values()) {
    if (s.userId === userId && s.status === "running" && s.id) {
      seen.add(s.id);
    }
  }

  // From cloud active list (may include ids not in mem)
  try {
    const active = await getActiveSession(userId);
    if (active?.id) seen.add(active.id);
  } catch {
    /* ignore */
  }

  // Query more running ids if possible
  const db = await getAdminDbAsync();
  if (db) {
    try {
      const snap = await db
        .collection("users")
        .doc(userId)
        .collection(COL)
        .where("status", "==", "running")
        .limit(20)
        .get();
      snap.forEach((d) => seen.add(d.id));
    } catch {
      /* ignore */
    }
  } else if (await canUseRest()) {
    const rows = await firestoreRestQuery(
      `users/${userId}`,
      COL,
      "status",
      "EQUAL",
      "running",
      20
    );
    for (const r of rows) {
      const id = String(r.id || "");
      if (id) seen.add(id);
    }
  }

  for (const id of seen) {
    const r = await markSessionStopped(userId, id, note);
    if (r.ok) stoppedIds.push(id);
    else errors.push(r.error || id);
  }

  return { stoppedIds, errors };
}

export async function listRunningSessions(): Promise<PaperSessionDoc[]> {
  const out = new Map<string, PaperSessionDoc>();
  const candidates: { userId: string; sessionId: string }[] = [];

  for (const s of mem().values()) {
    if (s.status === "running" && s.userId && s.id) {
      candidates.push({ userId: s.userId, sessionId: s.id });
    }
  }

  const db = await getAdminDbAsync();
  if (db) {
    try {
      const idx = await db
        .collection("paperSessionIndex")
        .where("status", "==", "running")
        .limit(50)
        .get();
      for (const d of idx.docs) {
        const ref = d.data() as { userId: string; sessionId: string };
        if (!ref.userId || !ref.sessionId) continue;
        candidates.push({ userId: ref.userId, sessionId: ref.sessionId });
      }
    } catch {
      /* ignore */
    }
  } else if (await canUseRest()) {
    const rows = await firestoreRestQuery(
      "",
      "paperSessionIndex",
      "status",
      "EQUAL",
      "running",
      50
    );
    for (const row of rows) {
      const ref = row as { userId?: string; sessionId?: string };
      if (!ref.userId || !ref.sessionId) continue;
      candidates.push({ userId: ref.userId, sessionId: ref.sessionId });
    }
  }

  // Only include sessions still running in cloud
  for (const c of candidates) {
    if (out.has(c.sessionId)) continue;
    const full = await getSession(c.userId, c.sessionId, { preferCloud: true });
    if (full?.status === "running") out.set(full.id, full);
  }

  return [...out.values()];
}

export async function updateSession(
  sessionId: string,
  patch: Partial<PaperSessionDoc>
): Promise<PaperSessionDoc | null> {
  const prev = mem().get(sessionId);
  let base = prev;
  if (!base && patch.userId) {
    base = (await getSession(patch.userId, sessionId)) || undefined;
  }
  if (!base) {
    for (const s of mem().values()) {
      if (s.id === sessionId) {
        base = s;
        break;
      }
    }
  }
  if (!base) {
    const db = await getAdminDbAsync();
    if (db) {
      try {
        const idx = await db
          .collection("paperSessionIndex")
          .doc(sessionId)
          .get();
        if (idx.exists) {
          const ref = idx.data() as { userId?: string };
          if (ref.userId) {
            base = (await getSession(ref.userId, sessionId)) || undefined;
          }
        }
      } catch {
        /* ignore */
      }
    } else if (await canUseRest()) {
      const idx = await firestoreRestGet(`paperSessionIndex/${sessionId}`);
      if (idx?.userId) {
        base =
          (await getSession(String(idx.userId), sessionId)) || undefined;
      }
    }
  }
  if (!base) return null;

  // Critical: re-read cloud so a concurrent Stop cannot be overwritten by a worker tick
  const cloud = await getSession(base.userId, sessionId, { preferCloud: true });
  const liveStatus = cloud?.status || base.status || mem().get(sessionId)?.status;
  if (isTerminalStatus(liveStatus)) {
    // Only allow explicit terminal patches; drop worker report updates
    if (!isTerminalStatus(patch.status)) {
      const terminal = cloud || mem().get(sessionId) || base;
      return {
        ...terminal,
        status: liveStatus as PaperSessionStatus,
      };
    }
  }

  const next: PaperSessionDoc = {
    ...(cloud || base),
    ...patch,
    id: base.id,
    userId: base.userId,
    upstoxAccessToken:
      patch.upstoxAccessToken ||
      cloud?.upstoxAccessToken ||
      base.upstoxAccessToken,
    updatedAt: Date.now(),
  };

  // Never resurrect a stopped session as running
  if (
    isTerminalStatus(liveStatus) &&
    !isTerminalStatus(next.status)
  ) {
    next.status = liveStatus as PaperSessionStatus;
  }

  await saveSession(next);
  return mem().get(sessionId) || next;
}

export async function setSessionStatus(
  sessionId: string,
  status: PaperSessionStatus,
  extra?: Partial<PaperSessionDoc>
): Promise<void> {
  await updateSession(sessionId, { status, ...extra });
  if (status !== "running") {
    const t = memTimers().get(sessionId);
    if (t) {
      clearInterval(t);
      memTimers().delete(sessionId);
    }
  }
}

/** Public view of session (no Upstox token). */
export function toPublicSession(doc: PaperSessionDoc): Record<string, unknown> {
  const { upstoxAccessToken: _t, ...rest } = doc;
  try {
    return compactSession(rest as never) as Record<string, unknown>;
  } catch {
    return {
      id: doc.id,
      status: doc.status,
      sessionDay: doc.sessionDay,
      startedAt: doc.startedAt,
      endsAt: doc.endsAt,
      updatedAt: doc.updatedAt,
      workerNote: doc.workerNote,
      lastError: doc.lastError,
      tickCount: doc.tickCount,
      lastBatch: doc.lastBatch,
      eventLog: (doc.eventLog || []).slice(0, 10),
      config: {
        strategy: { name: doc.config?.strategy?.name },
        strategy2: doc.config?.strategy2
          ? { name: doc.config.strategy2.name }
          : undefined,
      },
    };
  }
}
