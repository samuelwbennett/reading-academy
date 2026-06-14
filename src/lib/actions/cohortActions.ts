// src/lib/actions/cohortActions.ts
//
// Cohort aggregator. Given an array of (student, model) pairs,
// produces a flat action queue across the whole class, sorted so a
// teacher's eye lands on the highest-leverage thing first.
//
// Each action is annotated with the student it belongs to so the UI
// can group / filter.
//
// Budget-aware (M11-G): the engine knows real teacher capacity is
// finite. The "today" block fills in priority order until the daily
// cap is hit; overflow bumps to "this_week" instead of being silently
// dropped. The summary reports both the budgeted total and the
// overflow count so the UI can show "you have 12 today actions worth
// 90 min — 6 fit in your 30-min budget; 6 bumped to this week."
//
// Pure function. The Actions route (M11-E) calls this with the
// students it can see; cohort-level intelligence is a sort + group +
// budget over per-student outputs, nothing more.

import { generateActions, type Action, ACTION_CONSTANTS } from "./actionEngine";
import type { StudentModel } from "../mastery/studentModel";

interface MinimalNodeDef {
  id: string;
  topic?: string;
  skill?: string;
}

export interface CohortStudent {
  id: string;
  displayName: string;
  model: StudentModel;
}

export interface CohortAction extends Action {
  studentId: string;
  studentDisplayName: string;
  /** True when the engine bumped this from "today" to "this_week" to fit the daily budget. */
  bumpedFromToday?: boolean;
}

export interface CohortSummary {
  totalActions: number;
  todayCount: number;
  thisWeekCount: number;
  monitorCount: number;
  byKind: Record<string, number>;
  studentsWithActions: number;
  /** Sum of durationMinutes across the (possibly capped) today block. */
  todayMinutes: number;
  /** Daily capacity used; null when no cap was applied. */
  dailyCapacityMinutes: number | null;
  /** Count of actions the engine bumped from today → this_week to fit the cap. */
  overflowedToWeek: number;
  /** Total minutes the uncapped today block would have needed. */
  uncappedTodayMinutes: number;
  /** Per-student count for fairness display. */
  todayPerStudent: Record<string, number>;
}

export interface CohortConfig {
  /**
   * Max sum of durationMinutes for actions that stay in the "today" block.
   * Excess actions get bumped to this_week. Defaults to 30 — a realistic
   * primary-school pull-aside budget. Pass null to disable the cap.
   */
  dailyCapacityMinutes: number | null;
  /**
   * Optional per-student cap so one needy student doesn't consume the
   * whole today budget. Defaults to 10. Pass null to disable.
   */
  perStudentTodayMinutes: number | null;
}

export const DEFAULT_COHORT_CONFIG: CohortConfig = {
  dailyCapacityMinutes: 30,
  perStudentTodayMinutes: 10,
};

/**
 * Generate the unified cohort action queue.
 *
 * Returns:
 *   - actions: all per-student actions, flattened + sorted (today
 *     first, after the cap is applied; bumped actions appear in
 *     this_week with `bumpedFromToday: true` so the UI can mark them).
 *   - summary: counts + budget telemetry for the cohort header.
 */
export function generateCohortActions(
  students: CohortStudent[],
  graph: MinimalNodeDef[],
  now: number = Date.now(),
  configIn: Partial<CohortConfig> = {},
): { actions: CohortAction[]; summary: CohortSummary } {
  const config: CohortConfig = { ...DEFAULT_COHORT_CONFIG, ...configIn };

  const flat: CohortAction[] = [];
  const studentsWithActions = new Set<string>();

  for (const s of students) {
    const actions = generateActions(s.model, graph, now);
    for (const a of actions) {
      flat.push({
        ...a,
        studentId: s.id,
        studentDisplayName: s.displayName,
      });
      studentsWithActions.add(s.id);
    }
  }

  // 1. Initial priority sort within urgency tier — same as before.
  const sortByPriority = (a: CohortAction, b: CohortAction) => {
    const u =
      ACTION_CONSTANTS.URGENCY_ORDER[a.urgency] -
      ACTION_CONSTANTS.URGENCY_ORDER[b.urgency];
    if (u !== 0) return u;
    const k =
      ACTION_CONSTANTS.KIND_PRIORITY[a.kind] -
      ACTION_CONSTANTS.KIND_PRIORITY[b.kind];
    if (k !== 0) return k;
    return a.studentDisplayName.localeCompare(b.studentDisplayName);
  };
  flat.sort(sortByPriority);

  // 2. Apply the daily-capacity cap to the "today" block.
  const todayCandidates = flat.filter((a) => a.urgency === "today");
  const uncappedTodayMinutes = todayCandidates.reduce(
    (s, a) => s + (a.durationMinutes || 0),
    0,
  );

  let kept: CohortAction[] = todayCandidates;
  let bumped: CohortAction[] = [];
  if (config.dailyCapacityMinutes != null || config.perStudentTodayMinutes != null) {
    kept = [];
    bumped = [];
    const usedPerStudent: Record<string, number> = {};
    let usedTotal = 0;

    for (const a of todayCandidates) {
      const dur = a.durationMinutes || 0;
      const usedForStudent = usedPerStudent[a.studentId] || 0;
      const cap = config.dailyCapacityMinutes;
      const perCap = config.perStudentTodayMinutes;

      const overTotal = cap != null && usedTotal + dur > cap;
      const overStudent = perCap != null && usedForStudent + dur > perCap;

      if (overTotal || overStudent) {
        bumped.push({ ...a, urgency: "this_week", bumpedFromToday: true });
      } else {
        kept.push(a);
        usedTotal += dur;
        usedPerStudent[a.studentId] = usedForStudent + dur;
      }
    }
  }

  // 3. Reassemble: today (kept) + this_week (existing + bumped) + monitor.
  const existingWeek = flat.filter((a) => a.urgency === "this_week");
  const monitor = flat.filter((a) => a.urgency === "monitor");
  const ordered: CohortAction[] = [
    ...kept,
    ...existingWeek,
    ...bumped,
    ...monitor,
  ];

  // 4. Summary.
  const byKind: Record<string, number> = {};
  const todayPerStudent: Record<string, number> = {};
  let todayMinutes = 0;
  for (const a of ordered) {
    byKind[a.kind] = (byKind[a.kind] || 0) + 1;
    if (a.urgency === "today") {
      todayMinutes += a.durationMinutes || 0;
      todayPerStudent[a.studentId] = (todayPerStudent[a.studentId] || 0) + 1;
    }
  }

  const summary: CohortSummary = {
    totalActions: ordered.length,
    todayCount: kept.length,
    thisWeekCount: existingWeek.length + bumped.length,
    monitorCount: monitor.length,
    byKind,
    studentsWithActions: studentsWithActions.size,
    todayMinutes,
    dailyCapacityMinutes: config.dailyCapacityMinutes,
    overflowedToWeek: bumped.length,
    uncappedTodayMinutes,
    todayPerStudent,
  };

  return { actions: ordered, summary };
}

/**
 * Estimated total teacher-attention minutes for the today block.
 * Rough planning aid — "how much focused time will this morning need?"
 *
 * Note: with the M11-G budget cap, this is bounded by
 * `config.dailyCapacityMinutes`. For the uncapped total see
 * `summary.uncappedTodayMinutes`.
 */
export function todayMinutesEstimate(actions: CohortAction[]): number {
  return actions
    .filter((a) => a.urgency === "today")
    .reduce((acc, a) => acc + a.durationMinutes, 0);
}
