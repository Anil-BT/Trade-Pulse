import fs from "fs";
import path from "path";
import os from "os";

/**
 * Writable disk cache root.
 * - Local: <cwd>/.data-cache
 * - Vercel / Lambda: /tmp/... (project dir is read-only)
 */
let resolved: string | null = null;

export function getCacheDir(): string {
  if (resolved) return resolved;

  const onServerless =
    process.env.VERCEL === "1" ||
    process.env.AWS_LAMBDA_FUNCTION_NAME != null ||
    process.env.LAMBDA_TASK_ROOT != null;

  const candidates = onServerless
    ? [
        path.join(os.tmpdir(), "tradepulse-data-cache"),
        path.join("/tmp", "tradepulse-data-cache"),
      ]
    : [
        path.join(process.cwd(), ".data-cache"),
        path.join(os.tmpdir(), "tradepulse-data-cache"),
      ];

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      // prove write access
      const probe = path.join(dir, ".write-probe");
      fs.writeFileSync(probe, "ok");
      fs.unlinkSync(probe);
      resolved = dir;
      return dir;
    } catch {
      // try next
    }
  }

  // Last resort: still return tmp path; callers must tolerate write failures
  resolved = path.join(os.tmpdir(), "tradepulse-data-cache");
  return resolved;
}

/** Create cache dir if possible. Never throws. */
export function ensureCacheDir(): string {
  const dir = getCacheDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore — read/write callers catch their own errors
  }
  return dir;
}
