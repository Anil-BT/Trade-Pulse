import { NextRequest, NextResponse } from "next/server";
import { listFnoEquitySymbols } from "@/lib/data/fno-meta";
import { runBacktestJob } from "@/lib/run-job";
import { safeErrorMessage } from "@/lib/http";
import type {
  BacktestRequest,
  DualScanReport,
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
 * Run strategy(ies) across equity F&O underlyings.
 * - Single: `strategy` only → ScanReport
 * - Dual (no sector filter): `bullStrategy` + `bearStrategy` → DualScanReport
 *   One candle fetch per symbol; each side’s entry conditions run independently
 *   (bull → CE, bear → PE). Whichever side fires produces trades in its table.
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
      bullStrategy,
      bearStrategy,
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
      strategy?: StrategyConfig;
      bullStrategy?: StrategyConfig;
      bearStrategy?: StrategyConfig;
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
      scanAll?: boolean;
      symbols?: string[];
    };

    if (!from || !to) {
      return NextResponse.json({ error: "from and to required" }, { status: 400 });
    }

    const bullCfg: StrategyConfig | undefined = bullStrategy || strategy;
    if (!bullCfg?.entry?.length || !bullCfg?.exit?.length) {
      return NextResponse.json(
        {
          error:
            "Bullish (or primary) strategy entry and exit conditions required",
        },
        { status: 400 }
      );
    }
    const bull: StrategyConfig = bullCfg;

    const dual = Boolean(
      bearStrategy?.entry?.length && bearStrategy?.exit?.length
    );

    if (bearStrategy && !dual) {
      return NextResponse.json(
        {
          error:
            "Bearish strategy needs entry and exit conditions (or omit bearStrategy for single-strategy scan)",
        },
        { status: 400 }
      );
    }
    const bearCfg: StrategyConfig | undefined = dual ? bearStrategy : undefined;

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
      : universe.slice(
          0,
          Math.min(Math.max(1, Number(maxSymbols) || 200), 400)
        );
    const conc = Math.min(Math.max(1, Number(concurrency) || 3), 8);

    const bullRows: ScanRow[] = [];
    const bearRows: ScanRow[] = [];
    const singleRows: ScanRow[] = [];
    let idx = 0;

    const baseJob = {
      interval: interval as BacktestRequest["interval"],
      from,
      to,
      source: source || ("upstox" as const),
      initialCapital,
      positionSizePct,
      oneTradePerDay,
      entryTimeWindows,
      maxRiskPerTrade,
      tradeInstrument,
      upstoxAccessToken,
      dhanAccessToken,
      dhanClientId,
      kiteApiKey,
      kiteAccessToken,
    };

    async function runOne(
      sym: string,
      strat: StrategyConfig,
      direction: "bullish" | "bearish" | null,
      optionSide: "CE" | "PE" | undefined,
      preloaded?: import("@/lib/types").Candle[],
      includeCandles?: boolean
    ) {
      const optsPayload =
        tradeInstrument === "options_atm"
          ? {
              side: optionSide || options?.side || "CE",
              lotSize: options?.lotSize ?? 0,
              strikeStep: options?.strikeStep ?? 0,
              iv: options?.iv ?? 0.18,
              daysToExpiry: options?.daysToExpiry ?? 7,
              listedStrikes: options?.listedStrikes,
              // Prefer strategy positionLots; fall back to options.lots
              lots:
                strat.positionLots && strat.positionLots > 0
                  ? strat.positionLots
                  : options?.lots,
            }
          : options;

      const result = await runBacktestJob(
        {
          ...baseJob,
          symbol: sym,
          strategy: strat,
          options: optsPayload,
        },
        {
          candles: preloaded,
          includeCandles: Boolean(includeCandles),
        }
      );

      const tag = direction;
      const tradeList: ScanTradeDetail[] = (result.trades || []).map((t) => ({
        entryTime: t.entryTime,
        exitTime: t.exitTime,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        capitalUsed: t.capitalUsed ?? t.entryPrice * t.qty,
        underlyingEntry: t.underlyingEntry,
        underlyingExit: t.underlyingExit,
        strike: t.strike,
        optionSide: t.optionSide || optionSide,
        lots: t.lots,
        lotSize: t.lotSize,
        label: tag
          ? t.label
            ? `${tag} · ${t.label}`
            : tag
          : t.label,
        pnl: t.pnl,
        pnlPct: t.pnlPct,
        barsHeld: t.barsHeld,
      }));

      const m = result.metrics;
      const row: ScanRow =
        m.totalTrades > 0
          ? {
              symbol: result.symbol || sym,
              lotSize: result.optionsMeta?.lotSize,
              trades: m.totalTrades,
              winRate: m.winRate,
              totalPnl: m.totalPnl,
              totalPnlPct: m.totalPnlPct,
              finalEquity: m.finalEquity,
              equitySignals: result.diagnostics?.equitySignals,
              status: "ok",
              message: tag
                ? `${m.totalTrades} trade(s) · ${optionSide || ""} · “${strat.name}”`
                : `${m.totalTrades} trade(s)`,
              tradeList,
            }
          : {
              symbol: result.symbol || sym,
              lotSize: result.optionsMeta?.lotSize,
              trades: 0,
              winRate: 0,
              totalPnl: 0,
              totalPnlPct: 0,
              finalEquity: m.finalEquity,
              equitySignals: result.diagnostics?.equitySignals ?? 0,
              status: "no_trades",
              message:
                result.diagnostics?.note ||
                (result.diagnostics?.equitySignals
                  ? `Signals ${result.diagnostics.equitySignals}x but no fills (capital / premium / risk?)`
                  : "No trade — entry conditions never met on any day in range"),
              tradeList: [],
            };

      return {
        row,
        candles: result.candles,
        lotSize: result.optionsMeta?.lotSize,
      };
    }

    function errorRow(sym: string, lotSize: number, errMsg: string): ScanRow {
      return {
        symbol: sym,
        lotSize,
        trades: 0,
        winRate: 0,
        totalPnl: 0,
        totalPnlPct: 0,
        finalEquity: initialCapital,
        error: errMsg,
        status: "error",
        message: errMsg,
        tradeList: [],
      };
    }

    async function worker() {
      while (idx < list.length) {
        const i = idx++;
        const item = list[i];
        const sym = item.symbol;

        if (dual && bearCfg) {
          // One API candle load; both strategies evaluated independently
          let sharedCandles: import("@/lib/types").Candle[] | undefined;

          try {
            const bullRun = await runOne(
              sym,
              bull,
              "bullish",
              "CE",
              undefined,
              true
            );
            sharedCandles = bullRun.candles;
            bullRun.row.lotSize = bullRun.row.lotSize ?? item.lotSize;
            bullRows.push(bullRun.row);
          } catch (e) {
            bullRows.push(errorRow(sym, item.lotSize, safeErrorMessage(e)));
          }

          try {
            const bearRun = await runOne(
              sym,
              bearCfg,
              "bearish",
              "PE",
              sharedCandles,
              // if bull failed before candles, bear loads itself
              !sharedCandles
            );
            // if bull failed, bear may have fetched; drop candles from response
            bearRun.row.lotSize = bearRun.row.lotSize ?? item.lotSize;
            bearRows.push(bearRun.row);
          } catch (e) {
            bearRows.push(errorRow(sym, item.lotSize, safeErrorMessage(e)));
          }
        } else {
          try {
            const single = await runOne(
              sym,
              bull,
              null,
              options?.side,
              undefined,
              false
            );
            single.row.lotSize = single.row.lotSize ?? item.lotSize;
            singleRows.push(single.row);
          } catch (e) {
            singleRows.push(errorRow(sym, item.lotSize, safeErrorMessage(e)));
          }
        }
        await sleep(120);
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(conc, list.length) }, () => worker())
    );

    const sortRows = (rows: ScanRow[]) => {
      rows.sort((a, b) => {
        const order = { ok: 0, no_trades: 1, error: 2 };
        if (order[a.status] !== order[b.status]) {
          return order[a.status] - order[b.status];
        }
        return b.totalPnl - a.totalPnl;
      });
      return rows;
    };

    const buildReport = (
      rows: ScanRow[],
      strategyName: string,
      side?: "bullish" | "bearish"
    ): ScanReport => {
      sortRows(rows);
      const withTrades = rows.filter((r) => r.trades > 0);
      const totalPnl = withTrades.reduce((s, r) => s + r.totalPnl, 0);
      const totalTrades = rows.reduce((s, r) => s + r.trades, 0);
      return {
        generatedAt: new Date().toISOString(),
        strategyName,
        from,
        to,
        interval,
        source: source || "upstox",
        tradeInstrument: tradeInstrument || "equity",
        oneTradePerDay: Boolean(oneTradePerDay),
        universeSize: universe.length,
        scanned: rows.length,
        side,
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
    };

    if (dual && bearCfg) {
      const payload: DualScanReport = {
        dual: true,
        generatedAt: new Date().toISOString(),
        from,
        to,
        interval,
        source: source || "upstox",
        tradeInstrument: tradeInstrument || "equity",
        universeSize: universe.length,
        scanned: list.length,
        bull: buildReport(
          bullRows,
          bull.name || "Bullish strategy",
          "bullish"
        ),
        bear: buildReport(
          bearRows,
          bearCfg.name || "Bearish strategy",
          "bearish"
        ),
        note:
          "Fetched each symbol once from the API, then evaluated bullish (CE) and bearish (PE) conditions independently. Whichever side’s entry rules fire produces trades in that table.",
      };
      return NextResponse.json(payload);
    }

    return NextResponse.json(
      buildReport(singleRows, bull.name || "Strategy")
    );
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
