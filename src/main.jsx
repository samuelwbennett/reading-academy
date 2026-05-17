import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { consumeSessionFragment } from "./sessionBridge.js";
import "./styles.css";

// M16-G1: log the build stamp at app startup so we can verify in the
// production console exactly which bundle is running. Vite's `define`
// in vite.config.js injects __RA_BUILD_TIME__ and __RA_BUILD_SHA__ at
// build time. The fallback guards against the dev server, where the
// constants may not be replaced.
const BUILD_TIME =
  typeof __RA_BUILD_TIME__ === "string" ? __RA_BUILD_TIME__ : "dev";
const BUILD_SHA =
  typeof __RA_BUILD_SHA__ === "string" ? __RA_BUILD_SHA__ : "dev";
if (typeof window !== "undefined") {
  window.__RA_BUILD__ = { time: BUILD_TIME, sha: BUILD_SHA };
}
// eslint-disable-next-line no-console
console.log(
  `%c[ra.build] Reading Academy build ${BUILD_SHA} @ ${BUILD_TIME}`,
  "color:#27a;font-weight:600",
);

// Silent cross-app sign-in from the orchestration layer's "Start Now"
// button. Wait for the bridge to consume #vpa_session (no-op if
// absent) BEFORE React mounts so the first render is already signed-in.
async function boot() {
  await consumeSessionFragment();
  ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

boot();
