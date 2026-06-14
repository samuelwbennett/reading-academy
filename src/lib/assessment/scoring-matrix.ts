// src/lib/assessment/scoring-matrix.ts (M16-B1)
//
// Single source of truth for "which assessment types can be scored
// by ASR vs which need a human grader."
//
// Architecture rule (M16-B):
//   Reading Academy must never present a manual-scoring node to a
//   student in normal mode. Items where the expected answer is a
//   single phoneme (e.g. "say the first sound in 'sun'") cannot be
//   reliably scored by Web Speech or Azure today. Those nodes are
//   teacher-scored only — they're excluded from the session planner
//   and surfaced as "teacher-led" in the Drill route.
//
// When a future engine (Azure phoneme-level scoring + custom
// pronunciation models) makes single-phoneme answers reliable,
// move the relevant assessment from TEACHER_SCORED → STUDENT_SCORED.

/**
 * Assessment types where the expected answer is a single phoneme
 * or a sequence of single phonemes. ASR can't reliably distinguish
 * /s/ from /sh/ or "ess" without a reference utterance, so these
 * stay teacher-scored until that gap closes.
 */
export const TEACHER_SCORED_ASSESSMENTS: ReadonlySet<string> = new Set([
  "phoneme_isolate_initial",
  "phoneme_isolate_final",
  "phoneme_isolate_medial",
  "phoneme_segment",
  "phoneme_segment_4_5",
  "letter_sound",
]);

/**
 * Assessment types where the expected answer is a complete word and
 * ASR (Web Speech or Azure) can score it reliably against a
 * reference text.
 */
export const STUDENT_SCORED_ASSESSMENTS: ReadonlySet<string> = new Set([
  "read_aloud",
  "cold_passage",
  "phoneme_blend",
  "phoneme_delete_initial",
  "phoneme_delete_final",
  "phoneme_substitute",
]);

/**
 * Assessment types whose answer is a complete word the student
 * speaks aloud — the ASR-scorable subset of the phoneme family.
 * Used by the new PhonemeAsrItem to know when to use mic vs to
 * surface a teacher-led panel.
 */
export const ASR_SCORABLE_PHONEME_ASSESSMENTS: ReadonlySet<string> = new Set([
  "phoneme_blend",
  "phoneme_delete_initial",
  "phoneme_delete_final",
  "phoneme_substitute",
]);

export function isTeacherScored(assessment: string | undefined | null): boolean {
  return !!assessment && TEACHER_SCORED_ASSESSMENTS.has(assessment);
}

export function isStudentScorable(assessment: string | undefined | null): boolean {
  return !!assessment && STUDENT_SCORED_ASSESSMENTS.has(assessment);
}

export function isAsrScorablePhoneme(assessment: string | undefined | null): boolean {
  return !!assessment && ASR_SCORABLE_PHONEME_ASSESSMENTS.has(assessment);
}
