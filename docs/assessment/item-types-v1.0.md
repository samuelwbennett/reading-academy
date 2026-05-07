# Item Type Catalog v1.0

**Authored by:** Agent 03 — Assessment & Mastery
**Status:** v1.0, locked. New item types require explicit re-approval.
**Date:** 2026-05-07

The taxonomy of assessment item types Reading Academy uses across all K–2 nodes. Every node in the graph references one of these types via its `assessment` field. Each type has a frozen UX contract, a deterministic scoring rule, and a path from today's MVP to the eventual Azure-powered version.

A new item type is a structural decision, not a content choice. New types require this agent's approval and a written addendum to this catalog.

---

## Common contract for every item type

Every item, regardless of type, conforms to this attempt schema when scored:

```ts
type Attempt = {
  itemId: string;          // bank-stable item identifier
  nodeId: string;
  presentedAt: number;     // ms epoch when stimulus rendered/audio-onset
  respondedAt: number;     // ms epoch when response captured
  latencyMs: number;       // respondedAt - presentedAt
  recognized: string | null;  // ASR/typed/tap result
  expected: string;        // canonical correct answer
  correct: boolean;        // deterministic match per item type's rule
  asr?: { engine: "web_speech" | "azure_pa"; alts?: string[]; confidence?: number };
  typedInput?: string;     // for dictation
  taps?: Array<{ idx: number; ts: number }>;  // for tap-based items
  drillId?: string;
  itemContext: "lesson" | "review" | "fluency" | "diagnostic" | "cold_check";
};
```

Latency starts on **stimulus completion** (audio finished playing, or text rendered to screen), not on stimulus *start*. A 4-syllable audio prompt and a 1-syllable audio prompt should produce comparable latencies for equivalent skill.

---

## 1. `phoneme_isolate_initial`

**Strand fit:** PA_01

**What the student does:** Hears a spoken word. Says the first phoneme aloud.

**Stimulus:**
- Audio: TTS plays the target word (e.g., "sun"), single playback, "Play again" button available.
- Visual: speaker glyph; no letters on screen.

**Response:**
- ASR captures spoken phoneme (e.g., "/s/" → student says "sss").

**Scoring:**
```ts
function score(item, attempt) {
  const expected = item.expected;       // e.g., "s" or "sh"
  const heard = (attempt.asr.alts || []).join(" ").toLowerCase();
  // Match if any alt contains the expected phoneme as a free token
  // OR if the alt starts with the expected phoneme + optional vowel padding
  return phonemeContainsHead(heard, expected);
}
```

`phonemeContainsHead` rules:
- Exact: "s" === "s"
- Vowel-padded: "sss", "ess", "es" all match "s" (ASR adds a default vowel for isolated consonants)
- Digraph: "sh" matches "sh", "shh", "esh"
- Stop consonants: /p/, /t/, /k/, /b/, /d/, /g/ may register as "puh"/"tuh"/"kuh"/"buh"/"duh"/"guh" in ASR — accept the prefix.

**Latency:** From end-of-audio-playback to first ASR partial result.

**Today (Web Speech API):** Whole-utterance recognition only; the heuristic above is fragile for stop consonants. Acceptable for v1; flagged for upgrade.

**Future (Azure PA):** Phoneme-level alignment. Match the expected phoneme directly against the produced phoneme stream; reject if a vowel intrudes between word boundaries.

**Edge cases:**
- Silence > timeout → incorrect.
- Student says full word ("sun") instead of first phoneme — count as **incorrect** but flag in telemetry as "task confusion." Pattern across attempts triggers a re-explanation.
- Multiple phonemes spoken ("ssssooon") — count first as the answer.

**Item bank size minimum:** 20 cold words across consonant set 1; 30 once consonant set 2 unlocks.

---

## 2. `phoneme_isolate_final`

**Strand fit:** PA_02

**What the student does:** Hears a spoken word. Says the last phoneme aloud.

**Spec is identical to type 1** with two differences:
- Latency includes the audio playback duration (the stimulus must finish before the student can isolate the final phoneme).
- Items must end in a single phoneme (avoid digraphs that consolidate, e.g., -ng, in this node's bank).

**Item bank size minimum:** 20.

---

## 3. `phoneme_isolate_medial`

**Strand fit:** PA_03

**What the student does:** Hears a CVC word. Says the medial vowel phoneme.

**Spec identical to types 1–2.** Items are CVC only; phoneme bank is the five short vowels.

**Note:** Highest research-validated predictor of decoding among the isolation tasks (Yopp 1988). Worth its own node.

**Item bank size minimum:** 20 (4 per vowel).

---

## 4. `phoneme_blend`

**Strand fit:** PA_04, PA_05; the active node in current MVP (PA_04_blend_cvc)

**What the student does:** Hears a sequence of phonemes (e.g., "/k/", "/a/", "/t/", spaced ~850ms apart). Blends them and says the whole word.

**Stimulus:**
- Sequenced audio: each phoneme plays in sequence with a configurable inter-phoneme gap (default 850ms; tighter as the student progresses).
- Visual scaffold: bubbles light up one at a time as phonemes play (already implemented in `BlendTask`).

**Response:**
- ASR captures spoken whole word.

**Scoring:**
```ts
function score(item, attempt) {
  return matchWord(item.expected, attempt.asr.alts || []);
}
```

`matchWord` rule (already implemented in `src/App.jsx`):
- Normalize: lowercase, strip non-alpha.
- Exact match against any ASR alternative wins.
- Token containment ("the cat" contains "cat") wins.
- No Levenshtein. False positives ("rat" for "cat") are pedagogically worse than false negatives.

**Latency:** From end-of-final-phoneme-playback to first ASR result.

**Edge cases:**
- Student says blended phonemes back ("/k/ /a/ /t/") instead of the whole word — count as **incorrect** but log "task confusion."
- Student says wrong word that happens to contain the right phonemes ("cat-mat") — match takes priority by token containment; "cat-mat" contains "cat", so correct. This is a known imperfection of whole-word matching that goes away with Azure phoneme alignment.

**Item bank size minimum:** 20.

---

## 5. `phoneme_segment`

**Strand fit:** PA_06, PA_07

**What the student does:** Hears a spoken word. Says each phoneme aloud, in order.

**Today (Web Speech API):** **Not viable.** Web Speech recognizes utterances, not phoneme streams. v1 implementation falls back to `phoneme_blend` semantics (the inverse of segmenting; same skill set).

**Future (Azure PA):** Capture full audio, run pronunciation assessment with `granularity=phoneme`, compare returned phoneme array against expected sequence.

**Scoring (Azure path):**
```ts
function score(item, attempt) {
  const produced = attempt.asr.phonemes;       // ["k", "a", "t"]
  const expected = item.expected_phonemes;     // ["k", "a", "t"]
  if (produced.length !== expected.length) return false;
  return produced.every((p, i) => phonemeEquivalent(p, expected[i]));
}
```

**`phonemeEquivalent` allows:**
- Exact IPA match.
- Plain-character match ("k" === "k").
- Allophonic substitution table — `/k/` ≈ `/kʰ/` (aspirated k); `/t/` ≈ `/ɾ/` in coda position. Maintained by this agent.

**Latency:** From end-of-stimulus to end-of-final-phoneme audio.

**Item bank size minimum:** 20 (with Azure required).

**Status:** Currently substituted by `phoneme_blend` in the MVP per Reading Fluency engine v1.0. Re-enable when Azure ASR ships.

---

## 6, 7. `phoneme_delete_initial`, `phoneme_delete_final`

**Strand fit:** PA_08, PA_09

**What the student does:** Hears a word and an instruction ("Say 'stop' without the /s/"). Says the modified word.

**Stimulus:**
- Audio: spoken instruction, formatted "Say [word] without [phoneme]."
- No visual letters.

**Response:**
- ASR captures spoken modified word.

**Scoring:** Same as `phoneme_blend` — match against expected modified word.

**Item bank size minimum:** 20 each.

**Edge cases:**
- Instruction language is critical. "Say 'stop' without the /s/" — the kid might delete the wrong phoneme if "without" parses unfamiliarly. Item authoring guide will require simple, repeated instruction format.

---

## 8. `phoneme_substitute`

**Strand fit:** PA_10

**What the student does:** Hears "Change the /k/ in 'cat' to /h/." Says "hat."

**Stimulus:**
- Multi-clause audio instruction.
- Heaviest cognitive load of any PA item — students 6+ months of phonemic awareness work before this is reliable.

**Response and scoring:** Same as deletion items.

**Item bank size minimum:** 20.

**Note:** Kilpatrick (2015) calls this the strongest single predictor of orthographic mapping efficiency. High-value node despite being late.

---

## 9. `letter_sound`

**Strand fit:** LS_01–LS_04

**What the student does:** Sees a single letter (or digraph for `qu`, `x`). Produces the sound. Paired with a dictation reverse: hears the sound, types the letter.

**Two-part item structure** — both halves must pass for the node to advance:

**Part A — Read direction (letter → sound):**
- Stimulus: large rendered letter ("M").
- Response: ASR captures spoken phoneme.
- Scoring: same heuristic as `phoneme_isolate_initial`.

**Part B — Spell direction (sound → letter):**
- Stimulus: TTS plays the phoneme.
- Response: keyboard input (single character; physical or on-screen).
- Scoring: case-insensitive exact match.

**Mastery rule for the node:** Both halves must hit the read_accuracy threshold within their own rolling window. Part A is the primary drill; Part B is interleaved at 1:3 ratio (one spelling for every three readings).

**Latency target:** Acquisition 1500ms (read) / 2500ms (spell). Automaticity floor 800ms / 1500ms.

**Item bank size:** Bank IS the letter set (8 for set 1, 13 for set 2, 5 for vowels). Each letter has one read-direction item and one spell-direction item.

**Item identity:** The letter, plus a version (uppercase/lowercase). Mastery requires both versions for set 1 + 2; vowels stay lowercase only.

---

## 10. `read_aloud`

**Strand fit:** all CVC, blends, digraphs, silent-e, vowel teams, r-controlled, soft c/g, multisyllabic, HFW nodes — the workhorse type.

**What the student does:** Sees a written word. Reads it aloud. Paired dictation reverses the direction.

**Two-part structure** identical in shape to `letter_sound`:

**Part A — Decode (word → spoken):**
- Stimulus: written word, rendered large.
- Response: ASR captures spoken word.
- Scoring: `matchWord` (same as `phoneme_blend`).

**Part B — Encode (spoken → typed):**
- Stimulus: TTS plays the word.
- Response: keyboard input.
- Scoring: case-insensitive exact match (case for sentence-level dictation later).

**Mastery rule:** Both halves must hit threshold. Default Part A:Part B ratio is 2:1 (most items are read; encoding interleaved every third item).

**Latency:** Per `mastery.read_latency_ms` on each node.

**Item bank size:** 24–30 per node (per the requirements table in the agent spec).

**Edge cases:**
- HFW words are 1-version-per-word — bank size = word count for that node.
- Multisyllabic words (`SY_compound`, `SY_closed_2syl`) get longer latency targets and a slightly different `matchWord` rule that allows mid-word pause: "sun pause set" matches "sunset" if whole-utterance has the right phoneme content.

---

## 11. `cold_passage`

**Strand fit:** Fluency gates FL_01, FL_02, FL_03, FL_04.

**What the student does:** Sees a passage. Reads it aloud, timed 60 seconds. ASR aligns to the text and computes WCPM + accuracy.

**Stimulus:**
- Visual: passage rendered with normal sentence-level layout (no per-word boxes; this is a connected-text task).
- Audio: none. The student reads at their own pace.

**Response:**
- ASR captures continuous audio for the full duration.
- For Web Speech API: finalize a transcript at end-of-window, align to expected via Levenshtein-based word matching, count matches.
- For Azure PA: per-word alignment with confidence scores; cleaner WCPM.

**Scoring:**
```ts
function score(item, attempt) {
  const aligned = alignToExpected(attempt.asr.transcript, item.passage);
  const wcpm = aligned.correctWords / (60 / 60);
  const accuracy = aligned.correctWords / aligned.totalAttempted;
  return {
    wcpm,
    accuracy,
    passes: wcpm >= item.wcpm_min && accuracy >= item.passage_accuracy
  };
}
```

**Mastery rule:** Best of last 3 cold passages. The fluency gate node has `mastery: { wcpm_min, passage_accuracy, passage_word_count, rolling_window: 3, min_items: 3 }`.

**Edge cases:**
- Skipped lines: alignment penalty proportional to skipped word count.
- Student stops early (silence > 5s while time remains): the drill ends, score is computed on words actually read.
- Self-corrections: a word read incorrectly then corrected within the same line counts as **correct** (standard ORF rule). Researcher: Hasbrouck & Tindal procedural manual.
- Repetitions: do not double-count. "the the cat" → 2 correct words (the, cat).

**Item bank size:** 6 passages per fluency gate (3 active + 3 reserve cold pool).

**Status:** Implementable today with Web Speech API + a Levenshtein word-aligner. The aligner needs careful handling for long passages — flag for engineering review when first implemented.

---

## What's NOT in this catalog (and why)

These item types have been considered and explicitly excluded for v1:

- **Multiple-choice picture-to-word matching.** Pictures introduce three-cueing risk. Vetoed by Research Review.
- **Sentence-level reading with comprehension follow-up.** Comprehension is downstream; not a K–2 decoding node assessment.
- **"Self-paced reading" without timing.** Operating principle 9 of Research Review: untimed mastery checks for foundational skills are incomplete.
- **Game-like puzzles or word search.** Engagement-over-learning trap; vetoed.
- **AI-generated free-response writing.** Belongs to a much later phase.
- **Adaptive within-item difficulty.** An item is fixed once authored; difficulty comes from the node, not the item. Within-item adaptivity is a deferred feature.

Adding any of these requires a written case showing it doesn't trip a redline and provides signal the existing types don't.

---

## ASR pathway summary (Web Speech now → Azure later)

| Item type | Today (Web Speech) | After Azure PA |
|---|---|---|
| `phoneme_isolate_*` | Heuristic phoneme matching, fragile on stops | Per-phoneme alignment, robust |
| `phoneme_blend` | Whole-word match (works well) | Same; minor latency improvement from phoneme onset |
| `phoneme_segment` | **Not viable** (substitute with blend) | Direct phoneme-stream comparison |
| `phoneme_delete_*` | Whole-word match (works) | Same |
| `phoneme_substitute` | Whole-word match (works) | Same |
| `letter_sound` | Heuristic phoneme matching | Per-phoneme alignment |
| `read_aloud` | Whole-word match (works) | Per-phoneme accuracy + latency-from-first-phoneme |
| `cold_passage` | Levenshtein alignment to transcript | Per-word alignment with confidence |

Five item types meaningfully improve when Azure lands. One (`phoneme_segment`) is gated until then. The MVP can ship without it; the Architect's K-2 graph already has us substituting blend for segment.

---

## Decision log

### 2026-05 — v1.0 lock

- 11 item types accepted. Future types require explicit approval.
- `phoneme_segment` is the only type currently gated on Azure; substituted by `phoneme_blend` in v1.
- Two-part read+spell structure made standard for `letter_sound` and `read_aloud`. The current MVP does not yet implement Part B (dictation) — flagged as P1 engineering work.
- Item identity is the (item content, version) pair. Versioning matters for letter_sound (case) and is a no-op for word-level types until we add stylistic variants.
