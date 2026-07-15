/**
 * Server-side paper tick: fetch Upstox candles once per symbol,
 * then evaluate 1–2 strategies on the same bars (no duplicate market calls).
 */
import { listFnoEquitySymbols } from "../data/fno-meta";
import { fetchUpstoxCandles } from "../data/upstox";
import { resolveUpstoxInstrumentKey } from "../data/upstox-instruments";
import { resolveFnoMeta } from "../data/fno-meta";
import { runBacktest } from "../backtest";
import { dayBoundsUnix } from "../data/dates";
import { sanitizeToken } from "../http";
import { todayIst, isNseSessionOpen } from "./market-hours";
import { isRateLimitError } from "./sanitize";
import {
  getSession,
  listRunningSessions,
  memTimers,
  updateSession,
  setSessionStatus,
} from "./session-store";
import {
  strategiesForConfig,
  type PaperSessionDoc,
  type StrategyPaperResult,
} from "./session-types";
import type {
  BacktestResult,
  Candle,
  OpenPosition,
  ScanReport,
  ScanRow,
  ScanTradeDetail,
  StrategyConfig,
} from "../types";

const MAX_SYMBOLS_HARD = 80;

function findSessionInMem(sessionId: string): PaperSessionDoc | null {
  const g = globalThis as { __paperSessions?: Map<string, PaperSessionDoc> };
  return g.__paperSessions?.get(sessionId) || null;
}

function toTradeList(result: BacktestResult): ScanTradeDetail[] {
  return (result.trades || []).map((t) => ({
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
}

function buildReport(
  strategyName: string,
  rows: ScanRow[],
  openPositions: OpenPosition[],
  cfg: PaperSessionDoc["config"],
  today: string,
  universeSize: number
): ScanReport {
  const closed = rows.filter((r) => r.trades > 0);
  const totalPnl =
    closed.reduce((s, r) => s + r.totalPnl, 0) +
    openPositions.reduce((s, p) => s + p.unrealizedPnl, 0);
  return {
    generatedAt: new Date().toISOString(),
    strategyName,
    from: today,
    to: today,
    interval: cfg.interval,
    source: "upstox",
    tradeInstrument: cfg.tradeInstrument,
    oneTradePerDay: cfg.oneTradePerDay,
    universeSize,
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
    rows: [...rows].sort((a, b) => b.totalPnl - a.totalPnl),
  };
}

function rowFromResult(
  result: BacktestResult,
  sym: string,
  lotSize: number | undefined,
  initialCapital: number,
  strategyTag: string
): ScanRow {
  const tradeList = toTradeList(result);
  const totalPnl = tradeList.reduce((s, t) => s + t.pnl, 0);
  const winners = tradeList.filter((t) => t.pnl > 0).length;
  const displaySym = `${result.symbol || sym}`;

  if (tradeList.length > 0 || result.openPosition) {
    return {
      symbol: displaySym,
      lotSize: result.optionsMeta?.lotSize ?? lotSize,
      trades: tradeList.length,
      winRate: tradeList.length ? (winners / tradeList.length) * 100 : 0,
      totalPnl,
      totalPnlPct:
        initialCapital > 0 ? (totalPnl / initialCapital) * 100 : 0,
      finalEquity: initialCapital + totalPnl,
      status: "ok",
      message: result.openPosition
        ? `${strategyTag}: ${tradeList.length} closed · open`
        : `${strategyTag}: ${tradeList.length} paper trade(s)`,
      tradeList,
    };
  }
  return {
    symbol: displaySym,
    lotSize,
    trades: 0,
    winRate: 0,
    totalPnl: 0,
    totalPnlPct: 0,
    finalEquity: initialCapital,
    status: "no_trades",
    message: `${strategyTag}: no signal yet`,
    tradeList: [],
  };
}

export async function processPaperSession(
  sessionId: string,
  userIdHint?: string
): Promise<PaperSessionDoc | null> {
  let doc =
    findSessionInMem(sessionId) ||
    (await listRunningSessions()).find((s) => s.id === sessionId) ||
    null;

  if (!doc && userIdHint) {
    doc = await getSession(userIdHint, sessionId);
  }
  if (!doc || doc.status !== "running") return doc;

  const now = Date.now();
  if (now > doc.endsAt) {
    await setSessionStatus(sessionId, "ended", {
      workerNote: "Auto-stopped at session end (15:30 IST)",
      lastWorkerAt: now,
    });
    return getSession(doc.userId, sessionId);
  }

  const today = todayIst();
  if (doc.sessionDay !== today) {
    await setSessionStatus(sessionId, "ended", {
      workerNote: "Session day rolled over — start a new paper session",
      lastWorkerAt: now,
    });
    return getSession(doc.userId, sessionId);
  }

  try {
    const cfg = doc.config;
    const strats = strategiesForConfig(cfg);
    const universe = await listFnoEquitySymbols();
    // Full universe when scanAll; otherwise first maxSymbols (still rotate if > batch)
    const fullList = cfg.scanAll
      ? universe
      : universe.slice(0, Math.min(universe.length, Math.max(5, cfg.maxSymbols || 30)));

    const batchSize = Math.min(MAX_SYMBOLS_HARD, fullList.length || 1);
    const offset =
      fullList.length > 0
        ? (doc.rotationOffset || 0) % fullList.length
        : 0;

    // Rotating window: 80 this minute, next 80 next minute, wrap around
    const list: typeof fullList = [];
    for (let j = 0; j < batchSize && fullList.length > 0; j++) {
      list.push(fullList[(offset + j) % fullList.length]);
    }
    const nextOffset =
      fullList.length > 0 ? (offset + batchSize) % fullList.length : 0;
    const batchEnd =
      fullList.length > 0
        ? ((offset + list.length - 1) % fullList.length) + 1
        : 0;

    const token = sanitizeToken(doc.upstoxAccessToken);
    const { startMs: entryNotBeforeMs } = dayBoundsUnix(today, today);

    // Batch accumulators (this tick only)
    const batchRowsBySlot = new Map<1 | 2, ScanRow[]>();
    const batchOpensBySlot = new Map<1 | 2, OpenPosition[]>();
    for (const s of strats) {
      batchRowsBySlot.set(s.slot, []);
      batchOpensBySlot.set(s.slot, []);
    }

    let rateLimited = 0;
    let errors = 0;
    let consecutiveRateLimits = 0;
    const batchSymbols: string[] = [];

    for (let i = 0; i < list.length; i++) {
      // After several 429s in a row, stop this batch early — retry next ticks
      if (consecutiveRateLimits >= 3) {
        break;
      }

      const item = list[i];
      let candles: Candle[] = [];
      let symbol = item.symbol;
      batchSymbols.push(item.symbol);

      try {
        // ——— ONE Upstox candle fetch per symbol ———
        const resolved = await resolveUpstoxInstrumentKey(item.symbol, "NSE");
        symbol = resolved.tradingSymbol || item.symbol;
        candles = await fetchUpstoxCandles({
          instrumentKey: resolved.instrumentKey,
          interval: cfg.interval,
          from: today,
          to: today,
          accessToken: token,
          lookbackDays: 12,
        });
        consecutiveRateLimits = 0;

        if (candles.length < 5) {
          for (const s of strats) {
            batchRowsBySlot.get(s.slot)!.push({
              symbol,
              lotSize: item.lotSize,
              trades: 0,
              winRate: 0,
              totalPnl: 0,
              totalPnlPct: 0,
              finalEquity: cfg.initialCapital,
              status: "no_trades",
              message: `${s.strategy.name}: waiting for bars`,
              tradeList: [],
            });
          }
          continue;
        }

        let baseOptions = cfg.options;
        if (cfg.tradeInstrument === "options_atm") {
          const fno = await resolveFnoMeta(symbol);
          baseOptions = {
            side: cfg.options?.side || "CE",
            lotSize:
              (cfg.options?.lotSize || 0) > 0
                ? cfg.options!.lotSize
                : fno.lotSize,
            strikeStep:
              (cfg.options?.strikeStep || 0) > 0
                ? cfg.options!.strikeStep
                : fno.strikeStep,
            listedStrikes: fno.strikes || [],
            iv: cfg.options?.iv ?? 0.18,
            daysToExpiry: cfg.options?.daysToExpiry ?? 7,
          };
        }

        // ——— Evaluate each strategy on the SAME candles ———
        for (const s of strats) {
          let options = s.options ?? baseOptions;
          if (cfg.tradeInstrument === "options_atm" && options) {
            options = {
              ...baseOptions!,
              side: options.side || baseOptions?.side || "CE",
              lotSize:
                (options.lotSize || 0) > 0
                  ? options.lotSize
                  : baseOptions?.lotSize || 0,
              strikeStep:
                (options.strikeStep || 0) > 0
                  ? options.strikeStep
                  : baseOptions?.strikeStep || 0,
              iv: options.iv ?? baseOptions?.iv ?? 0.18,
              daysToExpiry:
                options.daysToExpiry ?? baseOptions?.daysToExpiry ?? 7,
              listedStrikes:
                options.listedStrikes || baseOptions?.listedStrikes || [],
            };
          }

          // Paper: model option fills only (no per-symbol option-chain fetch).
          // Avoids rate limits and "invalid string"/header issues from extra APIs.
          const result = runBacktest(candles, {
            symbol,
            interval: cfg.interval,
            from: today,
            to: today,
            source: "upstox",
            strategy: s.strategy,
            initialCapital: cfg.initialCapital,
            positionSizePct: cfg.positionSizePct,
            oneTradePerDay: cfg.oneTradePerDay,
            entryTimeWindows: cfg.entryTimeWindows,
            maxRiskPerTrade: cfg.maxRiskPerTrade,
            tradeInstrument: cfg.tradeInstrument,
            options,
            entryNotBeforeMs,
            leaveOpenPositions: true,
          });

          const tag = s.strategy.name || `S${s.slot}`;
          batchRowsBySlot
            .get(s.slot)!
            .push(
              rowFromResult(
                result,
                symbol,
                item.lotSize,
                cfg.initialCapital,
                tag
              )
            );

          if (result.openPosition) {
            batchOpensBySlot.get(s.slot)!.push({
              ...result.openPosition,
              symbol,
              label: `${tag} · ${symbol}`,
            });
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const is429 = isRateLimitError(msg);
        if (is429) {
          rateLimited += 1;
          consecutiveRateLimits += 1;
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          consecutiveRateLimits = 0;
          errors += 1;
          console.error(`[paper-worker] ${item.symbol}:`, msg);
        }
        const short = msg
          .replace(/[\u2010-\u2015]/g, "-")
          .replace(/[^\x20-\x7E]/g, " ")
          .slice(0, 120);
        for (const s of strats) {
          batchRowsBySlot.get(s.slot)!.push({
            symbol: item.symbol,
            lotSize: item.lotSize,
            trades: 0,
            winRate: 0,
            totalPnl: 0,
            totalPnlPct: 0,
            finalEquity: cfg.initialCapital,
            status: "error",
            error: short,
            message: is429
              ? `${s.strategy.name}: rate limited (retry next cycle)`
              : `${s.strategy.name}: ${short}`,
            tradeList: [],
          });
        }
      }
      if (i % 5 === 4) await new Promise((r) => setTimeout(r, 150));
    }

    // ——— Merge this batch into cumulative results across full universe ———
    const strategyResults: StrategyPaperResult[] = strats.map((s) => {
      const prev = doc.strategyResults?.find((r) => r.slot === s.slot);
      const prevRows = prev?.report.rows || [];
      const bySym = new Map(prevRows.map((r) => [r.symbol, r]));
      for (const row of batchRowsBySlot.get(s.slot) || []) {
        bySym.set(row.symbol, row);
      }
      const mergedRows = [...bySym.values()];

      // Opens: keep previous opens for symbols NOT in this batch; replace for batch symbols
      const batchSyms = new Set(
        (batchRowsBySlot.get(s.slot) || []).map((r) => r.symbol)
      );
      const prevOpens = (prev?.openPositions || []).filter(
        (o) => o.symbol && !batchSyms.has(o.symbol)
      );
      const mergedOpens = [
        ...prevOpens,
        ...(batchOpensBySlot.get(s.slot) || []),
      ];

      const name = s.strategy.name || `Strategy ${s.slot}`;
      return {
        strategyName: name,
        slot: s.slot,
        report: buildReport(
          name,
          mergedRows,
          mergedOpens,
          cfg,
          today,
          fullList.length
        ),
        openPositions: mergedOpens,
      };
    });

    const primary = strategyResults[0];
    const allOpen = strategyResults.flatMap((r) => r.openPositions);
    const tradeSum = strategyResults.reduce(
      (s, r) => s + r.report.summary.totalTrades,
      0
    );
    const covered = primary?.report.rows.length || 0;
    const cycles =
      fullList.length > 0 ? Math.ceil(fullList.length / batchSize) : 1;

    const logLine =
      `${new Date().toLocaleTimeString("en-IN")} · Tick #${(doc.tickCount || 0) + 1} · ` +
      `batch ${offset + 1}–${Math.min(offset + list.length, fullList.length)} of ${fullList.length}` +
      ` (${list.length} this min) · covered ${covered}/${fullList.length} · ` +
      `~${cycles} min/full cycle · trades ${tradeSum}` +
      (rateLimited ? ` · ${rateLimited} rate-limit` : "") +
      (errors ? ` · ${errors} other err` : "");

    const eventLog = [logLine, ...(doc.eventLog || [])].slice(0, 40);

    // Advance rotation even if partial batch (rate-limit stop mid-batch)
    // so we don't get stuck; failed symbols retry next full cycle
    const advancedOffset =
      consecutiveRateLimits >= 3 && list.length > 0
        ? // only advance past symbols we attempted
          (offset + batchSymbols.length) % fullList.length
        : nextOffset;

    // User may have clicked Stop while this tick was running — do not revive
    const latest = await getSession(doc.userId, sessionId, {
      preferCloud: true,
    });
    if (!latest || latest.status !== "running") {
      return latest;
    }

    return await updateSession(sessionId, {
      userId: doc.userId,
      report: primary?.report ?? null,
      openPositions: allOpen,
      strategyResults,
      rotationOffset: advancedOffset,
      lastBatch: {
        fromIndex: offset,
        toIndex: batchEnd,
        universeSize: fullList.length,
        symbols: batchSymbols.slice(0, 20),
        rateLimited: rateLimited || undefined,
        errors: errors || undefined,
      },
      lastWorkerAt: Date.now(),
      lastError: rateLimited
        ? `Rate limited on ${rateLimited} symbol(s) this tick — session continues; those names retry next cycle`
        : undefined,
      workerNote:
        fullList.length > batchSize
          ? `Rotating F&O: ${covered}/${fullList.length} symbols touched · next batch @ index ${advancedOffset} · ~${cycles} min per full pass`
          : isNseSessionOpen()
            ? "Server worker running — browser/logout does not stop this session"
            : "Outside market hours — session held until stop or 15:30 end",
      eventLog,
      tickCount: (doc.tickCount || 0) + 1,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "worker failed";
    const latest = await getSession(doc.userId, sessionId, {
      preferCloud: true,
    });
    if (latest && latest.status !== "running") return latest;
    return await updateSession(sessionId, {
      userId: doc.userId,
      lastWorkerAt: Date.now(),
      lastError: msg,
      workerNote: msg,
    });
  }
}

/**
 * Kick a worker tick. On Vercel/serverless, setInterval dies after the response —
 * only fire one process (cron + status polls drive further ticks).
 * Locally, keep an interval for continuous paper runs.
 */
export function ensureSessionLoop(sessionId: string, everyMs = 60_000) {
  const timers = memTimers();
  // Always run at least one tick (async, non-blocking for HTTP handlers)
  void processPaperSession(sessionId);

  // Serverless: no long-lived intervals
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return;
  }

  if (timers.has(sessionId)) return;
  const t = setInterval(() => {
    void processPaperSession(sessionId);
  }, everyMs);
  timers.set(sessionId, t);
}

export async function processAllRunningSessions(): Promise<number> {
  const list = await listRunningSessions();
  for (const s of list) {
    await processPaperSession(s.id, s.userId);
  }
  return list.length;
}
