/**
 * Market Watch scan (debug / legacy).
 * Preferred path: shared session via GET /api/watch/session + worker cron.
 */
import { NextRequest, NextResponse } from "next/server";
import { safeErrorMessage } from "@/lib/http";
import { runWatchBatch } from "@/lib/watch/scan-core";
import type { Interval, StrategyConfig } from "@/lib/types";
import type { MatchScanMode } from "@/lib/watch/match";
import type { WatchDataSource } from "@/lib/watch/scan-core";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      strategies,
      interval = "5m",
      source = "yahoo",
      upstoxAccessToken,
      rotateUniverse = true,
      rotationOffset = 0,
      batchSize,
      symbols: symbolFilter,
      matchMode = "session",
    } = body as {
      strategies: StrategyConfig[];
      interval?: Interval;
      source?: WatchDataSource;
      upstoxAccessToken?: string;
      rotateUniverse?: boolean;
      rotationOffset?: number;
      batchSize?: number;
      matchMode?: MatchScanMode;
      symbols?: string[];
    };

    const result = await runWatchBatch({
      strategies,
      interval,
      source,
      upstoxAccessToken,
      rotateUniverse,
      rotationOffset,
      batchSize,
      matchMode,
      symbols: symbolFilter,
    });

    return NextResponse.json(result);
  } catch (e) {
    console.error("[watch-scan]", e);
    return NextResponse.json(
      { error: safeErrorMessage(e) || "Watch scan failed" },
      { status: 500 }
    );
  }
}
