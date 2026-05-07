# Automaticity Curves

**Authored by:** Agent 04 — Reading Fluency
**Status:** v1.0
**Date:** 2026-05-07

The acquisition→automaticity latency targets per strand. These are the numbers that the `automaticity_target_latency_ms` schema field gets populated with on each node. Acquisition (the `read_latency_ms` field that already exists) is the gate to *unlock* the next node; automaticity is the gate to *retire* the node from active fluency drills.

Two latency targets per node, never one:

```
acquisition gate (read_latency_ms)        ← unlocks next node, owned by Assessment
automaticity floor (automaticity_target_latency_ms)  ← retires from Reading Facts, owned by this agent
```

A node is "fluent" when the student hits the automaticity floor 3 sessions in a row at ≥95% accuracy. Until then, the node stays in the Reading Facts active automaticity zone.

---

## The curves

| Strand | Acquisition latency (ms) | Automaticity floor (ms) | Source |
|---|---|---|---|
| Phonemic Awareness — isolation/blend (PA_01–PA_05) | 3000–5000 | 1500 | Kilpatrick (2015) PAST benchmarks |
| Phonemic Awareness — segment (PA_06–PA_07) | 5000–6000 | 2000 | Kilpatrick (2015) |
| Phonemic Awareness — manipulation (PA_08–PA_10) | 4000–5000 | 2500 | Kilpatrick (2015); Yopp (1988) |
| Letter-Sound Foundations (LS_01–LS_04) | 1500 | 800 | Compton (2003); Wolf & Bowers (1999) |
| CVC short-vowel words | 2500 | 1200 | Hasbrouck & Tindal (2017) inferred from end-G1 ORF |
| Initial Blends | 2500 | 1200 | Same |
| Final Blends | 2500 | 1200 | Same |
| Digraphs (sh/ch/th/ck/ng/nk) | 2500 | 1300 | Same; small bump for grapheme-pattern matching |
| Trigraphs (-tch/-dge) | 3000 | 1500 | Treiman & Kessler (2014) on orthographic complexity |
| High-Frequency Words | 1500 | 800 | LaBerge & Samuels (1974); HFW are sight-recognition-target |
| Inflectional Endings | 2500 | 1300 | Apel (2014) |
| Silent-e (CVCe) | 2500 | 1200 | Same baseline as CVC |
| Vowel Teams (transparent: ai/ee/oa) | 2500 | 1300 | Same |
| Vowel Teams (multi-value: oo, ow, ea) | 3000 | 1500 | Tunmer & Chapman (2012) on set-for-variability |
| R-Controlled (ar/or) | 2500 | 1300 | Same baseline |
| R-Controlled (er/ir/ur) | 3000 | 1500 | Spelling ambiguity adds load |
| Soft C/G | 3000 | 1500 | Conditional rule adds load |
| Multisyllabic — compound | 3000 | 1500 | Single-skill composition |
| Multisyllabic — closed two-syllable | 3500 | 2000 | Beck & Beck (2013) |

---

## Cold-passage WCPM benchmarks (the FL_xx fluency gates)

These are the **passage-level** fluency targets, distinct from per-word automaticity. They drive FL_01–FL_04 gate values and are calibrated to Hasbrouck & Tindal (2017) ORF norms.

| Gate | Position | WCPM target | H&T percentile | Accuracy | Passage length |
|---|---|---|---|---|---|
| FL_01_cvc_fluency | After short-vowel CVC + anchor HFW | 30 | mid-G1, ~10th percentile (intentionally low — earliest gate) | 95% | 60 words |
| FL_02_blend_digraph_fluency | After blends, digraphs, HFW1+2 | 50 | end-G1, ~25th percentile | 96% | 90 words |
| FL_03_silent_e_fluency | After silent-e patterns | 60 | end-G1, ~50th percentile | 96% | 100 words |
| FL_04_grade2_fluency | Terminal K-2 gate | 90 | end-G2, ~25th–50th percentile | 97% | 150 words |

Rationale for the "intentionally low" FL_01: early gates exist to prevent students from advancing on accuracy alone while reading is still effortful. Setting FL_01 at 30 WCPM (vs. H&T's median ~60 for end-G1) catches the wrong students before they accumulate gaps. Subsequent gates close the gap to median.

---

## The retirement rule (Reading Facts → graduated)

A node retires from the active automaticity zone when:

1. The student has hit `automaticity_target_latency_ms` on **at least 80% of items** in a Reading Facts drill, **3 sessions in a row**.
2. Within those 3 sessions, accuracy on this node remained ≥95%.

After retirement, the node enters spaced-review status:

```
1 day    → 1 sample item in next drill, must hit target
3 days   → 1 sample item, must hit target
7 days   → 1 sample item, must hit target
21 days  → 1 sample item, must hit target
90 days  → 1 sample item, must hit target
```

A miss at any sample resurfaces the node into the active automaticity zone. (FSRS-style; see Reading Facts engine spec for the full scheduler.)

---

## How latency translates to WCPM

For passage-level gates: `WCPM = correct words / minute`. Direct calculation from ASR-aligned audio.

For word-level Reading Facts: latency per word matters more than aggregate WCPM during the drill, but the drill ends with a WCPM display because that's the ecologically valid unit students and parents understand. Conversion:

```
drill_WCPM = wordsCorrect / (drillDurationMs / 60000)
```

A 60-second drill of 50 words attempted, 47 correct → 47 WCPM. Personal best is computed at the drill level, not the per-word level — the student should optimize for "more correct words in 60 seconds," not "shave 50ms off cat."

---

## What changes when ASR upgrades

When Web Speech API → Azure Pronunciation Assessment (see `docs/TODO.md`), per-phoneme scoring becomes available. That changes:

- **Latency definition.** Currently we time from word-presented to whole-word recognition. With phoneme-level alignment, we'll time from word-presented to *first-phoneme onset*, which is a cleaner signal because it isolates retrieval from production.
- **Automaticity definition.** With per-phoneme accuracy, "fluent" can mean "all phonemes accurate AND aligned to expected timing intervals." Today's whole-word match is a coarser proxy.
- **The numbers above shift.** First-phoneme-onset latency is roughly 200–400ms shorter than whole-word latency. The targets in this doc will be re-baselined when we cut over.

This is the upgrade path; the current targets are calibrated to whole-word latency.

---

## Citations

- Compton, D. L. (2003). Modeling the relationship between growth in rapid naming speed and growth in decoding skill in first-grade children. *Journal of Educational Psychology*, 95(2), 225–239.
- Ehri, L. C. (2014). Orthographic mapping in the acquisition of sight word reading. *Scientific Studies of Reading*, 18(1), 5–21.
- Hasbrouck, J., & Tindal, G. (2017). An update to compiled ORF norms. *Behavioral Research and Teaching Technical Report 1702*, University of Oregon.
- Kilpatrick, D. A. (2015). *Equipped for Reading Success*. Casey & Kirsch.
- LaBerge, D., & Samuels, S. J. (1974). Toward a theory of automatic information processing in reading. *Cognitive Psychology*, 6(2), 293–323.
- Treiman, R., & Kessler, B. (2014). *How Children Learn to Write Words*. Oxford.
- Tunmer, W. E., & Chapman, J. W. (2012). Does set for variability mediate the influence of vocabulary knowledge on the development of word recognition skills? *Scientific Studies of Reading*, 16(2), 122–140.
- Wolf, M., & Bowers, P. G. (1999). The double-deficit hypothesis for the developmental dyslexias. *Journal of Educational Psychology*, 91(3), 415–438.
- Yopp, H. K. (1988). The validity and reliability of phonemic awareness tests. *Reading Research Quarterly*, 23(2), 159–177.
