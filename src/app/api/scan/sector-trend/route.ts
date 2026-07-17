import { NextRequest, NextResponse } from "next/server";
import { safeErrorMessage } from "@/lib/http";
import { runSectorTrendScan } from "@/lib/sector-trend-scan";
import type { StrategyConfig, TradeInstrument } from "@/lib/types";
import type { SectorTrendMode, SectorWeightMode } from "@/lib/sector-trend";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/scan/sector-trend
 *
 * Configurable morning sector ranking + auto bull/bear from top-sector bias.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      from,
      to,
      interval = "5m",
      source = "upstox",
      mode = "auto",
      windowStart = "09:15",
      windowEnd = "09:45",
      topSectors = 2,
      topStocksPerSector = 3,
      biasThreshold = 0,
      weightMode = "turnover",
      minStocks = 2,
      minBreadthPct = 0,
      entryEnd = "15:15",
      bullStrategy,
      bearStrategy,
      strategy,
      initialCapital = 100000,
      positionSizePct = 100,
      oneTradePerDay = true,
      maxRiskPerTrade,
      tradeInstrument = "options_atm",
      options,
      upstoxAccessToken,
      dhanAccessToken,
      dhanClientId,
      kiteApiKey,
      kiteAccessToken,
      maxSymbols = 80,
      concurrency = 3,
      scanAll = false,
    } = body as {
      from: string;
      to: string;
      interval?: string;
      source?: "upstox" | "dhan" | "kite";
      mode?: SectorTrendMode;
      windowStart?: string;
      windowEnd?: string;
      topSectors?: number;
      topStocksPerSector?: number;
      biasThreshold?: number;
      weightMode?: SectorWeightMode;
      minStocks?: number;
      minBreadthPct?: number;
      entryEnd?: string;
      bullStrategy?: StrategyConfig;
      bearStrategy?: StrategyConfig;
      /** @deprecated single strategy — used as bull if bullStrategy omitted */
      strategy?: StrategyConfig;
      initialCapital?: number;
      positionSizePct?: number;
      oneTradePerDay?: boolean;
      maxRiskPerTrade?: {
        enabled: boolean;
        mode: "pct" | "amount";
        pct?: number;
        amount?: number;
      };
      tradeInstrument?: TradeInstrument;
      options?: {
        side: "CE" | "PE";
        lotSize: number;
        strikeStep: number;
        iv: number;
        daysToExpiry: number;
      };
      upstoxAccessToken?: string;
      dhanAccessToken?: string;
      dhanClientId?: string;
      kiteApiKey?: string;
      kiteAccessToken?: string;
      maxSymbols?: number;
      concurrency?: number;
      scanAll?: boolean;
    };

    if (!from || !to) {
      return NextResponse.json(
        { error: "from and to required" },
        { status: 400 }
      );
    }

    const trendMode: SectorTrendMode =
      mode === "bullish" || mode === "bearish" ? mode : "auto";

    const report = await runSectorTrendScan({
      from,
      to,
      interval: (interval === "1d" ? "5m" : interval) as "5m",
      source,
      bullStrategy: bullStrategy || strategy,
      bearStrategy,
      trend: {
        mode: trendMode,
        windowStart: String(windowStart || "09:15"),
        windowEnd: String(windowEnd || "09:45"),
        topSectors: Math.min(8, Math.max(1, Number(topSectors) || 2)),
        topStocksPerSector: Math.min(
          15,
          Math.max(1, Number(topStocksPerSector) || 3)
        ),
        biasThreshold: Number.isFinite(Number(biasThreshold))
          ? Number(biasThreshold)
          : 0,
        weightMode:
          weightMode === "equal" ? "equal" : ("turnover" as SectorWeightMode),
        minStocks: Math.min(20, Math.max(1, Number(minStocks) || 3)),
        minBreadthPct: Math.min(
          100,
          Math.max(0, Number(minBreadthPct) ?? 55)
        ),
      },
      entryEnd: String(entryEnd || "15:15"),
      initialCapital,
      positionSizePct,
      oneTradePerDay,
      maxRiskPerTrade,
      tradeInstrument,
      options,
      upstoxAccessToken,
      dhanAccessToken,
      dhanClientId,
      kiteApiKey,
      kiteAccessToken,
      maxSymbols: scanAll ? 400 : Math.min(400, Number(maxSymbols) || 80),
      concurrency,
      scanAll,
    });

    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json(
      { error: safeErrorMessage(err) || "Sector-trend scan failed" },
      { status: 500 }
    );
  }
}
