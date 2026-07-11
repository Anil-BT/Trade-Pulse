import { BacktestApp } from "@/components/BacktestApp";

export default function Home() {
  return (
    <main className="flex-1">
      <nav className="sticky top-0 z-20 border-b border-neutral-200/80 bg-white/80 backdrop-blur-xl">
        <div className="mx-auto flex h-12 max-w-6xl items-center justify-between px-5 sm:px-8">
          <span className="text-sm font-semibold tracking-tight">TradePulse</span>
          <span className="text-xs text-neutral-500">Yahoo · Upstox</span>
        </div>
      </nav>
      <BacktestApp />
    </main>
  );
}
