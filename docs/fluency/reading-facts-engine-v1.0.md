# Reading Facts Engine v1.0

**Authored by:** Agent 04 — Reading Fluency
**Status:** v1.0, implementation-ready
**Date:** 2026-05-07

The implementation specification for the daily fluency drill that turns accurate-but-slow reading into automatic recognition. This is the literacy moat. Most reading apps don't have this; the few that do don't gate on it. We do both.

---

## Mental model

```
Acquisition layer (Lesson)        →  Student can read the word correctly, sometimes slowly
        ↓
Reading Facts (this engine)        →  Student reads the word correctly, automatically
        ↓
Cold-passage gates (FL_01–FL_04)  →  Student reads connected text at grade-band WCPM
```

Reading Facts sits in the middle. It receives words from nodes that have crossed the acquisition gate (≥90% accuracy, ≤acquisition latency) and trains them until they cross the automaticity floor. Nodes that haven't reached acquisition mastery are *not* eligible for Reading Facts — fluency drilling without accuracy trains errors.

A node's lifecycle through the engine:

```
1. locked → unlocked → active (lesson)
2. active → mastered_for_acquisition (when accuracy + acquisition latency met)
3. mastered_for_acquisition → in_automaticity_zone (Reading Facts starts pulling items)
4. in_automaticity_zone → automatic (3 consecutive sessions hitting automaticity floor)
5. automatic → spaced_review_only (1d / 3d / 7d / 21d / 90d sample items)
6. spaced_review_miss → in_automaticity_zone (regression)
```

---

## Data model

### Per-node fluency state

Stored alongside the existing per-node state in `student_app_accounts.state.nodes[nodeId]`:

```ts
type NodeFluencyState = {
  acquisition: {
    accuracy: number;            // rolling, owned by Assessment agent
    latencyMs: number;           // rolling median
    masteredAt: number | null;   // ms epoch
  };
  automaticity: {
    inZone: boolean;             // currently in active Reading Facts zone
    consecutiveOnTarget: number; // sessions hitting automaticity floor (0..3)
    automaticAt: number | null;  // ms epoch, null until graduated
    nextReviewDue: number | null; // ms epoch for spaced review sample
    reviewIntervalIdx: number;   // 0..4 → [1d, 3d, 7d, 21d, 90d]
  };
  attempts: FluencyAttempt[];    // append-only log, capped at last 200
  personalBest: { wcpm: number; ts: number } | null;
};

type FluencyAttempt = {
  word: string;
  presentedAt: number;
  respondedAt: number;
  latencyMs: number;
  recognized: string | null;
  correct: boolean;
  withinAcquisitionGate: boolean;  // latencyMs ≤ read_latency_ms
  withinAutomaticity: boolean;     // latencyMs ≤ automaticity_target_latency_ms
  asrConfidence: number | null;
  drillId: string;
};
```

### Per-student aggregate

```ts
type FluencyAggregate = {
  overallPersonalBest: { wcpm: number; ts: number; drillId: string } | null;
  rollingDailyWcpm: number[];   // last 14 days, one number per day
  totalDrillsCompleted: number;
  totalWordsRead: number;
  lastDrillAt: number | null;
};
```

---

## Drill format

### Length

**60 seconds.** Hard cap. The drill ends at the buzzer regardless of items remaining. This is the standard ORF window, replicates research-validated WCPM measurement, and produces scores comparable to DIBELS/AIMSweb timing.

### Daily quota

Default: **3 drills/day = ~5 minutes of fluency work**. The session orchestrator (Student Modeling, #6) decides how to distribute these across the daily session.

### Item composition per drill

A 60-second drill targets 40–60 word presentations. Item composition follows the **70/30 interleaving rule**:

- **70% from a focal node.** The node currently most due for automaticity work — picked by the scheduler (algorithm below).
- **30% interleaved review** from prereqs of the focal node and other in-zone nodes. This is the FIRe-style trickle-down: fluent reading of a digraph word implicitly reviews the consonant blend it contains.

Specifically, given a focal node `F`:

```
items = []
for i in 0..target_item_count:
  if i mod 10 < 7:
    items.push(pickWord(F))                    // 70% focal
  else:
    pool = prereqs(F) + sibling_in_zone_nodes  // 30% interleaved
    items.push(pickWord(weighted_random(pool, by=staleness)))
```

`staleness` for a node = `now - lastSampledAt`. Older samples win. This produces natural rotation through the student's full active automaticity zone over a few days.

### Item presentation

Each item:

```
1. Word renders on screen (large, readable typography — exactly the same display as Drill view).
2. T0 = "presentedAt" timestamp (ms).
3. ASR begins listening (Web Speech API today; Azure Pronunciation Assessment later).
4. Student reads aloud.
5. ASR returns; T1 = "respondedAt".
6. latencyMs = T1 - T0.
7. Correctness via matchWord (current implementation in src/App.jsx).
8. Within-target = latencyMs ≤ node.automaticity_target_latency_ms.
9. Visual feedback flashes (≤300ms):
     - correct + within target  → green check, fast advance (~100ms transition)
     - correct + slow            → yellow check, normal advance (~250ms)
     - incorrect                 → red X, brief modeling of correct word, advance (~700ms)
10. Next word presented, drill timer continues.
```

The drill never blocks for student input. If the student doesn't speak within `node.read_latency_ms × 1.5` (the timeout), the item is logged as incorrect and the drill advances. This is the "harsh" rule from operating principle 8 — silence is not credit.

### Drill end

At T=60s the drill stops. The result screen shows:

```
        47 WCPM
        ─────────
        Personal best: 41 → 47 (new!)
        
        Words: 50 attempted · 47 correct · 38 automatic
        
        [ Continue ]
```

Note: **no detailed per-word breakdown is shown to the student.** That data is captured in telemetry but surfaced only in the parent/teacher dashboard. Operating principle 6.

---

## Scoring

### Per-item scoring (deterministic)

```python
def score_item(item, node):
    correct = matchWord(node.expected, item.recognized)
    within_target = item.latencyMs <= node.automaticity_target_latency_ms
    
    return {
        "correct": correct,
        "withinAcquisitionGate": item.latencyMs <= node.read_latency_ms,
        "withinAutomaticity": within_target,
        "credit": (
            "automatic" if (correct and within_target) else
            "accurate"  if (correct and not within_target) else
            "miss"
        )
    }
```

### Drill-level scoring

```python
def score_drill(items, drill_duration_ms):
    correct = sum(1 for i in items if i.correct)
    automatic = sum(1 for i in items if i.correct and i.withinAutomaticity)
    wcpm = correct / (drill_duration_ms / 60000)
    
    return {
        "wordsAttempted": len(items),
        "wordsCorrect": correct,
        "wordsAutomatic": automatic,
        "wcpm": wcpm,
        "automaticityRate": automatic / len(items) if items else 0,
    }
```

### Edge cases (explicit so two evaluators score identically)

- **Self-correction within latency window.** "the cat... I mean cat" — count as correct if the final spoken token matches and latency is to the *first* spoken token. This is the standard ORF rule.
- **False starts < 200ms.** "k-cat" → count latency from the start of "cat", not "k". 200ms is the rough boundary between disfluency and a separate utterance.
- **Repeated word.** "cat cat" → count as one correct item, latency to first token.
- **Substitution that ASR doesn't catch.** "rat" recognized as "cat" — this is a recall failure of ASR, not a student error. Treat as correct (best we can do until per-phoneme scoring lands). Log in telemetry for audit.
- **Mic timeout (no speech detected).** Counts as incorrect, latency = timeout value.
- **Noise / non-speech audio.** Web Speech API returns empty result → counts as incorrect.

---

## The scheduler — picking today's focal node

The scheduler runs once per drill. Inputs: full per-student fluency state. Output: a single focal node ID.

Priority order:

1. **Highest spaced-review urgency.** Any node in `spaced_review_only` whose `nextReviewDue` is in the past — pick the most overdue.
2. **In-zone node closest to retirement.** Among `in_automaticity_zone` nodes, pick the one with the highest `consecutiveOnTarget` count. Finishing a graduation is high-value.
3. **In-zone node with most items in pool but lowest recent practice.** Otherwise, pick the most-stale in-zone node.
4. **Newest acquisition-mastered node.** If no in-zone work exists, pick the most recently acquisition-mastered node and add it to the zone.
5. **Cold-passage warm-up.** If none of the above (rare — only for fresh students), serve a passage from FL_01.

```python
def pick_focal(state, node_defs):
    # 1. Overdue spaced review
    overdue = [n for n in node_defs
               if state[n.id].automaticity.nextReviewDue
               and state[n.id].automaticity.nextReviewDue < now()]
    if overdue:
        return min(overdue, key=lambda n: state[n.id].automaticity.nextReviewDue).id
    
    # 2. Closest to retirement
    in_zone = [n for n in node_defs if state[n.id].automaticity.inZone]
    near_retire = [n for n in in_zone
                   if state[n.id].automaticity.consecutiveOnTarget == 2]
    if near_retire:
        return near_retire[0].id
    
    # 3. Stalest in-zone
    if in_zone:
        return max(in_zone, key=lambda n: staleness(state[n.id])).id
    
    # 4. Newest acquisition-mastered
    candidates = [n for n in node_defs
                  if state[n.id].acquisition.masteredAt
                  and not state[n.id].automaticity.inZone
                  and not state[n.id].automaticity.automaticAt]
    if candidates:
        focal = max(candidates, key=lambda n: state[n.id].acquisition.masteredAt)
        # Move into zone
        state[focal.id].automaticity.inZone = True
        return focal.id
    
    # 5. Fluency gate warm-up
    return "FL_01_cvc_fluency"
```

---

## Retirement and spaced review

After each drill, the engine evaluates retirement for the focal node:

```python
def evaluate_retirement(node_state, drill_score, node_def):
    automaticity_rate = drill_score.wordsAutomatic / drill_score.wordsAttempted
    accuracy_rate    = drill_score.wordsCorrect / drill_score.wordsAttempted
    
    # Did this drill hit the automaticity floor?
    on_target = automaticity_rate >= 0.80 and accuracy_rate >= 0.95
    
    if on_target:
        node_state.automaticity.consecutiveOnTarget += 1
    else:
        node_state.automaticity.consecutiveOnTarget = 0
    
    if node_state.automaticity.consecutiveOnTarget >= 3:
        # Graduate
        node_state.automaticity.inZone = False
        node_state.automaticity.automaticAt = now()
        node_state.automaticity.nextReviewDue = now() + days(1)
        node_state.automaticity.reviewIntervalIdx = 0
```

After graduation, the spaced-review schedule fires: 1d → 3d → 7d → 21d → 90d. Each scheduled review is a single sample item dropped into a future drill. If the student misses it, the node returns to the active zone:

```python
def evaluate_review_sample(node_state, attempt, node_def):
    on_target = attempt.correct and attempt.withinAutomaticity
    
    if on_target:
        # Advance interval
        intervals = [1, 3, 7, 21, 90]
        idx = node_state.automaticity.reviewIntervalIdx
        if idx < len(intervals) - 1:
            node_state.automaticity.reviewIntervalIdx = idx + 1
        node_state.automaticity.nextReviewDue = now() + days(intervals[idx + 1] if idx + 1 < len(intervals) else 90)
    else:
        # Regression — back to active zone
        node_state.automaticity.inZone = True
        node_state.automaticity.consecutiveOnTarget = 0
        node_state.automaticity.automaticAt = None
        node_state.automaticity.nextReviewDue = None
```

---

## Personal best mechanics

Two personal bests tracked: per-node and overall.

- **Per-node personal best.** Highest WCPM achieved on a drill where this node was the focal. Surfaced as "Best on short-A words: 47 WCPM."
- **Overall personal best.** Highest WCPM achieved on any drill, regardless of focal node.

The drill end-screen shows:

- If new overall best: **"Personal best: 41 → 47 (new!)"** with the gold XP-ring pulse from the existing UI.
- If new per-node but not overall best: **"Best on short-A words: 38 → 44"** in smaller text, no animation.
- If neither: **"Today's score: 47 (best 51)"** in muted text.

Personal best resets are **never** triggered automatically. If a student has a clearly anomalous outlier (drill where they read 80 WCPM because they lucked into easy words), that's preserved. Anomaly detection lives in Student Modeling (#6); this engine doesn't second-guess.

---

## Trickle-down credit

When a focal-node attempt is correct + within automaticity:

```python
def emit_trickle_down(node_def, all_node_defs, attempt):
    if not node_def.trickle_down:
        return []
    
    credits = []
    for prereq_id in node_def.prereqs:
        prereq = next(n for n in all_node_defs if n.id == prereq_id)
        if not prereq.trickle_down:
            continue
        # Half credit per prereq edge
        credits.append({
            "nodeId": prereq_id,
            "weight": 0.5,
            "type": "implicit_review_via_fluency"
        })
    return credits
```

These credits don't move accuracy needles directly — they extend `nextReviewDue` for nodes in spaced-review status:

```python
def apply_trickle_down(state, credits):
    for c in credits:
        ns = state[c.nodeId]
        if ns.automaticity.nextReviewDue:
            # Extend by 30% × weight
            extension = (ns.automaticity.nextReviewDue - now()) * 0.3 * c.weight
            ns.automaticity.nextReviewDue += extension
```

This is FIRe-lite. Math Academy's full FIRe model is more sophisticated; this captures the load-bearing pattern.

---

## UI flow

The Reading Facts drill is a separate screen, distinct from the existing `Drill` component. It deserves its own component because the ergonomics are different — no buttons to tap, no "I said it" confirmations, just the mic and the timer and the words.

```
┌──────────────────────────────────────┐
│ Reading Facts · :42                  │
│                                      │
│                                      │
│            cat                       │
│        ████████████░░░               │
│                                      │
│         🎤 Listening                 │
│                                      │
│  Best: 41 WCPM       Today: 38 WCPM  │
└──────────────────────────────────────┘
```

After 60 seconds:

```
┌──────────────────────────────────────┐
│                                      │
│           47 WCPM                    │
│        ─────────────                 │
│        New personal best!            │
│                                      │
│   50 words · 47 correct · 38 auto    │
│                                      │
│         [   Continue →   ]           │
└──────────────────────────────────────┘
```

Component name: `ReadingFactsDrill`. Props: `{ studentId, onComplete }`. State: handled internally; commits aggregate to the storage layer on completion.

---

## Telemetry

Two events per drill (matches the contract in agent #4 spec):

- `fluency.attempt` — one per item, fired in real-time
- `fluency.drill_complete` — one per drill, fired at end

Both events go to:

1. localStorage (immediate, for offline)
2. Supabase `skill_attempts` table (write-through, when online)
3. Per-app `state.fluency` blob in `student_app_accounts.state` (so /api/snapshot and /api/mastery can read aggregates)

The orchestration adapter (`vpa-orchestration-layer/src/services/readingAcademy.js`) reads `today_wcpm` and `today_personal_bests` from `/api/snapshot` so the cross-app dashboard can render fluency progress alongside Math Academy's XP.

---

## Integration with current MVP

Phase 1 (this spec, current MVP):
- Add `ReadingFactsDrill` component
- Add `useReadingFacts()` hook that exposes `{ pickFocal, scoreItem, scoreDrill, evaluateRetirement, applyTrickleDown }`
- Add `fluency` blob to per-student state
- Reuse existing `MicButton` + Web Speech API
- Daily session orchestrator (next phase) gates 3× ReadingFactsDrill alongside the existing Lesson and Review

Phase 2 (after Azure ASR):
- Replace whole-word match with phoneme-aligned latency
- Recalibrate automaticity floors per `automaticity-curves.md` "What changes when ASR upgrades" section
- Add per-phoneme error reports to parent dashboard

Phase 3 (after pilot data):
- Tune the 70/30 interleave ratio based on per-student velocity curves
- Tune the 3-consecutive-on-target retirement criterion against actual retention rates
- Add prosody scoring (gate optional; surface as informational)

---

## What this engine does NOT do

Explicit out-of-scope to prevent scope creep:

- Comprehension. Fluency is a gate to comprehension, not comprehension itself. Reading Facts shows isolated words.
- Sentence-level fluency. Cold-passage gates (FL_01–FL_04) handle connected-text fluency. Different drill, different agent, different file.
- Per-phoneme remediation. Today, an error is "wrong word"; tomorrow with Azure, it's "wrong phoneme." Even then, the *response* to a phoneme error (re-teaching the GPC) is owned by AI Tutor Dialogue (#10), not this engine.
- Adaptive difficulty within a drill. The 60-second drill is fixed; difficulty comes from focal-node selection, not from mid-drill ramping.
- Encouragement copy. No "Nice job!" between items. The drill is silent except for the mic. AI Tutor Dialogue handles tone elsewhere.

---

## Open questions for the next pass

1. **What happens when a student has no acquisition-mastered nodes yet?** Currently the engine warm-ups with FL_01 cold-passage. Is that the right fallback? Probably — early drills should anchor on connected text. Confirm in pilot.
2. **Should there be a "warm-up" item count before the timer starts?** Some research suggests a 3-item lead-in before the WCPM timer reduces start-anxiety variance. Defer to pilot.
3. **How do we surface fluency in the existing Today's Tasks card?** Currently the dashboard shows Lesson + Review cards. Add a third "Reading Facts · 60s" card with its own pill. Mockup deferred to product/AI Tutor Dialogue (#10).
4. **What's the right XP value for a Reading Facts drill?** Currently fluency gates earn 5–8 XP. A daily Reading Facts drill should be similar — propose 5 XP per drill, +5 bonus on new personal best. Final values from Motivation & Behavioral Design (#8).
