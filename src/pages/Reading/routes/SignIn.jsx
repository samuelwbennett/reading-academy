// src/pages/Reading/routes/SignIn.jsx
//
// Magic-link sign-in. Magic link is the right primitive for K-2 pilots:
// the teacher (or parent) types their email, hits a button, and clicks
// the link from their inbox. No passwords on a shared device.
//
// Anonymous mode is still supported app-wide. This route is purely
// optional — useful for syncing state across devices or for the
// teacher dashboard view.

import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../../lib/auth/AuthProvider.jsx";
import {
  signInWithMagicLink,
  signInWithPassword,
} from "../../../services/auth.js";
import { ROUTES } from "../../../config/routes.js";

// Students sign in (password mode) with a bare username (e.g.
// "jacksonleever") and have a synthesized, non-deliverable email on file.
// Teachers/parents use a real email. Normalize: a value with no "@" is a
// student username and gets the student domain appended; anything with an
// "@" passes through untouched. Shared Supabase project with the
// orchestration app, so the domain matches app.elevateedwards.com.
const STUDENT_EMAIL_DOMAIN = "@students.elevateedwards.com";

function toLoginEmail(value) {
  const v = (value || "").trim().toLowerCase();
  if (!v) return v;
  return v.includes("@") ? v : v + STUDENT_EMAIL_DOMAIN;
}

// Pull ?invite=<token> from the URL on first render. Survives both
// /reading/signin?invite=… and /reading/signin?... (the magic-link
// redirect appends Supabase's own params).
function readInviteToken() {
  if (typeof window === "undefined") return null;
  try {
    const sp = new URLSearchParams(window.location.search);
    const t = sp.get("invite");
    return t && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

async function claimInvite(token, accessToken) {
  if (!token || !accessToken) return { ok: false, reason: "missing token or jwt" };
  try {
    const res = await fetch("/api/claim-student-invite", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ token }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, reason: json?.error || `status ${res.status}` };
    }
    return { ok: true, studentId: json.studentId, student: json.student };
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) };
  }
}

export default function SignIn() {
  const { session, student, profile, signOut, syncStatus, reprovision } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState("magic"); // "magic" | "password"
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const [inviteToken] = useState(() => readInviteToken());
  const [inviteStatus, setInviteStatus] = useState(null);
  const inviteClaimedRef = useRef(false);

  // When a session arrives AND we have an invite token in the URL,
  // claim it once. Idempotent: claim returns the same student if
  // already linked.
  useEffect(() => {
    if (!inviteToken) return;
    if (!session?.access_token) return;
    if (inviteClaimedRef.current) return;
    inviteClaimedRef.current = true;
    setInviteStatus({ phase: "claiming" });
    (async () => {
      const result = await claimInvite(inviteToken, session.access_token);
      if (result.ok) {
        setInviteStatus({ phase: "ok", student: result.student });
        // Re-run provisioning so the SignedInPanel re-reads the
        // updated profile (role: student, linked student row).
        await reprovision?.();
        // Strip the token from the URL so a refresh doesn't re-claim.
        try {
          const url = new URL(window.location.href);
          url.searchParams.delete("invite");
          window.history.replaceState({}, "", url.toString());
        } catch { /* noop */ }
      } else {
        setInviteStatus({ phase: "error", reason: result.reason });
        inviteClaimedRef.current = false; // allow retry
      }
    })();
  }, [inviteToken, session?.access_token, reprovision]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setSubmitting(true);
    try {
      if (mode === "magic") {
        const { error: err } = await signInWithMagicLink(email.trim());
        if (err) throw err;
        setMessage(
          `Check ${email.trim()} for a sign-in link. You can close this tab while you wait.`,
        );
      } else {
        const { error: err } = await signInWithPassword(toLoginEmail(email), password);
        if (err) throw err;
        setMessage("Signed in.");
      }
    } catch (err) {
      setError(err.message || "Sign-in failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="ra-app">
      <div className="ra-app-inner">
        <header className="ra-header">
          <Link to={ROUTES.READING} className="ra-header-back">
            ← Reading Academy
          </Link>
          <h1 className="ra-header-title">Sign in</h1>
          <p className="ra-header-status">
            Optional — sync this device's progress across logins.
          </p>
        </header>

        {inviteToken && (
          <InviteBanner status={inviteStatus} hasSession={!!session?.user} />
        )}
        <section className="ra-card">
          {session?.user ? (
            <SignedInPanel
              user={session.user}
              student={student}
              profile={profile}
              syncStatus={syncStatus}
              onSignOut={signOut}
              reprovision={reprovision}
            />
          ) : (
            <form onSubmit={handleSubmit} className="ra-form">
              <label className="ra-form-label">
                {mode === "password" ? "Username or email" : "Email"}
                <input
                  type={mode === "password" ? "text" : "email"}
                  required
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="ra-form-input"
                  placeholder={
                    mode === "password" ? "Username or email" : "you@example.com"
                  }
                />
                <span
                  style={{
                    display: "block",
                    fontSize: 11,
                    color: "#888",
                    marginTop: 4,
                  }}
                >
                  {mode === "password"
                    ? "Students: just your username. Teachers/parents: your email."
                    : "Any email works — school, gmail, parent address, anything."}
                </span>
              </label>

              {mode === "password" && (
                <label className="ra-form-label">
                  Password
                  <input
                    type="password"
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="ra-form-input"
                  />
                </label>
              )}

              <div className="ra-actions">
                <button
                  type="submit"
                  className="ra-btn ra-btn-primary"
                  disabled={submitting}
                >
                  {submitting
                    ? "Sending…"
                    : mode === "magic"
                    ? "Send sign-in link"
                    : "Sign in"}
                </button>
                <button
                  type="button"
                  className="ra-link"
                  onClick={() =>
                    setMode((m) => (m === "magic" ? "password" : "magic"))
                  }
                >
                  {mode === "magic"
                    ? "Use a password instead"
                    : "Use a magic link instead"}
                </button>
              </div>

              {message && (
                <p className="ra-card-sub" style={{ color: "#27a", marginTop: 12 }}>
                  {message}
                </p>
              )}
              {error && (
                <p className="ra-card-sub" style={{ color: "#c33", marginTop: 12 }}>
                  {error}
                </p>
              )}

              <p className="ra-card-sub" style={{ marginTop: 16 }}>
                You can keep using Reading Academy without signing in. Local
                progress stays on this device. Signing in makes it portable.
              </p>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}

const STATUS_COPY = {
  idle: { headline: "Signed in", body: null, tone: "neutral" },
  syncing: {
    headline: "Setting things up…",
    body: "Provisioning your account and reconciling local progress.",
    tone: "neutral",
  },
  teacher_ready: {
    headline: "Teacher account ready",
    body:
      "You can create classes, add students, and view the cohort action queue. Open the roster to get started.",
    tone: "good",
  },
  admin_ready: {
    headline: "Admin account ready",
    body:
      "Full access to organizations, teachers, classes, and students. Use admin powers carefully — every change is logged.",
    tone: "good",
  },
  student_synced: {
    headline: "Student account synced",
    body: "Your progress is loaded and will save across devices.",
    tone: "good",
  },
  awaiting_assignment: {
    headline: "Account created — awaiting roster assignment",
    body:
      "Your account exists, but a teacher hasn't added you to a class yet. Today's session will show real data once you're enrolled.",
    tone: "warn",
  },
  parent_ready: {
    headline: "Parent account ready",
    body: "You can view recaps for the children linked to this email.",
    tone: "good",
  },
  unknown_role: {
    headline: "Account in an unusual state",
    body: "Hit Refresh below to retry provisioning. If it persists, contact support.",
    tone: "warn",
  },
  error: {
    headline: "Something went wrong",
    body: "Sync failed. Open devtools console for details.",
    tone: "bad",
  },
  signed_out: { headline: "Signed out", body: null, tone: "neutral" },
};

const ROLE_CHIP_COLOR = {
  teacher: { bg: "#27a", fg: "white" },
  admin: { bg: "#52d", fg: "white" },
  student: { bg: "#2a7", fg: "white" },
  parent: { bg: "#a72", fg: "white" },
  unknown: { bg: "#bbb", fg: "white" },
};

function ctasForRole(role) {
  // Returns an array of { label, href, variant } for the action row.
  switch (role) {
    case "teacher":
      return [
        { label: "Open roster", href: "/reading/roster", variant: "primary" },
        { label: "Open actions", href: "/reading/actions", variant: "secondary" },
      ];
    case "admin":
      return [
        { label: "Open roster", href: "/reading/roster", variant: "primary" },
        { label: "Open actions", href: "/reading/actions", variant: "secondary" },
        { label: "Teacher dashboard", href: "/reading/debug", variant: "secondary" },
      ];
    case "student":
      return [
        { label: "Continue learning", href: "/reading", variant: "primary" },
      ];
    case "parent":
      return [
        { label: "Continue learning", href: "/reading", variant: "primary" },
      ];
    default:
      return [];
  }
}

const TONE_COLOR = {
  neutral: "#666",
  good: "#27a",
  warn: "#a72",
  bad: "#c33",
};

function statusCopyFor(status) {
  if (!status) return STATUS_COPY.idle;
  if (status.startsWith("reconciled:")) return STATUS_COPY.student_synced;
  if (status.startsWith("flushed:")) return STATUS_COPY.student_synced;
  return STATUS_COPY[status] || {
    headline: "Signed in",
    body: `Status: ${status}`,
    tone: "neutral",
  };
}

function InviteBanner({ status, hasSession }) {
  if (!hasSession && !status) {
    return (
      <section
        className="ra-card"
        style={{ marginBottom: 16, background: "#f3f7fb", borderLeft: "3px solid #27a" }}
      >
        <strong>You've been invited to a class.</strong>{" "}
        <span className="ra-card-sub">Sign in below — your account will be linked to your student profile automatically.</span>
      </section>
    );
  }
  if (status?.phase === "claiming") {
    return (
      <section className="ra-card" style={{ marginBottom: 16, background: "#f3f7fb" }}>
        Claiming invite…
      </section>
    );
  }
  if (status?.phase === "ok") {
    return (
      <section
        className="ra-card"
        style={{ marginBottom: 16, background: "#e9f6ee", borderLeft: "3px solid #27a" }}
      >
        <strong>Invite accepted!</strong>{" "}
        <span className="ra-card-sub">
          Linked to <strong>{status.student?.display_name || "your student profile"}</strong>. Your progress will sync from now on.
        </span>
      </section>
    );
  }
  if (status?.phase === "error") {
    return (
      <section
        className="ra-card"
        style={{ marginBottom: 16, background: "#fdecec", borderLeft: "3px solid #c33" }}
      >
        <strong>Couldn't claim invite:</strong> {status.reason}
        <div className="ra-card-sub" style={{ marginTop: 4 }}>
          Ask the teacher to send a fresh invite if this persists.
        </div>
      </section>
    );
  }
  return null;
}

function SignedInPanel({ user, student, profile, syncStatus, onSignOut, reprovision }) {
  const copy = statusCopyFor(syncStatus);
  const role = profile?.role || "unknown";
  const chip = ROLE_CHIP_COLOR[role] || ROLE_CHIP_COLOR.unknown;
  const ctas = ctasForRole(role);
  // Students don't see the role chip or the raw sync-status code.
  // Teachers/admins keep the diagnostics visible since this page
  // doubles as their account/debug entry point.
  const isStaff = role === "teacher" || role === "admin";

  return (
    <div>
      <h2 className="ra-card-title">{copy.headline}</h2>
      <p className="ra-card-sub" style={{ marginTop: 4 }}>
        {user.email}
        {profile?.display_name && profile.display_name !== user.email && (
          <> · <strong>{profile.display_name}</strong></>
        )}
        {isStaff && (
          <span
            style={{
              marginLeft: 8,
              fontSize: 11,
              padding: "2px 8px",
              borderRadius: 999,
              background: chip.bg,
              color: chip.fg,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              fontWeight: 600,
            }}
          >
            {role}
          </span>
        )}
      </p>
      {copy.body && (
        <p
          className="ra-card-sub"
          style={{ marginTop: 10, color: TONE_COLOR[copy.tone] || "#444" }}
        >
          {copy.body}
        </p>
      )}
      {student?.display_name && (
        <p className="ra-card-sub" style={{ marginTop: 8 }}>
          Linked student: <strong>{student.display_name}</strong>
        </p>
      )}
      {isStaff && (
        <p className="ra-card-sub" style={{ marginTop: 8, fontSize: 11, color: "#888" }}>
          sync status: <code className="ra-id">{syncStatus}</code>
        </p>
      )}
      <div className="ra-actions" style={{ marginTop: 18, display: "flex", gap: 10, flexWrap: "wrap" }}>
        {ctas.map((c) => (
          <a
            key={c.href}
            href={c.href}
            className={`ra-btn ra-btn-${c.variant}`}
          >
            {c.label}
          </a>
        ))}
        <button
          type="button"
          className="ra-btn ra-btn-secondary"
          onClick={reprovision}
        >
          Refresh
        </button>
        <button
          type="button"
          className="ra-btn ra-btn-secondary"
          onClick={onSignOut}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
