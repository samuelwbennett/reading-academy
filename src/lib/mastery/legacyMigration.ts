// src/lib/mastery/legacyMigration.ts
//
// One-time projection from the legacy readingState shape (what the
// diagnostic and the M1 drill engine wrote into
// `reading-academy:student-state:v1`) into the M3 StudentModel
// (`reading-academy:student-model:v1`).
//
// Why a migration: students who reached mastery before the M4-A
// telemetry shim deployed have a fully-populated legacy state but an
// empty M3 model. The session planner only reads from the M3 model,
// so without this projection their dashboards show nothing.
//
// Pure function. Idempotent. Returns a fresh StudentModel — caller
// is responsible for persisting it.

import type { Surface } from "../telemetry/types";
import {
  emptyStudentModel,
  emptyNodeState,
  HISTORY_LIMIT,
  type MasteryStatus,
  type NodeAttempt,
  type NodeState,
  type StudentModel,
} from "./studentModel";

interface LegacyAttempt {
  ts?: number;
  correct?: boolean;
  latencyMs?: number;
  source?: string;
}

interface LegacyNodeState {
  status?: string;
  attempts?: LegacyAttempt[];
  masteredAt?: number | null;
}

interface LegacyState {
  studentId?: string | null;
  nodes?: Record<string, LegacyNodeState>;
}

interface NodeDef {
  id: string;
}

const LEGACY_STATUS_MAP: Record<string, MasteryStatus> = {
  locked: "locked",
  unlocked: "unlocked",
  active: "active",
  practicing: "practicing",
  // Legacy "mastered" predates the 8-state machine — admit it as the
  // entry tier (`mastered_for_acquisition`). Automaticity tiers come
  // back automatically once the student does fresh attempts.
  mastered: "mastered_for_acquisition",
};

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function projectNode(
  nodeId: string,
  legacy: LegacyNodeState,
): NodeState {
  const base = emptyNodeState(nodeId);
  const status = LEGACY_STATUS_MAP[legacy.status ?? "locked"] ?? "locked";

  const legacyAttempts = legacy.attempts ?? [];
  const trimmed = legacyAttempts.slice(-HISTORY_LIMIT);
  const history: NodeAttempt[] = trimmed.map((a) => ({
    ts: a.ts ?? 0,
    itemId: "legacy",
    correct: !!a.correct,
    latencyMs: a.latencyMs ?? 0,
    hintCount: 0,
    surface: (a.source === "fluency" ? "fluency" : "drill") as Surface,
  }));

  const correctCount = history.filter((h) => h.correct).length;
  const rollingAccuracy =
    history.length > 0 ? correctCount / history.length : 0;
  const correctLatencies = history
    .filter((h) => h.correct)
    .map((h) => h.latencyMs);
  const rollingLatencyMs = median(correctLatencies);

  // Mastery confidence is what the legacy "mastered" stamp tells us.
  // If status is mastered, anchor it at 0.9 so the review scheduler
  // doesn't immediately treat it as fragile.
  const masteryConfidence =
    status === "mastered_for_acquisition" ? 0.9 :
    status === "practicing" ? 0.6 :
    status === "active" ? 0.3 :
    0;

  // No latency-target data carries over, so fluency confidence is 0
  // until fresh attempts run through the M3 engine.
  const fluencyConfidence = 0;

  const lastTs = history.length ? history[history.length - 1].ts : null;

  return {
    ...base,
    status,
    masteryConfidence,
    fluencyConfidence,
    attempts: legacyAttempts.length,
    history,
    rollingAccuracy,
    rollingLatencyMs,
    lastPracticedAt: lastTs,
    lastMasteredAt: legacy.masteredAt ?? null,
    forgettingRisk: 0,
    reviewDueAt: null,
  };
}

/**
 * Build a fresh StudentModel by projecting every node entry from
 * `legacy` into M3 shape. Locked-status entries are still included
 * so the planner sees the full graph.
 */
export function projectLegacyToModel(
  legacy: LegacyState,
  nodeDefs: NodeDef[],
): StudentModel {
  const model = emptyStudentModel(legacy.studentId ?? null);
  const legacyNodes = legacy.nodes ?? {};

  for (const def of nodeDefs) {
    const ln = legacyNodes[def.id];
    if (!ln) continue;
    model.nodes[def.id] = projectNode(def.id, ln);
  }
  return model;
}

/**
 * Additive merge: fill in any node that exists in legacy with a
 * non-locked status but is missing from the M3 model. Existing
 * model entries are NEVER overwritten — recent drill activity always
 * wins over a legacy snapshot.
 *
 * Returns { model, added } where `added` is the count of nodes
 * filled in (0 = nothing to migrate).
 */
export function mergeLegacyIntoModel(
  model: StudentModel,
  legacy: LegacyState | null,
  nodeDefs: NodeDef[],
): { model: StudentModel; added: number } {
  if (!legacy?.nodes) return { model, added: 0 };
  let added = 0;
  const nextNodes = { ...model.nodes };
  for (const def of nodeDefs) {
    if (nextNodes[def.id]) continue; // M3 already authoritative
    const ln = legacy.nodes[def.id];
    if (!ln) continue;
    if (!ln.status || ln.status === "locked") continue;
    nextNodes[def.id] = projectNode(def.id, ln);
    added += 1;
  }
  if (added === 0) return { model, added: 0 };
  return {
    model: {
      ...model,
      updatedAt: Date.now(),
      nodes: nextNodes,
    },
    added,
  };
}

/**
 * 2026-05-19 audit fix #3: reconcile legacy MASTERY into existing M3
 * entries.
 *
 * `mergeLegacyIntoModel` only adds missing nodes. That works on first
 * load, but if a student already has an M3 model and then takes the
 * diagnostic again (or the diagnostic re-runs cascadeUnlock on legacy),
 * any newly-mastered legacy entries never make it into M3. The
 * planner reads M3, so the new mastery stays invisible.
 *
 * This function walks legacy nodes with `status === "mastered"` and
 * promotes the matching M3 entry to `mastered_for_acquisition` IF the
 * M3 entry is currently below mastery (i.e. status in
 * {locked, unlocked, active, practicing, regressed}). M3 entries that
 * are already mastered/in-automaticity/automatic are left alone — we
 * never demote.
 */
export function reconcileLegacyMastery(
  model: StudentModel,
  legacy: LegacyState | null,
): { model: StudentModel; promoted: number } {
  if (!legacy?.nodes) return { model, promoted: 0 };
  const MASTERED_M3 = new Set([
    "mastered_for_acquisition",
    "in_automaticity_zone",
    "automatic",
  ]);
  let promoted = 0;
  const nextNodes = { ...model.nodes };
  for (const [nodeId, ln] of Object.entries(legacy.nodes)) {
    if (ln?.status !== "mastered") continue;
    const existing = nextNodes[nodeId];
    if (!existing) continue;
    if (MASTERED_M3.has(existing.status)) continue;
    nextNodes[nodeId] = {
      ...existing,
      status: "mastered_for_acquisition",
      masteryConfidence: Math.max(existing.masteryConfidence ?? 0, 0.9),
      lastMasteredAt: ln.masteredAt ?? existing.lastMasteredAt ?? null,
    };
    promoted += 1;
  }
  if (promoted === 0) return { model, promoted: 0 };
  return {
    model: { ...model, updatedAt: Date.now(), nodes: nextNodes },
    promoted,
  };
}

/**
 * Returns true iff the legacy state has any non-locked node — i.e.
 * the student has actually used the app and there's something worth
 * migrating.
 */
export function legacyHasProgress(legacy: LegacyState | null): boolean {
  if (!legacy?.nodes) return false;
  for (const k of Object.keys(legacy.nodes)) {
    const status = legacy.nodes[k]?.status;
    if (status && status !== "locked") return true;
  }
  return false;
}
