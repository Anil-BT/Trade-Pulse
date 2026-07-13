import { NextRequest, NextResponse } from "next/server";
import { verifyUserIdToken } from "@/lib/firebase/admin";
import { safeErrorMessage } from "@/lib/http";
import { cleanIdToken, compactSession } from "@/lib/paper/sanitize";
import {
  getActiveSession,
  getSession,
} from "@/lib/paper/session-store";
import { ensureSessionLoop } from "@/lib/paper/session-worker";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const idToken = cleanIdToken(
      (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
        req.nextUrl.searchParams.get("idToken") ||
        ""
    );
    const user = await verifyUserIdToken(idToken);
    if (!user?.uid) {
      return NextResponse.json({ error: "Sign in required" }, { status: 401 });
    }

    const sessionId = req.nextUrl.searchParams.get("sessionId");
    const doc = sessionId
      ? await getSession(user.uid, sessionId)
      : await getActiveSession(user.uid);

    if (doc?.status === "running") {
      try {
        ensureSessionLoop(doc.id, 60_000);
      } catch (e) {
        console.error("[paper-status] ensureSessionLoop:", e);
      }
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
  } catch (e) {
    console.error("[paper-status]", e);
    return NextResponse.json(
      { error: safeErrorMessage(e) || "Status failed" },
      { status: 500 }
    );
  }
}
