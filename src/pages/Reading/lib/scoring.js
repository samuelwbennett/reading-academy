// Read-aloud scoring — v1, deterministic, no fuzzy match.
//
// Per M1-C spec:
//   - normalize lowercase
//   - trim punctuation
//   - allow exact match
//   - allow simple ASR-fluff tolerance ("the cat" matches "cat")
//   - DO NOT add Levenshtein, homophones, phoneme alignment yet
//
// Why no Levenshtein: false positives on short words ("rat" for "cat") are
// pedagogically worse than false negatives. Better to ask a student to retry
// than to credit a near-miss as correct.

export function normalize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Match the expected word against the ASR transcript and any alternatives.
// Strategy:
//   1. Exact normalized match against any candidate.
//   2. Token containment — handles articles and filler ("the cat" → cat).
// No Levenshtein, no homophones, no AI.
export function matchWord(expected, transcript, alternatives = []) {
  const exp = normalize(expected);
  if (!exp) return false;
  const candidates = [transcript, ...(alternatives || [])].filter(Boolean);
  if (candidates.length === 0) return false;

  for (const cand of candidates) {
    const norm = normalize(cand);
    if (!norm) continue;
    if (norm === exp) return true;
    const tokens = norm.split(/\s+/);
    if (tokens.includes(exp)) return true;
  }
  return false;
}

// Score a single attempt against the item's expected answer.
// Returns the canonical attempt payload that recordAttempt + telemetry want.
export function scoreReadAloud({ item, asrResult, source = "web_speech" }) {
  const expected = item?.answer ?? item?.prompt ?? "";
  const transcript = asrResult?.transcript ?? null;
  const alternatives = asrResult?.alternatives ?? [];
  const correct =
    !asrResult?.error &&
    !!transcript &&
    matchWord(expected, transcript, alternatives);

  return {
    correct,
    transcript,
    alternatives,
    expected,
    latencyMs: asrResult?.latencyMs ?? 0,
    confidence: asrResult?.confidence ?? null,
    error: asrResult?.error ?? null,
    source,
  };
}

// Pronunciation-aware scoring (M15-D).
//
// When the ASR result comes from Azure (it carries accuracyScore +
// per-word breakdowns), use those to make a higher-confidence verdict
// than transcript matching alone. Tunable thresholds:
//
//   accuracyScore >= 70  AND transcript matches expected → CORRECT
//   accuracyScore  < 50  → INCORRECT (regardless of fuzzy transcript)
//   in between           → fall back to transcript matching
//
// Rationale: Azure's pronunciation accuracy nails /s/ vs /sh/ where
// transcript-only scoring loses confidence. But we still gate on
// transcript so a student saying "fish" for an item targeting "ship"
// can't pass via clean enunciation alone.
export function scoreReadAloudAzure({ item, asrResult, source = "azure_asr" }) {
  const expected = item?.answer ?? item?.prompt ?? "";
  const transcript = asrResult?.transcript ?? null;
  const accuracy = asrResult?.accuracyScore ?? null;
  const fluency = asrResult?.fluencyScore ?? null;
  const transcriptOk = matchWord(expected, transcript);

  let correct;
  let pronunciationVerdict;
  if (asrResult?.error) {
    correct = false;
    pronunciationVerdict = "error";
  } else if (typeof accuracy === "number") {
    if (accuracy >= 70 && transcriptOk) {
      correct = true;
      pronunciationVerdict = "high_confidence_correct";
    } else if (accuracy < 50) {
      correct = false;
      pronunciationVerdict = "low_accuracy";
    } else {
      correct = transcriptOk;
      pronunciationVerdict = transcriptOk
        ? "transcript_match_only"
        : "transcript_mismatch";
    }
  } else {
    correct = transcriptOk;
    pronunciationVerdict = transcriptOk ? "transcript_only" : "transcript_only_miss";
  }

  return {
    correct,
    transcript,
    alternatives: [],
    expected,
    latencyMs: asrResult?.latencyMs ?? 0,
    confidence: typeof accuracy === "number" ? accuracy / 100 : null,
    error: asrResult?.error ?? null,
    source,
    azureAccuracy: accuracy,
    azureFluency: fluency,
    pronunciationVerdict,
    words: asrResult?.words ?? null,
    phonemes: asrResult?.phonemes ?? null,
  };
}

/**
 * Engine-agnostic dispatcher. Routes to the right scoring helper
 * based on the asrResult.engine field that useAdaptiveSpeech sets.
 */
export function scoreReadAloudAuto({ item, asrResult }) {
  if (asrResult?.engine === "azure" || typeof asrResult?.accuracyScore === "number") {
    return scoreReadAloudAzure({ item, asrResult });
  }
  return scoreReadAloud({ item, asrResult, source: "web_speech" });
}

// Score an adult-override tap. No transcript captured; latency is from when
// the item was rendered to when the button was pressed.
export function scoreAdultOverride({ item, correct, latencyMs }) {
  return {
    correct: !!correct,
    transcript: null,
    alternatives: [],
    expected: item?.answer ?? item?.prompt ?? "",
    latencyMs: latencyMs ?? 0,
    confidence: null,
    error: null,
    source: "adult_override",
  };
}
