// Word-level Levenshtein aligner.
//
// Takes the expected passage text and the (concatenated) ASR transcript and
// returns a per-word alignment plus a summary. Used to compute WCPM and
// passage accuracy after a cold-read attempt.
//
// Tokenization is intentionally aggressive: lowercase, strip non-letters,
// collapse whitespace. The Hasbrouck & Tindal procedural manual treats
// self-corrections, repetitions, and punctuation differently — v1 here
// follows the simpler rule: a word counts as correct if it aligns to the
// expected position with an exact normalized match. Substitutions, skips,
// and inserted noise are misses.
//
// Algorithm:
//   1. Tokenize both sides.
//   2. Build edit-distance DP table over words.
//   3. Backtrack to assign per-expected-word verdict.
//   4. Sum matches for WCPM/accuracy.
//
// Complexity: O(m × n). Passages are ~60–150 words; transcripts similar.
// Cost is in microseconds. No need to optimize further.

export function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z\s]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function alignPassage(expectedText, transcript) {
  const e = tokenize(expectedText);
  const t = tokenize(transcript);
  const m = e.length;
  const n = t.length;

  if (m === 0) {
    return { correctWords: 0, totalExpected: 0, totalAttempted: n, aligned: [] };
  }
  if (n === 0) {
    return {
      correctWords: 0,
      totalExpected: m,
      totalAttempted: 0,
      aligned: e.map((w) => ({ expected: w, transcript: null, match: false })),
    };
  }

  // dp[i][j] = min edit distance to align e[0..i] with t[0..j].
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const subCost = e[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j - 1] + subCost,
        dp[i - 1][j] + 1, // deletion (skipped a word)
        dp[i][j - 1] + 1, // insertion (extra word)
      );
    }
  }

  // Backtrack from (m,n) collecting per-pair decisions.
  let i = m;
  let j = n;
  const aligned = [];
  let matched = 0;

  while (i > 0 || j > 0) {
    if (
      i > 0 &&
      j > 0 &&
      e[i - 1] === t[j - 1] &&
      dp[i][j] === dp[i - 1][j - 1]
    ) {
      aligned.unshift({ expected: e[i - 1], transcript: t[j - 1], match: true });
      matched++;
      i--; j--;
    } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      // Substitution.
      aligned.unshift({ expected: e[i - 1], transcript: t[j - 1], match: false });
      i--; j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      // Skipped word in transcript (deletion from student perspective).
      aligned.unshift({ expected: e[i - 1], transcript: null, match: false });
      i--;
    } else {
      // Extra word in transcript (noise).
      aligned.unshift({ expected: null, transcript: t[j - 1], match: false });
      j--;
    }
  }

  return {
    correctWords: matched,
    totalExpected: m,
    totalAttempted: n,
    aligned,
  };
}

// Compute WCPM and accuracy from an alignment + drill duration.
export function scorePassage(alignment, durationMs) {
  const minutes = Math.max(durationMs / 60_000, 1 / 60);
  const wcpm = Math.round(alignment.correctWords / minutes);
  const accuracy = alignment.totalExpected > 0
    ? alignment.correctWords / alignment.totalExpected
    : 0;
  return {
    wcpm,
    accuracy,
    correctWords: alignment.correctWords,
    totalExpected: alignment.totalExpected,
    totalAttempted: alignment.totalAttempted,
    durationMs,
  };
}

// Flatten passage paragraphs/sentences into one text string the aligner can
// chew on. Word-list arrays in the bank are also acceptable but the rendered
// text drives the canonical word order.
export function passageToText(passage) {
  if (!passage?.paragraphs) return "";
  return passage.paragraphs
    .flatMap((p) => (p.sentences || []).map((s) => s.text || ""))
    .join(" ");
}
