// src/lib/auth/useStudentMode.js (M16-D)
//
// Small role-detection helper. Drives the calm-vs-dashboard split:
//   - student / unauthenticated  → calm focused UI
//   - teacher / admin            → full dashboard chrome
//   - parent                     → student-style (read-only-ish)
//
// Components consume this with `const isStudent = useStudentMode();`
// then conditionally render dashboards / chips / tech labels.
//
// Architectural rule (M16-D core): the student experience must never
// leak technical or admin concepts. This hook is the single switch
// every UI surface uses to decide.

import { useAuth } from "./AuthProvider.jsx";
import { getStoredStudentSession } from "./useStudentSession.js";

const TEACHER_ROLES = new Set(["teacher", "admin"]);

/**
 * True iff the active session should see the calm student UI.
 *
 * Three sessions exist in this app:
 *   - Supabase Auth user with role teacher/admin → dashboard chrome
 *   - Supabase Auth user with role student/parent → student chrome
 *   - Passwordless student session (M16-L) → student chrome (always)
 *   - Anonymous → student chrome (default to over-simplification)
 *
 * Returns true unless we're confident the active session is a
 * teacher/admin. We'd rather over-simplify than accidentally show a
 * child a dashboard chip.
 */
export function useStudentMode() {
  // A passwordless student session ALWAYS forces student chrome,
  // regardless of any teacher Supabase Auth that may also be live in
  // the same browser (rare but possible during testing).
  if (getStoredStudentSession()) return true;
  let role = null;
  try {
    const auth = useAuth();
    role = auth?.profile?.role ?? null;
  } catch {
    role = null;
  }
  if (!role) return true; // anonymous / pre-provision → student UI
  return !TEACHER_ROLES.has(role);
}

/** Convenience: returns the inverse for components whose default is teacher chrome. */
export function useTeacherMode() {
  return !useStudentMode();
}
