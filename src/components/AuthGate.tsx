"use client";

import { useState, type ReactNode } from "react";
import { useAuth } from "@/lib/firebase/auth-context";

/**
 * Blocks the entire app until the user is signed in.
 * When Firebase is not configured, shows setup message only.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const {
    configured,
    user,
    loading,
    error,
    signInWithGoogle,
    signInWithEmail,
    signUpWithEmail,
    clearError,
  } = useAuth();

  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);

  if (loading) {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center px-5">
        <p className="text-sm text-neutral-500">Checking session…</p>
      </div>
    );
  }

  if (!configured) {
    return (
      <div className="mx-auto flex min-h-[70vh] max-w-md flex-col items-center justify-center px-5 text-center">
        <p className="text-xs font-medium tracking-[0.2em] text-neutral-500 uppercase">
          TradePulse
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">
          Auth not configured
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-neutral-600">
          Add Firebase env vars and restart the app. See{" "}
          <code className="text-xs">docs/FIREBASE.md</code>.
        </p>
      </div>
    );
  }

  if (user) {
    return <>{children}</>;
  }

  async function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    clearError();
    try {
      if (mode === "signup") {
        await signUpWithEmail(email, password, displayName);
      } else {
        await signInWithEmail(email, password);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-5 py-16">
      <div className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)] sm:p-8">
        <p className="text-xs font-medium tracking-[0.2em] text-neutral-500 uppercase">
          TradePulse
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-black">
          Sign in to continue
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-neutral-500">
          Backtests, F&amp;O scans, and saved strategies require an account.
        </p>

        <button
          type="button"
          onClick={async () => {
            setBusy(true);
            clearError();
            try {
              await signInWithGoogle();
            } finally {
              setBusy(false);
            }
          }}
          disabled={busy}
          className="mt-6 w-full rounded-full border border-neutral-300 px-4 py-2.5 text-sm font-medium hover:border-black disabled:opacity-50"
        >
          Continue with Google
        </button>

        <div className="my-4 flex items-center gap-2 text-[10px] tracking-wide text-neutral-400 uppercase">
          <span className="h-px flex-1 bg-neutral-200" />
          or email
          <span className="h-px flex-1 bg-neutral-200" />
        </div>

        <form onSubmit={submitEmail} className="space-y-3">
          {mode === "signup" && (
            <div>
              <label className="mb-1 block text-xs font-medium text-neutral-500">
                Display name
              </label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
                className="field-input w-full text-sm"
                autoComplete="name"
              />
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-500">
              Email
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="field-input w-full text-sm"
              autoComplete="email"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-500">
              Password
            </label>
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Min 6 characters"
              className="field-input w-full text-sm"
              autoComplete={
                mode === "signup" ? "new-password" : "current-password"
              }
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-full bg-black px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
          >
            {mode === "signup" ? "Create account" : "Sign in"}
          </button>
        </form>

        <button
          type="button"
          onClick={() => {
            setMode((m) => (m === "signin" ? "signup" : "signin"));
            clearError();
          }}
          className="mt-4 w-full text-center text-xs text-neutral-500 hover:text-black"
        >
          {mode === "signup"
            ? "Already have an account? Sign in"
            : "Need an account? Sign up"}
        </button>

        {error && (
          <p className="mt-4 rounded-xl bg-neutral-50 px-3 py-2 text-xs leading-snug text-neutral-700">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
