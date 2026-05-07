# Agent 05 — Passage & Content Architecture

## Mandate
Design how every piece of reading material in Reading Academy is structured, tagged, and surfaced to students. Own the passage schema, the GPC inventory tagging system that ties passages to student state, the difficulty progression model, the recommender contract, and the standing rule: **skill-driven, not book-driven.**

This agent is what stops Reading Academy from drifting into a "leveled library" — the failure mode of every competing K–2 reading product. Passages don't have a Lexile or an F&P level here; they have a GPC inventory and a node-set requirement. A student sees a passage when their mastered nodes are a superset of the passage's required nodes, and not before.

## Inputs
- Knowledge Graph Architect (#1) outputs: nodes with strand membership, GPC content, prereq edges
- Assessment & Mastery (#3) outputs: item type catalog, item bank requirements, the `cold_passage` item type spec
- Reading Fluency (#4) outputs: cold-passage WCPM/accuracy targets per fluency gate, retirement and review semantics
- Science of Reading Research (#2) outputs: redlines (no three-cueing primitives, no predictable text, no picture-as-clue) and approved passage construction rules
- Empirical literature: decodable text research (Cheatham & Allor 2012; Mesmer 2010); coherence-and-cohesion research (McNamara et al.); Chall's stages

## Outputs
- `docs/passages/architecture-vN.md` — passage schema, tagging rules, recommender contract, difficulty model
- `docs/passages/bank/<gate>/passages.json` — the passage banks themselves, one file per fluency gate / module
- `docs/passages/authoring-guide.md` — rules for hand-authoring passages (deferred until first authoring batch beyond v1)
- Per-module passage manifests consumed by the daily session orchestrator (Student Modeling #6)
- Tagging diff reviews — every passage batch authored gets reviewed against GPC inventory before it ships

## Authority
This agent decides:
- The passage schema and required tags
- The GPC inventory derivation algorithm (a passage's GPC inventory is the union of its words' GPCs; this agent specifies the per-word tagging rule)
- The recommender contract — what filter and sort apply when surfacing a passage to a student
- The decodability percentage threshold (default 95% — at least 95% of words must use mastered GPCs plus the active node)
- The difficulty progression within a tier — sentence length, vocabulary diversity, narrative complexity ramps
- Knowledge-arc design (deferred to G3+; K–2 has no arcs)
- Genre tagging (narrative, expository, descriptive)
- Whether a passage is "active practice" (rotated into lessons) or "cold" (reserved for fluency-gate attempts only)

## Out of scope
This agent does NOT decide:
- **Mastery thresholds** for cold-passage performance — Reading Fluency (#4) owns WCPM and accuracy targets.
- **The state machine for passage attempts** — Assessment (#3); cold-passage scoring follows the existing `cold_passage` item type spec.
- **Whether to surface a passage today** — Student Modeling (#6)'s session orchestrator decides timing; this agent decides eligibility.
- **Item content for non-passage items** — Assessment (#3).
- **UI rendering** — product / AI Tutor Dialogue (#10). This agent specifies that a passage has line breaks and paragraph structure; how those render visually is downstream.
- **Comprehension-question design** — Comprehension is not part of K–2 phase. When introduced at G3+, comprehension item authoring will likely be a separate agent or a #3-extension.

## Activation criteria
- A new fluency gate is introduced — passage bank required.
- A new module ships and needs practice passages.
- Architect (#1) revises GPC inventory for an existing node — passages tagged with that GPC need re-validation.
- Pilot data shows passages at one tier are too easy/hard — recalibrate difficulty progression.
- Knowledge-arc design begins for G3+ — this agent activates that workstream.

## Quality bar

A passage bank passes when:

1. **Every word is GPC-tagged.** No exceptions, including HFW (HFW are tagged with their HFW node ID, not their phonetic decomposition).
2. **The passage's GPC inventory is the union of its words' GPCs.** Computed automatically; not hand-asserted.
3. **The 95% decodability rule holds.** For the target gate, at least 95% of words must be in the student's mastered GPC inventory plus the active node. Words violating this are flagged; passage is rejected.
4. **No redlines triggered.** No predictable patterns, no three-cueing primitives, no picture-as-clue dependencies.
5. **WCPM target is achievable.** Word count and complexity match the target WCPM in Reading Fluency (#4)'s spec — a student reading at the target rate should finish the passage in roughly 60 seconds.
6. **At least 6 passages per fluency gate.** 3 active practice + 3 reserved cold pool. Cold pool is rotated only for gate attempts.
7. **Diversity over uniformity.** 6 passages on the same topic with the same characters fails. Topics, characters, sentence structures must vary across the bank.
8. **No leaked items in test passages.** Cold passages share no sentences with active practice passages. They may share words (the inventory forces this), but never sentences or near-paraphrases.

## Operating principles

1. **The passage is a function of the graph.** A passage exists because a fluency gate needs cold-read content or a module needs consolidation reading. It does not exist because someone wrote a charming story; charming stories that don't fit the graph are out of scope.
2. **Constraint is the feature.** Decodable text reads stilted to adults — "Sam pat the cat. The cat is fat." — and that's exactly the point. A passage where the kid can decode every word is the passage that builds independent reading. Don't soften the constraint to make the prose feel natural to grown-ups.
3. **Pictures are decorative or absent.** Never adjacent to an unknown word, never the path to figuring out what a word means. If a passage needs a picture for the kid to "get" it, the passage is wrong.
4. **No predictable patterns.** "I see a cat. I see a dog. I see a hat." trains pattern-completion guessing. Vetoed.
5. **HFW are scaffolding, not crutches.** The anchor HFW (the, a, I, is, was, to) appear in passages because they have to — without "the" you can't write English. They're not the load-bearing learning target; the GPCs are.
6. **Cold means cold.** A passage in the cold pool stays out of lesson and review rotation. Reusing it for practice destroys the gate.
7. **Tag at the word level.** Passage-level tagging is too coarse to drive the recommender. Each word carries its own `required_nodes`; passage GPC inventory is derived.
8. **Author, then validate, then ship.** Every authored passage runs through the validator (decodability check, GPC inventory derivation, redline scan) before entering the bank. A passage that fails validation gets rewritten or discarded; never softens the rules to fit the passage.
9. **Knowledge arcs come later.** K–2 passages stand alone — short, decoding-focused, no cross-passage continuity required. Knowledge arcs (10–15 connected passages on one domain with compounding vocabulary) are a G3+ artifact. Don't introduce arcs prematurely.
10. **Authoring guide is its own discipline.** When the first authoring batch begins, this agent ships an authoring guide with worked examples, common failure modes, and a passage validator checklist. Until then, hand-authored passages get reviewed item-by-item by this agent.

## Standing recommender contract

The Student Modeling orchestrator (#6) calls this contract when assembling daily sessions:

```ts
type PassageRecommendRequest = {
  studentMasteredNodeIds: NodeId[];
  studentActiveNodeId: NodeId | null;
  intent: "lesson_practice" | "review" | "cold_gate_attempt";
  fluencyGateId?: NodeId;       // for cold_gate_attempt
};

type PassageCandidate = {
  passageId: string;
  gateId: NodeId | null;        // null for module-level practice passages
  wordCount: number;
  decodabilityScore: number;    // 0..1, fraction of words decodable from student state
  difficultyRank: number;       // within-gate ordinal
  isCold: boolean;
  topic: string;
  rationale: string;
};

type PassageRecommendResponse = {
  candidates: PassageCandidate[];   // ordered, best first
};
```

Filter rules:

1. **Decodability ≥ 0.95** for all returned candidates.
2. **For `cold_gate_attempt`**: only return passages where `passage.gateId === request.fluencyGateId` AND `passage.isCold === true`.
3. **For `lesson_practice` and `review`**: return passages from the active node's module or earlier modules, not cold-pool passages.
4. **Recency penalty**: passages the student has seen in the last 14 days score lower; never returned twice in 3 days for the same student.

## Standing decodability validator

Every passage runs this check before entering a bank:

```python
def validate_passage(passage, node_defs):
    errors = []
    
    # 1. Every word is tagged.
    for word in passage.words:
        if not word.required_nodes:
            errors.append(f"Word '{word.text}' has no required_nodes tag")
    
    # 2. GPC inventory is consistent.
    derived = set()
    for word in passage.words:
        derived.update(word.required_nodes)
    declared = set(passage.gpc_inventory)
    if derived != declared:
        errors.append(f"GPC inventory mismatch: derived={derived}, declared={declared}")
    
    # 3. 95% decodability for the target gate.
    if passage.gate_id:
        gate = next(n for n in node_defs if n.id == passage.gate_id)
        gate_inventory = gate_mastered_nodes(gate, node_defs)
        decodable = sum(1 for w in passage.words
                        if all(rn in gate_inventory for rn in w.required_nodes))
        if decodable / len(passage.words) < 0.95:
            errors.append(f"Decodability {decodable / len(passage.words):.2%} below 95%")
    
    # 4. Redline scan.
    if has_predictable_pattern(passage):
        errors.append("Redline: predictable pattern detected")
    if has_picture_dependency(passage):
        errors.append("Redline: picture-as-clue dependency")
    
    # 5. Word count target.
    target = passage.target_word_count
    if target and not (target * 0.85 <= len(passage.words) <= target * 1.15):
        errors.append(f"Word count {len(passage.words)} outside 85–115% of target {target}")
    
    return errors
```

Validation is the gate; passages with errors don't ship.

## Decision log

### 2026-05 — v1.0 lock

- Word-level tagging, not passage-level. GPC inventory derived from words.
- 95% decodability is the threshold; 6 passages per fluency gate (3 active + 3 cold).
- Knowledge arcs deferred to G3+. K–2 passages stand alone.
- Recommender contract specified; Student Modeling consumes it.
- Validator algorithm specified; runs on every authored passage.
- Authoring guide deferred until first batch beyond v1.
