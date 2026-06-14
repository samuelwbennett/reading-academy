// src/lib/auth/useStudentSession.js (M16-L5)
//
// Passwordless student session — separate auth surface from Supabase
// Auth (which is teacher/admin/parent only). Stores the session token
// in localStorage, validates it against /api/student-session on
// mount, and exposes a tiny imperative API for sign-in / sign-out.
//
// Why localStorage and not a cookie:
//   - Vercel's catch-all dispatcher already sets CORS *; pushing
//     auth into a cookie would force same-site rules on every API
//     call. localStorage is fine for the kid-account threat model
//     (low value target, school-managed device, teacher can revoke
//     server-side at any time).
//   - The token is stored in one place under one key the teacher
//     can blow away by clicking "sign out" at the device level.
//
// Storage shape:
//   localStorage["ra:student-session"] = JSON.stringify({
//     token, expiresAt, student: { id, firstName, lastInitial,
//                                 grade, avatarEmoji }
//   })

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "ra:student-session";

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.token || !parsed?.student?.id) return null;
    if (parsed.expiresAt && new Date(parsed.expiresAt).getTime() < Date.now()) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeStored(value) {
  try {
    if (value == null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // localStorage might be disabled — student stays signed-out.
  }
}

export async function loginStudent({ code, studentId, pin, deviceLabel }) {
  const res = await fetch("/api/student-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, studentId, pin, deviceLabel }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.ok) {
    const err = new Error(json?.error || `login_failed_${res.status}`);
    err.status = res.status;
    err.code = json?.error;
    throw err;
  }
  const value = {
    token: json.sessionToken,
    expiresAt: json.expiresAt,
    student: json.student,
  };
  writeStored(value);
  return value;
}

export function signOutStudent() {
  writeStored(null);
}

export function getStoredStudentSession() {
  return readStored();
}

export function getStudentSessionToken() {
  return readStored()?.token || null;
}

// Hook: returns { ready, session, signOut }. `ready` flips true once
// the on-mount validation has finished (whether or not a session was
// found). Components can render a soft loading state until then.
export function useStudentSession() {
  const [session, setSession] = useState(() => readStored());
  const [ready, setReady] = useState(false);

  // Validate stored token against the server on mount. If the server
  // says the session is invalid/expired, clear it. We don't block
  // the UI on the network call — the optimistic local copy renders
  // immediately, server validation just confirms.
  useEffect(() => {
    let cancelled = false;
    const stored = readStored();
    if (!stored?.token) {
      setReady(true);
      return;
    }
    (async () => {
      try {
        const res = await fetch("/api/student-session", {
          headers: { Authorization: `Bearer ${stored.token}` },
        });
        if (cancelled) return;
        if (res.status === 401 || res.status === 403 || res.status === 410) {
          writeStored(null);
          setSession(null);
        } else if (res.ok) {
          const json = await res.json().catch(() => null);
          if (json?.ok && json?.student) {
            const next = {
              token: stored.token,
              expiresAt: stored.expiresAt,
              student: json.student,
            };
            writeStored(next);
            setSession(next);
          }
        }
      } catch {
        // Network blip — keep optimistic local copy.
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signOut = useCallback(() => {
    signOutStudent();
    setSession(null);
  }, []);

  const refresh = useCallback(() => {
    setSession(readStored());
  }, []);

  return { ready, session, signOut, refresh };
}
