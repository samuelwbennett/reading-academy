# Agent #1 — Knowledge Graph Architect (v2.0)

Version 2.0 · 2026-05-08
Supersedes: v1.0 (which only owned the data file)

---

## Mission

Own the **structure** of what Reading Academy teaches: every skill node, every prerequisite edge, every layer in the K–2 decoding graph. Own the **rendering** of that structure — the Math Academy-style visualization at `/reading/graph` is the canonical view of this agent's output. Set the rules for adding, splitting, merging, and retiring nodes.

The Knowledge Graph Architect does not own:
- assessment items (Agent #3 — Assessment & Mastery)
- decodable passages (Agent #5 — Passage & Content Architecture)
- mastery scoring rules (Agent #3 again)
- review scheduling (Agent #4 — Reading Fluency, with M3-D scheduler)

It does own:
- `src/data/skill_nodes.json` — the canonical graph
- `docs/agents/knowledge-graph-architect-v2.md` — this spec
- `src/lib/graph/layout.ts` — layered DAG layout
- `src/pages/Reading/components/KnowledgeGraph.jsx` — the viewer
- `src/pages/Reading/routes/Graph.jsx` — the route

---

## Authoring rules

A node is a **mastery target** — something a teacher could legitimately say "the child can now do X." Not a session, not a worksheet, not a video — a stable cognitive milestone. The unit-test for a candidate node: would two literacy specialists agree on what "mastered" means for it? If not, split it or pick a different boundary.

Every node MUST have:

- `id` — globally unique, snake_case, prefix indicates strand (`PA_`, `LS_`, `CVC_`, `BL_`, `DG_`, `TG_`, `HFW_`, `IE_`, `SE_`, `VT_`, `RC_`, `SCG_`, `SY_`, `FL_`)
- `course`, `unit`, `module`, `topic`, `strand`, `skill` — hierarchy + display
- `prereqs` — array of node ids, all of which MUST exist in the same file. Cycles are forbidden (the validator catches them via Tarjan).
- `assessment` — one of the 11 known item types (`phoneme_isolate_initial`, `read_aloud`, etc.) — see Agent #3's catalog
- `mastery` — `{ min_items: number }` (with overrides in the validator)
- `examples` — 3–6 representative examples for the docs / authoring guide

Optional but recommended:
- `automaticity_target_latency_ms` — fluency threshold for the engine
- `xpPerItem`, `xpOnMastery` — XP economy
- `trickle_down`, `set_for_variability` — pedagogical flags
- `phoneme_alternatives` — for IPA-tolerant scoring
- `notes` — free-form authoring notes

---

## Operations

### Add a node

1. Pick a stable `id` (snake_case, prefix-correct).
2. Identify all immediate prereqs already in the graph. Don't add transitive prereqs — the validator's transitive-closure check enforces minimal sets.
3. Set `assessment` to a type that has an authored item bank, OR plan for Agent #3 to author one.
4. Run `npm run validate` — must be 0 errors / 0 warnings.
5. Run `npm run build` and open `/reading/graph` — visually confirm the new node lands in a sensible layer with reasonable edge crossings.
6. Update the system overview's node count.

### Split a node

When a single node has become too big — the validator flags >40% items sharing a CVC pattern, or pilot data shows mastery confidence stalling — split into two related nodes.

1. Author both new nodes; transfer item bank entries appropriately.
2. The new nodes' prereqs include the old node's prereqs, plus possibly the *first* of the two splits.
3. Migrate any dependent nodes' prereq references.
4. **Keep the old `id` retired** in a `retired_ids` list inside this doc so the validator can warn on stale telemetry.
5. Update the M3 student-model migration to project old `id` data into the appropriate split.

### Retire a node

Rare. If a node was a misunderstanding of the curriculum:

1. Remove it from `skill_nodes.json`.
2. Remove its item bank from `assessment_items.json` (Agent #3 confirms).
3. Update any other node's `prereqs` that referenced it.
4. Add the id to `retired_ids` here.
5. Note in the system overview's changelog.

---

## Visualization contract

The `/reading/graph` view renders this agent's data. Two invariants:

- Foundation skills sit at the **bottom** (PA_01 has zero prereqs; that's the floor). Fluency gates sit at the **top**. The user reads the graph as a foundation-to-summit progression.
- Each node's color encodes the M3 mastery state from the **current student's** model: locked (gray), unlocked (light blue), active (green), practicing (amber), mastered (blue), in_automaticity_zone (indigo), automatic (violet), regressed (red).

The layout is layered (Sugiyama-style) with a barycenter crossing-reduction pass. It's deterministic — same input nodes produce the same `(x, y)` for each. This matters for screenshots and pilot reproducibility.

---

## Future: LLM-assisted graph expansion (M10)

For grade-3+ expansion, hand-authoring every node is slow. The plan is to give Claude a structured prompt with:
- the existing graph (as JSON)
- the curriculum standard (e.g., CCSS RF.3.x)
- examples of well-formed nodes in this style
- the validator rules

…and have it propose new node entries. Each proposal goes through:
1. Validator run (errors → reject, warnings → human review)
2. Sample item authoring by Agent #3 (separately, also LLM-assisted)
3. Pilot teacher spot-check
4. Merge

The LLM never writes directly to `skill_nodes.json`. It produces a PR-style diff that this agent reviews and applies.

---

## Retired ids

(none yet — the K–2 graph is original; nothing has been split or retired)

---

## Change log

- v2.0 (2026-05-08): Added visualization ownership (`KnowledgeGraph.jsx`, `Graph.jsx`, `layout.ts`). Formalized split/retire workflow. Added M10 LLM-assisted expansion plan.
- v1.0 (2026-04-15): Initial spec. Owned `skill_nodes.json` only.
