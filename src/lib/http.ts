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

/** Ensure error messages shown to clients stay ASCII-friendly. */
export function safeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const cleaned = raw
    .normalize("NFKC")
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
  return cleaned || "Unknown error";
}
