/**
 * Shared Market Watch session (read for all users).
 * GET  — hydrate UI; if market open and stale, runs one shared tick for everyone.
 * POST — optional forceTick (admin/dev); no per-user scan.
 */
import { NextRequest, NextResponse } from "next/server";
import { safeErrorMessage } from "@/lib/http";
import { sessionStatus } from "@/lib/paper/market-hours";
import { getOrTickSharedWatchSession } from "@/lib/watch/shared-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    const forceTick =
      req.nextUrl.searchParams.get("forceTick") === "1" ||
      req.nextUrl.searchParams.get("tick") === "1";

    const { session, ticked, open } = await getOrTickSharedWatchSession({
      forceTick,
    });

    const st = sessionStatus();
    return NextResponse.json({
      ok: true,
      open,
      marketLabel: st.label,
      today: st.today,
      ticked,
      shared: true,
      session,
      note: session
        ? open
          ? "Shared live session — one scan for all users."
          : "Market closed — showing latest session snapshot."
        : "No shared session yet — wait for market open or first tick.",
    });
  } catch (e) {
    console.error("[watch-session]", e);
    return NextResponse.json(
      { error: safeErrorMessage(e) || "Failed to load market watch session" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    let forceTick = false;
    try {
      const body = (await req.json()) as { forceTick?: boolean };
      forceTick = Boolean(body.forceTick);
    } catch {
      forceTick = false;
    }
    const { session, ticked, open } = await getOrTickSharedWatchSession({
      forceTick,
    });
    return NextResponse.json({
      ok: true,
      open,
      ticked,
      shared: true,
      session,
      marketLabel: sessionStatus().label,
    });
  } catch (e) {
    return NextResponse.json(
      { error: safeErrorMessage(e) || "Failed to load market watch session" },
      { status: 500 }
    );
  }
}
