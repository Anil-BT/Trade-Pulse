/**
 * Process all running paper sessions (cron or manual).
 * Header: Authorization: Bearer $CRON_SECRET  OR  x-cron-secret
 */
import { NextRequest, NextResponse } from "next/server";
import { safeErrorMessage } from "@/lib/http";
import { processAllRunningSessions } from "@/lib/paper/session-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const secret = process.env.CRON_SECRET || process.env.PAPER_WORKER_SECRET;
    if (secret) {
      const hdr =
        req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
        req.headers.get("x-cron-secret") ||
        "";
      if (hdr !== secret) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const n = await processAllRunningSessions();
    return NextResponse.json({
      ok: true,
      processed: n,
      at: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json(
      { error: safeErrorMessage(e) || "Worker failed" },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  return POST(req);
}
