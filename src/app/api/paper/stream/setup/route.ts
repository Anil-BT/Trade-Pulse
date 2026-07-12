/**
 * Paper stream setup:
 * 1) Authorize Upstox Market Data Feed V3 WebSocket URL
 * 2) Resolve NSE equity instrument keys for F&O underlyings
 */
import { NextRequest, NextResponse } from "next/server";
import { listFnoEquitySymbols } from "@/lib/data/fno-meta";
import { resolveUpstoxInstrumentKey } from "@/lib/data/upstox-instruments";
import { safeErrorMessage, sanitizeToken, asciiHeaders } from "@/lib/http";
import { todayIst } from "@/lib/paper/market-hours";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      upstoxAccessToken,
      maxSymbols = 200,
      scanAll = true,
    } = body as {
      upstoxAccessToken?: string;
      maxSymbols?: number;
      scanAll?: boolean;
    };

    const token = sanitizeToken(
      upstoxAccessToken || process.env.UPSTOX_ACCESS_TOKEN || ""
    );
    if (!token) {
      return NextResponse.json(
        { error: "Upstox access token required for live market feed." },
        { status: 400 }
      );
    }

    // Authorize feed
    const authRes = await fetch(
      "https://api.upstox.com/v3/feed/market-data-feed/authorize",
      {
        headers: asciiHeaders({
          Authorization: `Bearer ${token}`,
          Accept: "*/*",
          "Api-Version": "2.0",
        }),
        cache: "no-store",
        redirect: "manual",
      }
    );

    let authorizedRedirectUri = "";
    if (authRes.status === 200) {
      const json = (await authRes.json()) as {
        data?: { authorizedRedirectUri?: string; authorized_redirect_uri?: string };
      };
      authorizedRedirectUri =
        json?.data?.authorizedRedirectUri ||
        json?.data?.authorized_redirect_uri ||
        "";
    } else if (authRes.status === 302) {
      authorizedRedirectUri =
        authRes.headers.get("location") ||
        authRes.headers.get("Location") ||
        "";
    } else {
      const text = await authRes.text();
      throw new Error(
        `Upstox feed authorize failed (${authRes.status}): ${text.slice(0, 160)}`
      );
    }

    if (!authorizedRedirectUri?.startsWith("wss")) {
      // Some responses wrap URI differently
      throw new Error(
        "Upstox did not return a wss:// feed URL. Check token scopes / Market Data Feed access."
      );
    }

    // F&O equity underlyings → instrument keys
    let universe = await listFnoEquitySymbols();
    // LTPC mode allows up to 5000 keys — take full equity F&O list (usually ~150–200)
    const cap = scanAll
      ? Math.min(universe.length, 2000)
      : Math.min(Math.max(5, Number(maxSymbols) || 200), 2000);
    const slice = universe.slice(0, cap);

    const instruments: {
      symbol: string;
      instrumentKey: string;
      lotSize: number;
    }[] = [];
    const errors: string[] = [];

    // Resolve in batches
    for (let i = 0; i < slice.length; i++) {
      const item = slice[i];
      try {
        const r = await resolveUpstoxInstrumentKey(item.symbol, "NSE");
        if (r.instrumentKey) {
          instruments.push({
            symbol: r.tradingSymbol || item.symbol,
            instrumentKey: r.instrumentKey,
            lotSize: item.lotSize,
          });
        }
      } catch (e) {
        errors.push(
          `${item.symbol}: ${e instanceof Error ? e.message.slice(0, 40) : "resolve failed"}`
        );
      }
      if (i > 0 && i % 40 === 0) {
        await new Promise((r) => setTimeout(r, 80));
      }
    }

    if (!instruments.length) {
      return NextResponse.json(
        { error: "Could not resolve any F&O instrument keys for the feed." },
        { status: 422 }
      );
    }

    return NextResponse.json({
      authorizedRedirectUri,
      today: todayIst(),
      mode: "ltpc",
      instruments,
      instrumentKeys: instruments.map((i) => i.instrumentKey),
      symbolByKey: Object.fromEntries(
        instruments.map((i) => [i.instrumentKey, i.symbol])
      ),
      limits: {
        note: "Upstox V3 LTPC mode: up to 5000 instrument keys per connection; 2 connections/user.",
        subscribed: instruments.length,
      },
      resolveErrors: errors.slice(0, 20),
    });
  } catch (err) {
    return NextResponse.json(
      { error: safeErrorMessage(err) || "Feed setup failed" },
      { status: 500 }
    );
  }
}
