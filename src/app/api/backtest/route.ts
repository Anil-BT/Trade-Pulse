import { NextRequest, NextResponse } from "next/server";
import { runBacktestJob } from "@/lib/run-job";
import { safeErrorMessage } from "@/lib/http";
import type { BacktestRequest } from "@/lib/types";

export const dynamic = "force-dynamic";
/** Allow longer F&O / options runs on Vercel (capped by plan). */
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as BacktestRequest;
    const result = await runBacktestJob(body);

    const payload = {
      ...result,
      candles: downsample(result.candles, 2000),
      equityCurve: downsample(result.equityCurve, 1500),
    };

    return NextResponse.json(payload);
  } catch (err) {
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
