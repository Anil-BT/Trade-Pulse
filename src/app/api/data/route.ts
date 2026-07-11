import { NextRequest, NextResponse } from "next/server";
import { fetchYahooCandles } from "@/lib/data/yahoo";
import { fetchUpstoxCandles } from "@/lib/data/upstox";
import { resolveUpstoxInstrumentKey } from "@/lib/data/upstox-instruments";
import { generateSampleCandles } from "@/lib/data/sample";
import { ema } from "@/lib/indicators";
import type { Candle, DataSource, Interval } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/data?symbol=RELIANCE&interval=5m&from=...&to=...&source=upstox
 * For Upstox, symbol is resolved to instrument_key automatically.
 */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    let symbol = (sp.get("symbol") || "").trim().toUpperCase() || "SAMPLE";
    const interval = (sp.get("interval") || "5m") as Interval;
    const from = sp.get("from") || "";
    const to = sp.get("to") || "";
    const source = (sp.get("source") || "yahoo") as DataSource;
    const token = sp.get("token") || process.env.UPSTOX_ACCESS_TOKEN || "";
    const emaPeriod = Math.max(1, Number(sp.get("emaPeriod") || 9) || 9);

    if (!from || !to) {
      return NextResponse.json({ error: "from and to required" }, { status: 400 });
    }

    let candles: Candle[];
    let instrumentKey: string | undefined;

    if (source === "upstox") {
      const resolved = await resolveUpstoxInstrumentKey(symbol);
      instrumentKey = resolved.instrumentKey;
      symbol = resolved.tradingSymbol;
      candles = await fetchUpstoxCandles({
        instrumentKey: resolved.instrumentKey,
        interval,
        from,
        to,
        accessToken: token,
      });
    } else if (source === "sample") {
      candles = generateSampleCandles(symbol, interval, from, to);
    } else {
      candles = await fetchYahooCandles(symbol, interval, from, to);
    }

    if (!candles.length) {
      return NextResponse.json(
        {
          error: `No candles for ${symbol} ${from} → ${to}. Try a trading day or wider range.`,
        },
        { status: 400 }
      );
    }

    const maxBars = 2500;
    const series = downsample(candles, maxBars);
    const closes = series.map((c) => c.close);
    const emaSeries = ema(closes, emaPeriod);

    return NextResponse.json({
      symbol,
      instrumentKey,
      interval,
      source,
      from,
      to,
      count: series.length,
      totalAvailable: candles.length,
      emaPeriod,
      candles: series,
      ema: emaSeries,
      last: series[series.length - 1],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Fetch failed";
    return NextResponse.json({ error: message }, { status: 500 });
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
