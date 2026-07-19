/**
 * Shared Market Watch worker — cron / internal kick.
 * Runs one F&O rotation batch when NSE is open; no-ops when closed.
 * Auth: CRON_SECRET or PAPER_WORKER_SECRET (same as paper worker).
 */
import { NextRequest, NextResponse } from "next/server";
import { safeErrorMessage } from "@/lib/http";
import { isNseSessionOpen, sessionStatus } from "@/lib/paper/market-hours";
import { processSharedWatchTick } from "@/lib/watch/shared-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function authorized(req: NextRequest): boolean {
  const secret =
    process.env.CRON_SECRET ||
    process.env.PAPER_WORKER_SECRET ||
    process.env.INTERNAL_WORKER_KEY;
  if (!secret) return true;
  const hdr =
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    req.headers.get("x-cron-secret") ||
    "";
  return hdr === secret;
}

async function handle(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const open = isNseSessionOpen();
  const st = sessionStatus();

  if (!open) {
    const session = await processSharedWatchTick({ force: false });
    return NextResponse.json({
      ok: true,
      open: false,
      marketLabel: st.label,
      action: "idle",
      sessionDay: session?.sessionDay ?? null,
      matches: session?.matches?.length ?? 0,
      quotes: session?.quotes?.length ?? 0,
      at: new Date().toISOString(),
    });
  }

  const session = await processSharedWatchTick({ force: true });
  return NextResponse.json({
    ok: true,
    open: true,
    marketLabel: st.label,
    action: "tick",
    sessionDay: session?.sessionDay ?? null,
    tickCount: session?.tickCount ?? 0,
    batchIndex: session?.batchIndex ?? 0,
    batchesPerCycle: session?.batchesPerCycle ?? 0,
    matches: session?.matches?.length ?? 0,
    quotes: session?.quotes?.length ?? 0,
    rotationOffset: session?.rotationOffset ?? 0,
    note: session?.note,
    at: new Date().toISOString(),
  });
}

export async function GET(req: NextRequest) {
  try {
    return await handle(req);
  } catch (e) {
    console.error("[watch-worker]", e);
    return NextResponse.json(
      { error: safeErrorMessage(e) || "Watch worker failed" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    return await handle(req);
  } catch (e) {
    console.error("[watch-worker]", e);
    return NextResponse.json(
      { error: safeErrorMessage(e) || "Watch worker failed" },
      { status: 500 }
    );
  }
}

