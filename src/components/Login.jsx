import React, { useState } from "react";
import {
  signInWithPassword,
  signInWithMagicLink,
} from "../services/auth.js";

/**
 * Login — same UX as the dashboard's Login screen so a student
 * who can sign in there can sign in here with the same credentials.
 *
 * Includes a "Continue as guest" path that keeps the existing
 * localStorage-only flow available for demos.
 */
export default function Login({ onGuest }) {
  const [mode, setMode] = useState("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [magicSent, setMagicSent] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!email) return;
    if (mode === "password" && password.length < 6) {
      setErrorMsg("Password must be at least 6 characters.");
      return;
    }
    setErrorMsg("");
    setSubmitting(true);

    const result =
      mode === "password"
        ? await signInWithPassword(email.trim(), password)
        : await signInWithMagicLink(email.trim());

    setSubmitting(false);

    if (result.error) {
      setErrorMsg(result.error.message || "Couldn't sign in. Try again.");
      return;
    }
    if (mode === "magic") setMagicSent(true);
  }

  if (magicSent) {
    return (
      <div className="login-shell">
        <div className="login-card">
          <div className="brand-mark">VPA</div>
          <h1 className="login-title">Check your email</h1>
          <p className="login-sub">
            We sent a one-time sign-in link to <strong>{email}</strong>. Tap it
            on this device to continue.
          </p>
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setMagicSent(false);
              setEmail("");
            }}
          >
            Use a different email
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="brand-mark">VPA · Reading Academy</div>
        <h1 className="login-title">Sign in</h1>
        <p className="login-sub">
          Use your VPA student account. Same email and password as your dashboard.
        </p>

        <div className="login-tabs">
          <button
            type="button"
            className={`login-tab ${mode === "password" ? "active" : ""}`}
            onClick={() => { setMode("password"); setErrorMsg(""); }}
          >
            Password
          </button>
          <button
            type="button"
            className={`login-tab ${mode === "magic" ? "active" : ""}`}
            onClick={() => { setMode("magic"); setErrorMsg(""); }}
          >
            Email link
          </button>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          <input
            type="email"
            className="login-input"
            placeholder="email@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
            autoFocus
          />
          {mode === "password" && (
            <input
              type="password"
              className="login-input"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              minLength={6}
              required
            />
          )}
          <button
            type="submit"
            className="btn large login-submit"
            disabled={submitting}
          >
            {submitting
              ? "Working…"
              : mode === "magic"
              ? "Send sign-in link"
              : "Sign in"}
          </button>
          {errorMsg && <div className="login-error">{errorMsg}</div>}
        </form>

        {onGuest && (
          <>
            <div className="login-divider">or</div>
            <button
              type="button"
              className="btn ghost login-guest"
              onClick={onGuest}
            >
              Continue as guest
            </button>
            <div className="login-sub" style={{ fontSize: 12, marginTop: 8 }}>
              Guest mode runs the demo locally — progress isn't synced.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
