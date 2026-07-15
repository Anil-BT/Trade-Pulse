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

  mem().set(doc.id, { ...clean, upstoxAccessToken: doc.upstoxAccessToken });

  const payload = {
    ...clean,
    upstoxAccessToken: doc.upstoxAccessToken || null,
  };

  // Prefer Admin SDK
  const db = await getAdminDbAsync();
  if (db) {
    try {
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
          status: doc.status,
          updatedAt: doc.updatedAt || Date.now(),
          endsAt: doc.endsAt || null,
          sessionDay: doc.sessionDay || null,
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
        status: doc.status,
        updatedAt: doc.updatedAt || Date.now(),
        endsAt: doc.endsAt || null,
        sessionDay: doc.sessionDay || null,
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

export async function markSessionStopped(
  userId: string,
  sessionId: string,
  note: string
): Promise<void> {
  const now = Date.now();
  const m = mem().get(sessionId);
  if (m && m.userId === userId) {
    m.status = "stopped";
    m.updatedAt = now;
    m.workerNote = note;
    m.lastWorkerAt = now;
  } else {
    // Ensure mem has a stopped stub so same-instance getActiveSession skips it
    const existing = m;
    if (existing) {
      existing.status = "stopped";
      existing.updatedAt = now;
      existing.workerNote = note;
    }
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
      console.error("[paper-session] mark stopped admin failed:", e);
    }
  }

  if (!wrote && (await canUseRest())) {
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
  }

  if (!wrote) {
    // Still mark memory so local status is correct; surface for callers that re-read cloud
    console.error(
      "[paper-session] mark stopped: durable write failed",
      sessionId
    );
  }
}

export async function getSession(
  userId: string,
  sessionId: string
): Promise<PaperSessionDoc | null> {
  const m = mem().get(sessionId);
  if (m && m.userId === userId) return m;

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
        mem().set(sessionId, {
          ...data,
          id: data.id || sessionId,
          userId: data.userId || userId,
          upstoxAccessToken:
            data.upstoxAccessToken || existing?.upstoxAccessToken || "",
        });
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
      const doc = {
        ...(data as unknown as PaperSessionDoc),
        id: (data.id as string) || sessionId,
        userId: (data.userId as string) || userId,
        upstoxAccessToken:
          (data.upstoxAccessToken as string) ||
          existing?.upstoxAccessToken ||
          "",
      };
      mem().set(sessionId, doc);
      return doc;
    }
  }

  return m && m.userId === userId ? m : null;
}

export async function getActiveSession(
  userId: string
): Promise<PaperSessionDoc | null> {
  for (const s of mem().values()) {
    if (s.userId === userId && s.status === "running") return s;
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
          if (!best || (data.startedAt || 0) > (best.startedAt || 0)) {
            best = data;
          }
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

export async function listRunningSessions(): Promise<PaperSessionDoc[]> {
  const out = new Map<string, PaperSessionDoc>();
  for (const s of mem().values()) {
    if (s.status === "running") out.set(s.id, s);
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
        const full = await getSession(ref.userId, ref.sessionId);
        if (full?.status === "running") out.set(full.id, full);
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
      const full = await getSession(ref.userId, ref.sessionId);
      if (full?.status === "running") out.set(full.id, full);
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
