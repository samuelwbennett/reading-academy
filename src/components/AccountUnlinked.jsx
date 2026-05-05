import React from "react";
import { signOut } from "../services/auth.js";

export default function AccountUnlinked({ email, onRefresh, onGuest }) {
  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="brand-mark">VPA · Reading Academy</div>
        <h1 className="login-title">Account isn't linked yet</h1>
        <p className="login-sub">
          You're signed in as <strong>{email || "this account"}</strong>, but
          no student profile is connected to it yet. Ask your admin to link
          your account, then refresh.
        </p>
        <div className="login-actions">
          <button type="button" className="btn large" onClick={onRefresh}>
            I'm linked now — try again
          </button>
          {onGuest && (
            <button type="button" className="btn ghost" onClick={onGuest}>
              Continue as guest instead
            </button>
          )}
          <button type="button" className="link-btn" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
