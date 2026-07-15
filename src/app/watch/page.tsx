import { AuthGate } from "@/components/AuthGate";
import { AppHeader } from "@/components/AppHeader";
import { MarketWatchApp } from "@/components/MarketWatchApp";

export default function MarketWatchPage() {
  return (
    <main className="flex-1">
      <AuthGate>
        <AppHeader />
        <MarketWatchApp />
      </AuthGate>
    </main>
  );
}
