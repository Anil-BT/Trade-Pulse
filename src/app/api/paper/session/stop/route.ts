import { NextRequest, NextResponse } from "next/server";
import { verifyUserIdToken } from "@/lib/firebase/admin";
import { safeErrorMessage } from "@/lib/http";
import { cleanIdToken } from "@/lib/paper/sanitize";
import {
  getSession,
  markSessionStopped,
  stopAllRunningSessions,
  toPublicSession,
} from "@/lib/paper/session-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Stop all running paper sessions for the user.
 * Stops zombies that otherwise reappear after a single-id stop.
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

    // Always stop every running session for this user (prevents "starts again")
    const all = await stopAllRunningSessions(user.uid, "Stopped by user");

    // Also force-stop the id the client knows about (even if query missed it)
    if (sessionId) {
      const r = await markSessionStopped(user.uid, sessionId, "Stopped by user");
      if (r.ok && !all.stoppedIds.includes(sessionId)) {
        all.stoppedIds.push(sessionId);
      }
      if (!r.ok && r.error) all.errors.push(r.error);
    }

    if (all.stoppedIds.length === 0 && all.errors.length > 0) {
      return NextResponse.json(
        {
          error:
            all.errors[0] ||
            "Could not write stop to storage. Check FIREBASE_SERVICE_ACCOUNT_JSON.",
        },
        { status: 500 }
      );
    }

    const primaryId = sessionId || all.stoppedIds[0];
    const after = primaryId
      ? await getSession(user.uid, primaryId, { preferCloud: true })
      : null;

    return NextResponse.json({
      ok: true,
      status: "stopped",
      sessionId: primaryId || null,
      stoppedIds: all.stoppedIds,
      session: after
        ? toPublicSession({
            ...after,
            status: "stopped",
            workerNote: after.workerNote || "Stopped by user",
          })
        : primaryId
          ? {
              id: primaryId,
              status: "stopped",
              workerNote: "Stopped by user",
            }
          : null,
      note:
        all.stoppedIds.length > 1
          ? `Stopped ${all.stoppedIds.length} session(s).`
          : "Session stopped.",
    });
  } catch (e) {
    console.error("[paper-stop]", e);
    return NextResponse.json(
      { error: safeErrorMessage(e) || "Stop failed" },
      { status: 500 }
    );
  }
}
