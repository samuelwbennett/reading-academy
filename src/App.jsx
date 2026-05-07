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
import Launcher from "./pages/Launcher.jsx";
import Reading from "./pages/Reading/index.jsx";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* OS surface — the launcher hub */}
        <Route path={ROUTES.HOME} element={<Launcher />} />

        {/* Reading Academy SPA — full subtree under /reading */}
        <Route path={`${ROUTES.READING}/*`} element={<Reading />} />

        {/* Reserved internal apps — not yet built; bounce to home for now. */}
        <Route path={`${ROUTES.MATH_FACTS}/*`} element={<Navigate to={ROUTES.HOME} replace />} />
        <Route path={`${ROUTES.READING_FACTS}/*`} element={<Navigate to={ROUTES.HOME} replace />} />
        <Route path={`${ROUTES.DASHBOARD}/*`} element={<Navigate to={ROUTES.HOME} replace />} />

        {/* Catchall — unknown URLs return to the OS surface */}
        <Route path="*" element={<Navigate to={ROUTES.HOME} replace />} />
      </Routes>
    </BrowserRouter>
  );
}
