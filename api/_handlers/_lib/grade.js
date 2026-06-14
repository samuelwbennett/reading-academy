// api/_handlers/_lib/grade.js
// ----------------------------------------------------------------
// Shared grade-label validation for the provisioning endpoints
// (provision-student, bulk-provision-students, create-class).
//
// A grade label is "K" or a number 1-12. A class may also carry a
// range — two of those joined by a hyphen, e.g. "K-2", "3-5", "9-12".
// Grades are stored as TEXT, so "K" and ranges are first-class and
// must never be coerced to integers.
//
// Replaces the old K-2-only `ALLOWED_GRADES` set that each handler
// declared inline, which silently dropped grades 3-12.
// ----------------------------------------------------------------

const SINGLE = /^(K|[1-9]|1[0-2])$/; // "K", or "1".."12"

// True for a single grade ("K", "7") or a two-part range ("K-2").
export function isValidGrade(value) {
  if (typeof value !== "string") return false;
  const parts = value.trim().toUpperCase().split("-");
  if (parts.length < 1 || parts.length > 2) return false;
  return parts.every((p) => SINGLE.test(p));
}

// Trim + validate a grade from request input. Returns the cleaned,
// upper-cased label, or null when absent/invalid — callers store
// null as "no grade on file" rather than rejecting the request.
export function normalizeGrade(raw) {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toUpperCase();
  return isValidGrade(t) ? t : null;
}
