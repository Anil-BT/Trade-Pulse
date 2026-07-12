import { NextRequest, NextResponse } from "next/server";
import { fetchUpstoxCandles } from "@/lib/data/upstox";
import { resolveUpstoxInstrumentKey } from "@/lib/data/upstox-instruments";
import { fetchDhanCandles } from "@/lib/data/dhan";
import { fetchKiteCandles } from "@/lib/data/kite";
import { ema } from "@/lib/indicators";
import type { Candle, DataSource, Interval } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/data?symbol=RELIANCE&interval=5m&from=...&to=...&source=upstox
 */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    let symbol = (sp.get("symbol") || "").trim().toUpperCase();
    const interval = (sp.get("interval") || "5m") as Interval;
    const from = sp.get("from") || "";
    const to = sp.get("to") || "";
    const source = (sp.get("source") || "upstox") as DataSource;
    const emaPeriod = Math.max(1, Number(sp.get("emaPeriod") || 9) || 9);

    if (!from || !to) {
      return NextResponse.json({ error: "from and to required" }, { status: 400 });
    }
    if (!symbol) {
      return NextResponse.json({ error: "symbol required" }, { status: 400 });
    }

    let candles: Candle[];
    let instrumentKey: string | undefined;

    if (source === "upstox") {
      const token =
        sp.get("token") || process.env.UPSTOX_ACCESS_TOKEN || "";
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
    } else if (source === "dhan") {
      candles = await fetchDhanCandles({
        symbol,
        interval,
        from,
        to,
        accessToken:
          sp.get("token") || process.env.DHAN_ACCESS_TOKEN || "",
        clientId: sp.get("clientId") || process.env.DHAN_CLIENT_ID || undefined,
      });
    } else if (source === "kite") {
      candles = await fetchKiteCandles({
        symbol,
        interval,
        from,
        to,
        apiKey: sp.get("apiKey") || process.env.KITE_API_KEY || "",
        accessToken:
          sp.get("token") || process.env.KITE_ACCESS_TOKEN || "",
      });
    } else {
      return NextResponse.json(
        { error: "source must be upstox, dhan, or kite" },
        { status: 400 }
      );
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
