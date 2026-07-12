import { NextRequest, NextResponse } from "next/server";
import { verifyUserIdToken } from "@/lib/firebase/admin";
import { safeErrorMessage, sanitizeToken } from "@/lib/http";
import { todayIst } from "@/lib/paper/market-hours";
import { getActiveSession, saveSession } from "@/lib/paper/session-store";
import { ensureSessionLoop } from "@/lib/paper/session-worker";
import type { PaperSessionConfig, PaperSessionDoc } from "@/lib/paper/session-types";
import { uid } from "@/lib/format";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function sessionEndsAtMs(): number {
  // Today 15:30 IST → UTC
  const today = todayIst();
  const [y, m, d] = today.split("-").map(Number);
  // 15:30 IST = 10:00 UTC
  return Date.UTC(y, m - 1, d, 10, 0, 0, 0);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const idToken =
      (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
      body.idToken ||
      "";
    const user = await verifyUserIdToken(idToken);
    if (!user?.uid) {
      return NextResponse.json(
        {
          error:
            "Sign in required to start a durable paper session (survives browser close).",
        },
        { status: 401 }
      );
    }

    const token = sanitizeToken(
      body.upstoxAccessToken || process.env.UPSTOX_ACCESS_TOKEN || ""
    );
    if (!token) {
      return NextResponse.json(
        { error: "Upstox access token required" },
        { status: 400 }
      );
    }

    const config = body.config as PaperSessionConfig;
    if (!config?.strategy?.entry?.length || !config?.strategy?.exit?.length) {
      return NextResponse.json(
        { error: "Strategy 1 entry and exit required" },
        { status: 400 }
      );
    }
    if (config.strategy2) {
      if (!config.strategy2.entry?.length || !config.strategy2.exit?.length) {
        return NextResponse.json(
          { error: "Strategy 2 needs entry and exit conditions (or disable it)." },
          { status: 400 }
        );
      }
    }

    // Stop previous running session for this user
    const prev = await getActiveSession(user.uid);
    if (prev) {
      await saveSession({
        ...prev,
        status: "stopped",
        updatedAt: Date.now(),
        workerNote: "Superseded by new session",
      });
    }

    const id = uid() + uid();
    const now = Date.now();
    const endsAt = Math.max(sessionEndsAtMs(), now + 60_000);
    const dual = Boolean(config.strategy2?.entry?.length);

    const doc: PaperSessionDoc = {
      id,
      userId: user.uid,
      status: "running",
      upstoxAccessToken: token,
      config: {
        strategy: config.strategy,
        strategy2: dual ? config.strategy2 : undefined,
        options2: dual ? config.options2 : undefined,
        interval: config.interval || "5m",
        initialCapital: config.initialCapital ?? 100000,
        positionSizePct: config.positionSizePct ?? 100,
        oneTradePerDay: Boolean(config.oneTradePerDay),
        entryTimeWindows: config.entryTimeWindows,
        maxRiskPerTrade: config.maxRiskPerTrade,
        tradeInstrument: config.tradeInstrument || "options_atm",
        options: config.options,
        maxSymbols: config.maxSymbols ?? 30,
        scanAll: Boolean(config.scanAll),
      },
      sessionDay: todayIst(),
      startedAt: now,
      updatedAt: now,
      endsAt,
      tickCount: 0,
      report: null,
      openPositions: [],
      strategyResults: [],
      eventLog: [
        `${new Date().toLocaleTimeString("en-IN")} · Durable session started · ${
          dual
            ? `2 strategies (shared Upstox candles: “${config.strategy.name}” + “${config.strategy2?.name}”)`
            : `1 strategy (“${config.strategy.name}”)`
        } · until stop or 15:30 IST`,
      ],
      workerNote: dual
        ? "Dual strategy · one candle fetch per symbol"
        : "Starting server worker…",
    };

    await saveSession(doc);
    ensureSessionLoop(id, 60_000);

    return NextResponse.json({
      sessionId: id,
      status: "running",
      endsAt,
      note: "Paper session is running on the server. You can close the browser or log out; reopen Paper trading while signed in to view progress. Stop explicitly to cancel.",
    });
  } catch (e) {
    return NextResponse.json(
      { error: safeErrorMessage(e) || "Start failed" },
      { status: 500 }
    );
  }
}
