// src/lib/auth/AuthProvider.jsx
//
// React context that:
//   1. Tracks the Supabase auth session.
//   2. On every fresh sign-in, calls /api/provision-self to create
//      (or fetch) the user_profiles row idempotently. M12-A4: this
//      replaces the old "no_student" gap with role-aware status.
//   3. Resolves the linked student row (if any).
//   4. Reconciles the local M3 StudentModel with the remote row on
//      sign-in.
//   5. Pushes a final flush + state on sign-out.
//
// No UI here. Status values are stable strings the SignIn page +
// debug surfaces translate into friendly copy:
//
//   idle              — no session yet
//   syncing           — provisioning + reconciling
//   teacher_ready     — teacher profile ready, no student row needed
//   student_synced    — student profile + state synced
//   awaiting_assignment — student profile but no app account yet
//   parent_ready      — parent role provisioned
//   error             — something failed; details in console
//   signed_out        — user clicked Sign out

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  getSession,
  onAuthChange,
  signOut as supaSignOut,
  fetchLinkedStudent,
} from "../../services/auth.js";
import {
  startAutoFlush,
  flush,
  resetFlushCaches,
} from "../telemetry/flush";
import {
  reconcileOnSignIn,
  pushRemote,
  resetSyncCaches,
} from "../mastery/sync";
import { setStudentId as setTelemetryStudentId } from "../telemetry/emit";

const AuthCtx = createContext({
  session: null,
  student: null,
  profile: null,
  loading: true,
  signOut: async () => {},
  flushNow: async () => {},
  reprovision: async () => null,
  syncStatus: "idle",
});

export function useAuth() {
  return useContext(AuthCtx);
}

async function callProvisionSelf(jwt) {
  if (!jwt) return null;
  try {
    const res = await fetch("/api/provision-self", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn("[auth] provision-self non-200:", res.status, text);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn("[auth] provision-self threw:", err);
    return null;
  }
}

export default function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [student, setStudent] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncStatus, setSyncStatus] = useState("idle");
  const stopFlushRef = useRef(null);
  const lastUserIdRef = useRef(null);

  // 1. Boot.
  useEffect(() => {
    let mounted = true;
    (async () => {
      const s = await getSession();
      if (!mounted) return;
      setSession(s);
      setLoading(false);
    })();
    stopFlushRef.current = startAutoFlush();
    return () => {
      mounted = false;
      stopFlushRef.current?.();
    };
  }, []);

  // 2. Auth change subscription.
  useEffect(() => {
    const unsub = onAuthChange((s) => setSession(s));
    return () => {
      try { unsub?.(); } catch { /* noop */ }
    };
  }, []);

  // 3. On user change: provision profile, resolve student, reconcile.
  useEffect(() => {
    const uid = session?.user?.id ?? null;
    if (uid === lastUserIdRef.current) return;
    lastUserIdRef.current = uid;

    resetFlushCaches();
    resetSyncCaches();

    if (!uid) {
      setStudent(null);
      setProfile(null);
      setTelemetryStudentId(null);
      setSyncStatus("idle");
      return;
    }

    (async () => {
      setSyncStatus("syncing");

      // A. Provision (idempotent).
      const jwt = session?.access_token;
      const provision = await callProvisionSelf(jwt);
      if (provision?.profile) setProfile(provision.profile);
      const provisionedStudent = provision?.student || null;

      // B. Resolve linked student. The provision call returns it,
      //    but we re-query as a fallback in case provisioning
      //    failed (network, env not configured) — RLS still permits
      //    the self-read.
      const linked = provisionedStudent || (await fetchLinkedStudent());
      setStudent(linked);
      setTelemetryStudentId(linked?.id ?? null);

      // C. Status.
      if (provision?.status) {
        setSyncStatus(provision.status);
      } else if (linked) {
        setSyncStatus("student_synced");
      } else {
        // No provision response, no student — treat as awaiting.
        setSyncStatus("awaiting_assignment");
      }

      // D. State reconcile (only meaningful for students).
      if (linked) {
        try {
          const result = await reconcileOnSignIn();
          setSyncStatus(`reconciled:${result.decision}`);
        } catch (e) {
          console.warn("[auth] reconcile failed", e);
          setSyncStatus("error");
        }
      }

      // E. Drain any queued events from the anonymous session.
      flush().catch(() => {});
    })();
  }, [session?.user?.id, session?.access_token]);

  const signOut = useCallback(async () => {
    try { await flush(); } catch { /* noop */ }
    try { await pushRemote(); } catch { /* noop */ }
    await supaSignOut();
    setSession(null);
    setStudent(null);
    setProfile(null);
    setTelemetryStudentId(null);
    setSyncStatus("signed_out");
  }, []);

  const flushNow = useCallback(async () => {
    setSyncStatus("flushing");
    const r = await flush();
    setSyncStatus(`flushed:${r.flushed}`);
    return r;
  }, []);

  const reprovision = useCallback(async () => {
    const jwt = session?.access_token;
    if (!jwt) return null;
    const result = await callProvisionSelf(jwt);
    if (result?.profile) setProfile(result.profile);
    if (result?.status) setSyncStatus(result.status);
    return result;
  }, [session?.access_token]);

  const value = useMemo(
    () => ({
      session,
      student,
      profile,
      loading,
      signOut,
      flushNow,
      reprovision,
      syncStatus,
    }),
    [session, student, profile, loading, signOut, flushNow, reprovision, syncStatus],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
