/**
 * Durable paper-session store:
 * - Always: in-process Map (survives browser close while Node process is alive)
 * - If Admin configured: also Firestore users/{uid}/paperSessions/{id}
 */
import { getAdminDb } from "../firebase/admin";
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

export async function saveSession(doc: PaperSessionDoc): Promise<void> {
  // Always keep a memory copy first (survives even if serialize/Firestore fails)
  mem().set(doc.id, doc);

  let clean: PaperSessionDoc;
  try {
    const compacted = compactSession(doc as never) as PaperSessionDoc;
    clean = cleanForStorage(compacted, false);
  } catch (e) {
    console.error(
      "[paper-session] serialize failed, keeping memory-only:",
      e instanceof Error ? e.message : e
    );
    return;
  }

  mem().set(doc.id, { ...clean, upstoxAccessToken: doc.upstoxAccessToken });

  const db = getAdminDb();
  if (!db) return;

  try {
    // Prefer not to fail start if cloud write fails
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
  } catch (e) {
    console.error(
      "[paper-session] Firestore save failed (session still in memory):",
      e instanceof Error ? e.message : e
    );
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
    // Restore memory with cloud data; keep memory token if cloud missing it
    const existing = mem().get(sessionId);
    mem().set(sessionId, {
      ...data,
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
    const snap = await db
      .collection("users")
      .doc(userId)
      .collection(COL)
      .where("status", "==", "running")
      .limit(5)
      .get();
    let best: PaperSessionDoc | null = null;
    snap.forEach((d) => {
      const data = d.data() as PaperSessionDoc;
      if (!best || data.startedAt > best.startedAt) best = data;
      const existing = mem().get(data.id);
      mem().set(data.id, {
        ...data,
        upstoxAccessToken:
          data.upstoxAccessToken || existing?.upstoxAccessToken || "",
      });
    });
    return best;
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
      /* index may not exist */
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
  const db = getAdminDb();
  if (db) {
    try {
      await db.collection("paperSessionIndex").doc(sessionId).set(
        {
          userId: next.userId,
          sessionId: next.id,
          status: next.status,
          updatedAt: next.updatedAt,
          endsAt: next.endsAt,
        },
        { merge: true }
      );
    } catch {
      /* ignore */
    }
  }
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
