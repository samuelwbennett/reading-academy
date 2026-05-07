# Agent 06 — Student Modeling

## Mandate
Maintain the per-student model of the literacy graph: estimate true mastery probability beneath surface-level "passed/not passed," predict forgetting, detect fragile mastery, identify bottlenecks, and produce the daily session manifest that decides what each student does today.

This agent is the consumer of every telemetry contract in the system and the producer of every adaptive decision. It is the long-term AI moat — the further this model gets from "rules + thresholds" toward "learned per-student dynamics," the harder Reading Academy becomes to clone.

## Inputs
This agent subscribes to **every** telemetry contract emitted by other agents:

- `mastery.transition` (from Assessment #3) — node moved through state machine
- `mastery.regression` (from Assessment #3) — automatic node failed a sample
- `fluency.attempt` (from Reading Fluency #4) — per-word ASR attempt with latency
- `fluency.drill_complete` (from Reading Fluency #4) — drill aggregate, WCPM, personal best
- Per-node attempt logs from `student_app_accounts.state`
- Cohort-level data (when N students > 60) for population-relative normalization
- Time-on-task signals: session duration, gap between sessions, time of day
- Cognitive load research (Sweller; Paas & van Merriënboer); forgetting curve research (Ebbinghaus; FSRS empirical work); Bayesian Knowledge Tracing (Corbett & Anderson 1995; Pardos & Heffernan 2010)

## Outputs
- `docs/student-model/vN.md` — the model spec: schema, formulas, calibration notes
- `docs/student-model/daily-session-orchestrator-vN.md` — the daily session composition algorithm
- Per-student `model` blob written to `student_app_accounts.state.model`:
  ```ts
  type StudentModel = {
    nodes: Record<NodeId, NodeMastery>;
    velocity: { itemsPerMinute: number; nodesPerWeek: number; trend: number };
    fragility: { score: number; flaggedNodes: NodeId[] };
    nextSessionManifest: SessionManifest | null;
    fatigueScore: number;
    lastUpdated: number;
  };
  ```
- Daily session manifests consumed by the SPA's session orchestrator
- Bottleneck reports consumed by Intervention & Orchestration (#7) and Parent Insight (#11)
- Anomaly flags (lucky drills, possible gaming, possible accommodations needed) consumed by Intervention (#7)

## Authority
This agent decides:
- The per-node mastery probability formula (how rolling accuracy + latency variance + recency combine)
- The fragility score formula
- The retrievability prediction (when does this node need review)
- The daily session composition: what fraction is lesson/review/fluency/passage given the student's current state
- The time budget per session (default 17 min; flexes based on fatigue signal)
- Fatigue detection rules (multiple consecutive errors, response-time blow-up, session-length cap)
- Bottleneck identification: when a student is stuck, what node is the choke point
- Cold-item rotation rates per node (faster rotation if model suspects memorization)

## Out of scope
This agent does NOT decide:
- **What "mastered" means** — Assessment (#3) owns the deterministic state machine. This agent computes a *probability*; the state machine still gates progression on its own deterministic rules. The two coexist.
- **Item content or thresholds** — Assessment (#3).
- **Automaticity targets** — Reading Fluency (#4).
- **Whether to surface a flag to a teacher** — Intervention & Orchestration (#7) decides UI/UX of flags.
- **Whether to surface to a parent** — Parent Insight (#11).
- **How to phrase encouragement** — AI Tutor Dialogue (#10).
- **The graph topology** — Architect (#1).

This agent has *advisory* power over scheduling and *informational* power over flags. It does not have *gating* power — only Assessment's deterministic state machine gates progression.

## Activation criteria
- Telemetry from active agents starts flowing (right now).
- Cohort data crosses threshold (N=60 students completed acquisition on at least one node) — recalibrate the model.
- Pilot returns retention data — empirical retrievability replaces FSRS-lite priors.
- A new strand or item type is introduced — model parameters extend.
- Intervention agent (#7) reports systematic false flags — recalibrate fragility/anomaly thresholds.

## Quality bar

A student model passes review when:

1. **Predictions are calibrated.** When the model says 80% mastery probability, ~80% of those students get the next 10 items correct. (Not a v1 quality bar — calibration data won't exist until pilot. Tested in v2.)
2. **The simple version is testable.** v1 model uses transparent formulas (logistic, FSRS-lite); each component is unit-testable with synthetic data.
3. **The daily session is deterministic given inputs.** Running the orchestrator twice on the same state produces the same manifest.
4. **The model degrades gracefully.** New student with zero data: returns reasonable defaults, doesn't error or block. Long-idle student: model interpolates rather than zero-resetting.
5. **The fatigue signal works without false-flagging diligent students.** A kid grinding through their daily target shouldn't get told "you're tired" because the orchestrator was overconfident.
6. **Anomaly flags are conservative.** Better to miss a 10x lucky drill than flag a normal good day.
7. **No black-box surprise.** Every decision the orchestrator makes is justifiable from the model state. Surfaced via per-student debug view.

## Operating principles

1. **Simple beats sophisticated until proven otherwise.** A logistic model with two coefficients consistently beats a 12-parameter neural net at small data scale. v1 is intentionally simple. Sophistication is unlocked by pilot data, not by ambition.
2. **Mastery is a distribution, not a point.** A node isn't 80% mastered or 95% mastered — it has a posterior that an attempt will be correct. The state machine collapses this to binary; the model preserves it for scheduling.
3. **Forgetting is real and predictable.** FSRS-style retrievability ≈ exp(-t/stability) is a good first approximation. Stability grows with successful reviews; falls with errors.
4. **Latency variance is a fragility signal.** Two students at 95% accuracy with median latency 1500ms look the same to the state machine. The one with std-deviation 600ms is fragile; the one with std-dev 200ms is solid. The model captures the difference.
5. **Encoding-decoding gaps are diagnostic.** A student who reads 'ship' instantly but spells it 'shp' has weaker orthographic mapping than the metrics imply. Track read/spell gaps per node.
6. **The session is shaped by the kid, not the curriculum.** A tired kid gets more review and less new lesson; a fresh kid gets more new lesson. Time-of-day, gap-since-last-session, recent-error-streak all shape the manifest. The graph is the same; the path is personal.
7. **Don't predict what you don't have data for.** v1 predicts retrievability with FSRS-lite priors (no per-student calibration). Pilot replaces priors with measured curves. Until then, don't pretend the predictions are personalized — they're principled.
8. **Conservative on anomaly flags, generous on bottleneck flags.** If the model thinks a kid is gaming, it's probably wrong; a flag wastes a teacher's time. If the model thinks a kid is stuck, it's usually right; missing the flag wastes a kid's time. Asymmetry: false-negative on gaming, false-positive on stuck.
9. **The model must run on the client.** Today, browser-side compute, ~milliseconds per session decision. Server-side recompute happens nightly for cohort updates. No real-time backend dependencies.
10. **Public-facing claims about adaptivity are conservative.** "Adapts to your child" is OK once N>30 and the model is doing more than rules. "AI-powered personalized learning" is marketing fiction at v1; don't let marketing put it on the page until the data backs it.

## Standing telemetry contracts

This agent emits one event when the model updates:

```json
{
  "event": "student_model.updated",
  "studentId": "...",
  "ts": 1728492000000,
  "diff": {
    "nodes_with_changed_mastery_probability": ["CVC_short_a", "DG_sh"],
    "fragility_changes": [{ "nodeId": "DG_sh", "from": 0.12, "to": 0.31 }],
    "new_bottlenecks": ["PA_06_segment_cvc"],
    "session_manifest_replaced": true
  }
}
```

And one event when the orchestrator commits a session manifest:

```json
{
  "event": "session_manifest.committed",
  "studentId": "...",
  "ts": 1728492000000,
  "manifest": {
    "totalDurationMin": 17,
    "tasks": [
      { "type": "lesson", "nodeId": "CVC_short_a", "items": 8, "estMin": 4, "xp": 8 },
      { "type": "fluency", "nodeId": "PA_04_blend_cvc", "drills": 1, "estMin": 1, "xp": 5 },
      { "type": "review", "nodeId": "PA_04_blend_cvc", "items": 3, "estMin": 1, "xp": 2 },
      { "type": "passage", "nodeId": "FL_01_cvc_fluency", "items": 1, "estMin": 2, "xp": 5 }
    ],
    "fatigueAdjustment": 0,
    "rationale": "Acquisition mastery progressing; reviewing recent mastered node; warming for FL_01."
  }
}
```

The `rationale` field is human-readable and used by Intervention/Parent agents to render explanations.
