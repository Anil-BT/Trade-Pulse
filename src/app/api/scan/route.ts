import { NextRequest, NextResponse } from "next/server";
import { listFnoEquitySymbols } from "@/lib/data/fno-meta";
import { runBacktestJob } from "@/lib/run-job";
import { safeErrorMessage } from "@/lib/http";
import type {
  BacktestRequest,
  ScanReport,
  ScanRow,
  ScanTradeDetail,
  StrategyConfig,
  TradeInstrument,
} from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/scan
 * Run the same strategy across equity F&O underlyings.
 * Each stock includes tradeList (entry/exit time & price) or no_trades / error.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      from,
      to,
      interval = "5m",
      source = "upstox",
      strategy,
      initialCapital = 100000,
      positionSizePct = 100,
      oneTradePerDay = true,
      entryTimeWindows,
      maxRiskPerTrade,
      tradeInstrument = "options_atm",
      options,
      upstoxAccessToken,
      dhanAccessToken,
      dhanClientId,
      kiteApiKey,
      kiteAccessToken,
      maxSymbols = 200,
      concurrency = 3,
      scanAll = false,
      symbols,
    } = body as {
      from: string;
      to: string;
      interval?: string;
      source?: BacktestRequest["source"];
      strategy: StrategyConfig;
      initialCapital?: number;
      positionSizePct?: number;
      oneTradePerDay?: boolean;
      entryTimeWindows?: BacktestRequest["entryTimeWindows"];
      maxRiskPerTrade?: BacktestRequest["maxRiskPerTrade"];
      tradeInstrument?: TradeInstrument;
      options?: BacktestRequest["options"];
      upstoxAccessToken?: string;
      dhanAccessToken?: string;
      dhanClientId?: string;
      kiteApiKey?: string;
      kiteAccessToken?: string;
      maxSymbols?: number;
      concurrency?: number;
      /** When true, ignore maxSymbols and scan full equity F&O list */
      scanAll?: boolean;
      symbols?: string[];
    };

    if (!from || !to) {
      return NextResponse.json({ error: "from and to required" }, { status: 400 });
    }
    if (!strategy?.entry?.length || !strategy?.exit?.length) {
      return NextResponse.json(
        { error: "Strategy entry and exit conditions required" },
        { status: 400 }
      );
    }

    let universe: { symbol: string; lotSize: number; strikeStep: number }[];
    if (symbols?.length) {
      universe = symbols.map((s) => ({
        symbol: s.toUpperCase().replace(/\.NS$/i, ""),
        lotSize: 0,
        strikeStep: 0,
      }));
    } else {
      universe = await listFnoEquitySymbols();
    }

    const list = scanAll
      ? universe
      : universe.slice(0, Math.min(Math.max(1, Number(maxSymbols) || 200), 400));
    const conc = Math.min(Math.max(1, Number(concurrency) || 3), 8);

    const rows: ScanRow[] = [];
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
            from,
            to,
            source: source || "upstox",
            strategy,
            initialCapital,
            positionSizePct,
            oneTradePerDay,
            entryTimeWindows,
            maxRiskPerTrade,
            tradeInstrument,
            options,
            upstoxAccessToken,
            dhanAccessToken,
            dhanClientId,
            kiteApiKey,
            kiteAccessToken,
          });

          const m = result.metrics;
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

          if (m.totalTrades > 0) {
            rows.push({
              symbol: result.symbol || sym,
              lotSize: result.optionsMeta?.lotSize ?? item.lotSize,
              trades: m.totalTrades,
              winRate: m.winRate,
              totalPnl: m.totalPnl,
              totalPnlPct: m.totalPnlPct,
              finalEquity: m.finalEquity,
              equitySignals: result.diagnostics?.equitySignals,
              status: "ok",
              message: `${m.totalTrades} trade(s)`,
              tradeList,
            });
          } else {
            rows.push({
              symbol: result.symbol || sym,
              lotSize: result.optionsMeta?.lotSize ?? item.lotSize,
              trades: 0,
              winRate: 0,
              totalPnl: 0,
              totalPnlPct: 0,
              finalEquity: m.finalEquity,
              equitySignals: result.diagnostics?.equitySignals ?? 0,
              status: "no_trades",
              message:
                result.diagnostics?.note ||
                "No trade - entry conditions never met on any day in range",
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
        await sleep(120);
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(conc, list.length) }, () => worker())
    );

    rows.sort((a, b) => {
      const order = { ok: 0, no_trades: 1, error: 2 };
      if (order[a.status] !== order[b.status]) {
        return order[a.status] - order[b.status];
      }
      return b.totalPnl - a.totalPnl;
    });

    const withTrades = rows.filter((r) => r.trades > 0);
    const totalPnl = withTrades.reduce((s, r) => s + r.totalPnl, 0);
    const totalTrades = rows.reduce((s, r) => s + r.trades, 0);

    const report: ScanReport = {
      generatedAt: new Date().toISOString(),
      strategyName: strategy.name || "Strategy",
      from,
      to,
      interval,
      source: source || "upstox",
      tradeInstrument: tradeInstrument || "equity",
      oneTradePerDay: Boolean(oneTradePerDay),
      universeSize: universe.length,
      scanned: rows.length,
      summary: {
        ok: rows.filter((r) => r.status === "ok").length,
        errors: rows.filter((r) => r.status === "error").length,
        withTrades: withTrades.length,
        totalTrades,
        totalPnl,
        avgPnl: withTrades.length ? totalPnl / withTrades.length : 0,
        winners: withTrades.filter((r) => r.totalPnl > 0).length,
        losers: withTrades.filter((r) => r.totalPnl <= 0).length,
      },
      rows,
    };

    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json(
      { error: safeErrorMessage(err) || "Scan failed" },
      { status: 500 }
    );
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
