import React from "react";
import { Link } from "react-router-dom";
import { ROUTES } from "../../../config/routes.js";
import { useAuth } from "../../../lib/auth/AuthProvider.jsx";
import { useStudentMode } from "../../../lib/auth/useStudentMode.js";

// Two header modes (M16-D1):
//   - Student / anonymous: just the product wordmark + a quiet
//     sign-in chip. No nav row, no graph stats, no back-link.
//   - Teacher / admin: full nav with the dashboard surfaces.

export default function ReadingHeader({ nodeCount, valid }) {
  const isStudent = useStudentMode();

  let session = null;
  let student = null;
  try {
    const auth = useAuth();
    session = auth.session;
    student = auth.student;
  } catch {
    /* outside AuthProvider — render anon */
  }
  const signedIn = Boolean(session?.user);

  if (isStudent) {
    return (
      <header
        className="ra-header"
        style={{ paddingBottom: 8, marginBottom: 10 }}
      >
        <h1
          className="ra-header-title"
          style={{ fontSize: 24, margin: 0 }}
        >
          Reading Academy
        </h1>
        {signedIn && student?.display_name ? (
          <p className="ra-header-status" style={{ margin: "4px 0 0", color: "#666" }}>
            Hi, {student.display_name.split(" ")[0]}.
          </p>
        ) : (
          <p className="ra-header-status" style={{ margin: "4px 0 0", color: "#888" }}>
            <Link to="/reading/signin" className="ra-link">
              Sign in to save your progress
            </Link>
          </p>
        )}
      </header>
    );
  }

  // Teacher / admin chrome (unchanged from prior behavior).
  const label = signedIn
    ? student?.display_name
      ? `Signed in · ${student.display_name}`
      : `Signed in · ${session.user.email}`
    : "Sign in to sync";

  return (
    <header className="ra-header">
      <Link to={ROUTES.HOME} className="ra-header-back">
        ← VPA Learning OS
      </Link>
      <h1 className="ra-header-title">Reading Academy</h1>
      <p className="ra-header-status">
        <span className={`ra-header-dot ${valid ? "ok" : "bad"}`} />
        {nodeCount}-node graph loaded{valid ? "" : " (validation errors — see console)"}
        {" · "}
        <Link to="/reading/signin" className="ra-link">
          {label}
        </Link>
      </p>
      <nav
        style={{
          display: "flex",
          gap: 16,
          marginTop: 6,
          fontSize: 13,
          flexWrap: "wrap",
        }}
      >
        <Link to="/reading" className="ra-link">Today</Link>
        <Link to="/reading/diagnostic" className="ra-link">Placement</Link>
        <Link to="/reading/course-tree" className="ra-link">Course tree</Link>
        <Link to="/reading/graph" className="ra-link">Knowledge graph</Link>
        <Link to="/reading/actions" className="ra-link">Actions</Link>
        <Link to="/reading/debug" className="ra-link">Teacher dashboard</Link>
        <Link to="/reading/roster" className="ra-link">Roster</Link>
      </nav>
    </header>
  );
}
