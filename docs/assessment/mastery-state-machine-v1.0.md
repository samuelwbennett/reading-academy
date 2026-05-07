# Mastery State Machine v1.0

**Authored by:** Agent 03 — Assessment & Mastery
**Status:** v1.0, locked
**Date:** 2026-05-07

The formal lifecycle of a node from "the student has never seen this" to "the student has automated this." Eight states, ten transitions, every transition a pure function of (current state, attempt log, node config). This is the connective tissue between Architect (node definitions), Assessment (acquisition gating), and Reading Fluency (automaticity gating).

---

## Why a formal state machine

Without one, "mastery" is a sentiment. With one, mastery is a software state that two engineers will compute identically from the same attempt log. That's the whole point.

The current MVP code has informal states (`status: "locked" | "unlocked" | "active" | "practicing" | "mastered"`) but no transition discipline — the `recordAttempt` function in `src/lib/masteryEngine.js` treats them loosely. This doc is what locks them down.

---

## The eight states

```
┌────────────┐
│   LOCKED   │  Initial. Prereqs not yet mastered.
└─────┬──────┘
      │ all prereqs reach mastered_for_acquisition
      ▼
┌────────────┐
│  UNLOCKED  │  Available for student to encounter; no attempts yet.
└─────┬──────┘
      │ first attempt logged
      ▼
┌────────────┐
│   ACTIVE   │  ≥1 attempt; rolling window not yet full.
└─────┬──────┘
      │ rolling window full (attempts ≥ window)
      ▼
┌────────────────┐
│   PRACTICING   │  Window full but mastery criteria not met.
└─────┬──────┘
      │ accuracy ≥ threshold AND median latency ≤ acquisition gate AND attempts ≥ min_items
      ▼
┌──────────────────────────────────┐
│   MASTERED_FOR_ACQUISITION       │  Acquired. Handed to Reading Fluency #4.
└─────┬──────────────────────────────┘
      │ Reading Fluency takes over (this agent does not own further transitions)
      ▼
┌────────────────────────────┐
│   IN_AUTOMATICITY_ZONE     │  In daily Reading Facts drills.
└─────┬──────────────────────┘
      │ 3 consecutive Reading Facts sessions hitting automaticity floor
      ▼
┌────────────┐
│  AUTOMATIC │  Graduated. In spaced-review schedule.
└─────┬──────┘
      │ scheduled review sample misses
      ▼
┌────────────┐
│  REGRESSED │  Transient state; immediately re-routes to IN_AUTOMATICITY_ZONE.
└─────┬──────┘
      │ (auto-transition)
      ▼
back to IN_AUTOMATICITY_ZONE
```

| State | Owner | Stable? | Description |
|---|---|---|---|
| `locked` | Architect | yes | Prereqs unmet; not visible in active drills. |
| `unlocked` | Architect | yes | Available; appears in dashboard as "next up." |
| `active` | Assessment | transient | Has been attempted but window not full. |
| `practicing` | Assessment | yes | Window full; not yet meeting mastery criteria. |
| `mastered_for_acquisition` | Assessment → Reading Fluency | transient | Acquisition gate passed; immediately enters fluency. |
| `in_automaticity_zone` | Reading Fluency | yes | Daily Reading Facts focal candidate. |
| `automatic` | Reading Fluency | yes | Graduated; sampled on spaced schedule. |
| `regressed` | Reading Fluency | transient | A scheduled-review sample missed; auto-routes back. |

Stable states are where a node can rest indefinitely. Transient states are evaluated and exited within the same recordAttempt call.

---

## Transitions (ten total)

Every transition is a guarded edge. The guard is a pure function over (current_state, attempt_log, node_config).

### T1: locked → unlocked

**Guard:** `all_prereqs_mastered_for_acquisition(node, state)`

```ts
function canUnlock(node, state) {
  return node.prereqs.every(p =>
    state.nodes[p]?.status === "mastered_for_acquisition"
    || state.nodes[p]?.status === "in_automaticity_zone"
    || state.nodes[p]?.status === "automatic"
  );
}
```

**When evaluated:** After any state transition anywhere in the graph (via `cascadeUnlock`). Cheap — runs in O(N) once per significant change.

**Side effects:** None. Just status flip.

---

### T2: unlocked → active

**Guard:** First attempt logged for this node.

**When evaluated:** Inside `recordAttempt` after the attempt is appended.

**Side effects:** Status flip only.

---

### T3: active → practicing

**Guard:** `attempts.length >= rolling_window`

```ts
function activeToPracticing(state, nodeId, nodeConfig) {
  const attempts = state.nodes[nodeId].attempts;
  return attempts.length >= nodeConfig.mastery.rolling_window;
}
```

**Note:** This is a "you have enough data now" transition — it doesn't mean the student is mastering or struggling, just that there's now a full window to evaluate.

---

### T4: practicing → mastered_for_acquisition

**Guard (the canonical mastery rule):**

```ts
function isAcquisitionMastered(state, nodeId, nodeConfig) {
  const attempts = state.nodes[nodeId].attempts;
  const window = nodeConfig.mastery.rolling_window;
  const recent = attempts.slice(-window);
  
  // Accuracy
  const accuracy = recent.filter(a => a.correct).length / recent.length;
  if (accuracy < nodeConfig.mastery.read_accuracy) return false;
  
  // Latency
  const latencies = recent.map(a => a.latencyMs).sort((a, b) => a - b);
  const median = latencies[Math.floor(latencies.length / 2)];
  if (median > nodeConfig.mastery.read_latency_ms) return false;
  
  // Min items
  if (attempts.length < (nodeConfig.mastery.min_items ?? window * 2)) return false;
  
  return true;
}
```

Three conjunctive gates: accuracy, median latency, total attempts. **All three must pass.** `min_items` defaults to `2 × rolling_window` if not specified — this is what prevents a student from passing on the first 10 attempts; they must demonstrate retention over twice the window.

**Side effects on transition:**
- Set `state.nodes[nodeId].masteredAt = now()`.
- Trigger `cascadeUnlock` on the whole graph.
- Auto-transition to T5 within the same `recordAttempt` call.

---

### T5: mastered_for_acquisition → in_automaticity_zone

**Guard:** Always (immediate auto-transition).

This transition exists because acquisition mastery and automaticity work are owned by different agents (Assessment and Reading Fluency respectively). The transition is the **handoff point**. Once a node hits `mastered_for_acquisition`, it's no longer Assessment's concern; it's Reading Fluency's. The state name change makes the handoff visible in the data.

**Side effects:**
- `state.nodes[nodeId].automaticity = { inZone: true, consecutiveOnTarget: 0, automaticAt: null, nextReviewDue: null, reviewIntervalIdx: 0 }`.
- Reading Fluency engine picks up this node on the next drill scheduler run.

---

### T6: in_automaticity_zone → automatic

**Guard (owned by Reading Fluency #4, repeated here for completeness):**

```ts
function isAutomatic(node_state, drill_score, node_config) {
  const automaticityRate = drill_score.wordsAutomatic / drill_score.wordsAttempted;
  const accuracyRate = drill_score.wordsCorrect / drill_score.wordsAttempted;
  const onTarget = automaticityRate >= 0.80 && accuracyRate >= 0.95;
  
  if (onTarget) {
    node_state.automaticity.consecutiveOnTarget += 1;
  } else {
    node_state.automaticity.consecutiveOnTarget = 0;
  }
  
  return node_state.automaticity.consecutiveOnTarget >= 3;
}
```

**Side effects:**
- `state.nodes[nodeId].automaticity.inZone = false`.
- `state.nodes[nodeId].automaticity.automaticAt = now()`.
- `state.nodes[nodeId].automaticity.nextReviewDue = now() + 1 day`.
- `state.nodes[nodeId].automaticity.reviewIntervalIdx = 0`.

---

### T7: automatic + sample due → automatic + sample evaluated (no state change on success)

**Guard:** `nextReviewDue <= now()` triggers a sample item drop into the next drill.

**On sample success (correct + within target):** Advance interval. New `nextReviewDue = now() + intervals[idx + 1]` where intervals = `[1d, 3d, 7d, 21d, 90d]`. Cap at 90d.

**On sample miss:** Auto-transition T8.

---

### T8: automatic → regressed

**Guard:** Sample item missed (wrong word OR exceeded automaticity floor latency).

**Side effects:**
- `state.nodes[nodeId].automaticity.regressedAt = now()`.
- Telemetry: emit `mastery.regression` event so Student Modeling and Intervention agents see it.
- Auto-transition T9 within same call.

---

### T9: regressed → in_automaticity_zone

**Guard:** Always (immediate auto-transition).

**Side effects:**
- Reset automaticity counters: `consecutiveOnTarget = 0`, `automaticAt = null`, `nextReviewDue = null`.
- `inZone = true`.
- The node returns to active Reading Facts drilling.

---

### T10: any state → locked (regression cascade)

**Guard:** A prereq of node N transitions backwards (to `regressed` then `in_automaticity_zone`). Should N also be re-evaluated?

**Decision:** **No.** A node that has reached `mastered_for_acquisition` does not lose that status because a prereq regressed at the *automaticity* level. Acquisition is a one-way gate; only direct evidence on the node itself can demote it.

This is a deliberate asymmetry. Mastery learning doesn't invalidate prior learning when a related skill loses fluency. The student still acquired the skill; they're just not as fast at the prereq anymore.

---

## What is NOT a transition

These are signals consumed but **don't move the state machine**:

- **Time-since-last-attempt.** A node sitting in `practicing` for 90 days doesn't auto-regress. The agent doesn't penalize gaps; that's Student Modeling's job to surface as a fragility flag.
- **Confidence/hesitation signals.** A 5-second response to a 1500ms-target letter sound is logged with `latencyMs` and contributes to the median. It doesn't cause a special state.
- **Self-correction patterns.** Logged in telemetry; doesn't change the state machine.
- **Cross-strand correlations.** "Student is acing CVC but bombing PA" is an interesting Student Modeling signal; doesn't move this state machine.

---

## How this diff'rs from the current MVP

The current `src/lib/masteryEngine.js` implements a partial version of this state machine:

- ✅ `locked` → `unlocked` via `cascadeUnlock` (T1).
- ✅ `unlocked` → `active` via `recordAttempt` (T2). The MVP folds T2 and T3 together by transitioning to `practicing` on the first attempt that's not the very first; close enough for v1.
- ✅ `practicing` → `mastered` via `evaluateMastery` — this maps to T4.
- ❌ T5 (handoff to Reading Fluency) — not implemented; Reading Fluency engine itself isn't wired yet.
- ❌ T6, T7, T8, T9 — not implemented; depend on Reading Fluency engine.
- ❌ `min_items` gate — not enforced. Currently the engine just checks rolling window. **High-priority engineering fix:** add `min_items` enforcement.

**Required engineering work to bring the MVP to v1.0 spec:**

1. Add `min_items` field check in `evaluateMastery`. ~5 lines.
2. Add a `mastered_for_acquisition` → `in_automaticity_zone` auto-transition once Reading Fluency engine ships. ~10 lines.
3. Implement T6–T9 inside the Reading Fluency engine module (`src/lib/readingFactsEngine.js`, not yet created). ~80 lines.
4. Telemetry events (`mastery.transition`, `mastery.regression`) added to all transitions. ~30 lines across the engine.

---

## Pure-function contract

For testability and engineering sanity, every transition is a pure function:

```ts
// Signature
type Transition = (
  state: StudentState,
  nodeId: string,
  nodeConfigs: NodeConfig[],
  signal: AttemptLogged | DrillCompleted | SampleEvaluated | TickElapsed,
) => { newState: StudentState; emittedEvents: TransitionEvent[] };
```

No clocks. No randomness. No I/O. The "tick elapsed" signal is provided by the caller (the runtime); the state machine never reaches into `Date.now()` itself. Time is an input.

This makes the state machine fully unit-testable: a test fixture is `(state_in, signal) → (state_out, events_out)`, no mocking required.

---

## Open questions

1. **Should `regressed` exist as a stable state for a tick?** Currently it's transient (T8 → T9 in the same call). The argument for making it stable for one drill cycle is so Intervention agent can flag it visibly. **Tentative:** keep transient; Intervention reads from telemetry, not from state.
2. **Should `unlocked` auto-add the node to the daily session menu?** Today it does (via `getTodayTasks`). That's the right call for K–2; for older students with bigger graphs it might be too noisy. Defer.
3. **What if `min_items` is unmet but accuracy and latency both pass?** Currently: stays in `practicing`. Open question: should we surface "almost there — N more items needed" to the student? UI question, not state-machine question. Defer to AI Tutor Dialogue.

---

## Decision log

### 2026-05 — v1.0 lock

- 8 states, 10 transitions, all pure functions.
- Acquisition is a one-way gate: a `mastered_for_acquisition` node never demotes from prereq regression alone.
- Time is an input, not an internal clock.
- Handoff between Assessment (T1–T5) and Reading Fluency (T6–T9) is the `mastered_for_acquisition` → `in_automaticity_zone` edge. State name change makes the handoff visible.
- `min_items` defaults to `2 × rolling_window` when unset on a node — prevents passing on first window of attempts.
