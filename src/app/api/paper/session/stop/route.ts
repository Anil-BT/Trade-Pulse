import { NextRequest, NextResponse } from "next/server";
import { verifyUserIdToken } from "@/lib/firebase/admin";
import { safeErrorMessage } from "@/lib/http";
import { cleanIdToken } from "@/lib/paper/sanitize";
import {
  getActiveSession,
  getSession,
  markSessionStopped,
} from "@/lib/paper/session-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Stop must only patch status fields (markSessionStopped).
 * Do NOT use setSessionStatus/updateSession which re-serializes the full
 * report payload and can silently fail on Vercel/Firestore REST.
 */
export async function POST(req: NextRequest) {
  try {
    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const idToken = cleanIdToken(
      (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
        String(body.idToken || "")
    );
    const user = await verifyUserIdToken(idToken);
    if (!user?.uid) {
      return NextResponse.json({ error: "Sign in required" }, { status: 401 });
    }

    const sessionId =
      (typeof body.sessionId === "string" && body.sessionId.trim()) || "";

    let doc = sessionId
      ? await getSession(user.uid, sessionId)
      : await getActiveSession(user.uid);

    // Fallback: if id was stale, try active running session
    if ((!doc || doc.userId !== user.uid) && sessionId) {
      doc = await getActiveSession(user.uid);
    }

    if (!doc || doc.userId !== user.uid) {
      return NextResponse.json(
        {
          error:
            "No active session to stop. Refresh the page, or start a new session.",
        },
        { status: 404 }
      );
    }

    await markSessionStopped(user.uid, doc.id, "Stopped by user");

    // Verify status flipped (catch silent write failures)
    const after = await getSession(user.uid, doc.id);
    const status = after?.status || "stopped";
    if (after && after.status === "running") {
      return NextResponse.json(
        {
          error:
            "Stop request accepted but session still shows running in storage. Retry stop.",
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      sessionId: doc.id,
      status,
      session: after
        ? {
            id: after.id,
            status: after.status,
            sessionDay: after.sessionDay,
            startedAt: after.startedAt,
            endsAt: after.endsAt,
            updatedAt: after.updatedAt,
            workerNote: after.workerNote || "Stopped by user",
            tickCount: after.tickCount,
          }
        : {
            id: doc.id,
            status: "stopped",
            workerNote: "Stopped by user",
          },
    });
  } catch (e) {
    console.error("[paper-stop]", e);
    return NextResponse.json(
      { error: safeErrorMessage(e) || "Stop failed" },
      { status: 500 }
    );
  }
}
