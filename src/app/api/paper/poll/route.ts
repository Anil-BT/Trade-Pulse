/**
 * Paper trading poll: pull latest Upstox history for F&O underlyings and
 * re-run strategy as-of now. No order API — only simulated fills.
 */
import { NextRequest, NextResponse } from "next/server";
import { listFnoEquitySymbols } from "@/lib/data/fno-meta";
import { runBacktestJob } from "@/lib/run-job";
import { safeErrorMessage, sanitizeToken } from "@/lib/http";
import {
  addIstDays,
  isNseSessionOpen,
  sessionStatus,
  todayIst,
} from "@/lib/paper/market-hours";
import type {
  BacktestRequest,
  OpenPosition,
  ScanReport,
  ScanRow,
  ScanTradeDetail,
  StrategyConfig,
  TradeInstrument,
} from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      interval = "5m",
      strategy,
      initialCapital = 100000,
      positionSizePct = 100,
      oneTradePerDay = true,
      entryTimeWindows,
      maxRiskPerTrade,
      tradeInstrument = "options_atm",
      options,
      upstoxAccessToken,
      maxSymbols = 30,
      scanAll = false,
      concurrency = 2,
    } = body as {
      interval?: BacktestRequest["interval"];
      strategy: StrategyConfig;
      initialCapital?: number;
      positionSizePct?: number;
      oneTradePerDay?: boolean;
      entryTimeWindows?: BacktestRequest["entryTimeWindows"];
      maxRiskPerTrade?: BacktestRequest["maxRiskPerTrade"];
      tradeInstrument?: TradeInstrument;
      options?: BacktestRequest["options"];
      upstoxAccessToken?: string;
      maxSymbols?: number;
      scanAll?: boolean;
      concurrency?: number;
    };

    if (!strategy?.entry?.length || !strategy?.exit?.length) {
      return NextResponse.json(
        { error: "Strategy entry and exit conditions required" },
        { status: 400 }
      );
    }

    const token = sanitizeToken(
      upstoxAccessToken || process.env.UPSTOX_ACCESS_TOKEN || ""
    );
    if (!token) {
      return NextResponse.json(
        {
          error:
            "Upstox access token required for live paper trading (paste token or set UPSTOX_ACCESS_TOKEN).",
        },
        { status: 400 }
      );
    }

    const today = todayIst();
    const fromWarm = addIstDays(today, -12);
    const status = sessionStatus();

    let universe = await listFnoEquitySymbols();
    const list = scanAll
      ? universe
      : universe.slice(0, Math.min(Math.max(5, Number(maxSymbols) || 30), 80));

    const conc = Math.min(Math.max(1, Number(concurrency) || 2), 4);
    const rows: ScanRow[] = [];
    const openPositions: OpenPosition[] = [];
    let idx = 0;

    async function worker() {
      while (idx < list.length) {
        const i = idx++;
        const item = list[i];
        const sym = item.symbol;
        try {
          const result = await runBacktestJob({
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
            options,
            upstoxAccessToken: token,
            leaveOpenPositions: true,
          });

          // Warmup lookback is inside fetch; entryNotBefore is from `from` (today)
          const tradeList: ScanTradeDetail[] = (result.trades || []).map(
            (t) => ({
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
            })
          );

          if (result.openPosition) {
            openPositions.push({
              ...result.openPosition,
              symbol: result.symbol || sym,
              label:
                result.openPosition.label ||
                result.symbol ||
                sym,
            });
          }

          const totalPnl = tradeList.reduce((s, t) => s + t.pnl, 0);
          const winners = tradeList.filter((t) => t.pnl > 0).length;

          if (tradeList.length > 0) {
            rows.push({
              symbol: result.symbol || sym,
              lotSize: result.optionsMeta?.lotSize ?? item.lotSize,
              trades: tradeList.length,
              winRate: (winners / tradeList.length) * 100,
              totalPnl,
              totalPnlPct:
                initialCapital > 0 ? (totalPnl / initialCapital) * 100 : 0,
              finalEquity: initialCapital + totalPnl,
              equitySignals: result.diagnostics?.equitySignals,
              status: "ok",
              message: result.openPosition
                ? `${tradeList.length} closed · 1 open`
                : `${tradeList.length} paper trade(s)`,
              tradeList,
            });
          } else if (result.openPosition) {
            rows.push({
              symbol: result.symbol || sym,
              lotSize: result.optionsMeta?.lotSize ?? item.lotSize,
              trades: 0,
              winRate: 0,
              totalPnl: 0,
              totalPnlPct: 0,
              finalEquity: initialCapital,
              equitySignals: result.diagnostics?.equitySignals,
              status: "ok",
              message: "Open paper position (no exit yet)",
              tradeList: [],
            });
          } else {
            rows.push({
              symbol: result.symbol || sym,
              lotSize: result.optionsMeta?.lotSize ?? item.lotSize,
              trades: 0,
              winRate: 0,
              totalPnl: 0,
              totalPnlPct: 0,
              finalEquity: initialCapital,
              equitySignals: result.diagnostics?.equitySignals ?? 0,
              status: "no_trades",
              message: "No paper signal yet today",
              tradeList: [],
            });
          }
        } catch (e) {
          const errMsg = safeErrorMessage(e);
          rows.push({
            symbol: sym,
            lotSize: item.lotSize,
            trades: 0,
            winRate: 0,
            totalPnl: 0,
            totalPnlPct: 0,
            finalEquity: initialCapital,
            error: errMsg,
            status: "error",
            message: errMsg,
            tradeList: [],
          });
        }
        await sleep(150);
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(conc, Math.max(list.length, 1)) }, () =>
        worker()
      )
    );

    rows.sort((a, b) => {
      const order = { ok: 0, no_trades: 1, error: 2 };
      if (order[a.status] !== order[b.status]) {
        return order[a.status] - order[b.status];
      }
      return b.totalPnl - a.totalPnl;
    });

    const withTrades = rows.filter((r) => r.trades > 0 || r.status === "ok");
    const closedRows = rows.filter((r) => r.trades > 0);
    const totalPnl =
      closedRows.reduce((s, r) => s + r.totalPnl, 0) +
      openPositions.reduce((s, p) => s + p.unrealizedPnl, 0);
    const totalTrades = rows.reduce((s, r) => s + r.trades, 0);

    const report: ScanReport = {
      generatedAt: new Date().toISOString(),
      strategyName: strategy.name || "Paper strategy",
      from: today,
      to: today,
      interval: interval || "5m",
      source: "upstox",
      tradeInstrument: tradeInstrument || "equity",
      oneTradePerDay: Boolean(oneTradePerDay),
      universeSize: universe.length,
      scanned: rows.length,
      summary: {
        ok: rows.filter((r) => r.status === "ok").length,
        errors: rows.filter((r) => r.status === "error").length,
        withTrades: closedRows.length,
        totalTrades,
        totalPnl,
        avgPnl: closedRows.length ? totalPnl / closedRows.length : 0,
        winners: closedRows.filter((r) => r.totalPnl > 0).length,
        losers: closedRows.filter((r) => r.totalPnl <= 0).length,
      },
      rows,
    };

    return NextResponse.json({
      report,
      openPositions,
      market: {
        ...status,
        sessionOpen: isNseSessionOpen(),
        pollHintMs: 60_000,
        symbolsWatched: list.length,
        warmupFrom: fromWarm,
      },
      note:
        "Paper only — no real orders. Strategy runs on live Upstox candles for today; open legs stay open until exit conditions fire.",
    });
  } catch (err) {
    return NextResponse.json(
      { error: safeErrorMessage(err) || "Paper poll failed" },
      { status: 500 }
    );
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
