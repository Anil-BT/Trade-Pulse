import { NextRequest, NextResponse } from "next/server";
import { verifyUserIdToken } from "@/lib/firebase/admin";
import { safeErrorMessage } from "@/lib/http";
import { cleanIdToken, compactSession } from "@/lib/paper/sanitize";
import {
  getActiveSession,
  getSession,
} from "@/lib/paper/session-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
  const doc = sessionId
    ? await getSession(user.uid, sessionId)
    : await getActiveSession(user.uid);

  if (doc?.status === "running") {
    void import("@/lib/paper/session-worker")
      .then(({ ensureSessionLoop }) => {
        try {
          ensureSessionLoop(doc.id, 60_000);
        } catch (e) {
          console.error("[paper-status] ensureSessionLoop:", e);
        }
      })
      .catch((e) => console.error("[paper-status] worker import:", e));
  }

  if (!doc) {
    return NextResponse.json({ session: null });
  }

  // Never send token; compact so response never hits string-length limits
  const { upstoxAccessToken: _t, ...rest } = doc;
  let safe: Record<string, unknown> = rest as Record<string, unknown>;
  try {
    safe = compactSession(rest as never) as Record<string, unknown>;
  } catch {
    safe = {
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
    };
  }

  return NextResponse.json({ session: safe });
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
