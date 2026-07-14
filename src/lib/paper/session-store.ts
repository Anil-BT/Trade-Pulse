/**
 * Durable paper-session store:
 * - In-process Map (dev / same serverless instance only)
 * - Firestore users/{uid}/paperSessions/{id} + paperSessionIndex (required on Vercel)
 */
import { getAdminDb, getAdminLoadError, isAdminConfigured } from "../firebase/admin";
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

/** True when Admin Firestore is available for multi-instance durability. */
export function isDurableStoreReady(): boolean {
  return Boolean(getAdminDb());
}

export function durableStoreHint(): string {
  if (!isAdminConfigured()) {
    return "Set FIREBASE_SERVICE_ACCOUNT_JSON in Vercel env (service account JSON). Client Firebase alone is not enough for paper status.";
  }
  const err = getAdminLoadError();
  if (err) return `Firebase Admin failed: ${err}`;
  if (!getAdminDb()) {
    return "Firestore Admin not ready. Check FIREBASE_SERVICE_ACCOUNT_JSON private_key and project_id.";
  }
  return "";
}

export async function saveSession(doc: PaperSessionDoc): Promise<SaveSessionResult> {
  // Always keep a memory copy first
  mem().set(doc.id, doc);

  let clean: PaperSessionDoc;
  try {
    const compacted = compactSession(doc as never) as PaperSessionDoc;
    clean = cleanForStorage(compacted, false);
  } catch (e) {
    const msg =
      e instanceof Error
        ? e.message
        : "Session serialize failed";
    console.error("[paper-session] serialize failed:", msg);
    return { ok: false, durable: false, error: msg };
  }

  mem().set(doc.id, { ...clean, upstoxAccessToken: doc.upstoxAccessToken });

  const db = getAdminDb();
  if (!db) {
    // Local/dev: memory-only is OK; Vercel callers must check durable
    return {
      ok: true,
      durable: false,
      error: durableStoreHint() || "No Firestore Admin",
    };
  }

  try {
    const payload = {
      ...clean,
      upstoxAccessToken: doc.upstoxAccessToken || null,
    };
    await db
      .collection("users")
      .doc(doc.userId)
      .collection(COL)
      .doc(doc.id)
      .set(payload, { merge: true });

    // Index for worker discovery across instances
    await db.collection("paperSessionIndex").doc(doc.id).set(
      {
        userId: doc.userId,
        sessionId: doc.id,
        status: doc.status,
        updatedAt: doc.updatedAt || Date.now(),
        endsAt: doc.endsAt || null,
        sessionDay: doc.sessionDay || null,
      },
      { merge: true }
    );

    return { ok: true, durable: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Firestore save failed";
    console.error("[paper-session] Firestore save failed:", msg);
    return { ok: false, durable: false, error: msg };
  }
}

/** Lightweight status flip — never re-serialize huge reports. */
export async function markSessionStopped(
  userId: string,
  sessionId: string,
  note: string
): Promise<void> {
  const m = mem().get(sessionId);
  if (m && m.userId === userId) {
    m.status = "stopped";
    m.updatedAt = Date.now();
    m.workerNote = note;
    const t = memTimers().get(sessionId);
    if (t) {
      clearInterval(t);
      memTimers().delete(sessionId);
    }
  }
  const db = getAdminDb();
  if (!db) return;
  try {
    await db
      .collection("users")
      .doc(userId)
      .collection(COL)
      .doc(sessionId)
      .set(
        {
          status: "stopped",
          updatedAt: Date.now(),
          workerNote: note,
        },
        { merge: true }
      );
    await db.collection("paperSessionIndex").doc(sessionId).set(
      {
        userId,
        sessionId,
        status: "stopped",
        updatedAt: Date.now(),
      },
      { merge: true }
    );
  } catch (e) {
    console.error("[paper-session] mark stopped failed:", e);
  }
}

export async function getSession(
  userId: string,
  sessionId: string
): Promise<PaperSessionDoc | null> {
  const m = mem().get(sessionId);
  if (m && m.userId === userId) return m;

  const db = getAdminDb();
  if (!db) return m && m.userId === userId ? m : null;
  try {
    const snap = await db
      .collection("users")
      .doc(userId)
      .collection(COL)
      .doc(sessionId)
      .get();
    if (!snap.exists) return null;
    const data = snap.data() as PaperSessionDoc;
    const existing = mem().get(sessionId);
    mem().set(sessionId, {
      ...data,
      id: data.id || sessionId,
      userId: data.userId || userId,
      upstoxAccessToken:
        data.upstoxAccessToken || existing?.upstoxAccessToken || "",
    });
    return mem().get(sessionId) || null;
  } catch (e) {
    console.error("[paper-session] getSession failed:", e);
    return null;
  }
}

export async function getActiveSession(
  userId: string
): Promise<PaperSessionDoc | null> {
  for (const s of mem().values()) {
    if (s.userId === userId && s.status === "running") return s;
  }
  const db = getAdminDb();
  if (!db) return null;
  try {
    // Prefer ordered query; fall back if index missing
    let best: PaperSessionDoc | null = null;
    try {
      const snap = await db
        .collection("users")
        .doc(userId)
        .collection(COL)
        .where("status", "==", "running")
        .orderBy("startedAt", "desc")
        .limit(3)
        .get();
      snap.forEach((d) => {
        const data = d.data() as PaperSessionDoc;
        if (!best) best = { ...data, id: data.id || d.id };
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
        if (!best || (data.startedAt || 0) > (best.startedAt || 0)) best = data;
      });
    }

    if (best) {
      const b = best as PaperSessionDoc;
      const existing = mem().get(b.id);
      mem().set(b.id, {
        ...b,
        upstoxAccessToken:
          b.upstoxAccessToken || existing?.upstoxAccessToken || "",
      });
      return mem().get(b.id) || b;
    }
    return null;
  } catch (e) {
    console.error("[paper-session] getActiveSession failed:", e);
    return null;
  }
}

export async function listRunningSessions(): Promise<PaperSessionDoc[]> {
  const out = new Map<string, PaperSessionDoc>();
  for (const s of mem().values()) {
    if (s.status === "running") out.set(s.id, s);
  }
  const db = getAdminDb();
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
        const full = await getSession(ref.userId, ref.sessionId);
        if (full?.status === "running") out.set(full.id, full);
      }
    } catch {
      /* index query may fail without composite index — ignore */
    }
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
  // Last resort: load from index
  if (!base) {
    const db = getAdminDb();
    if (db) {
      try {
        const idx = await db.collection("paperSessionIndex").doc(sessionId).get();
        if (idx.exists) {
          const ref = idx.data() as { userId?: string };
          if (ref.userId) {
            base = (await getSession(ref.userId, sessionId)) || undefined;
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  if (!base) return null;
  const next: PaperSessionDoc = {
    ...base,
    ...patch,
    id: base.id,
    userId: base.userId,
    upstoxAccessToken: patch.upstoxAccessToken || base.upstoxAccessToken,
    updatedAt: Date.now(),
  };
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
