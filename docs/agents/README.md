# Reading Academy — Agent Registry

A literacy operating system is composed of specialized expert systems, not one giant prompt. Each agent below owns a tightly-scoped domain. Anything outside that scope, the agent refuses to decide on and routes to the appropriate sibling.

This is the same pattern Math Academy is built around — separate engines for curriculum, mastery, scheduling, fluency, etc. — and the same reason their product produces sharper decisions than any single-system competitor.

---

## How to use this registry

Each agent has a markdown spec at `docs/agents/NN-slug.md` defining:

- **Mandate** — one sentence
- **Inputs** — what the agent reads
- **Outputs** — what it produces
- **Authority** — what decisions it owns
- **Out of scope** — explicit refusals
- **Activation criteria** — when it runs
- **Quality bar** — how to know its work is good

Specs are loaded as system prompts when activating that agent. Today these are markdown files; later they graduate to Claude Agent SDK processes with their own tools.

---

## Activation order (what to build, when)

The order is forced by dependency — later agents need earlier agents' outputs.

| # | Agent | Depends on | Status |
|---|-------|------------|--------|
| 0 | Chief Integration & Systems Engineering | all pedagogy agents shipped | **Active (Build Plan v1.0 shipped)** |
| 1 | Literacy Knowledge Graph Architect | — | **Active (v1.1 graph shipped)** |
| 2 | Science of Reading Research | — (parallel to #1) | **Active (v1.0 review shipped)** |
| 3 | Assessment & Mastery | #1 | **Active (v1.0 catalog + state machine shipped)** |
| 4 | Reading Fluency (Reading Facts) | #1, #3 | **Active (engine v1.0 shipped)** |
| 5 | Passage & Content Architecture | #1 | **Active (architecture + FL_01 bank shipped)** |
| 6 | Student Modeling | #1, #3 | **Active (model + orchestrator v1.0 shipped)** |
| 7 | Intervention & Orchestration | #6 | Pending |
| 8 | Motivation & Behavioral Design | #1 | Pending |
| 9 | Speech Recognition & Oral Reading | #4 | Pending (Azure) |
| 10 | AI Tutor Dialogue | #6, #8 | Pending |
| 11 | Parent Insight | #6, #7 | Pending |
| 12 | Learning OS / Cross-App Orchestration | all | Pending |

---

## The 12 agents

### Core (the engine)

**1. Literacy Knowledge Graph Architect** — owns the prerequisite DAG of every literacy skill. Defines what a "skill" is at atomic granularity, the prereqs between them, and the unlock semantics. Without this, everything else is shallow edtech. **First output: the K-2 decoding graph (54 nodes).**

**2. Science of Reading Research** — translates literacy science into product rules. Evaluates evidence quality, sets instructional sequence, defines mastery thresholds, flags cognitive overload. The skeptic that prevents engagement-over-learning traps.

**3. Assessment & Mastery** — defines what counts as mastery for each node. Item design, confidence scoring, fluency weighting, transfer checks, cumulative validation. Reading mastery is fuzzier than math mastery; this agent makes it rigorous.

**4. Reading Fluency (Reading Facts)** — designs the automaticity engine. Latency thresholds, retrieval practice, spaced fluency review, oral reading rate, prosody. Math Academy's "math facts" equivalent. Likely our strongest moat.

**5. Passage & Content Architecture** — designs how reading material is structured. Decodable passage tagging, vocabulary control, syntax control, knowledge-domain tagging, difficulty progression. **Skill-driven, not book-driven.**

**6. Student Modeling** — estimates mastery probability, fragile mastery, forgetting curves, bottlenecks, guessing detection. Powers adaptive sequencing and review scheduling. Where the AI moat lives long-term.

**7. Intervention & Orchestration** — turns student data into teacher action. Prioritizes interventions, identifies stuck students, generates small-group plans, surfaces parent insights. The teacher operating system.

**8. Motivation & Behavioral Design** — XP, streaks, reinforcement timing, attention protection, frustration avoidance. Intentionally minimalist — Math Academy beats every competitor with no avatars and no gem economy.

### Secondary (the depth)

**9. Speech Recognition & Oral Reading** — phoneme error detection, substitution/omission analysis, hesitation, WCPM, pronunciation scoring. Currently stubbed by Web Speech API; eventual home for Azure Pronunciation Assessment integration. (See `docs/TODO.md`.)

**10. AI Tutor Dialogue** — coach, not chatbot. Prompting strategies, scaffolding, hint systems, Socratic questioning, encouragement style, cognitive load management.

**11. Parent Insight** — translates complexity into clarity. Progress summaries, risk flags, growth narratives, at-home suggestions. Adoption lever.

**12. Learning OS / Cross-App Orchestration** — coordinates Reading Academy, Reading Facts, Math Academy, Math Facts, future apps. Priority engine, time allocation, workload balancing, fatigue modeling, daily plans. **Reading Academy → Literacy OS → K-12 Mastery OS.**

---

## Strategic framing

The user-facing product is not "a reading app." The architecture is:

```
Reading Academy
    ↓ (compose)
Literacy Operating System
    ↓ (compose)
K-12 Mastery Operating System
```

Every agent decision should ladder up to the right framing for its layer. The Knowledge Graph Architect designs for a graph that can host morphology and comprehension nodes from G3-12, not just K-2 phonics. The Cross-App Orchestrator designs for a workload model that includes any future subject, not just reading + math.

---

## How to add a new agent

1. Create `docs/agents/NN-slug.md` using the template at `docs/agents/_template.md`.
2. Add a row to the activation table above.
3. Add a one-paragraph description to the appropriate section.
4. Note its dependencies and update the activation order if needed.
