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
    .replace(/[^\x21-\x7E]/g, "") // no spaces in tokens
    .trim();
}

/** Ensure error messages shown to clients stay ASCII-friendly. */
export function safeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, "...");
}
