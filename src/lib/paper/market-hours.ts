/** NSE cash session helpers (IST). */

const OPEN = 9 * 60 + 15;
const CLOSE = 15 * 60 + 30;

function istParts(ms = Date.now()) {
  const d = new Date(ms + 5.5 * 60 * 60 * 1000);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    da: d.getUTCDate(),
    day: d.getUTCDay(), // 0 Sun
    mins: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

/** Today YYYY-MM-DD in IST */
export function todayIst(ms = Date.now()): string {
  const { y, mo, da } = istParts(ms);
  return `${y}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`;
}

/** Calendar day N days before (IST date arithmetic via UTC date of shifted clock). */
export function addIstDays(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + delta * 86400000;
  const x = new Date(t);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}-${String(x.getUTCDate()).padStart(2, "0")}`;
}

export function isWeekdayIst(ms = Date.now()): boolean {
  const { day } = istParts(ms);
  return day >= 1 && day <= 5;
}

/** True during Mon–Fri 09:15–15:30 IST (approx session; no holiday calendar). */
export function isNseSessionOpen(ms = Date.now()): boolean {
  if (!isWeekdayIst(ms)) return false;
  const { mins } = istParts(ms);
  return mins >= OPEN && mins <= CLOSE;
}

export function sessionStatus(ms = Date.now()): {
  open: boolean;
  label: string;
  today: string;
} {
  const today = todayIst(ms);
  if (!isWeekdayIst(ms)) {
    return { open: false, label: "Weekend — paper waits for next session", today };
  }
  const { mins } = istParts(ms);
  if (mins < OPEN) {
    return { open: false, label: "Pre-open — starts 09:15 IST", today };
  }
  if (mins > CLOSE) {
    return { open: false, label: "Session closed — resumes next weekday 09:15 IST", today };
  }
  return { open: true, label: "Market open — paper algo running", today };
}
