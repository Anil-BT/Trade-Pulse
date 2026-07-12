import { NextRequest, NextResponse } from "next/server";
import { verifyUserIdToken } from "@/lib/firebase/admin";
import { safeErrorMessage } from "@/lib/http";
import {
  getActiveSession,
  getSession,
  setSessionStatus,
} from "@/lib/paper/session-store";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const idToken =
      (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
      body.idToken ||
      "";
    const user = await verifyUserIdToken(idToken);
    if (!user?.uid) {
      return NextResponse.json({ error: "Sign in required" }, { status: 401 });
    }

    const sessionId = body.sessionId as string | undefined;
    const doc = sessionId
      ? await getSession(user.uid, sessionId)
      : await getActiveSession(user.uid);

    if (!doc || doc.userId !== user.uid) {
      return NextResponse.json({ error: "No active session" }, { status: 404 });
    }

    await setSessionStatus(doc.id, "stopped", {
      workerNote: "Stopped by user",
      lastWorkerAt: Date.now(),
    });

    return NextResponse.json({ ok: true, sessionId: doc.id, status: "stopped" });
  } catch (e) {
    return NextResponse.json(
      { error: safeErrorMessage(e) || "Stop failed" },
      { status: 500 }
    );
  }
}
