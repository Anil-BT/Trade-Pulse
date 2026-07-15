/**
 * Market Watch scan: multi-strategy F&O filter (scanner-style).
 * For each symbol, fetch candles once and test all selected strategies
 * for entry match on the latest bar.
 */
import { NextRequest, NextResponse } from "next/server";
import { listFnoEquitySymbols } from "@/lib/data/fno-meta";
import { fetchUpstoxCandles } from "@/lib/data/upstox";
import { resolveUpstoxInstrumentKey } from "@/lib/data/upstox-instruments";
import { todayIst } from "@/lib/paper/market-hours";
import { isRateLimitError } from "@/lib/paper/sanitize";
import { safeErrorMessage, sanitizeToken } from "@/lib/http";
import { matchStrategyOnCandles, type WatchMatch } from "@/lib/watch/match";
import type { Interval, StrategyConfig } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_SYMBOLS = 80;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      strategies,
      interval = "5m",
      upstoxAccessToken,
      maxSymbols = 40,
      scanAll = false,
      symbols: symbolFilter,
    } = body as {
      strategies: StrategyConfig[];
      interval?: Interval;
      upstoxAccessToken?: string;
      maxSymbols?: number;
      scanAll?: boolean;
      symbols?: string[];
    };

    const token = sanitizeToken(
      String(upstoxAccessToken || process.env.UPSTOX_ACCESS_TOKEN || "")
    );
    if (!token) {
      return NextResponse.json(
        { error: "Upstox access token required" },
        { status: 400 }
      );
    }

    const strats = (strategies || []).filter(
      (s) => s?.name && s.entry?.length
    );
    if (!strats.length) {
      return NextResponse.json(
        { error: "Select at least one strategy with entry conditions" },
        { status: 400 }
      );
    }

    const universe = symbolFilter?.length
      ? symbolFilter.map((s) => ({ symbol: s.toUpperCase(), lotSize: 0 }))
      : await listFnoEquitySymbols();

    const cap = scanAll
      ? Math.min(universe.length, MAX_SYMBOLS)
      : Math.min(Math.max(5, maxSymbols || 40), MAX_SYMBOLS);
    const list = universe.slice(0, cap);

    const today = todayIst();
    const matches: WatchMatch[] = [];
    let scanned = 0;
    let errors = 0;
    let rateLimited = 0;

    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      try {
        const resolved = await resolveUpstoxInstrumentKey(item.symbol, "NSE");
        const symbol = resolved.tradingSymbol || item.symbol;
        const candles = await fetchUpstoxCandles({
          instrumentKey: resolved.instrumentKey,
          interval: interval as Interval,
          from: today,
          to: today,
          accessToken: token,
          lookbackDays: 12,
        });
        scanned += 1;

        if (candles.length < 5) continue;

        for (const strategy of strats) {
          const m = matchStrategyOnCandles(candles, strategy);
          if (m) {
            matches.push({
              symbol,
              strategyName: strategy.name,
              ...m,
            });
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isRateLimitError(msg)) {
          rateLimited += 1;
          await new Promise((r) => setTimeout(r, 1500));
        } else {
          errors += 1;
        }
      }
      if (i % 5 === 4) await new Promise((r) => setTimeout(r, 120));
    }

    // Sort: strategy name, then symbol
    matches.sort((a, b) => {
      const c = a.strategyName.localeCompare(b.strategyName);
      if (c !== 0) return c;
      return a.symbol.localeCompare(b.symbol);
    });

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      today,
      interval,
      strategies: strats.map((s) => s.name),
      universeSize: universe.length,
      scanned,
      matchCount: matches.length,
      rateLimited,
      errors,
      matches,
      note:
        scanned < list.length
          ? "Partial scan (errors or rate limits). Refresh to continue."
          : scanAll && universe.length > MAX_SYMBOLS
            ? `Showing first ${MAX_SYMBOLS} of ${universe.length} F&O names this pass.`
            : undefined,
    });
  } catch (e) {
    console.error("[watch-scan]", e);
    return NextResponse.json(
      { error: safeErrorMessage(e) || "Watch scan failed" },
      { status: 500 }
    );
  }
}
