# Daily Session Orchestrator v1.0

**Authored by:** Agent 06 — Student Modeling
**Status:** v1.0, implementation-ready
**Date:** 2026-05-07

The algorithm that produces today's task manifest. Reads from the student model; writes a `SessionManifest` that the SPA renders as the Today's Tasks card. Replaces the current rules-based `getTodayTasks` in `src/lib/masteryEngine.js`.

This is the "what does this kid do today" engine. It is the visible expression of every agent's work: the Architect's graph, the Researcher's principles, Assessment's mastery state, Reading Fluency's automaticity model, and Student Modeling's probabilistic layer all converge here.

---

## The output shape

```ts
type SessionManifest = {
  studentId: string;
  date: string;                    // YYYY-MM-DD, Denver-local
  totalDurationMin: number;        // ~17 default; flexes 8..25
  totalXp: number;                 // sum of task XPs
  tasks: Task[];                   // ordered (recommended order; student can reorder)
  fatigueAdjustment: number;       // -1..1, how much we reduced from default
  rationale: string;               // human-readable, for parent/teacher dashboard
  generatedAt: number;
};

type Task =
  | { type: "lesson";   nodeId: NodeId; items: number; estMin: number; xp: number; reasonCode: string }
  | { type: "review";   nodeId: NodeId; items: number; estMin: number; xp: number; reasonCode: string }
  | { type: "fluency";  nodeId: NodeId; drills: number; estMin: number; xp: number; reasonCode: string }
  | { type: "passage";  nodeId: NodeId; items: number; estMin: number; xp: number; reasonCode: string };
```

The `reasonCode` is a short tag (e.g., `"new_acquisition"`, `"fragile_review"`, `"due_for_spaced_review"`, `"automaticity_zone_focal"`) that drives the rationale string and feeds explanations in parent reports.

---

## The mix

Default 17-minute session decomposes into:

| Slot | Type | Default minutes | Default share |
|---|---|---|---|
| 1 | Lesson on active node | 4 | 24% |
| 2 | Reading Facts drill | 1 (60s drill + ~30s setup) | 6% |
| 3 | Review on most-fragile mastered node | 1 | 6% |
| 4 | Lesson continuation (active node) | 3 | 18% |
| 5 | Reading Facts drill (focal pick) | 1 | 6% |
| 6 | Review on next-due-for-review node | 1 | 6% |
| 7 | Cold passage attempt (if fluency gate is current) | 2 | 12% |
| 8 | Lesson polish (active node, last items) | 2 | 12% |
| 9 | Reading Facts drill (interleaved) | 1 | 6% |
| 10 | Closer (encoding/dictation on active node) | 1 | 6% |

That's ~17 min of student time, ~24% lesson, ~18% Reading Facts (3 × 60s drills), ~12% review, ~12% passage, ~6% encoding closer, ~28% transitions/setup absorbed within slots.

The orchestrator may **collapse, expand, or substitute** slots based on student state.

---

## The algorithm

```python
def compose_session(state, model, node_defs, target_minutes=17):
    manifest = SessionManifest(
        studentId=state.studentId,
        date=denver_date_iso(),
        totalDurationMin=0,
        totalXp=0,
        tasks=[],
        fatigueAdjustment=0,
        rationale="",
        generatedAt=now()
    )
    
    # 1. Establish budget based on velocity and consistency.
    target = adjust_target_minutes(target_minutes, model, state)
    manifest.totalDurationMin = target
    
    # 2. Pick the active node (the one in lesson focus).
    active = pick_active(state, node_defs)
    
    # 3. Pick the focal Reading Facts node (Reading Fluency engine's pickFocal).
    rf_focal = pick_focal_for_reading_facts(state, model, node_defs)
    
    # 4. Pick fragile mastered nodes for targeted review.
    fragile = sorted(model.fragility.flaggedNodes, key=lambda f: -f.score)[:2]
    
    # 5. Pick due-for-review nodes (FSRS-lite retrievability < 0.85).
    due = nodes_with_due_review(state, model, node_defs)
    
    # 6. Pick a fluency gate if one is the current active passage target.
    passage = pick_passage_node(state, model, node_defs)
    
    # 7. Compose slots, respecting the budget.
    slots = []
    
    if active:
        slots.append({"type": "lesson", "nodeId": active, "items": 6, "estMin": 4,
                      "reasonCode": "new_acquisition"})
    
    if rf_focal:
        slots.append({"type": "fluency", "nodeId": rf_focal, "drills": 1, "estMin": 1,
                      "reasonCode": "automaticity_zone_focal"})
    
    if fragile:
        slots.append({"type": "review", "nodeId": fragile[0].nodeId, "items": 3, "estMin": 1,
                      "reasonCode": "fragile_review"})
    
    if active:
        slots.append({"type": "lesson", "nodeId": active, "items": 4, "estMin": 3,
                      "reasonCode": "new_acquisition_continued"})
    
    if rf_focal:
        slots.append({"type": "fluency", "nodeId": rf_focal, "drills": 1, "estMin": 1,
                      "reasonCode": "automaticity_zone_focal"})
    
    if due:
        slots.append({"type": "review", "nodeId": due[0], "items": 3, "estMin": 1,
                      "reasonCode": "due_for_spaced_review"})
    
    if passage:
        slots.append({"type": "passage", "nodeId": passage, "items": 1, "estMin": 2,
                      "reasonCode": "fluency_gate_warmup"})
    
    if active:
        slots.append({"type": "lesson", "nodeId": active, "items": 4, "estMin": 2,
                      "reasonCode": "new_acquisition_polish"})
    
    if rf_focal:
        slots.append({"type": "fluency", "nodeId": rf_focal, "drills": 1, "estMin": 1,
                      "reasonCode": "automaticity_zone_focal"})
    
    if active and active_supports_encoding(active, node_defs):
        slots.append({"type": "review", "nodeId": active, "items": 3, "estMin": 1,
                      "reasonCode": "encoding_closer"})
    
    # 8. Trim to budget.
    slots = pack_to_budget(slots, target)
    
    # 9. Compute XP per slot.
    for s in slots:
        s["xp"] = compute_xp(s, node_defs)
    
    manifest.tasks = slots
    manifest.totalXp = sum(s["xp"] for s in slots)
    manifest.fatigueAdjustment = (target_minutes - target) / target_minutes
    manifest.rationale = build_rationale(slots, active, rf_focal, fragile, due, passage)
    
    return manifest
```

---

## `adjust_target_minutes`

The session length flexes based on the student's recent state:

```python
def adjust_target_minutes(default, model, state):
    target = default
    
    # If velocity is plateauing (trend negative), shorten by 20%.
    if model.velocity.trend < -0.1:
        target *= 0.8
    
    # If consistency is high (>0.7) and trend positive, allow up to 20% extension.
    if model.velocity.consistency > 0.7 and model.velocity.trend > 0.1:
        target *= 1.1
    
    # If recent fatigue is high (last session ended with fatigueScore > 0.6), shorten.
    last = last_session_summary(state)
    if last and last.endedFatigueScore > 0.6:
        target *= 0.85
    
    # Hard bounds: 8..25 min.
    return max(8, min(25, round(target)))
```

The default is 17 min; this clamps to 8 on the low end (a tired week's worst day) and 25 on the high end (a strong week's best day). Students never get more than 25 — past that, returns drop sharply per cognitive-load research.

---

## `pick_active`

The lesson focus node. Priority order:

1. Any node in `practicing` state with `pCorrect > 0.6` and `min_items` not yet met (close to mastery; finish it).
2. Any node in `practicing` state otherwise (let the kid keep working).
3. Any node in `active` state.
4. The most-recently-unlocked `unlocked` node.
5. None (student has no acquisition work to do — manifest skips lesson slots).

```python
def pick_active(state, node_defs):
    practicing = [(n, ns) for n in node_defs
                  if (ns := state.nodes.get(n.id)) and ns.status == "practicing"]
    
    # Closing in on mastery
    near_mastery = [n for n, ns in practicing if ns.model.pCorrect > 0.6]
    if near_mastery:
        return max(near_mastery, key=lambda n: state.nodes[n.id].model.pCorrect).id
    
    if practicing:
        return practicing[0][0].id
    
    active = [n for n in node_defs if state.nodes.get(n.id, {}).status == "active"]
    if active:
        return active[0].id
    
    unlocked = sorted(
        [n for n in node_defs if state.nodes.get(n.id, {}).status == "unlocked"],
        key=lambda n: -(state.nodes.get(n.id).unlockedAt or 0)
    )
    if unlocked:
        return unlocked[0].id
    
    return None
```

---

## `nodes_with_due_review`

Returns nodes where retrievability has dropped below 0.85 and a sample item should appear.

```python
def nodes_with_due_review(state, model, node_defs):
    due = []
    for n in node_defs:
        ns = state.nodes.get(n.id)
        if not ns:
            continue
        if ns.status not in ("automatic", "in_automaticity_zone"):
            continue
        nm = ns.model
        if nm.retrievability < 0.85:
            due.append(n.id)
    
    # Sort by retrievability, lowest first.
    due.sort(key=lambda nid: state.nodes[nid].model.retrievability)
    return due
```

---

## `pick_passage_node`

Returns a fluency-gate node if (a) the student has the prereqs for it and (b) hasn't passed it yet:

```python
def pick_passage_node(state, model, node_defs):
    fluency_gates = [n for n in node_defs if n.id.startswith("FL_")]
    for gate in fluency_gates:
        ns = state.nodes.get(gate.id)
        if ns and ns.status in ("active", "practicing", "unlocked"):
            return gate.id
    return None
```

---

## `pack_to_budget`

The core trimming pass. Slots are weighted by importance; lower-weight slots get dropped first when total exceeds the time budget.

```python
SLOT_WEIGHTS = {
    "new_acquisition":              1.0,
    "new_acquisition_continued":    0.9,
    "new_acquisition_polish":       0.7,
    "automaticity_zone_focal":      0.95,  # daily Reading Facts is high-value
    "fragile_review":               0.85,
    "due_for_spaced_review":        0.6,
    "fluency_gate_warmup":          0.7,
    "encoding_closer":              0.55,
}

def pack_to_budget(slots, target_minutes):
    total = sum(s["estMin"] for s in slots)
    if total <= target_minutes:
        return slots
    
    # Drop lowest-weight slots until under budget.
    slots_sorted = sorted(enumerate(slots), key=lambda x: SLOT_WEIGHTS.get(x[1]["reasonCode"], 0.5))
    drop_idx = set()
    for i, s in slots_sorted:
        if total <= target_minutes:
            break
        drop_idx.add(i)
        total -= s["estMin"]
    
    return [s for i, s in enumerate(slots) if i not in drop_idx]
```

The weights reflect the agent's priorities: lesson > fluency > fragile-review > passage > spaced-review > encoding closer. Tunable per pilot.

---

## `build_rationale`

Human-readable summary, surfaced in parent/teacher dashboards. Examples:

```python
def build_rationale(slots, active, rf_focal, fragile, due, passage):
    parts = []
    if active:
        parts.append(f"New skill: {active}")
    if rf_focal:
        parts.append(f"Reading Facts on {rf_focal}")
    if fragile:
        parts.append(f"Targeted review on fragile {fragile[0].nodeId}")
    if due:
        parts.append(f"Spaced review due: {due[0]}")
    if passage:
        parts.append(f"Cold passage warmup: {passage}")
    return "; ".join(parts) if parts else "All caught up — review session"
```

The rationale becomes the "Today, your child worked on…" line in the parent email.

---

## Recomputing the manifest

The manifest is recomputed:

1. **At midnight Denver time** — fresh manifest for the new day.
2. **When the session starts** — if midnight pass was missed (offline), regenerate.
3. **When mid-session fatigue hits 0.6** — the orchestrator may swap remaining slots to be lighter (lessons → reviews).
4. **After every mastery transition** — invalidates the manifest so the next session reflects the new state.

The manifest is **not** recomputed mid-task. A student in the middle of a lesson doesn't have the manifest swap underneath them.

---

## Edge cases

- **Brand-new student (no diagnostic).** Manifest = single lesson on the chain root (PA_04_blend_cvc currently). 6 items, ~3 min. Hold others until first attempts log.
- **Brand-new student (post-diagnostic).** Manifest opens on the active node from diagnostic placement. Reading Facts not invoked until first acquisition mastery.
- **All nodes mastered.** Manifest = 3 spaced-review samples + 1 Reading Facts focal pick. Total ~5 min. The "all caught up" state.
- **Student returning after long gap (>21 days).** Velocity model returns conservative defaults. Target minutes drops 20%. Manifest skips new lesson, focuses on highest-fragility-flagged node and 2 due reviews. "Welcome back" treatment.
- **Mid-session crash / refresh.** Manifest persists in localStorage; next visit picks up where slots left off, not from the top.

---

## Integration with current MVP

Replaces `getTodayTasks` in `src/lib/masteryEngine.js`. The current implementation is a stub:

```js
export function getTodayTasks(state, nodeDefs, limit = 4) {
  const tasks = [];
  const activeId = selectActiveNode(state, nodeDefs);
  if (activeId) tasks.push({ type: "Lesson", ... });
  const masteries = getRecentMasteries(state, nodeDefs, 5);
  for (const m of masteries) tasks.push({ type: "Review", ... });
  return tasks;
}
```

v1.0 replacement: a `composeSession(state, model, nodeDefs)` function that returns a full `SessionManifest`. The dashboard's `TodayTasks` component renders `manifest.tasks` instead of the current ad-hoc list.

Engineering work to ship the orchestrator:

1. Move `pickFocal` from the Reading Facts engine spec into `src/lib/readingFactsEngine.js`. ~30 lines.
2. Implement `computeStudentModel(state, nodeDefs)` per `student-model/v1.0.md`. ~150 lines.
3. Implement `composeSession(state, model, nodeDefs)` per this spec. ~100 lines.
4. Wire model recompute into `recordAttempt`. ~10 lines.
5. Replace `getTodayTasks` callsite with `composeSession`. ~5 lines.
6. Update `TodayTasks` component to render Tasks (not the stub shape). ~30 lines.

Estimated total: ~325 lines for the model + orchestrator + wiring. None of it changes existing code paths in a destructive way — it's additive.

---

## What this orchestrator does NOT do

- **Pick item-level content within a slot.** The slot says "lesson on CVC_short_a, 6 items"; *which* 6 items the lesson uses is owned by Assessment (#3) item-bank rotation.
- **Decide tone or encouragement copy.** AI Tutor Dialogue (#10).
- **Render UI.** Product/AI Tutor Dialogue.
- **Handle authentication or storage.** Engineering layer.
- **Predict long-term outcomes.** That's modeling territory but more sophisticated; v2.

---

## Open questions

1. **Should the student be able to override the manifest?** (i.e., "skip this slot" or "do more of that")  
   Tentative: **partial yes** — student can pick the order of slots (Math Academy menu pattern), but cannot skip mandatory slots (the active-node lesson). Skips trigger an Intervention flag.

2. **Should weekend sessions be different?**  
   Probably yes — fewer slots, more review, less new lesson. Defer to pilot data.

3. **Should the manifest be commit-and-immutable, or should it adapt as the student progresses through the session?**  
   v1: commit at session start, adapt only on fatigue trigger. Simpler. Reconsider after pilot.

---

## Decision log

### 2026-05 — v1.0 lock

- 10-slot default 17-min session, with collapse logic for shorter days.
- Slot weights drive trimming order; lesson > fluency > fragile-review > passage > spaced-review > encoding closer.
- Orchestrator is pure-functional given (state, model, nodeDefs).
- Manifest is committed at session start; adapts only on fatigue trigger ≥0.6.
- Manifest persists in localStorage; survives refresh.
- All slot definitions reference existing node IDs and existing telemetry contracts; no new schema additions outside the model blob defined in `student-model/v1.0.md`.
