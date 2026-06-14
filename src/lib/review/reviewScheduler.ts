// src/lib/review/reviewScheduler.ts
//
// Lightweight, deterministic spaced-review scheduler.
//
// Goal: pick when each mastered node should next surface in a session,
// and produce a ranked list of "due-today" reviews. Not a full FSRS or
// SM-2 implementation — those land in M5 once we have enough real
// telemetry to fit parameters. For now we use explicit, auditable
// heuristics:
//
//   1. Newly-mastered skills get reviewed soon (1 day).
//   2. Each successful review roughly doubles the interval (Leitner-ish).
//   3. A failed review collapses the interval back to the floor.
//   4. Fragility (low masteryConfidence) shortens the interval.
//   5. The scheduler is monotone: more attempts + more success ⇒ never
//      a *shorter* base interval, so a run of cold-passage successes
//      doesn't accidentally accelerate review of a strong skill.
//
// The scheduler is pure: { node, outcome } → { reviewDueAt, reviewLevel }.
// No I/O. Storage is the caller's job.

import type { NodeState } from "../mastery/studentModel";
import {
  reviewCard,
  rateAttempt,
  currentRetrievability,
  emptyCardState,
  type CardState,
  type Rating,
} from "./fsrs";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Tier ladder. Index = current review level. Value = days-until-next.
 * Mirrors the Reading Academy review cadence in build plan §6.4.
 */
const INTERVAL_DAYS: number[] = [1, 2, 4, 8, 16, 30, 60, 120];

const FLOOR_DAYS = INTERVAL_DAYS[0];
const CEILING_DAYS = INTERVAL_DAYS[INTERVAL_DAYS.length - 1];

export type ReviewOutcome = "passed" | "failed" | "skipped";

export interface ScheduleResult {
  /** Wall-clock ts of next review. */
  reviewDueAt: number;
  /** Index into INTERVAL_DAYS that produced this scheduling. */
  reviewLevel: number;
  /** Days from `now` to `reviewDueAt`, for display. */
  intervalDays: number;
}

interface ScheduleInput {
  node: NodeState;
  /** Optional: caller's notion of which Leitner box the node is in. */
  reviewLevel?: number;
  outcome: ReviewOutcome;
  now?: number;
}

/**
 * Compute the next review time for a node.
 *
 * - `passed`  → step up one box, capped at CEILING_DAYS.
 * - `failed`  → drop to FLOOR_DAYS (re-prove acquisition).
 * - `skipped` → stay at the same box, but re-due in FLOOR_DAYS.
 *
 * Fragility multiplier: confidence < 0.7 shrinks the interval by up
 * to 50% so weak mastery resurfaces faster.
 */
export function scheduleNextReview({
  node,
  reviewLevel = 0,
  outcome,
  now = Date.now(),
}: ScheduleInput): ScheduleResult {
  let nextLevel: number;
  if (outcome === "passed") {
    nextLevel = Math.min(reviewLevel + 1, INTERVAL_DAYS.length - 1);
  } else if (outcome === "failed") {
    nextLevel = 0;
  } else {
    nextLevel = reviewLevel;
  }

  const baseDays = INTERVAL_DAYS[nextLevel];
  const conf = clamp01(node.masteryConfidence);
  const fragilityFactor = conf >= 0.7 ? 1 : 0.5 + 0.5 * (conf / 0.7);
  const intervalDays = clamp(
    baseDays * fragilityFactor,
    FLOOR_DAYS,
    CEILING_DAYS,
  );

  return {
    reviewDueAt: now + Math.round(intervalDays * DAY_MS),
    reviewLevel: nextLevel,
    intervalDays,
  };
}

/**
 * Build today's review queue from a set of mastered/automaticity nodes.
 * Sort priority:
 *   1. overdue items first, by how overdue they are
 *   2. forgetting risk descending
 *   3. mastery confidence ascending (weakest first within tier)
 *
 * Caller decides how many to actually surface in a session.
 */
export function buildReviewQueue(
  nodes: NodeState[],
  now: number = Date.now(),
): NodeState[] {
  const eligible = nodes.filter(
    (n) =>
      (n.status === "mastered_for_acquisition" ||
        n.status === "in_automaticity_zone" ||
        n.status === "automatic" ||
        n.status === "regressed") &&
      n.reviewDueAt != null &&
      n.reviewDueAt <= now,
  );

  return [...eligible].sort((a, b) => {
    const overdueA = now - (a.reviewDueAt ?? now);
    const overdueB = now - (b.reviewDueAt ?? now);
    if (overdueA !== overdueB) return overdueB - overdueA;
    if (a.forgettingRisk !== b.forgettingRisk) {
      return b.forgettingRisk - a.forgettingRisk;
    }
    return a.masteryConfidence - b.masteryConfidence;
  });
}

/**
 * After a session that *did not* surface a node for review, decay its
 * confidence slightly so the model reflects forgetting. Keeps mastered
 * skills honest in the absence of attempts.
 */
export function decayUnpracticed(
  node: NodeState,
  now: number = Date.now(),
): NodeState {
  if (node.lastPracticedAt == null) return node;
  const daysSince = (now - node.lastPracticedAt) / DAY_MS;
  if (daysSince < 1) return node;
  // Lose ~2% of mastery confidence per dormant day, floored.
  const decayed = Math.max(
    0,
    node.masteryConfidence - 0.02 * Math.floor(daysSince),
  );
  return { ...node, masteryConfidence: decayed };
}

// ---------- FSRS-driven scheduling (M8-A) ----------
//
// The Leitner functions above stay for back-compat and as a sanity
// check. New code paths should use scheduleReviewFsrs which models
// stability/difficulty/retrievability per node.

export interface FsrsScheduleInput {
  /** Persisted FSRS card state for this node; pass undefined on first review. */
  card?: CardState;
  attempt: {
    correct: boolean;
    latencyMs: number;
    targetLatencyMs?: number;
  };
  /** Wall-clock ms at the moment of review. */
  now?: number;
}

export interface FsrsScheduleResult {
  card: CardState;
  reviewDueAt: number;
  intervalDays: number;
  rating: Rating;
  retrievabilityAtReview: number;
}

export function scheduleReviewFsrs({
  card,
  attempt,
  now = Date.now(),
}: FsrsScheduleInput): FsrsScheduleResult {
  const prior = card ?? emptyCardState();
  const rating = rateAttempt(
    attempt.correct,
    attempt.latencyMs,
    attempt.targetLatencyMs ?? 2000,
  );
  const out = reviewCard({ prior, rating, now });
  return {
    card: out.next,
    reviewDueAt: out.next.dueAt ?? now + Math.round(out.intervalDays * DAY_MS),
    intervalDays: out.intervalDays,
    rating,
    retrievabilityAtReview: out.retrievabilityAtReview,
  };
}

/**
 * Live retrievability for a node's FSRS card. Untouched cards
 * default to 1 (not at risk).
 */
export function nodeRetrievability(
  card: CardState | undefined,
  now: number = Date.now(),
): number {
  if (!card) return 1;
  return currentRetrievability(card, now);
}

// ---------- helpers ----------

function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}
function clamp01(x: number): number {
  return clamp(x, 0, 1);
}

export const REVIEW_CONSTANTS = {
  INTERVAL_DAYS,
  FLOOR_DAYS,
  CEILING_DAYS,
  DAY_MS,
} as const;

export type { CardState, Rating } from "./fsrs";
