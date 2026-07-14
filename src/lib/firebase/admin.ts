/**
 * Optional Firebase Admin (server-only) for durable paper sessions.
 * Set FIREBASE_SERVICE_ACCOUNT_JSON to a service-account JSON string.
 *
 * firebase-admin is loaded lazily so a missing/broken package never
 * takes down the whole API route module (HTML 500 on import).
 */
import type { App } from "firebase-admin/app";
import type { Auth } from "firebase-admin/auth";
import type { Firestore } from "firebase-admin/firestore";

let app: App | null | undefined;
let db: Firestore | null | undefined;
let auth: Auth | null | undefined;
let adminLoadError: string | null = null;

function parseServiceAccount(): object | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw?.trim()) return null;
  try {
    const sa = JSON.parse(raw) as {
      private_key?: string;
      project_id?: string;
      client_email?: string;
    };
    // Env files often store "\n" as two chars — fix PEM before cert()
    if (typeof sa.private_key === "string") {
      sa.private_key = sa.private_key.replace(/\\n/g, "\n");
    }
    if (!sa.private_key || !sa.client_email) return null;
    return sa;
  } catch {
    return null;
  }
}

export function isAdminConfigured(): boolean {
  return Boolean(parseServiceAccount());
}

export function getAdminLoadError(): string | null {
  return adminLoadError;
}

function loadAdminModules(): {
  getApps: typeof import("firebase-admin/app").getApps;
  initializeApp: typeof import("firebase-admin/app").initializeApp;
  cert: typeof import("firebase-admin/app").cert;
  getAuth: typeof import("firebase-admin/auth").getAuth;
  getFirestore: typeof import("firebase-admin/firestore").getFirestore;
} | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const appMod = require("firebase-admin/app") as typeof import("firebase-admin/app");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const authMod = require("firebase-admin/auth") as typeof import("firebase-admin/auth");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fsMod = require("firebase-admin/firestore") as typeof import("firebase-admin/firestore");
    return {
      getApps: appMod.getApps,
      initializeApp: appMod.initializeApp,
      cert: appMod.cert,
      getAuth: authMod.getAuth,
      getFirestore: fsMod.getFirestore,
    };
  } catch (e) {
    adminLoadError =
      e instanceof Error ? e.message.slice(0, 200) : "firebase-admin load failed";
    return null;
  }
}

export function getAdminApp(): App | null {
  if (app !== undefined) return app;
  const sa = parseServiceAccount();
  if (!sa) {
    app = null;
    return null;
  }
  const mods = loadAdminModules();
  if (!mods) {
    app = null;
    return null;
  }
  try {
    app =
      mods.getApps().length > 0
        ? mods.getApps()[0]!
        : mods.initializeApp({
            credential: mods.cert(sa as Parameters<typeof mods.cert>[0]),
            projectId:
              (sa as { project_id?: string }).project_id ||
              process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
          });
  } catch (e) {
    adminLoadError =
      e instanceof Error ? e.message.slice(0, 200) : "firebase-admin init failed";
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
  try {
    const mods = loadAdminModules();
    if (!mods) {
      db = null;
      return null;
    }
    db = mods.getFirestore(a);
  } catch (e) {
    adminLoadError =
      e instanceof Error ? e.message.slice(0, 200) : "firestore init failed";
    db = null;
  }
  return db;
}

export function getAdminAuth(): Auth | null {
  if (auth !== undefined) return auth;
  const a = getAdminApp();
  if (!a) {
    auth = null;
    return null;
  }
  try {
    const mods = loadAdminModules();
    if (!mods) {
      auth = null;
      return null;
    }
    auth = mods.getAuth(a);
  } catch (e) {
    adminLoadError =
      e instanceof Error ? e.message.slice(0, 200) : "auth init failed";
    auth = null;
  }
  return auth;
}

/** Verify Firebase ID token (Admin preferred; fallback to Identity Toolkit REST). */
export async function verifyUserIdToken(
  idToken: string
): Promise<{ uid: string; email?: string } | null> {
  if (!idToken?.trim()) return null;

  // Prefer Admin when configured; never throw out of this function
  try {
    const adminAuth = getAdminAuth();
    if (adminAuth) {
      try {
        const decoded = await adminAuth.verifyIdToken(idToken);
        return { uid: decoded.uid, email: decoded.email };
      } catch {
        // fall through to REST — expired/wrong token also fails here
      }
    }
  } catch {
    /* ignore admin path */
  }

  // Fallback: Google Identity Toolkit (works without service account)
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
