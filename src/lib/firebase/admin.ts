/**
 * Optional Firebase Admin (server-only) for durable paper sessions.
 * Set FIREBASE_SERVICE_ACCOUNT_JSON to a service-account JSON string.
 */
import { getApps, initializeApp, cert, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

let app: App | null | undefined;
let db: Firestore | null | undefined;
let auth: Auth | null | undefined;

function parseServiceAccount(): object | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw?.trim()) return null;
  try {
    return JSON.parse(raw) as object;
  } catch {
    return null;
  }
}

export function isAdminConfigured(): boolean {
  return Boolean(parseServiceAccount() || process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
}

export function getAdminApp(): App | null {
  if (app !== undefined) return app;
  const sa = parseServiceAccount();
  if (!sa) {
    app = null;
    return null;
  }
  try {
    app =
      getApps().length > 0
        ? getApps()[0]!
        : initializeApp({
            credential: cert(sa as Parameters<typeof cert>[0]),
            projectId:
              (sa as { project_id?: string }).project_id ||
              process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
          });
  } catch {
    app = null;
  }
  return app;
}

export function getAdminDb(): Firestore | null {
  if (db !== undefined) return db;
  const a = getAdminApp();
  if (!a) {
    db = null;
    return null;
  }
  db = getFirestore(a);
  return db;
}

export function getAdminAuth(): Auth | null {
  if (auth !== undefined) return auth;
  const a = getAdminApp();
  if (!a) {
    auth = null;
    return null;
  }
  auth = getAuth(a);
  return auth;
}

/** Verify Firebase ID token (Admin preferred; fallback to Identity Toolkit REST). */
export async function verifyUserIdToken(
  idToken: string
): Promise<{ uid: string; email?: string } | null> {
  if (!idToken?.trim()) return null;
  const adminAuth = getAdminAuth();
  if (adminAuth) {
    try {
      const decoded = await adminAuth.verifyIdToken(idToken);
      return { uid: decoded.uid, email: decoded.email };
    } catch {
      return null;
    }
  }
  // Fallback: Google Identity Toolkit
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      users?: { localId?: string; email?: string }[];
    };
    const u = data.users?.[0];
    if (!u?.localId) return null;
    return { uid: u.localId, email: u.email };
  } catch {
    return null;
  }
}
