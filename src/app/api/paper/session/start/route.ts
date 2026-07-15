import { NextRequest, NextResponse } from "next/server";
import { verifyUserIdToken } from "@/lib/firebase/admin";
import { safeErrorMessage, sanitizeToken } from "@/lib/http";
import { todayIst } from "@/lib/paper/market-hours";
import { asciiSafe, cleanForStorage, cleanIdToken } from "@/lib/paper/sanitize";
import {
  durableStoreHint,
  getActiveSession,
  isDurableStoreReady,
  markSessionStopped,
  saveSession,
  toPublicSession,
} from "@/lib/paper/session-store";
import type {
  PaperSessionConfig,
  PaperSessionDoc,
} from "@/lib/paper/session-types";
import { uid } from "@/lib/format";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
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

function jsonError(message: string, status = 500) {
  return NextResponse.json(
    { error: String(message || "Start failed").slice(0, 600) },
    { status }
  );
}

export async function POST(req: NextRequest) {
  try {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    // On Vercel, in-memory sessions vanish between requests — require Firestore
    const requireDurable =
      Boolean(process.env.VERCEL) || body.requireDurable !== false;
    if (requireDurable && !(await isDurableStoreReady())) {
      return jsonError(
        `Paper trading needs durable storage on this host. ${durableStoreHint()} ` +
          "Add FIREBASE_SERVICE_ACCOUNT_JSON in Vercel → Settings → Environment Variables, then redeploy.",
        503
      );
    }

    // Firebase JWT — do not run through aggressive token sanitizer
    const rawAuth = req.headers.get("authorization") || "";
    const idToken = cleanIdToken(
      rawAuth.replace(/^Bearer\s+/i, "") || String(body.idToken || "")
    );
    let user: { uid: string; email?: string } | null = null;
    try {
      user = await verifyUserIdToken(idToken);
    } catch (e) {
      console.error("[paper-start] verifyUserIdToken:", e);
      return jsonError(
        "Auth verification failed. Check Firebase config / re-sign in.",
        401
      );
    }
    if (!user?.uid) {
      return jsonError(
        "Sign in required to start a durable paper session (survives browser close).",
        401
      );
    }

    const token = sanitizeToken(
      String(body.upstoxAccessToken || process.env.UPSTOX_ACCESS_TOKEN || "")
    );
    if (!token) {
      return jsonError(
        "Upstox access token required. Paste the same token that works in Backtest.",
        400
      );
    }

    let config: PaperSessionConfig;
    try {
      config = cleanForStorage(body.config as PaperSessionConfig, false);
    } catch (e) {
      return jsonError(
        e instanceof Error
          ? e.message
          : "Strategy config could not be serialized.",
        400
      );
    }

    if (!config?.strategy?.entry?.length || !config?.strategy?.exit?.length) {
      return jsonError("Strategy 1 entry and exit required", 400);
    }
    if (config.strategy2) {
      if (!config.strategy2.entry?.length) {
        return jsonError(
          "Strategy 2 needs entry conditions (or disable dual strategy).",
          400
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
        asciiSafe(
          `${new Date().toLocaleTimeString("en-IN")} · First tick scheduled (dual options can take 1–3 min) · more lines appear when the tick saves`,
          400
        ),
      ],
      workerNote: dual
        ? "Dual strategy — first tick starting (shared candles)"
        : "Starting server worker…",
    };

    const saved = await saveSession(doc);
    if (requireDurable && !saved.durable) {
      return jsonError(
        `Could not save paper session to Firestore. ${saved.error || durableStoreHint()} ` +
          "Without this, status will stay empty on Vercel.",
        503
      );
    }
    if (!saved.ok) {
      return jsonError(saved.error || "Failed to save session", 500);
    }

    // Do NOT run processPaperSession in after() — it races the browser tick
    // and soft-locks without always writing a visible log. Client calls
    // /api/paper/session/tick immediately after start.

    return NextResponse.json({
      sessionId: id,
      status: "running",
      endsAt,
      durable: saved.durable,
      session: toPublicSession(doc),
      kickTick: true,
      note: saved.durable
        ? "Paper session saved. Keep the Paper tab open — browser runs ticks and writes server log lines."
        : "Session is memory-only (not durable across instances).",
    });
  } catch (e) {
    console.error("[paper-start]", e);
    try {
      const msg = safeErrorMessage(e) || "Start failed";
      const friendly = /bytestring|character at index|invalid string/i.test(msg)
        ? `Paper start failed (invalid string/token). Re-paste Upstox token as plain ASCII, sign out/in, and retry. Detail: ${msg}`
        : msg;
      return jsonError(friendly, 500);
    } catch {
      return jsonError("Start failed (unhandled server error)", 500);
    }
  }
}
