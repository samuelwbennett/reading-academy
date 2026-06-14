// src/lib/mastery/studentModel.ts
//
// Persistent student state for Reading Academy.
//
// Design principles:
//   1. Pure data + pure functions. No side effects in here. Persistence
//      is the responsibility of a thin wrapper (storage.ts) that the UI
//      and the engine both call.
//   2. Versioned. The shape evolves; the loader migrates old shapes
//      forward. Bump SCHEMA_VERSION on any breaking change.
//   3. Append-only history. We keep last-N attempts per node so the
//      mastery engine can compute rolling stats without re-reading the
//      full telemetry queue.
//   4. Explainable. Every score has a derivation, not a black box.
//
// This file defines the *shape* and the canonical reducers/readers.
// Mastery rules live in masteryEngine.ts.

import type { Surface } from "../telemetry/types";
import type { CardState } from "../review/fsrs";

export const SCHEMA_VERSION = "student-model/v1";

// Mastery state machine states (mirrors mastery-state-machine v1.0).
export type MasteryStatus =
  | "locked"
  | "unlocked"
  | "active"
  | "practicing"
  | "mastered_for_acquisition"
  | "in_automaticity_zone"
  | "automatic"
  | "regressed";

export type FluencyGate =
  | "FL_01_cvc_fluency"
  | "FL_02_blend_digraph_fluency"
  | "FL_03_silent_e_fluency"
  | "FL_04_grade2_fluency";

// ---------- Per-node state ----------

export interface NodeAttempt {
  ts: number;
  itemId: string;
  correct: boolean;
  latencyMs: number;
  hintCount: number;
  surface: Surface;
}

export interface NodeState {
  nodeId: string;
  status: MasteryStatus;

  /** Confidence the student has acquired the rule, in [0,1]. */
  masteryConfidence: number;
  /** Confidence the student executes within the automaticity-target latency, in [0,1]. */
  fluencyConfidence: number;

  /** Total attempts ever (for diagnostics). */
  attempts: number;
  /** Last 20 attempts; rolling window for engine math. */
  history: NodeAttempt[];

  /** Rolling accuracy across `history`. */
  rollingAccuracy: number;
  /** Rolling median latency_ms across `history`. */
  rollingLatencyMs: number;

  /** ts of most recent attempt (any outcome). */
  lastPracticedAt: number | null;
  /** ts when the node first crossed into mastered_for_acquisition. */
  lastMasteredAt: number | null;

  /** [0,1]; engine output, see masteryEngine.calculateForgettingRisk. */
  forgettingRisk: number;
  /** ts; null if no review needed yet. */
  reviewDueAt: number | null;

  /** FSRS card state — set by the bridge after each attempt. */
  fsrsCard?: CardState;
}

export const HISTORY_LIMIT = 20;

export function emptyNodeState(nodeId: string): NodeState {
  return {
    nodeId,
    status: "locked",
    masteryConfidence: 0,
    fluencyConfidence: 0,
    attempts: 0,
    history: [],
    rollingAccuracy: 0,
    rollingLatencyMs: 0,
    lastPracticedAt: null,
    lastMasteredAt: null,
    forgettingRisk: 0,
    reviewDueAt: null,
  };
}

// ---------- Per-fluency-gate state ----------

export interface PassageAttempt {
  ts: number;
  passageId: string;
  isCold: boolean;
  wcpm: number;
  accuracy: number;
}

export interface FluencyState {
  gateId: FluencyGate;
  /** Best WCPM on a *cold* passage (re-attempted is the gate metric). */
  coldWcpm: number;
  /** Best WCPM on practiced passages (lower bar, motivational). */
  practicedWcpm: number;
  /** Mean accuracy across history. */
  accuracyRate: number;
  /** Total passage reads (cold + practiced). */
  passageAttempts: number;
  /** Slope of WCPM over time. + = improving, − = regressing. */
  fluencyTrend: number;
  /** Last N passage attempts; engine uses for trend math. */
  history: PassageAttempt[];
  lastAttemptAt: number | null;
}

export const FLUENCY_HISTORY_LIMIT = 12;

export function emptyFluencyState(gateId: FluencyGate): FluencyState {
  return {
    gateId,
    coldWcpm: 0,
    practicedWcpm: 0,
    accuracyRate: 0,
    passageAttempts: 0,
    fluencyTrend: 0,
    history: [],
    lastAttemptAt: null,
  };
}

// ---------- Global state ----------

export interface GlobalState {
  /** Number of distinct calendar days (UTC) the student has had a session. */
  totalSessions: number;
  totalItemsAttempted: number;
  /** Consecutive calendar days with a session. Resets on a missed day. */
  streakDays: number;
  /** ts of the day-rollover anchor for streak math. */
  lastSessionDayUtc: number | null;
  /** XP earned today (resets at UTC rollover). */
  dailyXp: number;
  /** XP earned this ISO week (Mon-Sun). */
  weeklyXp: number;
}

export function emptyGlobalState(): GlobalState {
  return {
    totalSessions: 0,
    totalItemsAttempted: 0,
    streakDays: 0,
    lastSessionDayUtc: null,
    dailyXp: 0,
    weeklyXp: 0,
  };
}

// ---------- Top-level student model ----------

export interface StudentModel {
  schema: typeof SCHEMA_VERSION;
  studentId: string | null;
  createdAt: number;
  updatedAt: number;

  /** keyed by nodeId (matches src/data/skill_nodes.json). */
  nodes: Record<string, NodeState>;
  /** keyed by gateId (FL_01..FL_04). */
  fluency: Partial<Record<FluencyGate, FluencyState>>;
  global: GlobalState;
}

export function emptyStudentModel(studentId: string | null = null): StudentModel {
  const now = Date.now();
  return {
    schema: SCHEMA_VERSION,
    studentId,
    createdAt: now,
    updatedAt: now,
    nodes: {},
    fluency: {},
    global: emptyGlobalState(),
  };
}

// ---------- Pure readers ----------

export function getNode(model: StudentModel, nodeId: string): NodeState {
  return model.nodes[nodeId] ?? emptyNodeState(nodeId);
}

export function getFluency(
  model: StudentModel,
  gateId: FluencyGate,
): FluencyState {
  return model.fluency[gateId] ?? emptyFluencyState(gateId);
}

/** All nodes currently in a "mastered" family of statuses. */
export function listMasteredNodes(model: StudentModel): NodeState[] {
  return Object.values(model.nodes).filter((n) =>
    n.status === "mastered_for_acquisition" ||
    n.status === "in_automaticity_zone" ||
    n.status === "automatic"
  );
}

/** All nodes currently due for review, sorted soonest-first. */
export function listDueForReview(
  model: StudentModel,
  now: number = Date.now(),
): NodeState[] {
  return Object.values(model.nodes)
    .filter((n) => n.reviewDueAt != null && n.reviewDueAt <= now)
    .sort((a, b) => (a.reviewDueAt ?? 0) - (b.reviewDueAt ?? 0));
}

// ---------- Pure writers ----------

/** Replace a node's state immutably. */
export function setNode(model: StudentModel, node: NodeState): StudentModel {
  return {
    ...model,
    updatedAt: Date.now(),
    nodes: { ...model.nodes, [node.nodeId]: node },
  };
}

/** Replace a fluency gate's state immutably. */
export function setFluency(
  model: StudentModel,
  fluency: FluencyState,
): StudentModel {
  return {
    ...model,
    updatedAt: Date.now(),
    fluency: { ...model.fluency, [fluency.gateId]: fluency },
  };
}

/** Replace global state immutably. */
export function setGlobal(
  model: StudentModel,
  patch: Partial<GlobalState>,
): StudentModel {
  return {
    ...model,
    updatedAt: Date.now(),
    global: { ...model.global, ...patch },
  };
}

// ---------- Migration / load ----------

/**
 * Migrate any prior shape forward. Currently a no-op stub; bump
 * SCHEMA_VERSION and add a case here on breaking changes. Always
 * returns a model whose `.schema === SCHEMA_VERSION`.
 */
export function migrate(raw: unknown): StudentModel {
  if (!raw || typeof raw !== "object") return emptyStudentModel();
  const m = raw as Partial<StudentModel>;
  if (m.schema === SCHEMA_VERSION) return m as StudentModel;
  // Future: add case branches per old schema version.
  // For now, treat unknown shapes as a fresh start to avoid corrupting
  // mastery state with garbage from a stale storage write.
  console.warn(
    `[studentModel] unknown schema "${m.schema}"; resetting model`,
  );
  return emptyStudentModel(m.studentId ?? null);
}
