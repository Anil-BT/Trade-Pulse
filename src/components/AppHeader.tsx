"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AuthBar } from "./AuthBar";

const NAV = [
  { href: "/backtest", label: "Backtest" },
  { href: "/paper", label: "Paper trading" },
] as const;

export function AppHeader() {
  const pathname = usePathname() || "/";

  return (
    <nav className="sticky top-0 z-20 border-b border-neutral-200/80 bg-white/80 backdrop-blur-xl">
      <div className="mx-auto flex h-12 max-w-6xl items-center justify-between gap-4 px-5 sm:px-8">
        <div className="flex min-w-0 items-center gap-6">
          <Link
            href="/"
            className="shrink-0 text-sm font-semibold tracking-tight text-black hover:opacity-80"
          >
            TradePulse
          </Link>
          <div className="flex items-center gap-1">
            {NAV.map((item) => {
              const active =
                pathname === item.href ||
                pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                    active
                      ? "bg-black text-white"
                      : "text-neutral-600 hover:bg-neutral-100 hover:text-black"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>
        <AuthBar />
      </div>
    </nav>
  );
}
