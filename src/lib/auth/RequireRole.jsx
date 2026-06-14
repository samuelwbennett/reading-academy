// src/lib/auth/RequireRole.jsx (M19-3)
//
// Route guard for teacher/admin-only pages (Roster, Debug, StudentDetail).
//
// Resolution order:
//   1. If a passwordless student session is active in the browser, the
//      caller is unambiguously a student — redirect to /reading and
//      never let them see teacher chrome (defense in depth; the kid
//      can't do anything destructive here, but they shouldn't see
//      class codes or other kids' data even at rest).
//   2. If still loading auth state, render a soft "Loading…" card
//      instead of a flash of the protected page.
//   3. If no Supabase session, render a friendly "Sign in" panel
//      pointing at /reading/signin.
//   4. If signed in but role isn't in `allow`, render an explicit
//      "Not authorized" panel — better than a silent redirect because
//      the teacher might need to ask an admin to flip their role.
//
// The authoritative security boundary is still RLS in Postgres. This
// component is a UX guard so the wrong audience doesn't bump into
// half-loaded chrome and zero-state errors.

import React from "react";
import { Link, Navigate } from "react-router-dom";
import { useAuth } from "./AuthProvider.jsx";
import { getStoredStudentSession } from "./useStudentSession.js";

const TEACHER_ROLES = new Set(["teacher", "admin"]);
const ADMIN_ONLY = new Set(["admin"]);

export default function RequireRole({
  allow = "teacher", // "teacher" (teacher + admin), "admin", or array of role strings
  children,
}) {
  const studentSession = getStoredStudentSession();
  if (studentSession) {
    // Student in this browser — bounce.
    return <Navigate to="/reading" replace />;
  }

  const { session, profile, loading } = useAuth();

  if (loading) {
    return (
      <div className="ra-app">
        <div className="ra-app-inner" style={{ padding: 32, color: "#666" }}>
          Loading…
        </div>
      </div>
    );
  }

  if (!session?.user) {
    return <SignedOutFallback />;
  }

  const role = profile?.role ?? null;
  const allowed = resolveAllowed(allow);
  if (!role || !allowed.has(role)) {
    return <NotAuthorizedFallback currentRole={role} requiredRoles={Array.from(allowed)} />;
  }

  return children;
}

function resolveAllowed(allow) {
  if (Array.isArray(allow)) return new Set(allow);
  if (allow === "admin") return ADMIN_ONLY;
  if (allow === "teacher" || allow === "teacher_or_admin") return TEACHER_ROLES;
  return TEACHER_ROLES;
}

function SignedOutFallback() {
  return (
    <div className="ra-app">
      <div className="ra-app-inner">
        <section className="ra-card">
          <h2 className="ra-card-title">Sign in first</h2>
          <p className="ra-card-sub">
            This page is for teachers and admins. Sign in with your school
            email to continue.
          </p>
          <div className="ra-actions" style={{ marginTop: 14 }}>
            <Link to="/reading/signin" className="ra-btn ra-btn-primary">
              Go to sign-in
            </Link>
            <Link to="/reading" className="ra-btn" style={{ marginLeft: 8 }}>
              Back to today
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}

function NotAuthorizedFallback({ currentRole, requiredRoles }) {
  return (
    <div className="ra-app">
      <div className="ra-app-inner">
        <section className="ra-card">
          <h2 className="ra-card-title">Not authorized</h2>
          <p className="ra-card-sub">
            This page is only for{" "}
            <strong>{requiredRoles.join(" or ")}</strong> accounts. Your
            current role is{" "}
            <code>{currentRole || "unassigned"}</code>.
          </p>
          <p className="ra-card-sub" style={{ marginTop: 10, fontSize: 12, color: "#888" }}>
            If you should have access, an admin can update your role in
            <code> user_profiles</code>. Sign out and back in to refresh.
          </p>
          <div className="ra-actions" style={{ marginTop: 14 }}>
            <Link to="/reading" className="ra-btn ra-btn-primary">
              Back to today
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
