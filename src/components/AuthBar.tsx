"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/firebase/auth-context";

/**
 * Account controls when signed in: show name, edit name, sign out.
 */
export function AuthBar() {
  const { user, error, signOut, updateDisplayName, clearError } = useAuth();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      setName(user.displayName || "");
    }
  }, [user, user?.displayName]);

  if (!user) return null;

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    clearError();
    setSavedMsg(null);
    try {
      await updateDisplayName(name);
      setEditing(false);
      setSavedMsg("Name updated");
      setTimeout(() => setSavedMsg(null), 2000);
    } catch {
      // error shown via context
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {editing ? (
        <form
          onSubmit={saveName}
          className="flex flex-wrap items-center gap-2"
        >
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Display name"
            className="field-input w-40 py-1.5 text-xs sm:w-48"
            autoFocus
            maxLength={80}
            disabled={busy}
          />
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="rounded-full bg-black px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setName(user.displayName || "");
              clearError();
            }}
            className="rounded-full border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:border-black"
          >
            Cancel
          </button>
        </form>
      ) : (
        <>
          <button
            type="button"
            onClick={() => {
              setEditing(true);
              clearError();
            }}
            className="max-w-[180px] truncate text-left text-xs font-medium text-neutral-700 underline-offset-2 hover:underline sm:max-w-[240px]"
            title="Update display name"
          >
            {user.displayName || user.email || "Account"}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(true);
              clearError();
            }}
            className="rounded-full border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:border-black"
          >
            Edit name
          </button>
          <button
            type="button"
            onClick={() => signOut()}
            className="rounded-full border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:border-black"
          >
            Sign out
          </button>
        </>
      )}
      {savedMsg && (
        <span className="text-[11px] text-neutral-500">{savedMsg}</span>
      )}
      {error && editing && (
        <span className="w-full text-right text-[11px] text-neutral-600">
          {error}
        </span>
      )}
    </div>
  );
}
