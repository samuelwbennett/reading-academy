// src/lib/mastery/storage.ts
//
// Thin localStorage wrapper for the student model. Keeps persistence
// concerns out of studentModel.ts (which is pure data) and out of
// masteryEngine.ts (which is pure logic).
//
// On every load, fill in any node that exists in the legacy
// readingState with non-locked status but is missing from the M3
// model. This is what unblocks the session planner for users whose
// progress predates the M3 bridge — without it, drilled nodes (M3)
// can't pass the prereq check because their prereqs (legacy-only)
// look "locked" to the M3 model.
//
// The merge is additive — recent drill activity in M3 is never
// overwritten.

import skillNodes from "../../data/skill_nodes.json";
import {
  emptyStudentModel,
  migrate,
  type StudentModel,
} from "./studentModel";
import { mergeLegacyIntoModel, reconcileLegacyMastery } from "./legacyMigration";

const STORAGE_KEY = "reading-academy:student-model:v1";
const LEGACY_KEY = "reading-academy:student-state:v1";

function readJson<T>(key: string): T | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function load(): StudentModel {
  let model: StudentModel;
  try {
    if (typeof localStorage === "undefined") return emptyStudentModel();
    const raw = localStorage.getItem(STORAGE_KEY);
    model = raw ? migrate(JSON.parse(raw)) : emptyStudentModel();
  } catch (err) {
    console.warn("[studentModel] load failed; resetting", err);
    model = emptyStudentModel();
  }

  // Two-pass reconciliation with the legacy state:
  //   1. mergeLegacyIntoModel — additive, fills MISSING nodes only.
  //   2. reconcileLegacyMastery — promotes existing M3 entries when
  //      legacy has newly-marked mastery (e.g., post-diagnostic).
  // Together these close the dual-store split-brain that the 2026-05-19
  // audit found. Both are no-ops once M3 has caught up.
  const legacy = readJson<unknown>(LEGACY_KEY) as
    | Parameters<typeof mergeLegacyIntoModel>[1]
    | null;
  if (legacy) {
    let current = model;
    const { model: merged, added } = mergeLegacyIntoModel(
      current,
      legacy,
      skillNodes as Parameters<typeof mergeLegacyIntoModel>[2],
    );
    if (added > 0) {
      console.info(
        "[studentModel] merged",
        added,
        "node(s) from legacy state",
      );
      current = merged;
    }
    const { model: reconciled, promoted } = reconcileLegacyMastery(
      current,
      legacy,
    );
    if (promoted > 0) {
      console.info(
        "[studentModel] promoted",
        promoted,
        "node(s) to mastered from legacy state",
      );
      current = reconciled;
    }
    if (added > 0 || promoted > 0) {
      save(current);
      return current;
    }
  }

  return model;
}

export function save(model: StudentModel): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(model));
  } catch (err) {
    console.warn("[studentModel] save failed", err);
  }
}

export function reset(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* swallow */
  }
}
