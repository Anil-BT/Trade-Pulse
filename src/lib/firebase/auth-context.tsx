"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as fbSignOut,
  type User,
} from "firebase/auth";
import { getFirebase, isFirebaseConfigured } from "./client";

type AuthContextValue = {
  configured: boolean;
  user: User | null;
  loading: boolean;
  error: string | null;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signUpWithEmail: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  clearError: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const configured = isFirebaseConfigured();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(configured);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fb = getFirebase();
    if (!fb) {
      setLoading(false);
      return;
    }
    const unsub = onAuthStateChanged(fb.auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return () => unsub();
  }, []);

  const signInWithGoogle = useCallback(async () => {
    const fb = getFirebase();
    if (!fb) {
      setError("Firebase is not configured. Add env vars (see docs/FIREBASE.md).");
      return;
    }
    setError(null);
    try {
      await signInWithPopup(fb.auth, new GoogleAuthProvider());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Google sign-in failed");
    }
  }, []);

  const signInWithEmail = useCallback(async (email: string, password: string) => {
    const fb = getFirebase();
    if (!fb) {
      setError("Firebase is not configured.");
      return;
    }
    setError(null);
    try {
      await signInWithEmailAndPassword(fb.auth, email.trim(), password);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed");
    }
  }, []);

  const signUpWithEmail = useCallback(async (email: string, password: string) => {
    const fb = getFirebase();
    if (!fb) {
      setError("Firebase is not configured.");
      return;
    }
    setError(null);
    try {
      await createUserWithEmailAndPassword(fb.auth, email.trim(), password);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-up failed");
    }
  }, []);

  const signOut = useCallback(async () => {
    const fb = getFirebase();
    if (!fb) return;
    setError(null);
    await fbSignOut(fb.auth);
  }, []);

  const value = useMemo(
    () => ({
      configured,
      user,
      loading,
      error,
      signInWithGoogle,
      signInWithEmail,
      signUpWithEmail,
      signOut,
      clearError: () => setError(null),
    }),
    [
      configured,
      user,
      loading,
      error,
      signInWithGoogle,
      signInWithEmail,
      signUpWithEmail,
      signOut,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
