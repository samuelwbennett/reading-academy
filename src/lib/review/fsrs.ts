// src/lib/review/fsrs.ts
//
// FSRS-4-inspired spaced-review scheduler for skill nodes.
//
// FSRS (Free Spaced Repetition Scheduler) is the modern replacement
// for SM-2 / Anki's algorithm. It models each card with three
// quantities:
//
//   - stability  S  — how long the memory lasts (days). Larger = more stable.
//   - difficulty D  — intrinsic difficulty of the card, in [1, 10].
//   - retrievability R — probability of recalling the card right now,
//                        derived from time-since-review and stability.
//
// On each review the learner submits a rating in {1=again, 2=hard,
// 3=good, 4=easy}. The model:
//   - updates D in the direction of the rating
//   - updates S based on prior S, D, R, and the rating
//   - schedules the next review at the time when R will fall to a
//     target retention (we use 0.9, the FSRS default).
//
// We adapt FSRS to Reading Academy by:
//   - Mapping the binary correct/incorrect signal we already have
//     into a 4-level rating using latency.
//   - Using FSRS-4's published default weights (Anki / open-spaced-repetition
//     project default seed). Per-student fitting comes in M9 once
//     telemetry volume justifies it.
//
// Pure functions. No I/O. Deterministic.

const W: readonly number[] = [
  0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01,
  1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61,
];

const TARGET_RETENTION = 0.9;
const DECAY = -0.5;
const FACTOR = 19 / 81;
// Boundaries.
const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 10;
const MIN_STABILITY = 0.01;
const MAX_INTERVAL_DAYS = 365 * 5;

export type Rating = 1 | 2 | 3 | 4; // again, hard, good, easy

export interface CardState {
  /** Stability in days. */
  stability: number;
  /** Difficulty in [1, 10]. */
  difficulty: number;
  /** Last review wall-clock ms; null on first attempt. */
  lastReviewedAt: number | null;
  /** ISO ms when the card is due. */
  dueAt: number | null;
  /** Total reviews logged. */
  reps: number;
  /** Times the learner clicked again (failed) on this card. */
  lapses: number;
}

export function emptyCardState(): CardState {
  return {
    stability: 0,
    difficulty: 0,
    lastReviewedAt: null,
    dueAt: null,
    reps: 0,
    lapses: 0,
  };
}

// ---- core math ----

function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

function initStability(rating: Rating): number {
  // W[0..3] = initial stability per rating.
  return Math.max(W[rating - 1], MIN_STABILITY);
}

function initDifficulty(rating: Rating): number {
  return clamp(W[4] - (rating - 3) * W[5], MIN_DIFFICULTY, MAX_DIFFICULTY);
}

function nextDifficulty(prior: number, rating: Rating): number {
  const next = prior - W[6] * (rating - 3);
  // Mean-reversion towards the difficulty implied by a "good" rating.
  const target = initDifficulty(3);
  const meanReverted = W[7] * target + (1 - W[7]) * next;
  return clamp(meanReverted, MIN_DIFFICULTY, MAX_DIFFICULTY);
}

function retrievability(elapsedDays: number, stability: number): number {
  if (stability <= 0) return 0;
  return Math.pow(1 + FACTOR * (elapsedDays / stability), DECAY);
}

function recallStability(
  difficulty: number,
  stability: number,
  r: number,
  rating: Rating,
): number {
  const hardPenalty = rating === 2 ? W[15] : 1;
  const easyBonus = rating === 4 ? W[16] : 1;
  const factor =
    Math.exp(W[8]) *
    (11 - difficulty) *
    Math.pow(stability, -W[9]) *
    (Math.exp(W[10] * (1 - r)) - 1) *
    hardPenalty *
    easyBonus;
  return Math.max(stability * (1 + factor), MIN_STABILITY);
}

function lapseStability(
  difficulty: number,
  stability: number,
  r: number,
): number {
  const next =
    W[11] *
    Math.pow(difficulty, -W[12]) *
    (Math.pow(stability + 1, W[13]) - 1) *
    Math.exp((1 - r) * W[14]);
  return Math.max(next, MIN_STABILITY);
}

function intervalDaysFor(stability: number): number {
  // Solve r(t) = TARGET_RETENTION for t.
  const t = (stability / FACTOR) * (Math.pow(TARGET_RETENTION, 1 / DECAY) - 1);
  return clamp(t, 0.5, MAX_INTERVAL_DAYS);
}

// ---- public API ----

export interface ReviewInput {
  prior: CardState;
  rating: Rating;
  /** Wall-clock ms at the moment of review. */
  now: number;
}

export interface ReviewOutput {
  next: CardState;
  /** Days until next review (rounded to 0.5). */
  intervalDays: number;
  /** Computed retrievability at review time (diagnostic). */
  retrievabilityAtReview: number;
}

export function reviewCard({ prior, rating, now }: ReviewInput): ReviewOutput {
  const isFirstReview = prior.reps === 0 || prior.stability === 0;
  let stability: number;
  let difficulty: number;
  let r = 1;

  if (isFirstReview) {
    stability = initStability(rating);
    difficulty = initDifficulty(rating);
  } else {
    const elapsedDays = prior.lastReviewedAt != null
      ? Math.max(0, (now - prior.lastReviewedAt) / 86_400_000)
      : 0;
    r = retrievability(elapsedDays, prior.stability);
    difficulty = nextDifficulty(prior.difficulty, rating);
    stability =
      rating === 1
        ? lapseStability(difficulty, prior.stability, r)
        : recallStability(difficulty, prior.stability, r, rating);
  }

  const intervalDays = Math.round(intervalDaysFor(stability) * 2) / 2;
  const dueAt = now + Math.round(intervalDays * 86_400_000);

  return {
    next: {
      stability,
      difficulty,
      lastReviewedAt: now,
      dueAt,
      reps: prior.reps + 1,
      lapses: prior.lapses + (rating === 1 ? 1 : 0),
    },
    intervalDays,
    retrievabilityAtReview: r,
  };
}

/**
 * Project a binary correct/incorrect attempt into the 4-level FSRS
 * rating using latency. Tunable; the defaults assume a fluency
 * target of ~2 s for read-aloud and ~4 s for phoneme tasks.
 */
export function rateAttempt(
  correct: boolean,
  latencyMs: number,
  targetLatencyMs = 2000,
): Rating {
  if (!correct) return 1;
  if (latencyMs <= targetLatencyMs * 0.6) return 4; // easy
  if (latencyMs <= targetLatencyMs) return 3; // good
  return 2; // hard
}

/**
 * Live retrievability given the current model state and the time
 * right now. Useful for sorting the review queue by what's most at
 * risk of being forgotten.
 */
export function currentRetrievability(card: CardState, now: number): number {
  if (card.lastReviewedAt == null || card.stability <= 0) return 1;
  const elapsedDays = Math.max(0, (now - card.lastReviewedAt) / 86_400_000);
  return retrievability(elapsedDays, card.stability);
}

export const FSRS_CONSTANTS = {
  W,
  TARGET_RETENTION,
  DECAY,
  FACTOR,
  MAX_INTERVAL_DAYS,
} as const;
