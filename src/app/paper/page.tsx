import { AuthGate } from "@/components/AuthGate";
import { AppHeader } from "@/components/AppHeader";
import { PaperTradingApp } from "@/components/PaperTradingApp";

export default function PaperTradingPage() {
  return (
    <main className="flex-1">
      <AuthGate>
        <AppHeader />
        <PaperTradingApp />
      </AuthGate>
    </main>
  );
}
