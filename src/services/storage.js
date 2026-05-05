// =====================================================
// Storage adapter for Reading Academy student state.
//
// State shape (verbatim from initial student_state.json):
//   {
//     studentId, name, createdAt, diagnosticComplete,
//     nodes: { [nodeId]: { status, attempts: [], masteredAt? } }
//   }
//
// Persistence policy:
//   - localStorage is always the warm cache. Reading Academy renders
//     instantly off it on first paint, even when offline.
//   - When a guardian-linked Supabase auth user is signed in and we
//     can resolve a students row, we read state from
//     student_app_accounts.state (the universal-schema "per-app
//     persistent state" JSONB column) and write back on every
//     `saveState`. Writes are fire-and-forget — UI never blocks.
//   - The legacy localStorage key is read once on first migration so
//     existing demo state isn't lost when a student first signs in.
// =====================================================

import { supabase } from "./supabase.js";

const LS_KEY = "reading-academy:student-state:v1";
const APP_SLUG = "reading_academy";

// In-memory cache so we don't keep round-tripping for app_id.
let cachedAppId = null;

async function getAppId() {
  if (cachedAppId) return cachedAppId;
  const { data, error } = await supabase
    .from("learning_apps")
    .select("id")
    .eq("slug", APP_SLUG)
    .maybeSingle();
  if (error) {
    console.warn("[storage] learning_apps lookup failed:", error.message);
    return null;
  }
  cachedAppId = data?.id || null;
  return cachedAppId;
}

// Read what's in localStorage. Used as the synchronous first-paint
// state and as the fallback when no auth or no Supabase row exists.
export function readLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function writeLocal(state) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    /* quota / privacy mode — ignore */
  }
}

// Load state for a Supabase student. Falls back to local cache if no
// row exists yet (first-time signed-in student). Returns whatever is
// most recent — at v1 that's just "what Supabase has, else local".
export async function loadFromSupabase(studentId) {
  if (!studentId) return null;
  const appId = await getAppId();
  if (!appId) return null;

  const { data, error } = await supabase
    .from("student_app_accounts")
    .select("state")
    .eq("student_id", studentId)
    .eq("app_id", appId)
    .maybeSingle();

  if (error) {
    console.warn("[storage] student_app_accounts read failed:", error.message);
    return null;
  }
  return data?.state || null;
}

// Save state for a Supabase student. Upserts the
// student_app_accounts row by (student_id, app_id) so first-time
// students get a row created cleanly. Fire-and-forget — caller can
// await for tests but shouldn't in render.
export async function saveToSupabase(studentId, state) {
  if (!studentId) return;
  const appId = await getAppId();
  if (!appId) return;

  const payload = {
    student_id: studentId,
    app_id: appId,
    state,
    enabled: true,
  };

  const { error } = await supabase
    .from("student_app_accounts")
    .upsert(payload, { onConflict: "student_id,app_id" });

  if (error) {
    console.warn("[storage] student_app_accounts write failed:", error.message);
  }
}
