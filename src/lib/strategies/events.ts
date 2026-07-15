/** Cross-page strategy list refresh (Backtest ↔ Paper ↔ Market Watch). */

export const STRATEGIES_CHANGED_EVENT = "tradepulse:strategies-changed";

export function notifyStrategiesChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(STRATEGIES_CHANGED_EVENT));
}
