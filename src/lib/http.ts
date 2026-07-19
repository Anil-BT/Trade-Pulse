/**
 * HTTP header values must be ByteString (char codes 0–255).
 * Unicode (e.g. em dash U+2014 = 8212) throws:
 * "Cannot convert argument to a ByteString..."
 */

/** Keep only Latin-1-safe printable ASCII for headers. */
export function toHeaderValue(value: string): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u2010-\u2015]/g, "-") // various dashes → hyphen
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/[^\x20-\x7E]/g, "");
}

/** Safe headers object for fetch / https. */
export function asciiHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[toHeaderValue(k)] = toHeaderValue(v);
  }
  return out;
}

/** Sanitize Bearer / API tokens pasted from docs (smart dashes, BOM, etc.). */
export function sanitizeToken(token: string): string {
  return String(token ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u2018\u2019\u201C\u201D]/g, "")
    // keep only printable ASCII non-space (tokens must be ByteString-safe)
    .replace(/[^\x21-\x7E]/g, "")
    .trim();
}

/** Ensure error messages shown to clients stay ASCII-friendly. Never throws. */
export function safeErrorMessage(err: unknown): string {
  try {
    const raw = err instanceof Error ? err.message : String(err);
    let cleaned = raw;
    try {
      cleaned = raw.normalize("NFKC");
    } catch {
      cleaned = raw;
    }
    cleaned = cleaned
      .replace(/[\u2010-\u2015]/g, "-")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/\u2026/g, "...")
      .replace(/[^\x20-\x7E]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 400);
    if (/bytestring|character at index|greater than 255/i.test(cleaned)) {
      return `Invalid token/header characters (paste Upstox token as plain ASCII). ${cleaned}`;
    }
    if (/invalid string length/i.test(cleaned)) {
      return "Payload too large to process. Reduce symbols or simplify strategy.";
    }
    if (/^invalid string$/i.test(cleaned)) {
      return "Invalid string (often a bad token, date, or instrument key). Re-paste Upstox token and retry.";
    }
    if (
      /did not match the expected pattern|string did not match/i.test(cleaned)
    ) {
      return "Request blocked by the browser (often Safari header/time validation). Re-sign in, re-paste Upstox token as plain text, and try again.";
    }
    if (/unexpected token|not valid json|DOCTYPE/i.test(cleaned)) {
      return "Server returned a non-JSON response (page error or timeout). Retry in a moment; if it persists, check deploy/logs.";
    }
    if (/an error occurred with your deployment|FUNCTION_INVOCATION|Task timed out/i.test(
      cleaned
    )) {
      return (
        "Server timed out or crashed on Vercel (often >60s Hobby limit or heavy F&O options). " +
        "Use a shorter date range, fewer symbols, 1 lot, or run locally."
      );
    }
    return cleaned || "Unknown error";
  } catch {
    return "Unknown error";
  }
}

/**
 * Parse fetch Response as JSON without throwing on HTML / plain-text error pages
 * (e.g. Vercel "An error occurred with your deployment" → not valid JSON).
 */
export async function parseApiJson<T = Record<string, unknown>>(
  res: Response
): Promise<T> {
  const text = await res.text();
  const trimmed = (text || "").trim();
  if (!trimmed) {
    throw new Error(
      res.ok
        ? "Empty response from server"
        : `Server error ${res.status} (empty body). Often a timeout — try a shorter date range.`
    );
  }
  if (trimmed.startsWith("<") || /^<!DOCTYPE/i.test(trimmed)) {
    throw new Error(
      `Server returned HTML instead of JSON (HTTP ${res.status}). ` +
        "Usually a deploy error, timeout, or missing API route — retry or check server logs."
    );
  }
  // Vercel platform / gateway plain-text failures
  if (
    /^An error occurred/i.test(trimmed) ||
    /FUNCTION_INVOCATION_FAILED|FUNCTION_INVOCATION_TIMEOUT|Task timed out/i.test(
      trimmed
    )
  ) {
    throw new Error(
      `Server timed out or failed (HTTP ${res.status}). ` +
        "On Vercel Hobby, functions max ~60s. Use shorter dates, fewer F&O symbols, " +
        "1 lot, force smaller scan max, or run the same backtest locally."
    );
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const snippet = trimmed.slice(0, 120).replace(/\s+/g, " ");
    // Common: JSON.parse error message path when body starts with "An error..."
    if (/^An error |unexpected token/i.test(snippet)) {
      throw new Error(
        `Server returned a non-JSON error (HTTP ${res.status}). ` +
          "Usually Vercel timeout/crash. Shorten the range or run locally. " +
          `Body: ${snippet}`
      );
    }
    throw new Error(
      `Invalid JSON from server (HTTP ${res.status}): ${snippet}`
    );
  }
}

/**
 * Firebase JWT for Authorization / body — strip BOM/whitespace only.
 * Safe for Safari Headers (must be printable ASCII without spaces).
 */
export function cleanClientIdToken(token: string): string {
  return String(token ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\s+/g, "")
    .replace(/[^\x21-\x7E]/g, "")
    .trim();
}
