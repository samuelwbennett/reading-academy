# Item Authoring Guide v1.0

**Authored by:** Agent 03 — Assessment & Mastery
**Status:** v1.0, locked. Authoring batches must conform to this guide.
**Date:** 2026-05-07

This is the standing reference for anyone (human or LLM) authoring items for Reading Academy. Each item type has a frozen contract from `docs/assessment/item-types-v1.0.md`; this guide adds the *how* — concrete rules, worked examples, common failures, and the validator's pass criteria.

Authoring rule of thumb: **the validator is the source of truth.** If the validator passes, the items ship; if it fails, no shipment regardless of how the items read. Run `npm run validate` (or `--strict` to escalate warnings) before any commit that touches `src/data/assessment_items.json`.

---

## Universal rules

These apply to every item type. The validator checks them.

1. **Every item is a JSON object** with at minimum `prompt` and `answer` fields.
2. **The bank is keyed by node ID** (e.g., `"CVC_short_a": [ ... ]`). Orphan keys (banks for non-existent node IDs) generate a warning and are excluded by the runtime.
3. **Item count meets the minimum for the type** (`MIN_ITEMS` in the validator). Defaults: 20 for `phoneme_*`, 24 for `read_aloud`, 8 for `letter_sound`, 6 for `cold_passage`. HFW banks scale to the size of the word set.
4. **Cold reserve.** At least **20% of every bank** is reserved as cold — never used in lesson rotation, only in mastery checks. Mark with `"cold": true`. The recommender filters on this.
5. **Item identity is stable.** Don't reorder items between releases without a migration plan; spaced-review schedules reference items by their bank index.
6. **No three-cueing primitives.** No items where a picture or sentence context is the path to the right answer. Hard rule.
7. **No images for unknown words.** Pictures decorate, never decode.
8. **No AI-generated practice items in pilot batches.** Hand-authored only until item-bank quality controls are robust.
9. **Decodable when possible.** If a word can be decoded by the student's mastered GPC inventory at the node level, prefer it. If not, the item belongs to a future node.
10. **No emoji, no Unicode oddities, no smart quotes** in `prompt` or `answer`. Plain ASCII letters and digits only. The validator strips most of this anyway, but clean source content prevents drift.

---

## Type-by-type playbook

For each type below: required fields, scoring rule (recap from item-types-v1.0), authoring rules, ≥3 worked examples.

### `phoneme_isolate_initial` / `_final` / `_medial`

**Required fields:** `prompt` (CVC word), `answer` (single phoneme as ASCII letter or digraph).

**Scoring:** ASR captures spoken phoneme; matched if any alternative starts with the expected phoneme (with vowel-padding tolerance for stops).

**Authoring rules:**
- Items are CVC only for medial isolation; words with blends/digraphs are out of scope at the isolation level.
- `answer` uses plain ASCII characters: `s`, `t`, `sh`, `ch`. No `/slashes/` or IPA.
- For initial isolation: spread across 8 set-1 consonants minimum.
- For final isolation: avoid digraphs that consolidate (ng, nk).
- For medial isolation: include all 5 short vowels (a/i/o/u/e) at least 4 items each.

**Worked examples:**

```json
{ "prompt": "sun", "answer": "s" }   // initial: /s/
{ "prompt": "cat", "answer": "t" }   // final: /t/
{ "prompt": "map", "answer": "a" }   // medial: /a/
```

**Common failures:**
- Using digraph words like "ship" for initial-isolation when the node only covers single consonants.
- Authoring `answer: "/s/"` instead of `"s"`. The validator doesn't catch this; the matcher does, and you'll see false negatives.

---

### `phoneme_blend`

**Required fields:** `prompt` (the assembled word — the answer the student should produce after blending), `answer` (same as `prompt`), `phonemes` (array of plain-letter phonemes), `phonemeLabels` (array of `/slashed/` display strings — used by the BlendTask UI).

**Scoring:** ASR captures spoken whole word; matched against `answer` via `matchWord` (exact + token containment).

**Authoring rules:**
- For PA_04_blend_2_3 (currently mapped from the orphan PA_04_blend_cvc bank): use 2- or 3-phoneme words (`/a/-/t/ → at`, `/m/-/a/-/p/ → map`).
- For PA_05_blend_4_5: blends, digraphs, or final clusters — 4 or 5 phonemes (`/s/-/t/-/o/-/p/ → stop`).
- Spread across consonants and vowels — see diversity rule below.
- The `phonemes` array uses lowercase plain letters, NOT slashes. Digraphs are one entry: `["sh", "i", "p"]` for "ship".
- The `phonemeLabels` array uses `/slashed/` form for display: `["/sh/", "/i/", "/p/"]`.

**Worked examples:**

```json
{
  "prompt": "cat",
  "answer": "cat",
  "phonemes": ["k", "a", "t"],
  "phonemeLabels": ["/k/", "/a/", "/t/"]
}
{
  "prompt": "stop",
  "answer": "stop",
  "phonemes": ["s", "t", "o", "p"],
  "phonemeLabels": ["/s/", "/t/", "/o/", "/p/"]
}
```

**Common failures:**
- Mismatched `phonemes` length and `answer` length (validator flags this if `phonemes.length` doesn't match the `answer` syllable count).
- Using IPA in `phonemes` (`["k", "æ", "t"]`). Stick to plain ASCII letters.

---

### `phoneme_segment` (Azure-gated; not yet drillable)

**Required fields:** `prompt` (CVC word), `answer` (space-separated phonemes for display), `expected_phonemes` (canonical array used by Azure scoring once integrated).

**Status:** items can be authored now but won't drill until the Azure proxy ships. v1 MVP substitutes `phoneme_blend` for placement and drill purposes.

**Worked examples:**

```json
{
  "prompt": "cat",
  "answer": "/k/ /a/ /t/",
  "expected_phonemes": ["k", "a", "t"]
}
```

---

### `phoneme_delete_initial` / `_final`

**Required fields:** `prompt` (the source word the instruction will reference), `answer` (the modified word the student should say), `instruction` (audio instruction text — read aloud by TTS).

**Scoring:** ASR captures spoken modified word; matched against `answer` via `matchWord`.

**Authoring rules:**
- Source word and modified word are both single-syllable for v1.
- The `instruction` field is rendered to TTS — keep it short and predictable: `"Say [word] without [phoneme]."`
- Avoid words where deletion creates ambiguous phonotactics ("brought" without /b/ → not a word the student can produce confidently).

**Worked examples:**

```json
{
  "prompt": "stop",
  "answer": "top",
  "instruction": "Say stop without the /s/."
}
{
  "prompt": "lamp",
  "answer": "lam",
  "instruction": "Say lamp without the /p/."
}
```

---

### `phoneme_substitute`

**Required fields:** `prompt` (source word), `answer` (target word), `substitution` (object describing the change).

**Worked examples:**

```json
{
  "prompt": "cat",
  "answer": "hat",
  "substitution": { "from": "k", "to": "h", "position": "initial" }
}
{
  "prompt": "map",
  "answer": "mop",
  "substitution": { "from": "a", "to": "o", "position": "medial" }
}
```

---

### `letter_sound`

**Required fields:** `prompt` (the rendered letter), `answer` (the phoneme as plain letter), `version` ("upper" or "lower").

**Scoring:** Two-part — Part A (read direction) ASR-scores against `answer`; Part B (spell direction) keyboard-input matches `prompt` (case-insensitive). Both halves required for mastery; interleave at 1:3 (one spell per three reads).

**Authoring rules:**
- Bank size = letters in the set × 2 versions (upper + lower). For LS_01 (8 consonants): 16 items minimum.
- Vowels stay lowercase only at v1 (per Architect's K-2 design).
- For digraphs (`qu`, `x`): one item for the digraph as a whole, treated as a single grapheme.

**Worked examples:**

```json
{ "prompt": "M", "answer": "m", "version": "upper" }
{ "prompt": "m", "answer": "m", "version": "lower" }
{ "prompt": "qu", "answer": "kw", "version": "lower" }
```

---

### `read_aloud`

**Required fields:** `prompt` (the word to read), `answer` (same as `prompt` for non-irregular words; the canonical pronunciation for HFW).

**Scoring:** ASR captures spoken word; matched via `matchWord` (exact + token containment, no Levenshtein).

**Authoring rules:**
- **Bank size minimum: 24** for CVC/blend/digraph/silent-e/vowel-team/r-controlled nodes.
- **Diversity rule (validator-enforced):** no single first-letter+last-letter signature can account for ≥40% of the bank. A short-A bank with 18 -at words and 2 others fails.
- Cold reserve: mark 5+ items per bank with `"cold": true`.
- All words must be decodable from the student's mastered GPC inventory at this node + its prereqs. Use the prereq closure: a CVC_short_a item can use any CVC short-a word and the LS_01 consonants, nothing further.
- For HFW banks: bank IS the word set. `answer` == `prompt` for transparently spelled HFW; for irregular HFW (`said`, `was`), `answer` is the standard pronunciation transcription used by the matcher.

**Worked examples (CVC_short_a, partial):**

```json
{ "prompt": "cat", "answer": "cat" }
{ "prompt": "map", "answer": "map" }
{ "prompt": "ham", "answer": "ham", "cold": true }
{ "prompt": "fan", "answer": "fan" }
{ "prompt": "bag", "answer": "bag", "cold": true }
```

**Worked examples (HFW_01a_anchors):**

```json
{ "prompt": "the", "answer": "the" }
{ "prompt": "is",  "answer": "is" }
{ "prompt": "was", "answer": "was" }
{ "prompt": "to",  "answer": "to" }
```

**Common failures:**
- Using out-of-inventory words: `cab` in a CVC_short_a bank where consonant `b` (LS_02) isn't unlocked yet. The decodability rule rejects.
- All cold-reserve items at the end of the array (looks like a separate sub-bank). Spread cold items through the array so position-based debugging stays unsurprising.

---

### `cold_passage`

**Cold passages live in `docs/passages/bank/<gate>/passages.json`, not in `assessment_items.json`.** Authoring a cold passage is a different workflow:

1. Author the passage in the bank file with `validationStatus: "draft"`.
2. Run the passage validator (subsumed in `npm run validate`).
3. If clean, flip to `validationStatus: "passed"`.
4. Run `npm run build-passages` to regenerate `src/data/passages.json`.
5. Run `npm run validate` again.

Passage authoring rules and worked examples are in `docs/passages/architecture-v1.0.md` and the FL_01 bank itself (`docs/passages/bank/FL_01/passages.json`).

---

## Diversity discipline

The validator's first-letter/last-letter signature check is a *floor*. Real diversity goes further:

- **Vowel coverage.** Short-A items shouldn't all be `_at` words. Spread across `_at`, `_an`, `_ap`, `_am`, `_ag`, `_ad`, `_as`.
- **Consonant frame coverage.** Don't lean on three consonants when the node has eight available.
- **Frequency distribution.** Mix high-frequency words (cat, hat, sun) with mid-frequency (jam, hem, pip) so the student can't memorize the most-likely items.

A useful test: print your bank, hide every other letter, and read down the column. If the pattern is too predictable you've lost diversity.

---

## Worked authoring sequence (CVC_short_a, ~30 minutes)

1. Open `docs/assessment/item-types-v1.0.md` and re-read the `read_aloud` spec.
2. Open `src/data/skill_nodes.json` and read CVC_short_a's `mastery` config + `prereqs` to confirm the inventory.
3. List 30 candidate words across `_at`, `_an`, `_ap`, `_am`, `_ag`, `_ad`, `_as` (the realizable rimes from set-1 consonants).
4. Cross out any with out-of-inventory consonants.
5. Pick 24 that maximize signature spread.
6. Mark 5 of them `cold: true` — these get reserved.
7. Append to `src/data/assessment_items.json` under `"CVC_short_a"`.
8. Run `npm run validate`. Fix any flags.
9. Spot-check 5 items by reading them aloud yourself — does the prompt feel decodable from a fresh-eyes perspective? If a word reads weirdly to an adult, kids will struggle differently.

---

## What the validator catches automatically

- Missing `prompt` / `answer` — error
- Missing `phonemes` array on phoneme_blend / phoneme_segment — warning
- Bank size below minimum — warning
- Orphan bank (no matching node) — warning
- ≥40% same first/last consonant signature — warning
- Non-existent node IDs in passage gpcInventory — error
- Passage word count outside 85–115% of target — warning
- ≥4 sentences in a passage sharing the same 3-word opener — warning (predictable-pattern risk)

## What the validator can't catch (yet)

- Out-of-inventory words for the node's GPC scope. Future v2 enhancement: per-word GPC tagging on items, then validator can verify decodability automatically.
- Pedagogical quality of items. A bank that passes the diversity floor but is still rote can ship; the validator can't tell.
- Cultural/age appropriateness of word choices. Reviewer judgment required.

---

## Decision log

### 2026-05 — v1.0 lock
- 11 item types specified; authoring rules per type.
- 24-item minimum for read_aloud, 20 for phoneme_*, 8 for letter_sound, 6 for cold_passage.
- 20% cold reserve enforced via `cold: true` flag on individual items.
- Anti-three-cueing scan triggers at ≥4 same-template sentences (one over the soft limit so cleaner-but-borderline passages still ship).
- AI-generated items vetoed for pilot batches.
- Per-word GPC tagging deferred to v2.
