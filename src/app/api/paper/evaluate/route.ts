/**
 * Evaluate strategy on client-maintained live candles (paper fills only).
 */
import { NextRequest, NextResponse } from "next/server";
import { runBacktest } from "@/lib/backtest";
import { resolveFnoMeta } from "@/lib/data/fno-meta";
import { safeErrorMessage } from "@/lib/http";
import { dayBoundsUnix } from "@/lib/data/dates";
import { todayIst } from "@/lib/paper/market-hours";
import type {
  BacktestRequest,
  Candle,
  OpenPosition,
  ScanReport,
  ScanRow,
  ScanTradeDetail,
  StrategyConfig,
  TradeInstrument,
} from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      series,
      interval = "5m",
      strategy,
      initialCapital = 100000,
      positionSizePct = 100,
      oneTradePerDay = true,
      entryTimeWindows,
      maxRiskPerTrade,
      tradeInstrument = "options_atm",
      options,
    } = body as {
      series: { symbol: string; candles: Candle[]; lotSize?: number }[];
      interval?: BacktestRequest["interval"];
      strategy: StrategyConfig;
      initialCapital?: number;
      positionSizePct?: number;
      oneTradePerDay?: boolean;
      entryTimeWindows?: BacktestRequest["entryTimeWindows"];
      maxRiskPerTrade?: BacktestRequest["maxRiskPerTrade"];
      tradeInstrument?: TradeInstrument;
      options?: BacktestRequest["options"];
    };

    if (!strategy?.entry?.length || !strategy?.exit?.length) {
      return NextResponse.json(
        { error: "Strategy entry/exit required" },
        { status: 400 }
      );
    }
    if (!series?.length) {
      return NextResponse.json({ error: "series required" }, { status: 400 });
    }

    const today = todayIst();
    const { startMs: entryNotBeforeMs } = dayBoundsUnix(today, today);

    const rows: ScanRow[] = [];
    const openPositions: OpenPosition[] = [];

    for (const item of series.slice(0, 200)) {
      const sym = item.symbol;
      const candles = item.candles || [];
      if (candles.length < 5) {
        rows.push({
          symbol: sym,
          lotSize: item.lotSize,
          trades: 0,
          winRate: 0,
          totalPnl: 0,
          totalPnlPct: 0,
          finalEquity: initialCapital,
          status: "no_trades",
          message: "Waiting for bars…",
          tradeList: [],
        });
        continue;
      }

      try {
        let opt = options;
        if (tradeInstrument === "options_atm") {
          const meta = await resolveFnoMeta(sym);
          opt = {
            side: options?.side || "CE",
            lotSize: options?.lotSize || meta.lotSize || 0,
            strikeStep: options?.strikeStep || meta.strikeStep || 0,
            iv: options?.iv ?? 0.18,
            daysToExpiry: options?.daysToExpiry ?? 7,
          };
        }

        // Live paper uses equity-signal + model option fills (no per-tick option chain fetch)
        const result = runBacktest(candles, {
          symbol: sym,
          interval: interval as BacktestRequest["interval"],
          from: today,
          to: today,
          source: "upstox",
          strategy,
          initialCapital,
          positionSizePct,
          oneTradePerDay,
          entryTimeWindows,
          maxRiskPerTrade,
          tradeInstrument,
          options: opt,
          entryNotBeforeMs,
          leaveOpenPositions: true,
        });

        const tradeList: ScanTradeDetail[] = (result.trades || []).map((t) => ({
          entryTime: t.entryTime,
          exitTime: t.exitTime,
          entryPrice: t.entryPrice,
          exitPrice: t.exitPrice,
          capitalUsed: t.capitalUsed ?? t.entryPrice * t.qty,
          underlyingEntry: t.underlyingEntry,
          underlyingExit: t.underlyingExit,
          strike: t.strike,
          optionSide: t.optionSide,
          lots: t.lots,
          lotSize: t.lotSize,
          label: t.label,
          pnl: t.pnl,
          pnlPct: t.pnlPct,
          barsHeld: t.barsHeld,
        }));

        if (result.openPosition) {
          openPositions.push({
            ...result.openPosition,
            symbol: sym,
          });
        }

        const totalPnl = tradeList.reduce((s, t) => s + t.pnl, 0);
        const winners = tradeList.filter((t) => t.pnl > 0).length;

        if (tradeList.length || result.openPosition) {
          rows.push({
            symbol: sym,
            lotSize: result.optionsMeta?.lotSize ?? item.lotSize,
            trades: tradeList.length,
            winRate: tradeList.length
              ? (winners / tradeList.length) * 100
              : 0,
            totalPnl,
            totalPnlPct:
              initialCapital > 0 ? (totalPnl / initialCapital) * 100 : 0,
            finalEquity: initialCapital + totalPnl,
            status: "ok",
            message: result.openPosition
              ? `${tradeList.length} closed · open`
              : `${tradeList.length} paper trade(s)`,
            tradeList,
          });
        } else {
          rows.push({
            symbol: sym,
            lotSize: item.lotSize,
            trades: 0,
            winRate: 0,
            totalPnl: 0,
            totalPnlPct: 0,
            finalEquity: initialCapital,
            status: "no_trades",
            message: "No paper signal yet",
            tradeList: [],
          });
        }
      } catch (e) {
        rows.push({
          symbol: sym,
          lotSize: item.lotSize,
          trades: 0,
          winRate: 0,
          totalPnl: 0,
          totalPnlPct: 0,
          finalEquity: initialCapital,
          status: "error",
          error: safeErrorMessage(e),
          message: safeErrorMessage(e),
          tradeList: [],
        });
      }
    }

    rows.sort((a, b) => b.totalPnl - a.totalPnl);
    const closed = rows.filter((r) => r.trades > 0);
    const totalPnl =
      closed.reduce((s, r) => s + r.totalPnl, 0) +
      openPositions.reduce((s, p) => s + p.unrealizedPnl, 0);

    const report: ScanReport = {
      generatedAt: new Date().toISOString(),
      strategyName: strategy.name || "Paper strategy",
      from: today,
      to: today,
      interval: interval || "5m",
      source: "upstox",
      tradeInstrument: tradeInstrument || "equity",
      oneTradePerDay: Boolean(oneTradePerDay),
      universeSize: series.length,
      scanned: rows.length,
      summary: {
        ok: rows.filter((r) => r.status === "ok").length,
        errors: rows.filter((r) => r.status === "error").length,
        withTrades: closed.length,
        totalTrades: rows.reduce((s, r) => s + r.trades, 0),
        totalPnl,
        avgPnl: closed.length ? totalPnl / closed.length : 0,
        winners: closed.filter((r) => r.totalPnl > 0).length,
        losers: closed.filter((r) => r.totalPnl <= 0).length,
      },
      rows,
    };

    return NextResponse.json({
      report,
      openPositions,
      feed: "upstox_market_data_feed_v3",
    });
  } catch (err) {
    return NextResponse.json(
      { error: safeErrorMessage(err) || "Evaluate failed" },
      { status: 500 }
    );
  }
}
