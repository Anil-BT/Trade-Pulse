/**
 * Process running paper sessions (cron every minute, or status/start kick).
 * Header: Authorization: Bearer $CRON_SECRET  OR  x-cron-secret
 * Body/query optional: sessionId + userId to process a single session.
 */
import { NextRequest, NextResponse } from "next/server";
import { safeErrorMessage } from "@/lib/http";
import {
  processAllRunningSessions,
  processPaperSession,
} from "@/lib/paper/session-worker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** Long enough for dual-strategy options batch on Vercel */
export const maxDuration = 300;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET || process.env.PAPER_WORKER_SECRET;
  // No secret configured → allow (dev / simple prod); cron still needs network
  if (!secret) return true;
  const hdr =
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    req.headers.get("x-cron-secret") ||
    "";
  // Internal kicks from status/start use same secret or INTERNAL_WORKER_KEY
  const internal = process.env.INTERNAL_WORKER_KEY || secret;
  return hdr === secret || hdr === internal;
}

export async function POST(req: NextRequest) {
  try {
    if (!authorized(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const sessionId =
      (typeof body.sessionId === "string" && body.sessionId) ||
      req.nextUrl.searchParams.get("sessionId") ||
      "";
    const userId =
      (typeof body.userId === "string" && body.userId) ||
      req.nextUrl.searchParams.get("userId") ||
      "";

    if (sessionId) {
      const doc = await processPaperSession(sessionId, userId || undefined);
      return NextResponse.json({
        ok: true,
        mode: "single",
        sessionId,
        status: doc?.status || null,
        tickCount: doc?.tickCount ?? null,
        strategies: doc?.strategyResults?.map((s) => ({
          slot: s.slot,
          name: s.strategyName,
          open: s.openPositions?.length || 0,
          trades: s.report?.summary?.totalTrades || 0,
        })),
        at: new Date().toISOString(),
      });
    }

    const n = await processAllRunningSessions();
    return NextResponse.json({
      ok: true,
      mode: "all",
      processed: n,
      at: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[paper-worker]", e);
    return NextResponse.json(
      { error: safeErrorMessage(e) || "Worker failed" },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  return POST(req);
}
