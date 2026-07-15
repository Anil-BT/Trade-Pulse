/**
 * Authenticated paper tick — driven by the browser while the session page is open.
 *
 * Writes a log line immediately, then runs processPaperSession so dual-option
 * batches still produce visible Server log progress.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifyUserIdToken } from "@/lib/firebase/admin";
import { safeErrorMessage } from "@/lib/http";
import { asciiSafe, cleanIdToken } from "@/lib/paper/sanitize";
import {
  getSession,
  toPublicSession,
  updateSession,
} from "@/lib/paper/session-store";
import { processPaperSession } from "@/lib/paper/session-worker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

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

    const sessionId = String(body.sessionId || "").trim();
    if (!sessionId) {
      return NextResponse.json(
        { error: "sessionId required" },
        { status: 400 }
      );
    }

    let before = await getSession(user.uid, sessionId, { preferCloud: true });
    if (!before) {
      return NextResponse.json(
        { error: "Session not found" },
        { status: 404 }
      );
    }
    if (before.userId && before.userId !== user.uid) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (before.status !== "running") {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: `Session is ${before.status}`,
        session: toPublicSession(before),
      });
    }

    // Immediate log so UI is never stuck on only "Session started"
    const ack = asciiSafe(
      `${new Date().toLocaleTimeString("en-IN")} · Tick requested (browser) · #${(before.tickCount || 0) + 1}`,
      400
    );
    try {
      before =
        (await updateSession(sessionId, {
          userId: user.uid,
          eventLog: [ack, ...(before.eventLog || [])].slice(0, 40),
          workerNote: "Tick requested from browser…",
        })) || before;
    } catch (e) {
      console.error("[paper-tick] ack log failed:", e);
    }

    const doc = await processPaperSession(sessionId, user.uid);
    const latest =
      doc ||
      (await getSession(user.uid, sessionId, { preferCloud: true }));

    return NextResponse.json({
      ok: true,
      skipped: false,
      tickCount: latest?.tickCount ?? null,
      workerNote: latest?.workerNote,
      lastError: latest?.lastError,
      eventLog: (latest?.eventLog || []).slice(0, 12),
      strategyBooks: latest?.strategyResults?.length ?? 0,
      openCount: latest?.openPositions?.length ?? 0,
      session: latest ? toPublicSession(latest) : null,
    });
  } catch (e) {
    console.error("[paper-tick]", e);
    return NextResponse.json(
      { error: safeErrorMessage(e) || "Tick failed" },
      { status: 500 }
    );
  }
}
