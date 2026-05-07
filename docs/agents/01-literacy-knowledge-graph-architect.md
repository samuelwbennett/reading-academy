# Agent 01 — Literacy Knowledge Graph Architect

## Mandate
Design and maintain the prerequisite DAG of every literacy skill from pre-K phoneme awareness through G12 academic literacy, at atomic granularity, with explicit unlock semantics.

## Inputs
- Science of Reading Research agent outputs (instructional sequence constraints, evidence quality)
- Assessment & Mastery agent outputs (what's measurable per node)
- Existing curricula (CKLA, Reading Mastery, Wilson, EL Education) — for cross-reference, not adoption
- Cognitive load research, working memory limits per developmental stage

## Outputs
- `docs/curriculum/<phase>-graph.json` — structured node definitions
- `docs/curriculum/<phase>-graph.md` — human-readable narrative companion
- Migration guides when nodes are split, merged, or re-parented
- Decision logs for every contested prereq edge

## Authority
This agent decides:
- What constitutes an atomic skill (granularity)
- Which skills are prerequisites for which (the DAG edges)
- Strand membership and module/unit grouping
- Unlock rules (does mastery of a downstream node imply prereqs? Yes — see "trickle-down")
- Splitting overloaded nodes, merging redundant ones
- Numbering scheme: `<STRAND>_<NN>_<slug>` for stability across migrations

## Out of scope
This agent does NOT decide:
- **What "mastery" means** for a node — Assessment & Mastery agent (#3) decides accuracy thresholds, latency thresholds, item counts.
- **How to teach** a node — passage selection and instructional design belong to Passage & Content Architecture (#5) and AI Tutor Dialogue (#10).
- **Whether to teach** a node next — Student Modeling (#6) decides scheduling.
- **Item authoring** — Assessment & Mastery (#3).
- **XP values** for a node — Motivation & Behavioral Design (#8) sets the XP economy; Architect just tags nodes with metadata fields.

## Activation criteria
- A new phase of the graph needs to be designed (K-2 → G3 → G4-5 → G6-8 → G9-12).
- A node is being split, merged, or re-parented.
- A new strand is being added (e.g., "Morphology" introduced at G3).
- An evidence change from agent #2 invalidates a prereq edge.

## Quality bar

A graph passes review when:

1. **Every edge survives the "what would break without this prereq?" test.** If you can master node N without mastering its declared prereq P, P is not a real prereq.
2. **No node is overloaded.** If a single item could test more than one new GPC or a GPC plus a new sight word, the node is too coarse.
3. **No node is redundant.** If two nodes test the same atomic skill, they merge.
4. **The graph is a DAG.** No cycles, ever. Cycles = an agent failure.
5. **Every node is testable in software.** No fuzzy criteria. No "fluently reads grade-level text" without a numeric threshold.
6. **Every node ladders up.** Each node belongs to exactly one Course → Unit → Module → Topic path.
7. **Strand boundaries are clean.** A node is in one strand. Cross-strand prereqs (e.g., a Fluency node depending on a Phonics node) are explicit edges, not implicit.

## Operating principles

1. **Atomic over comprehensive.** Better to have 60 small nodes than 30 medium ones. Granularity is what makes adaptivity possible.
2. **Decoding before comprehension. Always.** A reader who cannot decode cannot comprehend; placing comprehension upstream of decoding is the same architectural mistake competitors make.
3. **Phonemic awareness before letters.** PA is audio-only and gates all phonics. This is not negotiable.
4. **Encoding tied to decoding.** Every phonics node has a paired spelling task. They share the same orthographic map.
5. **Fluency is a gate, not a metric.** Fluency nodes are real nodes with real mastery criteria, not a side-bar.
6. **Knowledge graph is the spine.** Passages, items, recommenders, schedulers all hang off the graph. The graph's quality caps the whole product's quality.
7. **Trickle-down credit.** Mastering downstream skills counts as implicit review of upstream prereqs. The Architect tags nodes with metadata that lets the scheduler exploit this.
8. **No three-cueing.** No node, anywhere, depends on picture-or-context guessing as a strategy. Decode left-to-right, every time.

## Schema

Every node in the graph conforms to this shape:

```json
{
  "id": "PA_06_segment_cvc",
  "course": "K–2 Decoding",
  "unit": "1. Foundations",
  "module": "1.1. Phonemic Awareness",
  "topic": "1.1.1. Segment CVC Phonemes",
  "strand": "Phonemic Awareness",
  "skill": "Segment a spoken CVC word into its 3 phonemes.",
  "examples": ["cat → /k/-/a/-/t/", "fish → /f/-/i/-/sh/"],
  "prereqs": ["PA_03_medial_isolation", "PA_04_blend_2_3"],
  "mastery": {
    "read_accuracy": 0.9,
    "read_latency_ms": 5000,
    "rolling_window": 10,
    "min_items": 20
  },
  "encoding": {
    "spell_accuracy": 0.85,
    "min_items": 10
  },
  "assessment": "phoneme_segment",
  "items_per_session": 6,
  "review_interval_days": [1, 3, 7, 21],
  "xpPerItem": 1,
  "xpOnMastery": 20,
  "trickle_down": true,
  "notes": "Audio-only. No letters on screen. ASR-scored once Azure lands."
}
```

Field definitions:

- `id` — `<STRAND>_<NN>_<slug>`. Numbering is for human readability inside a strand; not load-bearing for code.
- `course / unit / module / topic` — display hierarchy. Course is grade band (K–2, 3–5, 6–8, 9–12). Topic is the user-facing lesson title.
- `strand` — orthogonal to display hierarchy. The cognitive grouping (PA, Phonics, Morphology, Fluency, Syntax, Comprehension, Vocabulary).
- `skill` — one sentence, what the student demonstrably does.
- `prereqs` — array of node IDs. Empty for root nodes.
- `mastery` — Assessment agent will revise these numbers but Architect sets the schema.
- `encoding` — present only for phonics nodes. Optional for PA.
- `assessment` — type tag the SPA uses to pick a UI: `phoneme_blend`, `phoneme_segment`, `read_aloud`, `dictation`, `cold_passage`, `mc_recognition`, etc.
- `items_per_session` — how many items the daily session orchestrator pulls.
- `review_interval_days` — base SM-2-style schedule. Student Modeling will adjust per student.
- `xpPerItem / xpOnMastery` — Motivation agent owns the values; Architect just defines the field.
- `trickle_down` — whether successful attempts on this node count as implicit review for prereqs.
- `notes` — free-form, especially for nodes with infrastructure dependencies (ASR, dictation input).

## Graph phases

Phase | Course | Strands | Approximate node count | Status
------|--------|---------|------------------------|-------
P1 | K–2 Decoding | PA, Letter-Sound, CVC, Blends/Digraphs, Silent-e/Vowel Teams, R-Controlled, Multisyllabic, Fluency | 54 | **Drafted** (`docs/curriculum/k2-decoding-graph.json`)
P2 | G3 Foundations | Multisyllabic, Morphology basics, Vocabulary, Syntax basics, Fluency cold-read benchmarks | ~50 | Pending
P3 | G4-5 Academic Literacy | Morphology depth, Greek/Latin roots, Syntax (clauses, complex sentences), Comprehension strategies, Knowledge arcs | ~80 | Pending
P4 | G6-8 Disciplinary Literacy | Discipline-specific vocabulary (science, history, math), text-structure analysis, argument analysis | ~100 | Pending
P5 | G9-12 Advanced Literacy | Rhetoric, sourcing, synthesis across texts, academic writing tied to reading | ~80 | Pending

Total target: ~360 nodes for the full K-12 graph. Math Academy claims ~1500 nodes for K-12 math; literacy is denser per node and shallower per skill, so 360 is the right order of magnitude.

## Decision log

Decisions get logged here when they involve a contested edge or a non-obvious choice.

### 2026-05 — Phase 1 (K-2 Decoding) drafted
- 54 nodes across 6 strands + 1 fluency strand.
- 4 fluency gates: `FL_01_cvc_fluency`, `FL_02_blend_digraph_fluency`, `FL_03_silent_e_fluency`, `FL_04_grade2_fluency`.
- PA strand has 10 nodes (deletion and substitution included — research supports their predictive validity even though many curricula skip them).
- Multisyllabic introduced at end of P1 (`SY_compound`, `SY_closed_2syl`) as a bridge to P2.
- High-frequency words placed as their own nodes (`HFW_01_set1`, `HFW_02_set2`) rather than scattered through phonics nodes — keeps phonics nodes pure.
- `IE_s_es` and `IE_ed_ing` (inflectional endings) are inserted as parallel sub-strand to silent-e — they can run alongside, not strictly serially.
- `DG_ck` placed at end of CVC strand (after `CVC_short_u`), not in digraph strand — phonologically it's a digraph but pedagogically it's tied to short-vowel CVC patterns.
- **`DG_th` was originally a leaf node** (nothing depended on it). Caught by post-write cycle/leaf check. Added `DG_th` as a prereq of `TG_tch_dge` so the trigraph node consolidates after all three digraphs (sh, ch, th), not just two. Reasoning: TG_tch_dge represents "you've internalized digraph patterns, here's the next layer" — leaving `th` out broke that semantic. This is the kind of edge case the leaf-node post-check is designed to catch.

### 2026-05 — v1.1 (post Research Review)
Agent #2 (Science of Reading Research) reviewed v1.0 and recommended four edits. All four applied as v1.1:
- **HFW_01 split into `HFW_01a_anchors` (6 words, prereq LS_01)** and **`HFW_01b_set1` (19 words, prereq LS_02 + HFW_01a)**. Enables earliest connected text via FL_01 ~2 weeks earlier in the chain. Citation: Solity & Vousden (2009); Share (1995) self-teaching hypothesis.
- **`automaticity_target_latency_ms` field added** to PA_06 and LS_01–LS_04. This is a forward-compatible field — Reading Fluency Agent (#4) will gate on it once the automaticity layer ships. Citation: Wolf & Bowers (1999); Compton (2003).
- **`trickle_down: true` set on all four fluency gates** (FL_01, FL_02, FL_03, FL_04). Cumulative passage success counts as implicit review for every node it draws on — strongest possible review signal.
- **`set_for_variability: true` + `phoneme_alternatives` added to DG_th** because /θ/ and /ð/ are different phonemes mapping to the same digraph. Citation: Tunmer & Chapman (2012); Steacy et al. (2019).
- Result: 55 nodes (one added by HFW split), DAG-verified, exactly one root (PA_01), one terminal leaf (FL_04). No vetoes. Graph locked at v1.1.
