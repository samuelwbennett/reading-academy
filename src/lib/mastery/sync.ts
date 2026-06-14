// src/lib/mastery/sync.ts
//
// Sync the M3 StudentModel between this client and the
// `student_app_accounts.state` row in Supabase.
//
// The legacy state blob (used by /api/snapshot, /api/mastery, the
// orchestration dashboard) lives at `state` directly. We co-locate the
// new M3 model under `state.modelV2` so we don't need a column
// migration. Two consumers, one row, no conflicts.
//
// Strategy:
//   - On sign-in: download the row, take whichever side has the
//     newer `updatedAt`. If remote wins, write to local. If local
//     wins, push to remote.
//   - On every save() of the model (e.g. after recordAttempt), the
//     local copy is authoritative immediately. A debounced background
//     push uploads the row a few seconds later. The flush() worker
//     handles the *event* stream; sync() handles the *state* blob.

import { supabase } from "../../services/supabase.js";
import { load as loadLocal, save as saveLocal } from "./storage";
import { migrate, type StudentModel } from "./studentModel";

const APP_SLUG = "reading_academy";
const MODEL_KEY = "modelV2";
const PUSH_DEBOUNCE_MS = 4_000;

let appIdCache: string | null = null;
let studentIdCache: string | null = null;
let pendingPushTimer: number | null = null;

async function getAppId(): Promise<string | null> {
  if (appIdCache) return appIdCache;
  const { data, error } = await supabase
    .from("learning_apps")
    .select("id")
    .eq("slug", APP_SLUG)
    .maybeSingle();
  if (error) {
    console.warn("[mastery.sync] learning_apps lookup failed:", error.message);
    return null;
  }
  appIdCache = data?.id ?? null;
  return appIdCache;
}

async function getStudentId(): Promise<string | null> {
  if (studentIdCache) return studentIdCache;
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData?.user?.id;
  if (!uid) return null;
  const { data, error } = await supabase
    .from("students")
    .select("id")
    .eq("auth_user_id", uid)
    .maybeSingle();
  if (error) {
    console.warn("[mastery.sync] students lookup failed:", error.message);
    return null;
  }
  studentIdCache = data?.id ?? null;
  return studentIdCache;
}

interface PullResult {
  status: "ok" | "no_student" | "no_app" | "no_row" | "error";
  remoteModel?: StudentModel;
  reason?: string;
}

/**
 * Fetch the remote student_app_accounts row and extract the M3 model.
 */
export async function pullRemote(): Promise<PullResult> {
  const studentId = await getStudentId();
  if (!studentId) return { status: "no_student" };
  const appId = await getAppId();
  if (!appId) return { status: "no_app" };

  const { data, error } = await supabase
    .from("student_app_accounts")
    .select("state")
    .eq("student_id", studentId)
    .eq("app_id", appId)
    .maybeSingle();

  if (error) {
    console.warn("[mastery.sync] pull failed:", error.message);
    return { status: "error", reason: error.message };
  }
  const remoteState = data?.state as Record<string, unknown> | null;
  if (!remoteState || !remoteState[MODEL_KEY]) {
    return { status: "no_row" };
  }
  const remoteModel = migrate(remoteState[MODEL_KEY]);
  return { status: "ok", remoteModel };
}

/**
 * Push the local M3 model into the row, merging next to the legacy
 * `state` blob (preserves orchestration-dashboard behavior).
 */
export async function pushRemote(model?: StudentModel): Promise<{ ok: boolean; reason?: string }> {
  const studentId = await getStudentId();
  if (!studentId) return { ok: false, reason: "no_student" };
  const appId = await getAppId();
  if (!appId) return { ok: false, reason: "no_app" };

  const localModel = model ?? loadLocal();

  // Read the legacy state, merge in modelV2, write back.
  const { data: existing, error: readErr } = await supabase
    .from("student_app_accounts")
    .select("state")
    .eq("student_id", studentId)
    .eq("app_id", appId)
    .maybeSingle();

  if (readErr) {
    console.warn("[mastery.sync] preflight read failed:", readErr.message);
    return { ok: false, reason: readErr.message };
  }

  const merged: Record<string, unknown> = {
    ...((existing?.state as Record<string, unknown>) ?? {}),
    [MODEL_KEY]: localModel,
  };

  const { error: writeErr } = await supabase
    .from("student_app_accounts")
    .upsert(
      {
        student_id: studentId,
        app_id: appId,
        state: merged,
        enabled: true,
      },
      { onConflict: "student_id,app_id" },
    );

  if (writeErr) {
    console.warn("[mastery.sync] push failed:", writeErr.message);
    return { ok: false, reason: writeErr.message };
  }
  return { ok: true };
}

/**
 * Reconcile local + remote on sign-in. Latest-write-wins on
 * `updatedAt`. Falls back to local-only if no remote yet.
 */
export async function reconcileOnSignIn(): Promise<{
  decision: "took_remote" | "kept_local" | "remote_missing" | "no_auth";
}> {
  const studentId = await getStudentId();
  if (!studentId) return { decision: "no_auth" };

  const local = loadLocal();
  const remote = await pullRemote();

  if (remote.status !== "ok" || !remote.remoteModel) {
    // No remote model yet — push local up.
    await pushRemote(local);
    return { decision: "remote_missing" };
  }

  const remoteUpdated = remote.remoteModel.updatedAt ?? 0;
  const localUpdated = local.updatedAt ?? 0;

  if (remoteUpdated > localUpdated) {
    saveLocal(remote.remoteModel);
    return { decision: "took_remote" };
  }
  await pushRemote(local);
  return { decision: "kept_local" };
}

/**
 * Schedule a debounced push. Call after any local mutation. Multiple
 * calls within PUSH_DEBOUNCE_MS coalesce.
 */
export function schedulePush(): void {
  if (typeof window === "undefined") return;
  if (pendingPushTimer != null) {
    window.clearTimeout(pendingPushTimer);
  }
  pendingPushTimer = window.setTimeout(() => {
    pendingPushTimer = null;
    pushRemote().catch(() => {});
  }, PUSH_DEBOUNCE_MS);
}

/** Reset caches; call from auth state change. */
export function resetSyncCaches(): void {
  appIdCache = null;
  studentIdCache = null;
}
