import { NextRequest, NextResponse } from "next/server";
import { verifyUserIdToken } from "@/lib/firebase/admin";
import { safeErrorMessage, sanitizeToken } from "@/lib/http";
import { todayIst } from "@/lib/paper/market-hours";
import { asciiSafe, cleanForStorage, cleanIdToken } from "@/lib/paper/sanitize";
import {
  getActiveSession,
  markSessionStopped,
  saveSession,
} from "@/lib/paper/session-store";
import { ensureSessionLoop } from "@/lib/paper/session-worker";
import type { PaperSessionConfig, PaperSessionDoc } from "@/lib/paper/session-types";
import { uid } from "@/lib/format";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function sessionEndsAtMs(): number {
  const today = todayIst();
  const [y, m, d] = today.split("-").map(Number);
  if (!y || !m || !d) return Date.now() + 6 * 3600_000;
  // 15:30 IST = 10:00 UTC
  return Date.UTC(y, m - 1, d, 10, 0, 0, 0);
}

function normalizeWindows(
  windows: PaperSessionConfig["entryTimeWindows"]
): PaperSessionConfig["entryTimeWindows"] {
  if (!windows?.length) return undefined;
  return windows
    .map((w) => ({
      enabled: Boolean(w?.enabled),
      start: asciiSafe(w?.start || "09:15", 8) || "09:15",
      end: asciiSafe(w?.end || "15:30", 8) || "15:30",
    }))
    .filter((w) => w.start && w.end);
}

export async function POST(req: NextRequest) {
  try {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // Firebase JWT — do not run through aggressive token sanitizer
    const rawAuth = req.headers.get("authorization") || "";
    const idToken = cleanIdToken(
      rawAuth.replace(/^Bearer\s+/i, "") ||
        String(body.idToken || "")
    );
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
      String(body.upstoxAccessToken || process.env.UPSTOX_ACCESS_TOKEN || "")
    );
    if (!token) {
      return NextResponse.json(
        {
          error:
            "Upstox access token required. Paste the same token that works in Backtest.",
        },
        { status: 400 }
      );
    }

    let config: PaperSessionConfig;
    try {
      // Do not ascii-strip strategy strings (indicator names are already ASCII)
      config = cleanForStorage(body.config as PaperSessionConfig, false);
    } catch (e) {
      return NextResponse.json(
        {
          error:
            e instanceof Error
              ? e.message
              : "Strategy config could not be serialized.",
        },
        { status: 400 }
      );
    }

    if (!config?.strategy?.entry?.length || !config?.strategy?.exit?.length) {
      return NextResponse.json(
        { error: "Strategy 1 entry and exit required" },
        { status: 400 }
      );
    }
    if (config.strategy2) {
      if (!config.strategy2.entry?.length || !config.strategy2.exit?.length) {
        return NextResponse.json(
          {
            error:
              "Strategy 2 needs entry and exit conditions (or disable dual strategy).",
          },
          { status: 400 }
        );
      }
    }

    // Stop previous running session WITHOUT re-serializing huge reports
    try {
      const prev = await getActiveSession(user.uid);
      if (prev?.id) {
        await markSessionStopped(
          user.uid,
          prev.id,
          "Superseded by new session"
        );
      }
    } catch (e) {
      console.error("[paper-start] stop previous:", e);
    }

    const id = `${uid()}${uid()}`;
    const now = Date.now();
    const endsAt = Math.max(sessionEndsAtMs(), now + 60_000);
    const dual = Boolean(config.strategy2?.entry?.length);
    const s1 = asciiSafe(config.strategy.name || "Strategy 1", 80);
    const s2 = asciiSafe(config.strategy2?.name || "Strategy 2", 80);

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
        initialCapital: Number(config.initialCapital) || 100000,
        positionSizePct: Number(config.positionSizePct) || 100,
        oneTradePerDay: Boolean(config.oneTradePerDay),
        entryTimeWindows: normalizeWindows(config.entryTimeWindows),
        maxRiskPerTrade: config.maxRiskPerTrade?.enabled
          ? {
              enabled: true,
              mode: config.maxRiskPerTrade.mode === "amount" ? "amount" : "pct",
              pct:
                config.maxRiskPerTrade.mode === "pct"
                  ? Number(config.maxRiskPerTrade.pct) || 2
                  : undefined,
              amount:
                config.maxRiskPerTrade.mode === "amount"
                  ? Number(config.maxRiskPerTrade.amount) || 5000
                  : undefined,
            }
          : undefined,
        tradeInstrument: config.tradeInstrument || "options_atm",
        options: config.options,
        maxSymbols: Number(config.maxSymbols) || 30,
        scanAll: Boolean(config.scanAll),
      },
      sessionDay: todayIst(),
      startedAt: now,
      updatedAt: now,
      endsAt,
      tickCount: 0,
      rotationOffset: 0,
      report: null,
      openPositions: [],
      strategyResults: [],
      eventLog: [
        asciiSafe(
          `${new Date().toLocaleTimeString("en-IN")} · Session started · ${
            dual
              ? `2 strategies (shared candles: "${s1}" + "${s2}")`
              : `1 strategy ("${s1}")`
          } · until stop or 15:30 IST`,
          400
        ),
      ],
      workerNote: dual
        ? "Dual strategy - one candle fetch per symbol"
        : "Starting server worker...",
    };

    await saveSession(doc);

    // Defer first worker tick so HTTP response is not blocked / oversized
    setTimeout(() => {
      try {
        ensureSessionLoop(id, 60_000);
      } catch (e) {
        console.error("[paper-start] ensureSessionLoop:", e);
      }
    }, 500);

    return NextResponse.json({
      sessionId: id,
      status: "running",
      endsAt,
      note: "Paper session is running on the server. Close browser or log out — reopen Paper trading while signed in to view progress.",
    });
  } catch (e) {
    console.error("[paper-start]", e);
    const msg = safeErrorMessage(e) || "Start failed";
    const friendly = /bytestring|character at index|invalid string/i.test(msg)
      ? `Paper start failed (invalid string/token). Re-paste Upstox token as plain ASCII, sign out/in, and retry. Detail: ${msg}`
      : msg;
    return NextResponse.json({ error: friendly }, { status: 500 });
  }
}
