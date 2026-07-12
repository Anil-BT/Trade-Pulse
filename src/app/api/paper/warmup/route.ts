/**
 * Warmup historical candles for paper trading (indicators need history).
 * Live ticks then update the latest bar via Market Data Feed.
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchUpstoxCandles } from "@/lib/data/upstox";
import { resolveUpstoxInstrumentKey } from "@/lib/data/upstox-instruments";
import { safeErrorMessage, sanitizeToken } from "@/lib/http";
import { todayIst, addIstDays } from "@/lib/paper/market-hours";
import type { Candle, Interval } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      symbols,
      interval = "5m",
      upstoxAccessToken,
    } = body as {
      symbols: string[];
      interval?: Interval;
      upstoxAccessToken?: string;
    };

    const token = sanitizeToken(
      upstoxAccessToken || process.env.UPSTOX_ACCESS_TOKEN || ""
    );
    if (!token) {
      return NextResponse.json({ error: "Upstox token required" }, { status: 400 });
    }
    if (!symbols?.length) {
      return NextResponse.json({ error: "symbols required" }, { status: 400 });
    }

    const today = todayIst();
    const from = addIstDays(today, -10);
    // Cap warmup size for rate limits
    const list = symbols.slice(0, 120);
    const candlesBySymbol: Record<string, Candle[]> = {};
    const errors: string[] = [];

    for (let i = 0; i < list.length; i++) {
      const sym = list[i];
      try {
        const resolved = await resolveUpstoxInstrumentKey(sym, "NSE");
        const candles = await fetchUpstoxCandles({
          instrumentKey: resolved.instrumentKey,
          interval: (interval || "5m") as Interval,
          from,
          to: today,
          accessToken: token,
          lookbackDays: 2,
        });
        candlesBySymbol[resolved.tradingSymbol || sym] = candles;
      } catch (e) {
        errors.push(
          `${sym}: ${e instanceof Error ? e.message.slice(0, 50) : "fail"}`
        );
      }
      if (i % 5 === 4) await new Promise((r) => setTimeout(r, 200));
    }

    return NextResponse.json({
      today,
      from,
      interval,
      candlesBySymbol,
      warmed: Object.keys(candlesBySymbol).length,
      errors: errors.slice(0, 30),
    });
  } catch (err) {
    return NextResponse.json(
      { error: safeErrorMessage(err) || "Warmup failed" },
      { status: 500 }
    );
  }
}
