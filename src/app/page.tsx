import { AuthBar } from "@/components/AuthBar";
import { AuthGate } from "@/components/AuthGate";
import { BacktestApp } from "@/components/BacktestApp";

export default function Home() {
  return (
    <main className="flex-1">
      <AuthGate>
        <nav className="sticky top-0 z-20 border-b border-neutral-200/80 bg-white/80 backdrop-blur-xl">
          <div className="mx-auto flex h-12 max-w-6xl items-center justify-between gap-3 px-5 sm:px-8">
            <span className="shrink-0 text-sm font-semibold tracking-tight">
              TradePulse
            </span>
            <AuthBar />
          </div>
        </nav>
        <BacktestApp />
      </AuthGate>
    </main>
  );
}
