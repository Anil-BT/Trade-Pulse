/**
 * Shared Upstox request pacing + rate-limit detection.
 * Cloudflare 1015 / HTTP 429 need long cool-downs, not 500ms retries.
 */

let lastRequestAt = 0;
/** Minimum gap between Upstox HTTP calls (ms). Increases after 429. */
let minGapMs = 400;
let coolUntil = 0;

export function isUpstoxRateLimitError(msg: string): boolean {
  return /429|rate.?limit|1015|too many requests|being rate.limited/i.test(
    msg
  );
}

export function noteUpstoxSuccess() {
  // Slowly recover toward baseline after healthy calls
  minGapMs = Math.max(400, Math.floor(minGapMs * 0.9));
}

export function noteUpstoxRateLimited() {
  // Back off harder after Cloudflare/Upstox 429
  minGapMs = Math.min(8000, Math.max(minGapMs * 2, 2000));
  coolUntil = Date.now() + 60_000; // at least 60s cool-down
}

/** Wait for cool-down + spacing before the next Upstox call. */
export async function waitForUpstoxSlot(): Promise<void> {
  const now = Date.now();
  if (now < coolUntil) {
    await sleep(coolUntil - now);
  }
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < minGapMs) {
    await sleep(minGapMs - elapsed);
  }
  lastRequestAt = Date.now();
}

export function parseRetryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const sec = Number(h);
  if (Number.isFinite(sec) && sec >= 0) return Math.min(sec * 1000, 180_000);
  const when = Date.parse(h);
  if (Number.isFinite(when)) {
    return Math.min(Math.max(0, when - Date.now()), 180_000);
  }
  return null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Backoff delays for 429: 15s, 45s, 90s (plus cool-down). */
export function rateLimitBackoffMs(attempt: number): number {
  const base = [15_000, 45_000, 90_000, 120_000][Math.min(attempt, 3)];
  return base + Math.floor(Math.random() * 2000);
}
