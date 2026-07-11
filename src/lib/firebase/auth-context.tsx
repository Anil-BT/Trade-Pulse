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
  updateProfile,
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
  signUpWithEmail: (
    email: string,
    password: string,
    displayName?: string
  ) => Promise<void>;
  updateDisplayName: (name: string) => Promise<void>;
  signOut: () => Promise<void>;
  clearError: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const configured = isFirebaseConfigured();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(configured);
  const [error, setError] = useState<string | null>(null);
  /** Bump to force re-render after profile update (User object mutates). */
  const [profileTick, setProfileTick] = useState(0);

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

  const signUpWithEmail = useCallback(
    async (email: string, password: string, displayName?: string) => {
      const fb = getFirebase();
      if (!fb) {
        setError("Firebase is not configured.");
        return;
      }
      setError(null);
      try {
        const cred = await createUserWithEmailAndPassword(
          fb.auth,
          email.trim(),
          password
        );
        const name = displayName?.trim();
        if (name) {
          await updateProfile(cred.user, { displayName: name });
          setProfileTick((t) => t + 1);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Sign-up failed");
      }
    },
    []
  );

  const updateDisplayName = useCallback(async (name: string) => {
    const fb = getFirebase();
    const current = fb?.auth.currentUser;
    if (!current) {
      setError("Not signed in.");
      return;
    }
    const clean = name.trim();
    if (!clean) {
      setError("Name cannot be empty.");
      return;
    }
    setError(null);
    try {
      await updateProfile(current, { displayName: clean });
      // Refresh user from auth so UI picks up new displayName
      setUser(fb.auth.currentUser);
      setProfileTick((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update name");
      throw e;
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
      updateDisplayName,
      signOut,
      clearError: () => setError(null),
    }),
    // profileTick forces consumers to re-read user.displayName after updateProfile
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      configured,
      user,
      loading,
      error,
      signInWithGoogle,
      signInWithEmail,
      signUpWithEmail,
      updateDisplayName,
      signOut,
      profileTick,
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
