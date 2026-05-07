// Centralized route registry for the VPA Learning OS.
//
// Use these constants in <Route path>, <Link to>, useNavigate() targets, and
// the launcher's APPS array. Hardcoded route strings should not appear
// elsewhere in the codebase.
//
// Adding a new app:
//   1. Add a key to ROUTES below.
//   2. Add a <Route> in src/App.jsx.
//   3. Add an entry in the launcher APPS array (in src/pages/Launcher.jsx)
//      with `internal: true` and `to: ROUTES.<KEY>`.
//
// External apps (Math Academy, Quill, etc.) are NOT in INTERNAL_ROUTES; the
// launcher uses window.open for them.

export const ROUTES = {
  HOME: "/",
  READING: "/reading",
  MATH_FACTS: "/math-facts",
  READING_FACTS: "/reading-facts",
  DASHBOARD: "/dashboard",
};

// Set of routes that are rendered inside this SPA.
export const INTERNAL_ROUTES = new Set([
  ROUTES.HOME,
  ROUTES.READING,
  ROUTES.MATH_FACTS,
  ROUTES.READING_FACTS,
  ROUTES.DASHBOARD,
]);

export function isInternal(route) {
  return INTERNAL_ROUTES.has(route);
}
