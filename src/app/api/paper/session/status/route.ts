import { after, NextRequest, NextResponse } from "next/server";
import { verifyUserIdToken } from "@/lib/firebase/admin";
import { safeErrorMessage } from "@/lib/http";
import { cleanIdToken } from "@/lib/paper/sanitize";
import {
  durableStoreHint,
  getActiveSession,
  getSession,
  isDurableStoreReady,
  toPublicSession,
} from "@/lib/paper/session-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

async function handleStatus(
  req: NextRequest,
  body: Record<string, unknown> = {}
) {
  const idToken = cleanIdToken(
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
      String(body.idToken || "") ||
      req.nextUrl.searchParams.get("idToken") ||
      ""
  );
  const user = await verifyUserIdToken(idToken);
  if (!user?.uid) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }

  const sessionId =
    (typeof body.sessionId === "string" && body.sessionId) ||
    req.nextUrl.searchParams.get("sessionId") ||
    "";

  // Active view (no id): only a *running* session
  // Explicit id: return that doc (may be stopped) but never auto-revive work
  let doc = sessionId
    ? await getSession(user.uid, sessionId, { preferCloud: true })
    : await getActiveSession(user.uid);

  // If client asked by id but that session is not running, fall back to any
  // true active session only when they are polling without a "stopped" intent.
  // For active-only UI we return null when not running (unless sessionId set
  // and status is stopped/ended so UI can show "Session stopped").
  if (doc && !sessionId && doc.status !== "running") {
    doc = null;
  }

  // Drive paper work only for confirmed running sessions
  if (doc?.status === "running") {
    // Double-check cloud before scheduling a long tick
    const fresh = await getSession(user.uid, doc.id, { preferCloud: true });
    if (!fresh || fresh.status !== "running") {
      doc = fresh;
    } else {
      doc = fresh;
      const sid = doc.id;
      const uid = user.uid;
      const last = doc.lastWorkerAt || 0;
      if (Date.now() - last > 45_000) {
        after(async () => {
          try {
            const { processPaperSession } = await import(
              "@/lib/paper/session-worker"
            );
            await processPaperSession(sid, uid);
          } catch (e) {
            console.error("[paper-status] tick:", e);
          }
        });
      }
    }
  }

  const durableReady = await isDurableStoreReady();

  if (!doc) {
    return NextResponse.json({
      session: null,
      durableReady,
      hint: !durableReady ? durableStoreHint() : undefined,
    });
  }

  // For default status polls (no sessionId), hide non-running sessions so UI
  // does not re-attach after Stop
  if (!sessionId && doc.status !== "running") {
    return NextResponse.json({
      session: null,
      durableReady,
    });
  }

  return NextResponse.json({
    session: toPublicSession(doc),
    durableReady,
  });
}

export async function GET(req: NextRequest) {
  try {
    return await handleStatus(req);
  } catch (e) {
    console.error("[paper-status]", e);
    return NextResponse.json(
      { error: safeErrorMessage(e) || "Status failed" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    return await handleStatus(req, body);
  } catch (e) {
    console.error("[paper-status]", e);
    return NextResponse.json(
      { error: safeErrorMessage(e) || "Status failed" },
      { status: 500 }
    );
  }
}
