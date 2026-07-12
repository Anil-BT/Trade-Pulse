/**
 * Durable paper-session store:
 * - Always: in-process Map (survives browser close while Node process is alive)
 * - If Admin configured: also Firestore users/{uid}/paperSessions/{id}
 */
import { getAdminDb } from "../firebase/admin";
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

function stripUndefined<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export async function saveSession(doc: PaperSessionDoc): Promise<void> {
  const clean = stripUndefined(doc);
  mem().set(doc.id, clean);
  const db = getAdminDb();
  if (!db) return;
  try {
    await db
      .collection("users")
      .doc(doc.userId)
      .collection(COL)
      .doc(doc.id)
      .set(clean, { merge: true });
  } catch {
    // non-fatal — memory still holds it
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
    mem().set(sessionId, data);
    return data;
  } catch {
    return null;
  }
}

export async function getActiveSession(
  userId: string
): Promise<PaperSessionDoc | null> {
  // Memory first
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
      mem().set(data.id, data);
    });
    return best;
  } catch {
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
      // collection group query needs index — fall back to known user scan via mem only
      // Prefer loading from a top-level index collection if we write there too
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
    // try find in mem by scanning
    for (const s of mem().values()) {
      if (s.id === sessionId) {
        base = s;
        break;
      }
    }
  }
  if (!base) return null;
  const next: PaperSessionDoc = stripUndefined({
    ...base,
    ...patch,
    id: base.id,
    userId: base.userId,
    updatedAt: Date.now(),
  });
  await saveSession(next);
  // Index for worker discovery
  const db = getAdminDb();
  if (db) {
    try {
      await db
        .collection("paperSessionIndex")
        .doc(sessionId)
        .set(
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
  return next;
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
