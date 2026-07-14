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
    return cleaned || "Unknown error";
  } catch {
    return "Unknown error";
  }
}

/**
 * Parse fetch Response as JSON without throwing on HTML error pages
 * (e.g. Vercel/Next 500 HTML → "Unexpected token '<' ... is not valid JSON").
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
        : `Server error ${res.status} (empty body)`
    );
  }
  if (trimmed.startsWith("<") || /^<!DOCTYPE/i.test(trimmed)) {
    throw new Error(
      `Server returned HTML instead of JSON (HTTP ${res.status}). ` +
        "Usually a deploy error, timeout, or missing API route — retry or check server logs."
    );
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const snippet = trimmed.slice(0, 120).replace(/\s+/g, " ");
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
