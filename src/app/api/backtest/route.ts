import { NextRequest, NextResponse } from "next/server";
import { runBacktestJob } from "@/lib/run-job";
import { safeErrorMessage } from "@/lib/http";
import type { BacktestRequest } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/**
 * Hobby plan hard-caps ~60s. Longer values are clamped and still kill the
 * function → Vercel returns plain text "An error occurred with your deployment"
 * (client sees Unexpected token 'A' if it tries res.json()).
 */
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    let body: BacktestRequest;
    try {
      body = (await req.json()) as BacktestRequest;
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body for backtest request" },
        { status: 400 }
      );
    }
    const result = await runBacktestJob(body);

    // Keep payload small for Vercel response limits
    const payload = {
      ...result,
      candles: downsample(result.candles, 1500),
      equityCurve: downsample(result.equityCurve, 1000),
      // drop heavy openPosition instrument noise if huge
    };

    return NextResponse.json(payload);
  } catch (err) {
    console.error("[api/backtest]", err);
    return NextResponse.json(
      { error: safeErrorMessage(err) || "Backtest failed" },
      { status: 500 }
    );
  }
}

function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) {
    out.push(arr[Math.floor(i * step)]);
  }
  out[out.length - 1] = arr[arr.length - 1];
  return out;
}
