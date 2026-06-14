// Top-level router shell for the VPA Learning OS.
//
// Keep this file thin. It only wires routes to page components.
// Page components live under src/pages/<Name>/. Engine logic lives in
// src/lib/. Side-effecting integrations live in src/services/.
//
// Adding a new route: register it in src/config/routes.js, then add a
// <Route> below pointing at the page component.

import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ROUTES } from "./config/routes.js";
import Reading from "./pages/Reading/index.jsx";
import StudentLogin from "./pages/StudentLogin.jsx";

// 2026-05-19: the legacy Launcher page (src/pages/Launcher.jsx) is retired.
// It duplicated what vpa-orchestration-layer already does as the canonical
// cross-app dashboard, and added a confusing intermediate hop when users
// clicked "Reading" from the orchestrator. Root now redirects straight to
// /reading. The Launcher file is left on disk for now in case we want to
// salvage any pieces (rings, styling) for the orchestration layer.

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Root → straight into Reading Academy. The cross-app dashboard
            lives in vpa-orchestration-layer; this app is a single course. */}
        <Route path={ROUTES.HOME} element={<Navigate to={ROUTES.READING} replace />} />

        {/* M16-L4: passwordless student login (class code + PIN) */}
        <Route path={ROUTES.STUDENT_LOGIN} element={<StudentLogin />} />

        {/* Reading Academy SPA — full subtree under /reading */}
        <Route path={`${ROUTES.READING}/*`} element={<Reading />} />

        {/* Reserved internal apps — not yet built; bounce to /reading. */}
        <Route path={`${ROUTES.MATH_FACTS}/*`} element={<Navigate to={ROUTES.READING} replace />} />
        <Route path={`${ROUTES.READING_FACTS}/*`} element={<Navigate to={ROUTES.READING} replace />} />
        <Route path={`${ROUTES.DASHBOARD}/*`} element={<Navigate to={ROUTES.READING} replace />} />

        {/* Catchall — unknown URLs land in Reading Academy. */}
        <Route path="*" element={<Navigate to={ROUTES.READING} replace />} />
      </Routes>
    </BrowserRouter>
  );
}
