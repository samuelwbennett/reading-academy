// useAuth — same shape as the dashboard's useAuth.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getSession,
  onAuthChange,
  signOut as authSignOut,
  fetchLinkedStudent,
} from "../services/auth.js";

export function useAuth() {
  const [session, setSession] = useState(null);
  const [student, setStudent] = useState(null);
  // status: "loading" | "anonymous" | "unlinked" | "ready" | "guest"
  const [status, setStatus] = useState("loading");
  const mountedRef = useRef(true);

  const resolveLinked = useCallback(async (sess) => {
    if (!sess) {
      if (!mountedRef.current) return;
      setStudent(null);
      setStatus("anonymous");
      return;
    }
    const linked = await fetchLinkedStudent();
    if (!mountedRef.current) return;
    setStudent(linked);
    setStatus(linked ? "ready" : "unlinked");
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let unsub = () => {};

    (async () => {
      const sess = await getSession();
      if (!mountedRef.current) return;
      setSession(sess);
      await resolveLinked(sess);
    })();

    unsub = onAuthChange(async (newSession) => {
      if (!mountedRef.current) return;
      setSession(newSession);
      await resolveLinked(newSession);
    });

    return () => {
      mountedRef.current = false;
      unsub();
    };
  }, [resolveLinked]);

  const signOut = useCallback(async () => {
    await authSignOut();
  }, []);

  // Guest mode: no auth, no Supabase, just localStorage. Lets the
  // existing demo flow keep working without forcing sign-in.
  const continueAsGuest = useCallback(() => {
    setStatus("guest");
  }, []);

  const refresh = useCallback(async () => {
    await resolveLinked(session);
  }, [resolveLinked, session]);

  return { session, student, status, signOut, refresh, continueAsGuest };
}
