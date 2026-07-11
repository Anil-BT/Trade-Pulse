"use client";

import { useState } from "react";
import { useAuth } from "@/lib/firebase/auth-context";

/**
 * Compact sign-in / account control for the header.
 * Hidden when Firebase env vars are not configured.
 */
export function AuthBar() {
  const {
    configured,
    user,
    loading,
    error,
    signInWithGoogle,
    signInWithEmail,
    signUpWithEmail,
    signOut,
    clearError,
  } = useAuth();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  if (!configured) return null;

  if (loading) {
    return (
      <span className="text-xs text-neutral-400">Checking session…</span>
    );
  }

  if (user) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="max-w-[160px] truncate text-xs text-neutral-600">
          {user.displayName || user.email}
        </span>
        <button
          type="button"
          onClick={() => signOut()}
          className="rounded-full border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:border-black"
        >
          Sign out
        </button>
      </div>
    );
  }

  async function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    clearError();
    try {
      if (mode === "signup") {
        await signUpWithEmail(email, password);
      } else {
        await signInWithEmail(email, password);
      }
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          clearError();
        }}
        className="rounded-full bg-black px-4 py-1.5 text-xs font-medium text-white hover:bg-neutral-800"
      >
        Sign in
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-72 rounded-2xl border border-neutral-200 bg-white p-4 shadow-lg">
          <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
            Account
          </p>
          <p className="mt-1 text-xs text-neutral-500">
            Sign in to sync strategies across devices.
          </p>

          <button
            type="button"
            onClick={async () => {
              setBusy(true);
              clearError();
              try {
                await signInWithGoogle();
                setOpen(false);
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
            className="mt-3 w-full rounded-full border border-neutral-300 px-3 py-2 text-sm font-medium hover:border-black disabled:opacity-50"
          >
            Continue with Google
          </button>

          <div className="my-3 flex items-center gap-2 text-[10px] text-neutral-400 uppercase">
            <span className="h-px flex-1 bg-neutral-200" />
            or email
            <span className="h-px flex-1 bg-neutral-200" />
          </div>

          <form onSubmit={submitEmail} className="space-y-2">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              className="field-input w-full text-sm"
              autoComplete="email"
            />
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password (min 6)"
              className="field-input w-full text-sm"
              autoComplete={
                mode === "signup" ? "new-password" : "current-password"
              }
            />
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-full bg-black px-3 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
            >
              {mode === "signup" ? "Create account" : "Sign in with email"}
            </button>
          </form>

          <button
            type="button"
            onClick={() =>
              setMode((m) => (m === "signin" ? "signup" : "signin"))
            }
            className="mt-2 w-full text-center text-xs text-neutral-500 hover:text-black"
          >
            {mode === "signup"
              ? "Already have an account? Sign in"
              : "Need an account? Sign up"}
          </button>

          {error && (
            <p className="mt-2 text-xs leading-snug text-neutral-700">{error}</p>
          )}
        </div>
      )}
    </div>
  );
}
