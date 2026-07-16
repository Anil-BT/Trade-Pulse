/**
 * Send a Telegram message via Bot API.
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN  — from @BotFather
 *   TELEGRAM_CHAT_ID    — group/channel/user id (default if body.chatId omitted)
 *
 * Body: { text: string, chatId?: string }
 */
import { NextRequest, NextResponse } from "next/server";
import { safeErrorMessage } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const token = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
    if (!token) {
      return NextResponse.json(
        {
          error:
            "TELEGRAM_BOT_TOKEN not set. Create a bot with @BotFather and add the token to env.",
        },
        { status: 503 }
      );
    }

    let body: { text?: string; chatId?: string } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      body = {};
    }

    const text = String(body.text || "").trim();
    if (!text) {
      return NextResponse.json({ error: "text required" }, { status: 400 });
    }
    // Telegram limit ~4096
    const message = text.slice(0, 4000);

    // Strip quotes/spaces people paste from JSON
    const chatIdRaw = String(
      body.chatId || process.env.TELEGRAM_CHAT_ID || ""
    )
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!chatIdRaw) {
      return NextResponse.json(
        {
          error:
            "chatId required (set TELEGRAM_CHAT_ID in env or pass chatId in body).",
        },
        { status: 400 }
      );
    }
    // Telegram accepts string or number; numeric ids work as numbers
    const chatId: string | number = /^-?\d+$/.test(chatIdRaw)
      ? Number(chatIdRaw)
      : chatIdRaw;

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true,
      }),
      cache: "no-store",
    });

    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
      result?: { message_id?: number };
    };

    if (!res.ok || !json.ok) {
      return NextResponse.json(
        {
          error:
            json.description ||
            `Telegram API error (${res.status})`,
        },
        { status: 502 }
      );
    }

    return NextResponse.json({
      ok: true,
      messageId: json.result?.message_id,
    });
  } catch (e) {
    console.error("[telegram-notify]", e);
    return NextResponse.json(
      { error: safeErrorMessage(e) || "Telegram send failed" },
      { status: 500 }
    );
  }
}

/** Health: is bot token configured? */
export async function GET() {
  const token = Boolean(String(process.env.TELEGRAM_BOT_TOKEN || "").trim());
  const defaultChat = Boolean(
    String(process.env.TELEGRAM_CHAT_ID || "").trim()
  );
  return NextResponse.json({
    configured: token,
    defaultChatId: defaultChat,
  });
}
