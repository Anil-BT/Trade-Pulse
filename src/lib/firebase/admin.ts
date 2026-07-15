/**
 * Firebase Admin for durable paper sessions (server-only).
 *
 * On Vercel/Next, `require("firebase-admin/auth")` can fail with ERR_REQUIRE_ESM
 * (jose is ESM-only). We load admin via dynamic import() and fall back to
 * Firestore REST + Node crypto JWT if the SDK cannot load.
 */
import type { App } from "firebase-admin/app";
import type { Auth } from "firebase-admin/auth";
import type { Firestore } from "firebase-admin/firestore";
import { createSign } from "crypto";

export type ServiceAccount = {
  project_id?: string;
  client_email?: string;
  private_key?: string;
  type?: string;
};

let app: App | null | undefined;
let db: Firestore | null | undefined;
let auth: Auth | null | undefined;
let adminLoadError: string | null = null;
let initPromise: Promise<void> | null = null;

/** Parsed once from env */
export function parseServiceAccount(): ServiceAccount | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw?.trim()) return null;
  try {
    const sa = JSON.parse(raw) as ServiceAccount;
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

export function getProjectId(): string {
  const sa = parseServiceAccount();
  return (
    sa?.project_id ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
    process.env.GCLOUD_PROJECT ||
    ""
  );
}

type AdminMods = {
  getApps: typeof import("firebase-admin/app").getApps;
  initializeApp: typeof import("firebase-admin/app").initializeApp;
  cert: typeof import("firebase-admin/app").cert;
  getAuth: typeof import("firebase-admin/auth").getAuth;
  getFirestore: typeof import("firebase-admin/firestore").getFirestore;
};

async function loadAdminModules(): Promise<AdminMods | null> {
  try {
    // Dynamic import (not require) — avoids ERR_REQUIRE_ESM on jose
    const [appMod, authMod, fsMod] = await Promise.all([
      import("firebase-admin/app"),
      import("firebase-admin/auth"),
      import("firebase-admin/firestore"),
    ]);
    return {
      getApps: appMod.getApps,
      initializeApp: appMod.initializeApp,
      cert: appMod.cert,
      getAuth: authMod.getAuth,
      getFirestore: fsMod.getFirestore,
    };
  } catch (e) {
    // Fallback: default firebase-admin export (namespace API)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adminMod: any = await import("firebase-admin");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a: any = adminMod.default || adminMod;
      return {
        getApps: () => (a.apps || []) as ReturnType<
          typeof import("firebase-admin/app").getApps
        >,
        initializeApp: (opts) =>
          a.initializeApp(opts) as ReturnType<
            typeof import("firebase-admin/app").initializeApp
          >,
        cert: (c) =>
          a.credential.cert(c) as ReturnType<
            typeof import("firebase-admin/app").cert
          >,
        getAuth: (appInst?) => a.auth(appInst) as Auth,
        getFirestore: (appInst?) => a.firestore(appInst) as Firestore,
      };
    } catch (e2) {
      const msg = e2 instanceof Error ? e2.message : String(e2);
      const msg1 = e instanceof Error ? e.message : String(e);
      adminLoadError = (msg || msg1).slice(0, 280);
      return null;
    }
  }
}

async function ensureAdminInit(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (app !== undefined) return;
    const sa = parseServiceAccount();
    if (!sa) {
      app = null;
      db = null;
      auth = null;
      return;
    }
    const mods = await loadAdminModules();
    if (!mods) {
      app = null;
      db = null;
      auth = null;
      return;
    }
    try {
      const existing = mods.getApps();
      app =
        existing.length > 0
          ? existing[0]!
          : mods.initializeApp({
              credential: mods.cert({
                projectId: sa.project_id,
                clientEmail: sa.client_email,
                privateKey: sa.private_key,
              } as never),
              projectId:
                sa.project_id || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
            });
      db = mods.getFirestore(app);
      auth = mods.getAuth(app);
    } catch (e) {
      adminLoadError =
        e instanceof Error ? e.message.slice(0, 280) : "firebase-admin init failed";
      app = null;
      db = null;
      auth = null;
    }
  })();
  return initPromise;
}

/** @deprecated prefer getAdminAppAsync — sync may return null before init */
export function getAdminApp(): App | null {
  return app ?? null;
}

export async function getAdminAppAsync(): Promise<App | null> {
  await ensureAdminInit();
  return app ?? null;
}

/** Sync: only valid after await ensureAdmin / getAdminDbAsync */
export function getAdminDb(): Firestore | null {
  return db ?? null;
}

export async function getAdminDbAsync(): Promise<Firestore | null> {
  await ensureAdminInit();
  return db ?? null;
}

export function getAdminAuth(): Auth | null {
  return auth ?? null;
}

export async function getAdminAuthAsync(): Promise<Auth | null> {
  await ensureAdminInit();
  return auth ?? null;
}

export async function isDurableStoreReadyAsync(): Promise<boolean> {
  const firestore = await getAdminDbAsync();
  if (firestore) return true;
  // REST fallback works when service account is configured
  return Boolean(parseServiceAccount() && getProjectId());
}

export function durableAdminHint(): string {
  if (!isAdminConfigured()) {
    return "Set FIREBASE_SERVICE_ACCOUNT_JSON in Vercel env (service account JSON). Client Firebase alone is not enough for paper status.";
  }
  if (adminLoadError) {
    return `Firebase Admin SDK load issue (using REST if possible): ${adminLoadError}`;
  }
  return "";
}

/** Verify Firebase ID token (Admin preferred; REST always available). */
export async function verifyUserIdToken(
  idToken: string
): Promise<{ uid: string; email?: string } | null> {
  if (!idToken?.trim()) return null;

  try {
    const adminAuth = await getAdminAuthAsync();
    if (adminAuth) {
      try {
        const decoded = await adminAuth.verifyIdToken(idToken);
        return { uid: decoded.uid, email: decoded.email };
      } catch {
        /* fall through */
      }
    }
  } catch {
    /* ignore */
  }

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

// ─── Google OAuth (service account) for Firestore REST fallback ─────────────

let cachedAccess: { token: string; exp: number } | null = null;

function base64url(input: Buffer | string): string {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return b
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** Access token for Firestore REST (no firebase-admin). */
export async function getGoogleAccessToken(): Promise<string | null> {
  const sa = parseServiceAccount();
  if (!sa?.client_email || !sa.private_key) return null;

  if (cachedAccess && cachedAccess.exp > Date.now() + 60_000) {
    return cachedAccess.token;
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  );
  const unsigned = `${header}.${claim}`;
  const sign = createSign("RSA-SHA256");
  sign.update(unsigned);
  sign.end();
  const sig = base64url(sign.sign(sa.private_key));
  const assertion = `${unsigned}.${sig}`;

  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      adminLoadError = `OAuth token failed: ${t.slice(0, 160)}`;
      return null;
    }
    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) return null;
    cachedAccess = {
      token: data.access_token,
      exp: Date.now() + (data.expires_in || 3600) * 1000,
    };
    return data.access_token;
  } catch (e) {
    adminLoadError =
      e instanceof Error ? e.message.slice(0, 200) : "OAuth token error";
    return null;
  }
}

// ─── Firestore REST helpers (value encode/decode) ───────────────────────────

type FsValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { timestampValue: string }
  | { mapValue: { fields?: Record<string, FsValue> } }
  | { arrayValue: { values?: FsValue[] } };

function encodeValue(v: unknown): FsValue {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    if (Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER) {
      return { integerValue: String(v) };
    }
    return { doubleValue: v };
  }
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(encodeValue) } };
  }
  if (typeof v === "object") {
    const fields: Record<string, FsValue> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === undefined) continue;
      fields[k] = encodeValue(val);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function decodeValue(v: FsValue | undefined): unknown {
  if (!v || typeof v !== "object") return null;
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("stringValue" in v) return v.stringValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("mapValue" in v) {
    const out: Record<string, unknown> = {};
    const fields = v.mapValue.fields || {};
    for (const [k, val] of Object.entries(fields)) {
      out[k] = decodeValue(val);
    }
    return out;
  }
  if ("arrayValue" in v) {
    return (v.arrayValue.values || []).map(decodeValue);
  }
  return null;
}

function encodeDocument(data: Record<string, unknown>): Record<string, FsValue> {
  const fields: Record<string, FsValue> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    fields[k] = encodeValue(v);
  }
  return fields;
}

function decodeDocument(
  fields: Record<string, FsValue> | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!fields) return out;
  for (const [k, v] of Object.entries(fields)) {
    out[k] = decodeValue(v);
  }
  return out;
}

function docPath(path: string): string {
  const projectId = getProjectId();
  const clean = path.replace(/^\/+/, "");
  return `projects/${projectId}/databases/(default)/documents/${clean}`;
}

/**
 * Set/merge a document via Firestore REST (works when Admin SDK cannot load).
 * path e.g. users/{uid}/paperSessions/{id}
 */
export async function firestoreRestSet(
  path: string,
  data: Record<string, unknown>,
  merge = true
): Promise<boolean> {
  const token = await getGoogleAccessToken();
  const projectId = getProjectId();
  if (!token || !projectId) return false;

  const name = docPath(path);
  const fields = encodeDocument(data);
  const fieldPaths = Object.keys(fields);
  const qs = merge
    ? "?" + fieldPaths.map((p) => `updateMask.fieldPaths=${encodeURIComponent(p)}`).join("&")
    : "";

  const url = `https://firestore.googleapis.com/v1/${name}${qs}`;
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields }),
    });
    if (!res.ok) {
      const t = await res.text();
      adminLoadError = `Firestore REST set failed: ${t.slice(0, 180)}`;
      return false;
    }
    return true;
  } catch (e) {
    adminLoadError =
      e instanceof Error ? e.message.slice(0, 200) : "Firestore REST set error";
    return false;
  }
}

export async function firestoreRestGet(
  path: string
): Promise<Record<string, unknown> | null> {
  const token = await getGoogleAccessToken();
  const projectId = getProjectId();
  if (!token || !projectId) return null;

  const url = `https://firestore.googleapis.com/v1/${docPath(path)}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const t = await res.text();
      adminLoadError = `Firestore REST get failed: ${t.slice(0, 180)}`;
      return null;
    }
    const data = (await res.json()) as { fields?: Record<string, FsValue> };
    return decodeDocument(data.fields);
  } catch (e) {
    adminLoadError =
      e instanceof Error ? e.message.slice(0, 200) : "Firestore REST get error";
    return null;
  }
}

/** Structured query: status == value on a collection under parent path. */
export async function firestoreRestQuery(
  parentPath: string,
  collectionId: string,
  field: string,
  op: "EQUAL",
  value: string | number,
  limit = 5
): Promise<Record<string, unknown>[]> {
  const token = await getGoogleAccessToken();
  const projectId = getProjectId();
  if (!token || !projectId) return [];

  const parent = parentPath
    ? `projects/${projectId}/databases/(default)/documents/${parentPath.replace(/^\/+/, "")}`
    : `projects/${projectId}/databases/(default)/documents`;

  const url = `https://firestore.googleapis.com/v1/${parent}:runQuery`;
  const fieldFilter = {
    fieldFilter: {
      field: { fieldPath: field },
      op,
      value: encodeValue(value),
    },
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId }],
          where: fieldFilter,
          limit,
        },
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      adminLoadError = `Firestore REST query failed: ${t.slice(0, 180)}`;
      return [];
    }
    const rows = (await res.json()) as Array<{
      document?: { name?: string; fields?: Record<string, FsValue> };
    }>;
    const out: Record<string, unknown>[] = [];
    for (const row of rows) {
      if (!row.document?.fields) continue;
      const doc = decodeDocument(row.document.fields);
      const name = row.document.name || "";
      const id = name.split("/").pop();
      if (id) doc.id = doc.id || id;
      out.push(doc);
    }
    return out;
  } catch (e) {
    adminLoadError =
      e instanceof Error ? e.message.slice(0, 200) : "Firestore REST query error";
    return [];
  }
}
