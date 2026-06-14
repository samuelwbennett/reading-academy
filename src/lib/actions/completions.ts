// src/lib/actions/completions.ts
//
// Thin wrapper around `reading_action_completions` for the UI.
// Reads completions for one student, marks them complete/skipped,
// and provides a local in-memory cache so list re-renders don't
// roundtrip on every keypress.

import { supabase } from "../../services/supabase.js";
import type { Action } from "./actionEngine";

export type CompletionStatus = "completed" | "skipped" | "dismissed";

export interface CompletionRow {
  action_id: string;
  status: CompletionStatus;
  completed_at: string;
  note?: string | null;
}

export async function fetchCompletions(
  studentId: string,
  weeksBack = 2,
): Promise<Record<string, CompletionRow>> {
  if (!studentId) return {};
  const since = new Date(Date.now() - weeksBack * 7 * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("reading_action_completions")
    .select("action_id, status, completed_at, note")
    .eq("student_id", studentId)
    .gte("completed_at", since);
  if (error) {
    console.warn("[actions.completions] fetch failed:", error.message);
    return {};
  }
  const map: Record<string, CompletionRow> = {};
  for (const row of data || []) map[row.action_id] = row;
  return map;
}

export async function markAction(
  studentId: string,
  action: Action,
  status: CompletionStatus,
  note: string | null = null,
): Promise<{ ok: boolean; reason?: string }> {
  const { data: userData } = await supabase.auth.getUser();
  const teacherUserId = userData?.user?.id ?? null;
  const { error } = await supabase
    .from("reading_action_completions")
    .upsert(
      {
        student_id: studentId,
        action_id: action.id,
        teacher_user_id: teacherUserId,
        status,
        note,
        action_snapshot: action,
      },
      { onConflict: "student_id,action_id" },
    );
  if (error) {
    console.warn("[actions.completions] mark failed:", error.message);
    return { ok: false, reason: error.message };
  }
  return { ok: true };
}
