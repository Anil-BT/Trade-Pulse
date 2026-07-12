import { NextRequest, NextResponse } from "next/server";
import { verifyUserIdToken } from "@/lib/firebase/admin";
import { safeErrorMessage } from "@/lib/http";
import {
  getActiveSession,
  getSession,
} from "@/lib/paper/session-store";
import { ensureSessionLoop } from "@/lib/paper/session-worker";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const idToken =
      (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
      req.nextUrl.searchParams.get("idToken") ||
      "";
    const user = await verifyUserIdToken(idToken);
    if (!user?.uid) {
      return NextResponse.json({ error: "Sign in required" }, { status: 401 });
    }

    const sessionId = req.nextUrl.searchParams.get("sessionId");
    let doc = sessionId
      ? await getSession(user.uid, sessionId)
      : await getActiveSession(user.uid);

    // If still running, make sure process loop is attached (e.g. after cold start)
    if (doc?.status === "running") {
      ensureSessionLoop(doc.id, 60_000);
    }

    if (!doc) {
      return NextResponse.json({ session: null });
    }

    // Never send token to client
    const { upstoxAccessToken: _t, ...safe } = doc;
    return NextResponse.json({ session: safe });
  } catch (e) {
    return NextResponse.json(
      { error: safeErrorMessage(e) || "Status failed" },
      { status: 500 }
    );
  }
}
