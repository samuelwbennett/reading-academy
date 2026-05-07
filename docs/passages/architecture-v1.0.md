# Passage & Content Architecture v1.0

**Authored by:** Agent 05 — Passage & Content Architecture
**Status:** v1.0, locked
**Date:** 2026-05-07

The schema and machinery for every piece of reading material in Reading Academy. Word-level GPC tagging, passage-level metadata, recommender contract, difficulty progression. This is the spec engineering implements; the FL_01 sample bank is the worked example.

---

## Schema

### Passage

```ts
type Passage = {
  passageId: string;                  // stable identifier, e.g. "P_FL01_001"
  gateId: NodeId | null;              // FL_01_cvc_fluency, FL_02_..., or null for module practice
  module: string;                     // "2.1. Short Vowels", etc.
  topic: string;                      // "Sam and the Cat", "The Hat in the Pot"
  genre: "narrative" | "expository" | "descriptive";
  isCold: boolean;                    // true → reserved for gate attempts only

  // Difficulty
  targetWordCount: number;            // matches the gate's passage_word_count
  difficultyRank: number;             // ordinal within the gate (1..N)
  avgSentenceLengthWords: number;     // computed
  multisyllabicPctIfAny: number;      // computed; 0 for K-1

  // GPC inventory (derived from words)
  gpcInventory: string[];             // strand:GPC tags, e.g. ["CVC:short_a", "DG:sh"]
  hfwInventory: string[];             // node IDs, e.g. ["HFW_01a_anchors"]

  // Content
  paragraphs: Paragraph[];

  // Authoring metadata
  authoredBy: string;                 // human or agent ID
  authoredAt: number;
  validationStatus: "pending" | "passed" | "failed";
  validationErrors: string[];
};

type Paragraph = {
  sentences: Sentence[];
};

type Sentence = {
  text: string;                       // canonical rendering
  words: Word[];
};

type Word = {
  text: string;                       // surface form
  punctuation?: string;               // trailing punctuation (period, comma, etc.)
  requiredNodes: NodeId[];            // every node a student must have to decode this word
  isHfw: boolean;
  isProperNoun: boolean;
};
```

### Word tagging rules

Every word carries `requiredNodes` — the set of mastered nodes a student needs to decode it. Computed at authoring time, not run time.

```python
def required_nodes_for_word(word, node_defs):
    """Return the smallest node set that decodes this word."""
    nodes = set()
    
    # If word is a high-frequency word, the HFW node alone is sufficient.
    if word in HFW_LOOKUP:
        return [HFW_LOOKUP[word]]  # e.g., ["HFW_01a_anchors"]
    
    # Otherwise, decompose phonetically.
    phonemes = phonemic_decomposition(word)  # ["k", "a", "t"] for "cat"
    
    # Each phoneme requires the letter-sound node + any pattern node.
    for phoneme, grapheme in phonemes:
        nodes.add(letter_sound_node(grapheme))
    
    # Add the pattern node (the highest-level abstraction needed).
    pattern = pattern_node(word)
    if pattern:
        nodes.add(pattern)  # e.g., "CVC_short_a" for "cat"
    
    return sorted(nodes)
```

Examples:

| Word | requiredNodes | isHfw |
|---|---|---|
| `cat` | `["LS_01_consonants_set1", "LS_03_short_vowels_ai", "CVC_short_a"]` | false |
| `the` | `["HFW_01a_anchors"]` | true |
| `ship` | `["LS_01_consonants_set1", "LS_03_short_vowels_ai", "DG_sh"]` | false |
| `made` | `["LS_01_consonants_set1", "LS_03_short_vowels_ai", "SE_a_e"]` | false |

Note: pattern nodes (like CVC_short_a) implicitly require their prereqs. The `requiredNodes` array lists only the *minimal* set; the recommender unrolls prereqs when checking against student state.

### GPC inventory derivation

The passage-level `gpcInventory` is the union of all `requiredNodes` across all words in the passage. Computed automatically; never hand-asserted.

```python
def derive_gpc_inventory(passage):
    inventory = set()
    for para in passage.paragraphs:
        for sent in para.sentences:
            for word in sent.words:
                inventory.update(word.requiredNodes)
    return sorted(inventory)
```

This is the field the recommender filters on.

---

## Recommender

The contract specified in agent #5's spec, implemented:

```python
def recommend_passages(request, all_passages, node_defs):
    student_full_inventory = unroll_prereqs(
        request.studentMasteredNodeIds + ([request.studentActiveNodeId] if request.studentActiveNodeId else []),
        node_defs
    )
    
    candidates = []
    for p in all_passages:
        # Filter 1: Cold-pool gate matching
        if request.intent == "cold_gate_attempt":
            if p.gateId != request.fluencyGateId or not p.isCold:
                continue
        else:
            if p.isCold:
                continue
        
        # Filter 2: Decodability ≥ 0.95
        decodable = sum(1 for w in all_words(p)
                        if all(rn in student_full_inventory for rn in w.requiredNodes))
        decodability = decodable / len(all_words(p))
        if decodability < 0.95:
            continue
        
        # Filter 3: Recency penalty
        days_since_seen = days_since_student_saw(p.passageId, request.studentId)
        if days_since_seen < 3:
            continue
        
        candidates.append(PassageCandidate(
            passageId=p.passageId,
            gateId=p.gateId,
            wordCount=word_count(p),
            decodabilityScore=decodability,
            difficultyRank=p.difficultyRank,
            isCold=p.isCold,
            topic=p.topic,
            rationale=f"{decodability:.0%} decodable; rank {p.difficultyRank}; last seen {days_since_seen}d ago"
        ))
    
    # Sort: difficultyRank ascending (easier first), then recency descending (oldest first).
    candidates.sort(key=lambda c: (c.difficultyRank, -days_since_student_saw(c.passageId, request.studentId)))
    return candidates
```

`unroll_prereqs` walks the prereq DAG to produce the full transitive set — a student who has mastered `DG_sh` is also implicitly considered to have `CVC_short_i`, `CVC_short_a`, etc.

---

## Difficulty progression within a tier

Inside a single fluency gate's bank, passages are ranked 1..N by composite difficulty. Three signals:

```python
def compute_difficulty_rank(passage, peer_passages):
    score = (
        0.5 * passage.avgSentenceLengthWords +     # longer sentences = harder
        0.3 * vocabulary_diversity(passage) +      # more unique words = harder
        0.2 * narrative_complexity(passage)        # more clauses, dialogue = harder
    )
    
    # Rank within the gate's bank.
    peer_scores = [(p.passageId, score_for(p)) for p in peer_passages]
    peer_scores.sort(key=lambda x: x[1])
    return next(i for i, (pid, _) in enumerate(peer_scores, 1) if pid == passage.passageId)
```

Within FL_01's 6-passage bank, rank 1 is the easiest (shortest sentences, narrowest vocab), rank 6 is the hardest. The recommender starts at rank 1 for first attempts and progresses up.

`vocabulary_diversity` = unique words / total words. `narrative_complexity` = (sentences with multiple clauses) / total sentences.

---

## Cold pool semantics

- Each fluency gate has 6 passages: 3 active + 3 cold.
- Active passages rotate into lesson and module practice.
- Cold passages **only** appear when `intent == "cold_gate_attempt"`.
- A cold passage that has been used for a gate attempt is "consumed" for 30 days — the recommender will not return it again to the same student during that window. After 30 days it's eligible again.
- If a student exhausts all 3 cold passages, the bank rotates the 3 active passages into the cold slot temporarily. This is a fallback; the long-term fix is to author more passages.

---

## Anti-three-cueing constraints

The validator scans for these patterns and rejects the passage:

```python
def has_predictable_pattern(passage):
    """Detect repetitive sentence frames that train pattern guessing."""
    sentences = [s.text for p in passage.paragraphs for s in p.sentences]
    if len(sentences) < 3:
        return False
    
    # Rule 1: ≥3 consecutive sentences with the same first 2 words.
    for i in range(len(sentences) - 2):
        first_words = [tuple(sentences[i+j].split()[:2]) for j in range(3)]
        if len(set(first_words)) == 1:
            return True
    
    # Rule 2: Same sentence template with single-word substitution across ≥3 sentences.
    # ("I see a cat. I see a dog. I see a hat.") → templates collapse to "I see a X"
    templates = [collapse_to_template(s) for s in sentences]
    for t in set(templates):
        if templates.count(t) >= 3:
            return True
    
    return False

def collapse_to_template(sentence):
    """Replace all decodable nouns with a placeholder."""
    return " ".join("X" if is_content_word(w) else w for w in sentence.split())
```

`has_picture_dependency` is N/A in v1 (no pictures yet); the function returns False unless a passage tags itself with `requires_picture: true`, in which case validation fails.

---

## Knowledge arcs (deferred)

Knowledge arcs — 10–15 connected passages on one domain with compounding vocabulary — are a **G3+ feature**. K–2 passages stand alone.

Reasoning: a K–2 student is decoding-bound. Asking them to track multi-passage continuity adds load that detracts from the actual learning target. By G3, decoding is increasingly automatic; comprehension becomes the focus, and arcs become the right structure.

When arcs activate (P3 of the graph), this agent ships an `arc-architecture-v1.md` extension. Until then, the schema has no arc field.

---

## Engineering integration

The passage banks live as JSON files at `docs/passages/bank/<tier>/passages.json`. Build-time the file is imported into the SPA the same way `skill_nodes.json` is.

```ts
// src/data/passages.json — generated/concatenated from docs/passages/bank/
import passages from "./data/passages.json" with { type: "json" };

// Usage in the orchestrator:
import { recommendPassages } from "./lib/passageRecommender.js";
const candidates = recommendPassages(request, passages, skillNodes);
```

Engineering work to integrate v1.0:

1. Concatenation script: walk `docs/passages/bank/`, output `src/data/passages.json`. ~30 lines.
2. `recommendPassages` function in `src/lib/passageRecommender.js` per the contract above. ~80 lines.
3. `validatePassage` function for CI; runs on every PR that touches passages. ~50 lines.
4. `<PassageReader>` component for the cold-passage drill UI. Roughly mirrors `<Drill>` but renders connected text. ~150 lines.
5. Wire orchestrator (#6) to call `recommendPassages` when composing a session manifest with a passage slot. ~10 lines.

Total: ~320 lines + the passage content itself.

---

## Decision log

### 2026-05 — v1.0 lock

- Word-level tagging is the schema's load-bearing decision.
- 95% decodability threshold is the validator's hard gate.
- Cold pool is 3 passages per fluency gate; consumed-for-30-days lockout per student.
- Difficulty rank is composite (sentence length, vocab diversity, narrative complexity).
- Knowledge arcs explicitly deferred to G3+.
- Anti-three-cueing scan is part of validator, not optional.
