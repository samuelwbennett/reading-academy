// src/lib/cognitive/contribution.ts
//
// Reading Academy's contribution to the unified Student Cognitive
// Profile. Pure functions over the M3 StudentModel — no I/O.
//
// The orchestration layer pulls these via /api/cognitive-contribution
// and merges with other apps' contributions. Reading Academy does not
// own the final profile; it owns the evidence it can defensibly emit.
//
// Spec: docs/architecture/cognitive-profile-v1.md
//
// Honesty rule: confidence reflects the evidence base, not how good
// the math is. Few samples → low confidence. The merger applies that
// weighting automatically.

import type { NodeState, StudentModel } from "../mastery/studentModel";
import type { CardState } from "../review/fsrs";

export const CONTRIBUTION_SCHEMA_VERSION = "cognitive-profile/v1";
export const APP_ID = "reading_academy";

export type DimensionId =
  | "automaticity"
  | "workingPace"
  | "persistence"
  | "forgettingSlope"
  | "decodingEfficiency"
  | "mathFluency"
  | "interventionResponsiveness"
  | "masteryVelocity";

export interface DimensionContribution {
  dimension: DimensionId;
  value: number; // [0, 1]
  confidence: number; // [0, 1]
  samples: number;
  evidence: {
    method: string;
    details: string;
  };
}

export interface CognitiveContributionPayload {
  studentId: string | null;
  appId: typeof APP_ID;
  schemaVersion: typeof CONTRIBUTION_SCHEMA_VERSION;
  computedAt: string;
  contributions: DimensionContribution[];
}

// ---- helpers ----

const MASTERED_STATES = new Set([
  "mastered_for_acquisition",
  "in_automaticity_zone",
  "automatic",
]);

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** Confidence in [0,1] that grows with evidence count, plateaus around 0.9. */
function confidenceFromSamples(n: number, scale = 50): number {
  if (n <= 0) return 0;
  return clamp01(1 - Math.exp(-n / scale)) * 0.9;
}

function totalAttempts(model: StudentModel): number {
  let n = 0;
  for (const ns of Object.values(model.nodes)) n += ns.attempts;
  return n;
}

// ---- per-dimension derivations ----

/**
 * Automaticity = mean FSRS stability across nodes that have at least
 * a few reps, normalized to [0, 1] via stability target.
 */
function deriveAutomaticity(model: StudentModel): DimensionContribution | null {
  const cards: CardState[] = [];
  for (const ns of Object.values(model.nodes)) {
    if (ns.fsrsCard && ns.fsrsCard.reps >= 2) cards.push(ns.fsrsCard);
  }
  if (cards.length === 0) return null;
  const STABILITY_TARGET_DAYS = 30;
  const meanStability =
    cards.reduce((acc, c) => acc + c.stability, 0) / cards.length;
  const value = clamp01(meanStability / STABILITY_TARGET_DAYS);
  const samples = cards.reduce((acc, c) => acc + c.reps, 0);
  return {
    dimension: "automaticity",
    value,
    confidence: confidenceFromSamples(samples, 80),
    samples,
    evidence: {
      method: "fsrs_stability_aggregate",
      details: `Mean FSRS stability ${meanStability.toFixed(1)}d across ${cards.length} nodes (${samples} reviews).`,
    },
  };
}

/**
 * Working pace = items per minute averaged across recent activity,
 * normalized so 6 items/min ≈ 1.0 (a strong K-2 sustained rate).
 */
function deriveWorkingPace(model: StudentModel): DimensionContribution | null {
  const all: { ts: number; latencyMs: number }[] = [];
  for (const ns of Object.values(model.nodes)) {
    for (const a of ns.history) {
      if (Number.isFinite(a.ts) && Number.isFinite(a.latencyMs) && a.latencyMs > 0) {
        all.push({ ts: a.ts, latencyMs: a.latencyMs });
      }
    }
  }
  if (all.length < 8) return null;
  const meanLatencyMs =
    all.reduce((acc, a) => acc + a.latencyMs, 0) / all.length;
  if (meanLatencyMs <= 0) return null;
  const itemsPerMinute = 60_000 / meanLatencyMs;
  const TARGET_IPM = 6;
  const value = clamp01(itemsPerMinute / TARGET_IPM);
  return {
    dimension: "workingPace",
    value,
    confidence: confidenceFromSamples(all.length, 100),
    samples: all.length,
    evidence: {
      method: "items_per_minute_window",
      details: `Mean response latency ${Math.round(meanLatencyMs)}ms → ${itemsPerMinute.toFixed(2)} items/min (target 6).`,
    },
  };
}

/**
 * Persistence = ratio of "session continues after a wrong answer" to
 * total wrong answers. We approximate this from history: for each
 * incorrect attempt, did the next attempt land within 5 minutes?
 */
function derivePersistence(model: StudentModel): DimensionContribution | null {
  // Flatten and sort all attempts globally.
  const events: { ts: number; correct: boolean }[] = [];
  for (const ns of Object.values(model.nodes)) {
    for (const a of ns.history) {
      events.push({ ts: a.ts, correct: a.correct });
    }
  }
  if (events.length < 6) return null;
  events.sort((a, b) => a.ts - b.ts);

  let wrongCount = 0;
  let continuedCount = 0;
  const FIVE_MIN_MS = 5 * 60 * 1000;
  for (let i = 0; i < events.length - 1; i++) {
    if (events[i].correct) continue;
    wrongCount += 1;
    if (events[i + 1].ts - events[i].ts < FIVE_MIN_MS) continuedCount += 1;
  }
  if (wrongCount < 3) return null;
  const value = clamp01(continuedCount / wrongCount);
  return {
    dimension: "persistence",
    value,
    confidence: confidenceFromSamples(wrongCount, 20),
    samples: wrongCount,
    evidence: {
      method: "post_failure_continuation_ratio",
      details: `${continuedCount}/${wrongCount} incorrect attempts had a follow-up within 5 minutes.`,
    },
  };
}

/**
 * Forgetting slope = mean lapse-per-review across nodes with FSRS
 * history. Higher lapse rate → steeper forgetting.
 */
function deriveForgettingSlope(model: StudentModel): DimensionContribution | null {
  const cards: CardState[] = [];
  for (const ns of Object.values(model.nodes)) {
    if (ns.fsrsCard && ns.fsrsCard.reps >= 3) cards.push(ns.fsrsCard);
  }
  if (cards.length === 0) return null;
  let totalReps = 0;
  let totalLapses = 0;
  for (const c of cards) {
    totalReps += c.reps;
    totalLapses += c.lapses;
  }
  if (totalReps < 6) return null;
  const lapseRate = totalLapses / totalReps;
  // Lapse rate of ~0 → slope 0 (great memory). Lapse rate of ~0.5 → slope 1 (steep).
  const value = clamp01(lapseRate / 0.5);
  return {
    dimension: "forgettingSlope",
    value,
    confidence: confidenceFromSamples(totalReps, 60),
    samples: totalReps,
    evidence: {
      method: "fsrs_lapse_rate",
      details: `${totalLapses}/${totalReps} reviews ended in 'again'.`,
    },
  };
}

/**
 * Decoding efficiency = composite of mastered-CVC-and-up nodes count
 * + mean accuracy on those nodes + cold-read WCPM gain. Reading
 * Academy's primary signal — the most authoritative contribution
 * we make to the unified profile.
 */
function deriveDecodingEfficiency(model: StudentModel): DimensionContribution | null {
  const decodingNodeIds = Array.from(
    Object.keys(model.nodes).filter((id) =>
      id.startsWith("CVC_") ||
      id.startsWith("BL_") ||
      id.startsWith("DG_") ||
      id.startsWith("TG_") ||
      id.startsWith("SE_") ||
      id.startsWith("VT_") ||
      id.startsWith("RC_") ||
      id.startsWith("LS_"),
    ),
  );
  if (decodingNodeIds.length === 0) return null;

  let masteredCount = 0;
  let accSum = 0;
  let attemptSum = 0;
  for (const id of decodingNodeIds) {
    const ns = model.nodes[id];
    if (!ns) continue;
    if (MASTERED_STATES.has(ns.status)) masteredCount += 1;
    accSum += ns.rollingAccuracy * ns.attempts;
    attemptSum += ns.attempts;
  }
  if (attemptSum < 8) return null;
  const meanAccuracy = accSum / attemptSum;

  // Cold WCPM contributes if any fluency gate has cold reads.
  let coldWcpm = 0;
  let coldAttempts = 0;
  for (const f of Object.values(model.fluency)) {
    if (!f) continue;
    coldWcpm = Math.max(coldWcpm, f.coldWcpm);
    coldAttempts += f.history.filter((h) => h.isCold).length;
  }
  // 60 WCPM ≈ end-of-grade-1 benchmark; map linearly to [0, 1].
  const wcpmComponent = clamp01(coldWcpm / 60);
  const masteryComponent = clamp01(masteredCount / 12); // 12 mastered decoding nodes ≈ strong K-2

  const value = clamp01(
    0.4 * meanAccuracy + 0.3 * masteryComponent + 0.3 * wcpmComponent,
  );
  return {
    dimension: "decodingEfficiency",
    value,
    confidence: confidenceFromSamples(attemptSum + coldAttempts * 5, 120),
    samples: attemptSum + coldAttempts,
    evidence: {
      method: "decoding_composite_v1",
      details: `${masteredCount} mastered decoding nodes; mean accuracy ${(meanAccuracy * 100).toFixed(0)}%; best cold WCPM ${Math.round(coldWcpm)}.`,
    },
  };
}

/**
 * Intervention responsiveness = movement in mastery confidence after
 * a "regressed → practicing → mastered" cycle. We approximate this
 * by counting nodes that crossed back to mastery after a regressed
 * spell, weighted by how fast they came back.
 *
 * v1 is intentionally low-confidence — we don't have explicit
 * intervention tagging yet (M11). Once the Teacher Action Engine
 * ships, this contribution will get an order of magnitude better.
 */
function deriveInterventionResponsiveness(
  model: StudentModel,
): DimensionContribution | null {
  // Heuristic v1: count cards with reps >= 5 and lapses >= 1 that
  // have current stability >= 5 days. They lapsed and recovered.
  let recoveries = 0;
  let lapsedCards = 0;
  for (const ns of Object.values(model.nodes)) {
    const c = ns.fsrsCard;
    if (!c || c.lapses === 0) continue;
    lapsedCards += 1;
    if (c.stability >= 5) recoveries += 1;
  }
  if (lapsedCards < 2) return null;
  const value = clamp01(recoveries / lapsedCards);
  return {
    dimension: "interventionResponsiveness",
    value,
    confidence: Math.min(0.5, confidenceFromSamples(lapsedCards, 8)),
    samples: lapsedCards,
    evidence: {
      method: "lapse_recovery_v1_heuristic",
      details: `${recoveries}/${lapsedCards} lapsed cards have current FSRS stability ≥ 5 days. Pre-pilot heuristic — superseded by M11 intervention tagging.`,
    },
  };
}

/**
 * Mastery velocity = newly-mastered nodes per active session,
 * smoothed. Composite signal — when the others trend up so does this.
 */
function deriveMasteryVelocity(
  model: StudentModel,
): DimensionContribution | null {
  // "Sessions" approximated by distinct calendar days the student
  // had at least one attempt.
  const dayKeys = new Set<string>();
  let masteredNodes = 0;
  for (const ns of Object.values(model.nodes)) {
    for (const a of ns.history) {
      const d = new Date(a.ts);
      const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
      dayKeys.add(key);
    }
    if (MASTERED_STATES.has(ns.status)) masteredNodes += 1;
  }
  const sessions = dayKeys.size;
  if (sessions < 2) return null;
  const newMasteryPerSession = masteredNodes / sessions;
  // 0.5 mastered per session → value 1.0. K-2 students typically
  // hit this rhythm in early CVC.
  const value = clamp01(newMasteryPerSession / 0.5);
  const samples = totalAttempts(model);
  return {
    dimension: "masteryVelocity",
    value,
    confidence: confidenceFromSamples(samples, 150),
    samples,
    evidence: {
      method: "mastery_per_session_smoothed",
      details: `${masteredNodes} mastered across ${sessions} active days → ${newMasteryPerSession.toFixed(2)} per session.`,
    },
  };
}

// ---- public API ----

/**
 * Build Reading Academy's full contribution payload. Returns only
 * the dimensions for which we have evidence — null entries are
 * dropped so the orchestration layer doesn't see noise.
 */
export function buildContribution(
  model: StudentModel,
  studentId: string | null = null,
  now: number = Date.now(),
): CognitiveContributionPayload {
  const contributions: DimensionContribution[] = [];
  const candidates = [
    deriveAutomaticity(model),
    deriveWorkingPace(model),
    derivePersistence(model),
    deriveForgettingSlope(model),
    deriveDecodingEfficiency(model),
    deriveInterventionResponsiveness(model),
    deriveMasteryVelocity(model),
  ];
  for (const c of candidates) {
    if (c && c.confidence >= 0.05) contributions.push(c);
  }
  return {
    studentId,
    appId: APP_ID,
    schemaVersion: CONTRIBUTION_SCHEMA_VERSION,
    computedAt: new Date(now).toISOString(),
    contributions,
  };
}

// Re-exports for the API endpoint.
export const __dimensionDerivers = {
  deriveAutomaticity,
  deriveWorkingPace,
  derivePersistence,
  deriveForgettingSlope,
  deriveDecodingEfficiency,
  deriveInterventionResponsiveness,
  deriveMasteryVelocity,
};
