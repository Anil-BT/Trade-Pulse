import { NextRequest, NextResponse } from "next/server";
import { verifyUserIdToken } from "@/lib/firebase/admin";
import { safeErrorMessage } from "@/lib/http";
import { cleanIdToken } from "@/lib/paper/sanitize";
import {
  getActiveSession,
  getSession,
  markSessionStopped,
  toPublicSession,
} from "@/lib/paper/session-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Stop must only patch status fields (markSessionStopped).
 * Worker ticks re-check cloud status so they cannot revive a stopped session.
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

    // Prefer explicit id; also stop any active running session for this user
    let doc = sessionId
      ? await getSession(user.uid, sessionId, { preferCloud: true })
      : null;
    if (!doc || doc.userId !== user.uid) {
      doc = await getActiveSession(user.uid);
    }

    if (!doc || doc.userId !== user.uid) {
      // Already stopped / nothing running — treat as success for UI
      return NextResponse.json({
        ok: true,
        status: "stopped",
        session: null,
        note: "No running session found (already stopped).",
      });
    }

    // If already terminal, just return
    if (doc.status === "stopped" || doc.status === "ended") {
      return NextResponse.json({
        ok: true,
        sessionId: doc.id,
        status: doc.status,
        session: toPublicSession(doc),
      });
    }

    const result = await markSessionStopped(
      user.uid,
      doc.id,
      "Stopped by user"
    );
    if (!result.ok) {
      return NextResponse.json(
        {
          error:
            result.error ||
            "Could not write stop to storage. Check FIREBASE_SERVICE_ACCOUNT_JSON.",
        },
        { status: 500 }
      );
    }

    // Force cloud re-read for verification
    const after = await getSession(user.uid, doc.id, { preferCloud: true });
    const status = after?.status || "stopped";
    if (after && after.status === "running") {
      // One more hard write
      const retry = await markSessionStopped(
        user.uid,
        doc.id,
        "Stopped by user (retry)"
      );
      const after2 = await getSession(user.uid, doc.id, { preferCloud: true });
      if (after2?.status === "running" || !retry.ok) {
        return NextResponse.json(
          {
            error:
              "Stop write did not stick (worker may still be mid-tick). Click Stop again in a few seconds.",
          },
          { status: 500 }
        );
      }
      return NextResponse.json({
        ok: true,
        sessionId: doc.id,
        status: after2?.status || "stopped",
        session: after2 ? toPublicSession(after2) : null,
      });
    }

    return NextResponse.json({
      ok: true,
      sessionId: doc.id,
      status,
      session: after ? toPublicSession(after) : {
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
