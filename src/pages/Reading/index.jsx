import React, { Suspense, lazy } from "react";
import { Routes, Route } from "react-router-dom";
import AuthProvider from "../../lib/auth/AuthProvider.jsx";
import RequireRole from "../../lib/auth/RequireRole.jsx";
import Today from "./routes/Today.jsx";
import Diagnostic from "./routes/Diagnostic.jsx";
import Drill from "./routes/Drill.jsx";
import Fluency from "./routes/Fluency.jsx";
import Passage from "./routes/Passage.jsx";
import "./styles.css";

// Lazy-loaded — these routes carry heavier dependencies (charts, CSV
// helpers, magic-link UI, full-page SVG graph) and aren't on the
// daily hot path.
const Debug = lazy(() => import("./routes/Debug.jsx"));
const SignIn = lazy(() => import("./routes/SignIn.jsx"));
const Roster = lazy(() => import("./routes/Roster.jsx"));
const Graph = lazy(() => import("./routes/Graph.jsx"));
const CourseTreePage = lazy(() => import("./routes/CourseTreePage.jsx"));
const Actions = lazy(() => import("./routes/Actions.jsx"));
const StudentDetail = lazy(() => import("./routes/StudentDetail.jsx"));

// Reading Academy — internal router.
//
// Mounted by App.jsx at /reading/*. AuthProvider wraps the routes so
// every screen has access to the session, the linked student row,
// and starts the telemetry flush worker on mount.

function Loading() {
  return (
    <div className="ra-app">
      <div className="ra-app-inner" style={{ padding: 32, color: "#666" }}>
        Loading…
      </div>
    </div>
  );
}

export default function Reading() {
  return (
    <AuthProvider>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route index element={<Today />} />
          <Route path="diagnostic" element={<Diagnostic />} />
          <Route path="drill" element={<Drill />} />
          <Route path="fluency" element={<Fluency />} />
          <Route path="passage" element={<Passage />} />
          {/* M19-3: teacher/admin-gated routes — RLS is still the
              authoritative boundary, this is the UX gate. Student
              sessions in this browser get redirected to /reading. */}
          <Route
            path="debug"
            element={
              <RequireRole allow="teacher">
                <Debug />
              </RequireRole>
            }
          />
          <Route path="signin" element={<SignIn />} />
          <Route
            path="roster"
            element={
              <RequireRole allow="teacher">
                <Roster />
              </RequireRole>
            }
          />
          <Route path="graph" element={<Graph />} />
          <Route path="course-tree" element={<CourseTreePage />} />
          <Route
            path="actions"
            element={
              <RequireRole allow="teacher">
                <Actions />
              </RequireRole>
            }
          />
          <Route
            path="student/:studentId"
            element={
              <RequireRole allow="teacher">
                <StudentDetail />
              </RequireRole>
            }
          />
          <Route path="*" element={<Today />} />
        </Routes>
      </Suspense>
    </AuthProvider>
  );
}
