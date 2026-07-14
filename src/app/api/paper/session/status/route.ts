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
  let doc = sessionId
    ? await getSession(user.uid, sessionId)
    : await getActiveSession(user.uid);

  // Drive paper work from status polls (Hobby cron is only daily)
  if (doc?.status === "running") {
    const sid = doc.id;
    const uid = user.uid;
    const last = doc.lastWorkerAt || 0;
    // At most one background tick per ~45s per session (avoid overlap)
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

  if (!doc) {
    return NextResponse.json({
      session: null,
      durableReady: isDurableStoreReady(),
      hint: !isDurableStoreReady() ? durableStoreHint() : undefined,
    });
  }

  // Re-read after optional work is scheduled (returns current Firestore state)
  if (sessionId) {
    doc = (await getSession(user.uid, sessionId)) || doc;
  } else {
    doc = (await getActiveSession(user.uid)) || doc;
  }

  return NextResponse.json({
    session: toPublicSession(doc),
    durableReady: isDurableStoreReady(),
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

/** Mobile-safe: idToken in JSON body (avoids Authorization header issues). */
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
