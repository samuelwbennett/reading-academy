// src/lib/mastery/masteryEngine.ts
//
// Deterministic, rule-based mastery engine. Inputs are pure: a node's
// previous state + a fresh attempt → next state. No side effects.
//
// Design rules (per build plan v1.0 + Reading Fluency agent v1.0):
//   1. Mastery requires both accuracy AND fluency. Latency below the
//      node's automaticity_target_latency_ms is the fluency threshold.
//   2. Multiple successful attempts are required (mastery_min_items).
//   3. Cold-read performance > practiced performance for fluency gates.
//   4. A failure does NOT instantly revoke mastery — confidence decays;
//      regression takes a sustained dip below the floor.
//   5. Rolling windows so a single bad day doesn't crater a node.
//
// The engine reads node-level config from the skill graph (passed in)
// so that any per-node tuning lives next to the curriculum, not in code.

import type { Surface } from "../telemetry/types";
import {
  emptyNodeState,
  emptyFluencyState,
  HISTORY_LIMIT,
  FLUENCY_HISTORY_LIMIT,
  type FluencyGate,
  type FluencyState,
  type MasteryStatus,
  type NodeAttempt,
  type NodeState,
  type PassageAttempt,
} from "./studentModel";

// ---------- Config (subset of skill_nodes.json schema) ----------

export interface NodeConfig {
  id: string;
  /** Min accurate attempts required to be considered for mastery. */
  mastery?: { min_items?: number };
  /** Latency threshold (ms) below which an attempt counts as fluent. */
  automaticity_target_latency_ms?: number;
  /** Optional explicit accuracy threshold; defaults to ACCURACY_FLOOR. */
  mastery_accuracy_floor?: number;
}

const ACCURACY_FLOOR = 0.85;
const REGRESSION_FLOOR = 0.6;
const MASTERY_FLOOR = 0.9;
const FLUENCY_FLOOR = 0.7;
const DEFAULT_MIN_ITEMS = 5;
const DEFAULT_LATENCY_TARGET_MS = 4000;

// ---------- Pure helpers ----------

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Slope of y over equally-spaced x. Used as a coarse trend signal —
 * not a real linear regression, just sign + magnitude. Returns 0 for
 * fewer than 2 points.
 */
function trendSlope(xs: number[]): number {
  if (xs.length < 2) return 0;
  const n = xs.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += xs[i];
    sumXY += i * xs[i];
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

function pushBounded<T>(arr: T[], item: T, limit: number): T[] {
  const next = [...arr, item];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

// ---------- Mastery state machine transitions ----------

/**
 * Choose next status given prior status + freshly-computed signals.
 * Encodes the state machine; no thresholds inline besides the defaults
 * imported above.
 */
function nextStatus(
  prior: MasteryStatus,
  signals: {
    accuracy: number;
    fluency: number;
    attempts: number;
    minItems: number;
  },
): MasteryStatus {
  const { accuracy, fluency, attempts, minItems } = signals;
  const enoughEvidence = attempts >= minItems;

  // Below the regression floor: regression cascade.
  if (accuracy < REGRESSION_FLOOR && enoughEvidence) {
    if (
      prior === "automatic" ||
      prior === "in_automaticity_zone" ||
      prior === "mastered_for_acquisition"
    ) {
      return "regressed";
    }
    return "practicing";
  }

  // Sustained mastery + fluency → automaticity climb.
  if (
    enoughEvidence &&
    accuracy >= MASTERY_FLOOR &&
    fluency >= FLUENCY_FLOOR
  ) {
    if (prior === "mastered_for_acquisition") return "in_automaticity_zone";
    if (prior === "in_automaticity_zone" && fluency >= 0.9) return "automatic";
    if (prior === "automatic") return "automatic";
    return "mastered_for_acquisition";
  }

  // Acquisition-but-not-fluent: hold at mastered_for_acquisition.
  if (enoughEvidence && accuracy >= ACCURACY_FLOOR) {
    if (prior === "automatic" || prior === "in_automaticity_zone") {
      return "in_automaticity_zone";
    }
    if (prior === "regressed") return "practicing";
    return "mastered_for_acquisition";
  }

  // Active practice band.
  if (prior === "locked") return "unlocked";
  if (prior === "unlocked") return "active";
  if (prior === "regressed") return "regressed";
  return prior === "active" || prior === "practicing" ? "practicing" : "active";
}

// ---------- Public API ----------

/**
 * Apply one attempt to a node. Returns the new NodeState plus a list
 * of state transitions (for telemetry emission).
 */
export function updateNodeMastery(
  prior: NodeState | undefined,
  attempt: {
    itemId: string;
    correct: boolean;
    latencyMs: number;
    hintCount: number;
    surface: Surface;
    ts?: number;
  },
  config: NodeConfig,
): {
  next: NodeState;
  transitioned: boolean;
  from: MasteryStatus;
  to: MasteryStatus;
} {
  const ts = attempt.ts ?? Date.now();
  const base = prior ?? emptyNodeState(config.id);

  const newAttempt: NodeAttempt = {
    ts,
    itemId: attempt.itemId,
    correct: attempt.correct,
    latencyMs: attempt.latencyMs,
    hintCount: attempt.hintCount,
    surface: attempt.surface,
  };

  const history = pushBounded(base.history, newAttempt, HISTORY_LIMIT);

  // Hinted attempts count at half weight when computing accuracy.
  const weighted = history.map((a) => ({
    correctScore: a.correct ? (a.hintCount > 0 ? 0.5 : 1) : 0,
    latencyMs: a.latencyMs,
    correct: a.correct,
  }));

  const accuracy = mean(weighted.map((w) => w.correctScore));
  const rollingAccuracy = clamp01(accuracy);

  const correctLatencies = weighted
    .filter((w) => w.correct)
    .map((w) => w.latencyMs);
  const rollingLatencyMs = median(correctLatencies);

  const targetLatency =
    config.automaticity_target_latency_ms ?? DEFAULT_LATENCY_TARGET_MS;
  // fluencyConfidence: fraction of correct attempts under the target.
  const fluencyConfidence =
    correctLatencies.length === 0
      ? 0
      : correctLatencies.filter((ms) => ms <= targetLatency).length /
        correctLatencies.length;

  // masteryConfidence is a smoothed accuracy with a slight latency penalty.
  const latencyPenalty = clamp01(
    Math.min(1, rollingLatencyMs / (targetLatency * 2)),
  );
  const masteryConfidence = clamp01(
    rollingAccuracy * (1 - 0.2 * (1 - fluencyConfidence)) -
      0.05 * latencyPenalty,
  );

  const minItems = config.mastery?.min_items ?? DEFAULT_MIN_ITEMS;

  const proposed = nextStatus(base.status, {
    accuracy: rollingAccuracy,
    fluency: fluencyConfidence,
    attempts: history.length,
    minItems,
  });

  const lastMasteredAt =
    base.lastMasteredAt == null && proposed === "mastered_for_acquisition"
      ? ts
      : base.lastMasteredAt;

  const next: NodeState = {
    ...base,
    status: proposed,
    masteryConfidence,
    fluencyConfidence,
    attempts: base.attempts + 1,
    history,
    rollingAccuracy,
    rollingLatencyMs,
    lastPracticedAt: ts,
    lastMasteredAt,
    forgettingRisk: calculateForgettingRisk({
      ...base,
      lastPracticedAt: ts,
      masteryConfidence,
      status: proposed,
    }),
    reviewDueAt: base.reviewDueAt, // Updated by reviewScheduler, not here.
  };

  return {
    next,
    transitioned: proposed !== base.status,
    from: base.status,
    to: proposed,
  };
}

/**
 * Forgetting-risk heuristic, in [0,1]. Combines:
 *   - days since last practice (longer = riskier)
 *   - inverse of mastery confidence (weak skills decay faster)
 *   - regression status (capped at high risk)
 *
 * Replaceable in M5 with a real spacing model (FSRS, SM-2, etc.).
 */
export function calculateForgettingRisk(
  node: Pick<NodeState, "lastPracticedAt" | "masteryConfidence" | "status">,
  now: number = Date.now(),
): number {
  if (node.status === "regressed") return 0.95;
  if (node.lastPracticedAt == null) return 0;
  const daysSince = (now - node.lastPracticedAt) / (24 * 60 * 60 * 1000);
  // Sigmoid-ish: 0 days ≈ 0, 7 days ≈ 0.5, 21 days ≈ 0.95, plateau.
  const decay = 1 - Math.exp(-daysSince / 7);
  const fragility = 1 - clamp01(node.masteryConfidence);
  return clamp01(0.4 * decay + 0.6 * fragility * decay);
}

/**
 * Should this node be on the review queue right now? Not when to *next*
 * schedule it — that's `reviewScheduler.ts`.
 */
export function shouldScheduleReview(
  node: NodeState,
  now: number = Date.now(),
): boolean {
  if (
    node.status !== "mastered_for_acquisition" &&
    node.status !== "in_automaticity_zone" &&
    node.status !== "automatic"
  ) {
    return false;
  }
  if (node.reviewDueAt != null && node.reviewDueAt <= now) return true;
  return calculateForgettingRisk(node, now) >= 0.7;
}

/**
 * Apply one passage attempt to a fluency gate's state.
 */
export function updateFluencyState(
  prior: FluencyState | undefined,
  attempt: {
    passageId: string;
    isCold: boolean;
    wcpm: number;
    accuracy: number;
    ts?: number;
  },
  gateId: FluencyGate,
): FluencyState {
  const ts = attempt.ts ?? Date.now();
  const base = prior ?? emptyFluencyState(gateId);

  const passageAttempt: PassageAttempt = {
    ts,
    passageId: attempt.passageId,
    isCold: attempt.isCold,
    wcpm: attempt.wcpm,
    accuracy: attempt.accuracy,
  };

  const history = pushBounded(
    base.history,
    passageAttempt,
    FLUENCY_HISTORY_LIMIT,
  );

  const coldBests = history.filter((h) => h.isCold).map((h) => h.wcpm);
  const practicedBests = history
    .filter((h) => !h.isCold)
    .map((h) => h.wcpm);

  const coldWcpm = coldBests.length ? Math.max(...coldBests) : base.coldWcpm;
  const practicedWcpm = practicedBests.length
    ? Math.max(...practicedBests)
    : base.practicedWcpm;

  const accuracyRate = mean(history.map((h) => h.accuracy));
  const fluencyTrend = trendSlope(history.map((h) => h.wcpm));

  return {
    gateId,
    coldWcpm,
    practicedWcpm,
    accuracyRate,
    passageAttempts: base.passageAttempts + 1,
    fluencyTrend,
    history,
    lastAttemptAt: ts,
  };
}

// Re-export thresholds so the validator + tests can assert against them.
export const THRESHOLDS = {
  ACCURACY_FLOOR,
  REGRESSION_FLOOR,
  MASTERY_FLOOR,
  FLUENCY_FLOOR,
  DEFAULT_MIN_ITEMS,
  DEFAULT_LATENCY_TARGET_MS,
} as const;
