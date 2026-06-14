// Reading Academy — runtime state load/save and active-node selection.
//
// Single-purpose module. Wraps the existing pure-fn engines from
// src/lib/masteryEngine.js and src/lib/graphValidator.js with the localStorage
// integration this route needs.
//
// localStorage key:  reading-academy:student-state:v1
//
// Behavior on load:
//   1. If localStorage has a saved state, parse it.
//      - Apply legacy migration: PA_06_segment_cvc → PA_04_blend_cvc.
//   2. Otherwise, clone src/data/student_state.json as the seed.
//   3. Backfill any nodes missing from state.nodes (the graph may have grown
//      since the saved state was written).
//   4. Run cascadeUnlock to promote any locked node whose prereqs are met.
//   5. Return the result.
//
// On every state change, the route calls saveState() to persist back to
// localStorage. Existing progress is never destroyed by this module.

import skillNodes from "../../../data/skill_nodes.json";
import initialState from "../../../data/student_state.json";
import {
  cascadeUnlock,
  cascadeUnlockAutonomous,
  selectActiveNode,
  selectActiveNodeAutonomous,
} from "../../../lib/masteryEngine.js";
import { backfillNodeState } from "../../../lib/graphValidator.js";

// The mastery engine's cascadeUnlock reads node defs from globalThis.__skillNodes.
// Setting it once here keeps the engine call-sites simple. Flagged in
// docs/build-plan/v1.0.md as M1 cleanup: refactor to take nodes as an arg.
if (typeof globalThis !== "undefined") {
  globalThis.__skillNodes = skillNodes;
}

export const STORAGE_KEY = "reading-academy:student-state:v1";

export { skillNodes };

export function loadState() {
  let state = null;

  // 1. Try localStorage.
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        state = JSON.parse(raw);
      }
    }
  } catch (e) {
    console.warn("[reading] failed to read state from localStorage:", e);
  }

  // 2. Fallback to seed.
  if (!state || typeof state !== "object" || !state.nodes) {
    state = structuredClone(initialState);
  }

  // 3. Prune phantom node entries — IDs that exist in saved state but no
  //    longer in the current graph (e.g., from earlier renaming experiments
  //    like `PA_04_blend_cvc` that aren't part of the canonical graph).
  //    Prunes preserve real progress; phantom keys would otherwise inflate
  //    storage and confuse counts.
  const validIds = new Set(skillNodes.map((n) => n.id));
  const prunedKeys = [];
  for (const id of Object.keys(state.nodes)) {
    if (!validIds.has(id)) {
      prunedKeys.push(id);
      delete state.nodes[id];
    }
  }
  if (prunedKeys.length) {
    console.warn(
      `[reading] pruned ${prunedKeys.length} phantom node(s) from saved state:`,
      prunedKeys,
    );
  }

  // 4. Backfill: any node in the graph that's missing from state gets a
  //    locked entry. Existing entries are preserved untouched.
  state = backfillNodeState(state, skillNodes);

  // 5. Cascade unlock — M16-K3: autonomous variant treats teacher-led
  //    prereqs as soft so the autonomous student can progress through
  //    the auto-scorable spine of the graph. Teacher-mode workflows
  //    (Diagnostic ?teacher=1, Roster) can still call the strict
  //    cascadeUnlock from masteryEngine when they need it.
  state = cascadeUnlockAutonomous(state, skillNodes);

  return state;
}

export function saveState(state) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
  } catch (e) {
    console.warn("[reading] failed to save state to localStorage:", e);
  }
}

// Returns the ID of the node the student should engage with next, or null if
// nothing is available.
//
// M16-K2 / M16-K3: autonomous mode is the default. The autonomous variant
// skips teacher-led nodes so the student is never offered a task they can't
// complete on their own. Teacher mode (?teacher=1 or signed-in teacher/
// admin) can opt back into the strict variant by passing { autonomous:
// false } so they can drill / observe teacher-led nodes directly.
export function getActiveNodeId(state, opts = {}) {
  const autonomous = opts.autonomous !== false;
  return autonomous
    ? selectActiveNodeAutonomous(state, skillNodes)
    : selectActiveNode(state, skillNodes);
}

// M16-K4: observation-queue helper. Whenever the autonomous student
// would have landed on a teacher-led node, we record an entry here so
// teachers can see what the student bypassed and verify in person.
// Stored under state.pendingTeacherObservations[nodeId] = { ts, reason }.
// Pure function — caller must saveState to persist.
export function markPendingTeacherObservation(state, nodeId, reason = "auto_skipped") {
  if (!state || !nodeId) return state;
  const next = { ...state };
  next.pendingTeacherObservations = {
    ...(state.pendingTeacherObservations || {}),
    [nodeId]: {
      ts: Date.now(),
      reason,
    },
  };
  return next;
}

export function listPendingTeacherObservations(state) {
  const map = state?.pendingTeacherObservations || {};
  return Object.entries(map).map(([nodeId, meta]) => ({ nodeId, ...meta }));
}

// Counts grouped per the M1-A spec: mastered, in progress (active+practicing),
// unlocked (available but not started), locked (prereqs unmet).
export function getProgressCounts(state) {
  let mastered = 0;
  let inProgress = 0;
  let unlocked = 0;
  let locked = 0;

  for (const def of skillNodes) {
    const status = state.nodes?.[def.id]?.status || "locked";
    if (status === "mastered") mastered++;
    else if (status === "active" || status === "practicing") inProgress++;
    else if (status === "unlocked") unlocked++;
    else locked++;
  }

  const total = skillNodes.length;
  return {
    total,
    mastered,
    inProgress,
    unlocked,
    locked,
    pct: total > 0 ? mastered / total : 0,
  };
}

// Helper: prereq progress for the active node, formatted for UI.
// Returns "none required" if no prereqs, otherwise "N/M mastered".
export function getPrereqProgress(state, node) {
  if (!node || !node.prereqs || node.prereqs.length === 0) {
    return { label: "none required", count: 0, total: 0 };
  }
  const count = node.prereqs.filter(
    (p) => state.nodes?.[p]?.status === "mastered",
  ).length;
  return { label: `${count}/${node.prereqs.length} mastered`, count, total: node.prereqs.length };
}
