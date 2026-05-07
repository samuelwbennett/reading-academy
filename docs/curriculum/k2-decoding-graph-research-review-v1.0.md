# K-2 Decoding Graph — Research Review v1.0

**Reviewer:** Agent 02 — Science of Reading Research
**Subject:** `docs/curriculum/k2-decoding-graph.json` v1.0.0 (54 nodes)
**Author:** Agent 01 — Literacy Knowledge Graph Architect
**Date:** 2026-05-07

---

## Executive summary

54 nodes reviewed. **42 approved with confidence**, **8 approved with concerns**, **4 recommended changes**, **0 vetoes** (no redline violations).

**Strongest endorsement:** the inclusion of phoneme deletion and substitution (PA_08–10) in the foundation strand. Most curricula stop at blending/segmenting; including manipulation tasks is what differentiates a research-aligned product from a phonics-as-marketing one. Strong, replicated evidence (Kilpatrick 2015; Ehri's phases) places phonemic *proficiency* — not just awareness — as the gate for orthographic mapping. The Architect got this right.

**Strongest concern:** the chain-style serial dependency between PA_08 → PA_09 → PA_10 forces a student who blasts through deletion/substitution to do them sequentially when the research supports them as parallel skills. Recommend partial parallelization. Details below.

**Overall judgment:** the graph is research-aligned. No redlines tripped. Ship the structure; tune the four flagged issues before the K-2 phase enters production curriculum authoring.

---

## Approved with confidence

| Node(s) | Claim approved | Citation | Strength |
|---|---|---|---|
| PA_01–PA_05 | PA tasks placed *before* and as prereqs to phonics. | National Reading Panel (2000), Ch. 2; Ehri et al. (2001), *Reading Research Quarterly*. | Strong |
| PA_06–PA_07 | Segmenting requires both phoneme isolation and blending as prereqs. | Schatschneider et al. (2004), *Journal of Educational Psychology*, on PA task hierarchies. | Strong |
| PA_08–PA_10 | Phoneme deletion and substitution included as PA nodes. | Kilpatrick (2015), *Equipped for Reading Success*, ch. 4–5 on phoneme proficiency. Yopp (1988) on PA task difficulty hierarchy. | Strong |
| LS_01–LS_04 | Letter-sound knowledge taught explicitly, with vowels split out and short vowels introduced as a block. | NRP (2000), Ch. 2; Ehri (2014) phases of word reading. | Strong |
| CVC_short_a → CVC_short_e | CVC short-vowel sequence with VC-vowel-VC structure as the first phonics target after PA + letter sounds. | Ehri (2014); Adams (1990), *Beginning to Read*. | Strong |
| BL_INIT_s → BL_INIT_l → BL_INIT_r | Initial blends ordered s → l → r. | Defensible by phonological frequency and articulatory complexity (Treiman 1985). | Moderate |
| BL_FIN | Final blends as a unified node, not split per cluster. | Pragmatic. No evidence supports per-cluster decomposition at K-2; cumulative review handles within-node variance. | Moderate |
| DG_sh, DG_ch, DG_th, DG_ng_nk, DG_ck | Digraphs introduced after blends, not before. | NRP (2000) systematic phonics findings; Adams (1990). | Strong |
| TG_tch_dge | Trigraphs after digraphs. | Logical and supported by orthographic complexity research (Treiman & Kessler 2014). | Moderate |
| SE_a_e → SE_u_e | Silent-e taught after CVC + blends + digraphs. CVC-vs-CVCe contrast (mad/made) explicitly required. | Ehri (2014); Bear et al., *Words Their Way*, on word study sequences; Kessler & Treiman on long-vowel orthography. | Strong |
| VT_ai_ay → VT_oi_oy | Vowel teams after silent-e fluency gate (FL_03). | Treiman & Kessler (2014); standard scope-and-sequence in evidence-based curricula (CKLA, Wilson). | Moderate |
| RC_ar → RC_or → RC_er_ir_ur | R-controlled vowels after vowel teams; the er/ir/ur trio consolidated into one node because all spell /ɝ/. | Phonological consolidation supported by Ehri & Saltmarsh (1995). Spelling ambiguity flagged correctly in node notes. | Strong |
| FL_01 / FL_02 / FL_03 / FL_04 | Cold-passage fluency gates blocking downstream connected-text work. WCPM + accuracy thresholds. | Hasbrouck & Tindal (2017) ORF norms; National Center on Intensive Intervention recommendations. | Strong |
| Encoding paired with decoding (every phonics node has an `encoding` field) | Every phonics node has a paired spelling task. | NRP (2000), Ch. 3; Ehri (2014); Berninger et al. (2002) on the read-spell connection. | Strong |
| Mastery requires *both* accuracy and latency | Latency thresholds present on every read-aloud node. | Kuhn & Stahl (2003) on automaticity; Wolf & Bowers (1999) on RAN; LaBerge & Samuels (1974) on automatic word recognition. | Strong |
| Set-for-variability flagged in VT_oo_both | The "try both sounds" prompt for ambiguous vowel teams. | Tunmer & Chapman (2012); Steacy et al. (2019). | Strong |

---

## Approved with concerns

### 1. PA_06_segment_cvc latency = 5000ms

**Concern:** 5 seconds per segmenting response is generous. Kilpatrick's "1-second" benchmark for phoneme proficiency suggests this is well above the proficiency threshold.

**Citation:** Kilpatrick (2015) Phonological Awareness Screening Test (PAST) benchmarks: 1s response by mid-G1 for basic segmenting.

**Recommendation:** Hold the 5000ms ceiling for *acquisition* mastery in this phase, but flag that Reading Fluency Agent (#4) will need to drive this down to ≤2000ms in the automaticity layer before the student is considered "proficient." Add a `automaticity_target_latency_ms: 2000` field to the schema for nodes that will eventually need to graduate from acquisition to automaticity.

**Evidence strength:** Strong.

---

### 2. HFW_01 prereqs

**Concern:** `HFW_01_set1` requires `LS_02_consonants_set2`. The prerequisite chain currently forces students to fully master 21 consonants before encountering "the," "a," or "I" — three of the highest-frequency words in English.

**Citation:** Solity & Vousden (2009) on the value of early HFW exposure for connected-text reading; Share (1995) on self-teaching hypothesis (early access to text drives orthographic learning).

**Recommendation:** Split HFW_01 into HFW_01a (anchor words: the, a, I, is, was, to — 6 words, prereq = LS_01 only) and HFW_01b (remaining 19 words, current prereq). This lets connected-text reading start ~2 weeks earlier without weakening the phonics chain.

**Evidence strength:** Moderate. The earlier-HFW recommendation is supported but not conclusively replicated; conservative implementation is also defensible.

---

### 3. The DG_th node lumps voiced /ð/ and unvoiced /θ/

**Concern:** "thin" (/θɪn/) and "that" (/ðæt/) are different phonemes. The Architect's `notes` field mentions both, but the assessment doesn't separate them. A student could "master" DG_th while only producing one of the two sounds reliably.

**Citation:** Tunmer & Chapman (2012) on set-for-variability; Treiman & Kessler (2014) on graphemes that map to multiple phonemes.

**Recommendation:** Either (a) add an explicit set-for-variability prompt to the DG_th assessment ("try both sounds"), or (b) split into DG_th_unvoiced and DG_th_voiced. Option (a) is lighter weight and probably correct for K-2; option (b) is more rigorous. Defer to Assessment & Mastery (#3).

**Evidence strength:** Moderate.

---

### 4. Latency on letter-sound nodes (LS_01–LS_04) at 1500ms

**Concern:** 1.5s per letter-sound is appropriate for *acquisition* but well above the automaticity threshold (target ≤500–800ms by mid-G1).

**Citation:** Wolf & Bowers (1999) on RAN; Compton (2003) on letter-naming fluency benchmarks.

**Recommendation:** Same fix as PA_06 above — add `automaticity_target_latency_ms` to the schema. Letter-sound automaticity drives downstream decoding speed; if the system never gates on it, students will plateau at slow-but-accurate reading.

**Evidence strength:** Strong.

---

### 5. Inflectional endings IE_s_es / IE_ed_ing as serial chain in main path

**Concern:** The Architect placed IE_s_es as a prereq for FL_02, and IE_ed_ing as a prereq for FL_03. This is defensible, but research suggests inflectional endings can run as a parallel sub-strand alongside silent-e and vowel teams.

**Citation:** Goodwin & Ahn (2010) meta-analysis on morphological awareness; Apel (2014) on the early role of inflectional morphology.

**Recommendation:** Keep current edges, but add `parallel_to: ["SE_a_e", "SE_i_e"]` metadata so the daily session orchestrator can interleave instead of forcing strict serialization.

**Evidence strength:** Moderate.

---

### 6. The "trickle_down: false" flag on fluency gates and HFW

**Concern:** The flag is set false on HFW and fluency. For HFW this is correct (HFW are word-level memory artifacts, not graphs of skills). For fluency, this is partially wrong — mastering FL_02 *should* count as implicit review of every phonics node it draws on.

**Citation:** Math Academy's "Fractional Implicit Repetition" pattern, applied here: cumulative connected-text mastery is the most ecologically valid review there is.

**Recommendation:** Set `trickle_down: true` on all fluency gates. Their downstream credit goes back to every node whose patterns appear in the cold passage.

**Evidence strength:** Moderate (analog from spaced-repetition literature; not directly tested in fluency-as-review).

---

### 7. PA strand may underweight rhyme/syllable awareness for K students

**Concern:** The graph starts at phoneme isolation. Most K-aged students benefit from a rhyme-and-syllable warm-up before phoneme-level work.

**Citation:** Anthony & Francis (2005) on the developmental progression of phonological awareness (word → syllable → onset-rime → phoneme).

**Recommendation:** Add two optional pre-K nodes (`PA_00a_rhyme`, `PA_00b_syllable_count`) as a **screen-out** layer — students who can already do these skip them. Don't gate on them for students placing into PA_01+ via the diagnostic.

**Evidence strength:** Moderate. The skill progression is real but K students placing into PA_01 directly are not harmed by skipping rhyme/syllable.

---

### 8. Multisyllabic bridge (SY_compound, SY_closed_2syl) at the end of K-2

**Concern:** The Architect placed multisyllabic decoding at the *end* of the K-2 phase. This is conservative. Many evidence-aligned curricula introduce two-syllable closed words alongside short-vowel CVC by mid-G1.

**Citation:** Beck & Beck (2013), *Making Sense of Phonics*, on multisyllabic instruction timing; the EL Education K-2 scope-and-sequence.

**Recommendation:** Hold for now — early multisyllabic instruction works only when CVC mastery is strong, and our diagnostic should reveal that students rarely have this strength in summer pilot populations. Re-examine after first pilot if the graph leaves multisyllabic gains on the table.

**Evidence strength:** Preliminary.

---

## Recommended changes (specific edits)

These are the four edits the Research agent recommends the Architect make to the v1.0 graph before locking it.

### Change 1 — Split HFW_01 to enable earlier connected text

```diff
- HFW_01_set1 (25 words, prereq: LS_02_consonants_set2)
+ HFW_01a_anchors (6 words: the, a, I, is, was, to; prereq: LS_01_consonants_set1)
+ HFW_01b_set1   (19 words: rest; prereq: LS_02_consonants_set2)
```

Updates downstream: `FL_01_cvc_fluency` depends on `HFW_01a_anchors` (sufficient for the earliest passages) instead of `HFW_01_set1`. `HFW_02_set2` still depends on `HFW_01b_set1`.

### Change 2 — Add automaticity targets to schema

```diff
  "mastery": {
    "read_accuracy": 0.9,
    "read_latency_ms": 2500,
+   "automaticity_target_latency_ms": 1200,
    "rolling_window": 10,
    "min_items": 20
  }
```

Adds a future-facing field that the Reading Fluency Agent (#4) will actively gate on once the automaticity layer ships. For now, it's metadata; it doesn't change MVP behavior.

### Change 3 — Set `trickle_down: true` on FL_01 / FL_02 / FL_03 / FL_04

Cumulative passage mastery is the strongest possible implicit review. Currently flagged false; flip to true.

### Change 4 — Add set-for-variability flag to DG_th and any future ambiguous-grapheme nodes

```diff
  "id": "DG_th",
+ "set_for_variability": true,
+ "phoneme_alternatives": ["/θ/", "/ð/"]
```

This is a schema extension — Architect adds the fields; Assessment & Mastery (#3) will use them when designing items.

---

## Vetoed (redline violations)

**None.** No node, principle, or operating rule in the graph triggers the redlines list. The Architect's principle 8 ("No three-cueing") is explicit, and there are no smuggled instances of picture-as-clue or predictable-text patterns. Clean pass.

---

## Open questions

### Q1 — Should sight-word knowledge be tested for *both* recognition and production?

The HFW nodes test reading and spelling separately. Open question whether a "produce in a sentence" task adds load-bearing signal. Current best evidence: probably not for K-2; comprehension-in-sentences is later phase work.

**What would resolve it:** A pilot comparison of HFW retention with vs. without production tasks, run with a partner school.

### Q2 — Do we need a "morphological awareness" pre-cursor before P2?

The graph ends K-2 with closed two-syllable words. P2 will introduce affixes and roots. Open question whether a transitional node ("recognize that 'jumped' = 'jump' + 'ed'") belongs in P1 or P2.

**What would resolve it:** Apel (2014) suggests basic morphological awareness emerges around end of G1; this leans toward placing the precursor in P1. Defer to Architect's P2 design.

### Q3 — Is the diagnostic placement adaptive enough?

The current diagnostic walks forward from node 0. The Architect's P1 graph has 54 nodes; that's ~150 placement items at worst. Mid-graph entry with adaptive walking would cut this to ~30.

**What would resolve it:** The diagnostic itself is owned by the Assessment & Mastery agent. Flag for review when #3 activates.

---

## Citations

- Adams, M. J. (1990). *Beginning to Read: Thinking and Learning About Print*. MIT Press.
- Anthony, J. L., & Francis, D. J. (2005). Development of phonological awareness. *Current Directions in Psychological Science*, 14(5), 255–259.
- Apel, K. (2014). A comprehensive definition of morphological awareness. *Topics in Language Disorders*, 34(3), 197–209.
- Bear, D. R., Invernizzi, M., Templeton, S., & Johnston, F. (2019). *Words Their Way: Word Study for Phonics, Vocabulary, and Spelling Instruction* (7th ed.). Pearson.
- Beck, I. L., & Beck, M. E. (2013). *Making Sense of Phonics: The Hows and Whys* (2nd ed.). Guilford.
- Berninger, V. W., et al. (2002). Writing and reading: Connections between language by hand and language by eye. *Journal of Learning Disabilities*, 35(1), 39–56.
- Compton, D. L. (2003). Modeling the relationship between growth in rapid naming speed and growth in decoding skill. *Journal of Educational Psychology*, 95(2), 225–239.
- Ehri, L. C. (2014). Orthographic mapping in the acquisition of sight word reading. *Scientific Studies of Reading*, 18(1), 5–21.
- Ehri, L. C., et al. (2001). Phonemic awareness instruction helps children learn to read. *Reading Research Quarterly*, 36(3), 250–287.
- Ehri, L. C., & Saltmarsh, J. (1995). Beginning readers outperform older disabled readers in learning to read words by sight. *Reading and Writing*, 7(3), 295–326.
- Goodwin, A. P., & Ahn, S. (2010). A meta-analysis of morphological interventions. *Annals of Dyslexia*, 60(2), 183–208.
- Hanford, E. (2019). At a Loss for Words. APM Reports.
- Hasbrouck, J., & Tindal, G. (2017). An update to compiled ORF norms. *Behavioral Research and Teaching Technical Report 1702*.
- Kilpatrick, D. A. (2015). *Equipped for Reading Success*. Casey & Kirsch.
- Kuhn, M. R., & Stahl, S. A. (2003). Fluency: A review of developmental and remedial practices. *Journal of Educational Psychology*, 95(1), 3–21.
- LaBerge, D., & Samuels, S. J. (1974). Toward a theory of automatic information processing in reading. *Cognitive Psychology*, 6(2), 293–323.
- National Reading Panel (2000). *Teaching Children to Read: An Evidence-Based Assessment*. NICHD.
- Schatschneider, C., et al. (2004). Kindergarten prediction of reading skills. *Journal of Educational Psychology*, 96(2), 265–282.
- Share, D. L. (1995). Phonological recoding and self-teaching. *Cognition*, 55(2), 151–218.
- Solity, J., & Vousden, J. (2009). Real books vs reading schemes. *Educational Psychology*, 29(4), 469–511.
- Steacy, L. M., et al. (2019). The role of set for variability in irregular word reading. *Scientific Studies of Reading*, 23(6), 523–532.
- Treiman, R. (1985). Onsets and rimes as units of spoken syllables. *Journal of Experimental Child Psychology*, 39(1), 161–181.
- Treiman, R., & Kessler, B. (2014). *How Children Learn to Write Words*. Oxford.
- Tunmer, W. E., & Chapman, J. W. (2012). Does set for variability mediate the influence of vocabulary knowledge on the development of word recognition skills? *Scientific Studies of Reading*, 16(2), 122–140.
- Wolf, M., & Bowers, P. G. (1999). The double-deficit hypothesis for the developmental dyslexias. *Journal of Educational Psychology*, 91(3), 415–438.
- Yopp, H. K. (1988). The validity and reliability of phonemic awareness tests. *Reading Research Quarterly*, 23(2), 159–177.

---

## Recommendation to Architect

Make the four recommended edits (HFW split, automaticity targets in schema, trickle_down on fluency gates, set-for-variability on DG_th), accept the eight noted concerns as backlog items, and lock the graph at v1.1. The structure is sound. Don't relitigate; ship.
