/**
 * Server-side paper tick: fetch Upstox candles once per symbol,
 * then evaluate 1–2 strategies on the same bars (no duplicate market calls).
 */
import { listFnoEquitySymbols } from "../data/fno-meta";
import { fetchUpstoxCandles, fetchUpstoxLtp } from "../data/upstox";
import { resolveUpstoxInstrumentKey } from "../data/upstox-instruments";
import { resolveFnoMeta } from "../data/fno-meta";
import { runBacktest } from "../backtest";
import { dayBoundsUnix } from "../data/dates";
import { createOptionPricer } from "../option-pricing";
import { previewEntrySignals } from "../run-job";
import { sanitizeToken } from "../http";
import { todayIst, isNseSessionOpen } from "./market-hours";
import { asciiSafe, isRateLimitError } from "./sanitize";
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

/**
 * Max symbols per worker tick.
 * Dual options = 2 pricers/symbol — keep small so a tick finishes within
 * serverless maxDuration and actually persists strategyResults.
 */
const MAX_SYMBOLS_HARD = process.env.VERCEL ? 16 : 80;
const MAX_SYMBOLS_DUAL_OPTIONS = process.env.VERCEL ? 6 : 30;

/** Soft-lock max age: if a tick heartbeated then died, allow a new one after this */
const IN_PROGRESS_LOCK_MS = 180_000;

/** In-process lock so concurrent status/cron kicks don't double-run one session */
const tickInFlight = new Set<string>();

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
  const d = result.diagnostics;
  const bars = d?.candleCount ?? result.candles?.length ?? 0;

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
        ? `${strategyTag}: ${tradeList.length} closed · OPEN · ${bars} bars`
        : `${strategyTag}: ${tradeList.length} paper trade(s) · ${bars} bars`,
      tradeList,
      equitySignals: d?.equitySignals,
    };
  }

  // Explain *why* no fill — “conditions true on chart” often = not yet scanned,
  // no today bars, capital skip, or 1-trade/day already used then exited.
  const why: string[] = [];
  if (bars < 5) why.push(`only ${bars} bars (need today+warmup)`);
  else why.push(`${bars} bars`);
  if (d?.equitySignals != null) {
    if (d.equitySignals === 0) why.push("0 entry signals on server data");
    else why.push(`${d.equitySignals} signal(s)`);
  }
  if (d?.skippedInsufficientCapital) {
    why.push(
      `capital skip ×${d.skippedInsufficientCapital}` +
        (d.minLotCost
          ? ` (need ~₹${Math.ceil(d.minLotCost).toLocaleString("en-IN")}/lot)`
          : "")
    );
  }
  if (d?.skippedNoMarketPremium) {
    why.push(
      `no mkt prem ×${d.skippedNoMarketPremium} (strict — no model)`
    );
  }
  if (
    (d?.equitySignals || 0) > 0 &&
    !d?.skippedInsufficientCapital &&
    tradeList.length === 0
  ) {
    why.push("entered then exited (or 1-trade/day used)");
  }
  if (d?.note) why.push(d.note.slice(0, 90));

  return {
    symbol: displaySym,
    lotSize: result.optionsMeta?.lotSize ?? lotSize,
    trades: 0,
    winRate: 0,
    totalPnl: 0,
    totalPnlPct: 0,
    finalEquity: initialCapital,
    status: "no_trades",
    message: `${strategyTag}: ${why.join(" · ") || "no signal yet"}`,
    tradeList: [],
    equitySignals: d?.equitySignals,
  };
}

export async function processPaperSession(
  sessionId: string,
  userIdHint?: string
): Promise<PaperSessionDoc | null> {
  if (tickInFlight.has(sessionId)) {
    return findSessionInMem(sessionId);
  }
  tickInFlight.add(sessionId);

  try {
    return await processPaperSessionInner(sessionId, userIdHint);
  } finally {
    tickInFlight.delete(sessionId);
  }
}

async function processPaperSessionInner(
  sessionId: string,
  userIdHint?: string
): Promise<PaperSessionDoc | null> {
  // Always prefer cloud status — warm mem often still says "running" after Stop
  let doc: PaperSessionDoc | null = null;
  if (userIdHint) {
    doc = await getSession(userIdHint, sessionId, { preferCloud: true });
  }
  if (!doc) {
    const fromList = (await listRunningSessions()).find((s) => s.id === sessionId);
    if (fromList?.userId) {
      doc = await getSession(fromList.userId, sessionId, { preferCloud: true });
    }
  }
  if (!doc) {
    const memDoc = findSessionInMem(sessionId);
    if (memDoc?.userId) {
      doc = await getSession(memDoc.userId, sessionId, { preferCloud: true });
    }
  }
  if (!doc || doc.status !== "running") {
    // Sync mem if cloud says stopped
    if (doc && findSessionInMem(sessionId)) {
      const m = findSessionInMem(sessionId);
      if (m) m.status = doc.status;
    }
    return doc;
  }

  const now = Date.now();
  // Soft lock: another instance started a tick recently — skip (cron + status race).
  // Expire after IN_PROGRESS_LOCK_MS so a killed mid-tick cannot stall forever.
  if (
    doc.lastWorkerAt &&
    now - doc.lastWorkerAt < IN_PROGRESS_LOCK_MS &&
    /tick in progress/i.test(String(doc.workerNote || ""))
  ) {
    return doc;
  }

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

  // Heartbeat so UI shows "running" and concurrent kicks back off
  try {
    const hbLine = asciiSafe(
      `${new Date().toLocaleTimeString("en-IN")} · Tick #${(doc.tickCount || 0) + 1} starting...`,
      400
    );
    await updateSession(sessionId, {
      userId: doc.userId,
      lastWorkerAt: now,
      workerNote: "Server tick in progress…",
      eventLog: [hbLine, ...(doc.eventLog || [])].slice(0, 40),
    });
    // Refresh doc.eventLog for final merge
    doc = (await getSession(doc.userId, sessionId, { preferCloud: true })) || doc;
  } catch (e) {
    console.error("[paper-worker] heartbeat failed:", e);
  }

  try {
    const cfg = doc.config;
    const strats = strategiesForConfig(cfg);
    const dual = strats.length > 1;
    if (!strats.length) {
      const line = asciiSafe(
        `${new Date().toLocaleTimeString("en-IN")} · Tick aborted — no strategies on session config`,
        400
      );
      return await updateSession(sessionId, {
        userId: doc.userId,
        lastWorkerAt: Date.now(),
        lastError: "No strategies in session config",
        workerNote: "No strategies configured",
        eventLog: [line, ...(doc.eventLog || [])].slice(0, 40),
      });
    }

    let universe: Awaited<ReturnType<typeof listFnoEquitySymbols>> = [];
    try {
      universe = await listFnoEquitySymbols();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const line = asciiSafe(
        `${new Date().toLocaleTimeString("en-IN")} · F&O universe load failed: ${msg.slice(0, 120)}`,
        400
      );
      return await updateSession(sessionId, {
        userId: doc.userId,
        lastWorkerAt: Date.now(),
        lastError: msg.slice(0, 300),
        workerNote: "F&O universe load failed",
        eventLog: [line, ...(doc.eventLog || [])].slice(0, 40),
      });
    }

    // Full universe when scanAll; otherwise first maxSymbols (still rotate if > batch)
    const fullList = cfg.scanAll
      ? universe
      : universe.slice(0, Math.min(universe.length, Math.max(5, cfg.maxSymbols || 30)));

    if (!fullList.length) {
      const line = asciiSafe(
        `${new Date().toLocaleTimeString("en-IN")} · Tick #${(doc.tickCount || 0) + 1} — F&O universe empty (retry next tick)`,
        400
      );
      return await updateSession(sessionId, {
        userId: doc.userId,
        lastWorkerAt: Date.now(),
        lastError: "F&O universe empty",
        workerNote: "F&O universe empty — will retry",
        eventLog: [line, ...(doc.eventLog || [])].slice(0, 40),
        tickCount: (doc.tickCount || 0) + 1,
      });
    }

    const token = sanitizeToken(doc.upstoxAccessToken);
    if (!token) {
      const line = asciiSafe(
        `${new Date().toLocaleTimeString("en-IN")} · Tick aborted — missing Upstox access token on session`,
        400
      );
      return await updateSession(sessionId, {
        userId: doc.userId,
        lastWorkerAt: Date.now(),
        lastError: "Missing Upstox token",
        workerNote: "Paste Upstox token and start again",
        eventLog: [line, ...(doc.eventLog || [])].slice(0, 40),
      });
    }

    const hardCap =
      dual && cfg.tradeInstrument === "options_atm"
        ? MAX_SYMBOLS_DUAL_OPTIONS
        : MAX_SYMBOLS_HARD;
    const batchSize = Math.min(hardCap, fullList.length || 1);
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

    // Block entries before cash open (warmup bars still used for indicators)
    const entryNotBeforeMs = Date.parse(`${today}T09:15:00+05:30`);
    // Fallback if parse fails
    const entryFloor =
      Number.isFinite(entryNotBeforeMs) && entryNotBeforeMs > 0
        ? entryNotBeforeMs
        : dayBoundsUnix(today, today).startMs;

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

          // Paper options: STRICT market-only (no Black–Scholes fallback)
          let optionPricer;
          const tag = s.strategy.name || `S${s.slot}`;
          if (cfg.tradeInstrument === "options_atm" && options) {
            try {
              const signalTimes = previewEntrySignals(
                candles,
                s.strategy.entry,
                s.strategy.entryLogic ?? "and",
                Boolean(cfg.oneTradePerDay)
              );
              const last = candles[candles.length - 1];
              if (last) {
                signalTimes.push({ timeMs: last.time, spot: last.close });
              }
              // Always build pricer when options (even 0 signals → no market series)
              optionPricer = await createOptionPricer({
                symbol,
                side: options.side || "CE",
                equityCandles: candles,
                from: today,
                to: today,
                interval: cfg.interval,
                listedStrikes: options.listedStrikes || [],
                strikeStep: options.strikeStep || 0,
                lotSize: options.lotSize,
                preferredDaysToExpiry: options.daysToExpiry ?? 7,
                fallbackIv: options.iv ?? 0.18,
                accessToken: token,
                signalTimes:
                  signalTimes.length > 0
                    ? signalTimes
                    : last
                      ? [{ timeMs: last.time, spot: last.close }]
                      : [],
                maxMarketContracts: 3,
                marketOnly: true,
              });
            } catch (e) {
              console.warn(
                `[paper-worker] option pricer ${symbol}:`,
                e instanceof Error ? e.message : e
              );
            }

            if (!optionPricer || optionPricer.marketContractsUsed < 1) {
              batchRowsBySlot.get(s.slot)!.push({
                symbol,
                lotSize: item.lotSize,
                trades: 0,
                winRate: 0,
                totalPnl: 0,
                totalPnlPct: 0,
                finalEquity: cfg.initialCapital,
                status: "no_trades",
                message: `${tag}: strict mode — no Upstox option candles (skipped)`,
                tradeList: [],
              });
              continue;
            }
          }

          const result = runBacktest(
            candles,
            {
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
              entryNotBeforeMs: entryFloor,
              leaveOpenPositions: true,
            },
            { optionPricer }
          );

          // Strict: drop any open not entered on market premium
          if (
            result.openPosition &&
            cfg.tradeInstrument === "options_atm" &&
            result.openPosition.premiumSource !== "market"
          ) {
            result.openPosition = undefined;
          }

          // Live LTP for open mark (required in strict mode for honest uP&L)
          if (
            result.openPosition &&
            result.openPosition.instrumentKey &&
            token
          ) {
            try {
              const ltps = await fetchUpstoxLtp({
                instrumentKeys: [result.openPosition.instrumentKey],
                accessToken: token,
              });
              const key = result.openPosition.instrumentKey;
              let ltp = ltps.get(key) || 0;
              if (!(ltp > 0)) {
                for (const [, v] of ltps) {
                  if (v > 0) {
                    ltp = v;
                    break;
                  }
                }
              }
              if (ltp > 0) {
                const entry = result.openPosition.entryPrice;
                const qty = result.openPosition.qty;
                result.openPosition.markPrice = ltp;
                result.openPosition.unrealizedPnl = (ltp - entry) * qty;
                result.openPosition.markSource = "ltp";
              } else if (
                result.openPosition.markSource !== "market" ||
                !(result.openPosition.markPrice > 0)
              ) {
                // No LTP and no market candle mark — don't show fake model uP&L
                result.openPosition.markPrice = result.openPosition.entryPrice;
                result.openPosition.unrealizedPnl = 0;
                result.openPosition.markSource = "market";
              }
            } catch {
              if (result.openPosition.premiumSource === "market") {
                result.openPosition.markPrice = result.openPosition.entryPrice;
                result.openPosition.unrealizedPnl = 0;
              }
            }
          }

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
            const src =
              result.openPosition.markSource ||
              result.openPosition.premiumSource ||
              "market";
            batchOpensBySlot.get(s.slot)!.push({
              ...result.openPosition,
              symbol,
              label: `${tag} · ${symbol} · ${
                src === "ltp" ? "LTP" : "mkt"
              }`,
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

    const openCount = allOpen.length;
    const signalSum = strategyResults.reduce(
      (s, r) =>
        s +
        (r.report.rows || []).reduce(
          (ss, row) => ss + (Number(row.equitySignals) || 0),
          0
        ),
      0
    );
    const stratNames = strats
      .map((s) => s.strategy.name || `S${s.slot}`)
      .join(" + ");
    const logLine =
      `${new Date().toLocaleTimeString("en-IN")} · Tick #${(doc.tickCount || 0) + 1} · ` +
      `${dual ? `dual [${stratNames}]` : stratNames} · ` +
      `batch ${offset + 1}–${Math.min(offset + list.length, fullList.length)} of ${fullList.length}` +
      ` (${list.length} this tick) · covered ${covered}/${fullList.length} · ` +
      `~${cycles} min/full cycle · trades ${tradeSum} · open ${openCount} · signals ${signalSum}` +
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
        (dual ? `Dual: ${stratNames}. ` : "") +
        (fullList.length > batchSize
          ? `Rotating F&O: ${covered}/${fullList.length} symbols · next @ ${advancedOffset} · ~${cycles} min/full pass · ${strats.length} strateg${strats.length === 1 ? "y" : "ies"}`
          : isNseSessionOpen()
            ? "Server worker running — browser/logout does not stop this session"
            : "Outside market hours — session held until stop or 15:30 end"),
      eventLog,
      tickCount: (doc.tickCount || 0) + 1,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "worker failed";
    console.error("[paper-worker] tick error:", msg);
    const latest = await getSession(doc.userId, sessionId, {
      preferCloud: true,
    });
    if (latest && latest.status !== "running") return latest;
    const line = asciiSafe(
      `${new Date().toLocaleTimeString("en-IN")} · Tick failed: ${msg.slice(0, 160)}`,
      400
    );
    return await updateSession(sessionId, {
      userId: doc.userId,
      lastWorkerAt: Date.now(),
      lastError: msg.slice(0, 400),
      workerNote: `Tick failed: ${msg.slice(0, 120)}`,
      eventLog: [line, ...(latest?.eventLog || doc.eventLog || [])].slice(
        0,
        40
      ),
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
