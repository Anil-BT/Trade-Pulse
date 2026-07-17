import Link from "next/link";
import { AuthGate } from "@/components/AuthGate";
import { AppHeader } from "@/components/AppHeader";
import { ResultsPanel } from "@/components/ResultsPanel";

export default function Home() {
  return (
    <main className="flex-1">
      <AuthGate>
        <AppHeader />
        <div className="mx-auto max-w-6xl px-5 pb-24 pt-12 sm:px-8">
          <header className="mb-12 max-w-2xl">
            <p className="mb-3 text-xs font-medium tracking-[0.2em] text-neutral-500 uppercase">
              TradePulse
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-black sm:text-5xl">
              Markets.
              <br />
              <span className="text-neutral-400">Tools that compound.</span>
            </h1>
            <p className="mt-5 text-base leading-relaxed text-neutral-600 sm:text-lg">
              Choose a workspace from the header, or scan upcoming F&amp;O
              results below.
            </p>
          </header>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Link
              href="/backtest"
              className="group rounded-3xl border border-neutral-200 bg-white p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition hover:border-neutral-400"
            >
              <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
                Menu
              </p>
              <h2 className="mt-2 text-xl font-semibold tracking-tight text-black group-hover:underline">
                Backtest
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-neutral-600">
                Historical candles, strategy rules, single-symbol and F&amp;O
                universe scans — what used to be the home page.
              </p>
              <p className="mt-4 text-sm font-medium text-black">Open →</p>
            </Link>

            <Link
              href="/watch"
              className="group rounded-3xl border border-neutral-200 bg-white p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition hover:border-neutral-400"
            >
              <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
                Menu
              </p>
              <h2 className="mt-2 text-xl font-semibold tracking-tight text-black group-hover:underline">
                Market watch
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-neutral-600">
                Multi-strategy F&amp;O scanner — list names where entry
                conditions match on the latest bar.
              </p>
              <p className="mt-4 text-sm font-medium text-black">Open →</p>
            </Link>

            <Link
              href="/paper"
              className="group rounded-3xl border border-neutral-200 bg-white p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition hover:border-neutral-400"
            >
              <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
                Menu
              </p>
              <h2 className="mt-2 text-xl font-semibold tracking-tight text-black group-hover:underline">
                Paper trading
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-neutral-600">
                Same strategies as Backtest on live Upstox data. Logs simulated
                entry/exit — no real orders.
              </p>
              <p className="mt-4 text-sm font-medium text-black">Open →</p>
            </Link>
          </div>

          <ResultsPanel />
        </div>
      </AuthGate>
    </main>
  );
}
