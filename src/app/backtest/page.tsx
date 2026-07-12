import { AuthGate } from "@/components/AuthGate";
import { AppHeader } from "@/components/AppHeader";
import { BacktestApp } from "@/components/BacktestApp";

export default function BacktestPage() {
  return (
    <main className="flex-1">
      <AuthGate>
        <AppHeader />
        <BacktestApp />
      </AuthGate>
    </main>
  );
}
