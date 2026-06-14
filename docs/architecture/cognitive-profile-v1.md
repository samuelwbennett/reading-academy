# VPA Learning OS — Student Cognitive Profile v1.0

Version 1.0 · 2026-05-08
Owner: **the orchestration layer** (vpa-orchestration-layer.vercel.app)
Contributors: every VPA vertical app (Reading Academy, Math Academy, ESL Academy, …)
Audience: launcher engineers, app engineers, agent designers

---

## What this is

The Student Cognitive Profile is the **unified longitudinal model** of a learner. It lives in the orchestration layer, not in any individual vertical app. Each vertical contributes evidence about the dimensions it can measure; the orchestration layer merges the contributions, maintains confidence intervals, and exposes the unified profile to dashboards, intervention systems, and other apps.

This is the data structure that makes "Plaid for learning systems" coherent. Every app feeds it. No app owns it. The teacher dashboard, AI recommender, parent recap, and cross-app daily plan all read from it.

**Hard rule.** Reading Academy does NOT own this model. Reading Academy emits *contributions*. The orchestration layer integrates them. If a future vertical disagrees with Reading Academy's reading-fluency estimate, the orchestration layer arbitrates — neither app does. This is what protects the system from per-vertical drift and keeps the cognitive profile portable.

---

## The 8 universal dimensions

Each dimension is a number in [0, 1] with a confidence interval. Together they form a stable cognitive fingerprint that survives across grades, subjects, and even apps.

### 1. Automaticity
**What it measures.** How fast skills move from "knows it" to "knows it without thinking." A learner with high automaticity decodes / computes / recalls within a target latency without conscious effort.
**How to read it.** 0 = every response is laborious. 1 = nearly all attempts on mastered material are sub-target-latency.
**How it evolves.** Climbs slowly, can decay with disuse, plateaus per individual.

### 2. Working pace
**What it measures.** The learner's natural productive rate per session. Not speed under pressure — sustainable working speed.
**How to read it.** 0 = needs many breaks, fatigues fast. 1 = sustains a long, focused session at high item rate.
**How it evolves.** Stable trait with developmental drift. Bigger swings indicate fatigue, illness, or environment.

### 3. Persistence
**What it measures.** Tolerance for difficulty. How long the learner stays engaged when items get hard.
**How to read it.** 0 = exits a session at first failure. 1 = pushes through extended difficulty without disengaging.
**How it evolves.** Trait with growth potential. Spaced wins increase it; repeated frustration decreases it.

### 4. Forgetting slope
**What it measures.** How fast the learner's mastered skills decay without practice. The exponent of their personal forgetting curve.
**How to read it.** 0 = remembers nearly everything indefinitely. 1 = decays sharply within days. Most learners fall in 0.3–0.6.
**How it evolves.** Mostly stable per individual. Improves with sleep, regular practice, structured retrieval.

### 5. Decoding efficiency
**What it measures.** Reading-specific: how efficiently the learner converts orthography to phonology. Composite of letter-sound automaticity, blending fluency, and orthographic mapping.
**How to read it.** 0 = sub-grade decoding. 1 = above-grade decoding accuracy + speed.
**How it evolves.** Strong climb in K–2, plateaus by grade 4 unless intervention is needed. **Reading Academy is the primary contributor.**

### 6. Math fluency
**What it measures.** Math-specific: how efficiently the learner retrieves arithmetic facts and applies operational procedures.
**How to read it.** 0 = sub-grade fluency. 1 = above-grade.
**How it evolves.** Strong climb K–3 for facts; procedural fluency follows curriculum. **Math Academy / Math Facts are the primary contributors.**

### 7. Intervention responsiveness
**What it measures.** How quickly a learner shifts after a targeted intervention. Critical for response-to-intervention (RTI) models — distinguishes "needs more practice" from "needs different instruction."
**How to read it.** 0 = same intervention pattern, no movement. 1 = clear performance jump after intervention.
**How it evolves.** Trait-like but malleable. Low responsiveness flags learners for diagnostic referral.

### 8. Mastery velocity
**What it measures.** Average time-to-mastery across new skills. The composite signal that aggregates the others.
**How to read it.** 0 = slow acquisition across the board. 1 = fast acquisition across the board.
**How it evolves.** Composite metric — reflects everything else. Useful for top-line "is this learner growing?" answers.

---

## Wire shape

```jsonc
{
  "studentId": "uuid",
  "schemaVersion": "cognitive-profile/v1",
  "updatedAt": "2026-05-08T14:22:31Z",
  "dimensions": {
    "automaticity":             { "value": 0.62, "confidence": 0.71, "samples": 184 },
    "workingPace":              { "value": 0.55, "confidence": 0.40, "samples":  42 },
    "persistence":              { "value": 0.68, "confidence": 0.58, "samples":  31 },
    "forgettingSlope":          { "value": 0.42, "confidence": 0.33, "samples":  17 },
    "decodingEfficiency":       { "value": 0.71, "confidence": 0.82, "samples": 240 },
    "mathFluency":              { "value": null, "confidence": 0.0,  "samples":   0 },
    "interventionResponsiveness":{ "value": 0.50, "confidence": 0.20, "samples":   4 },
    "masteryVelocity":          { "value": 0.64, "confidence": 0.65, "samples": 277 }
  },
  "contributors": {
    "reading_academy": {
      "lastContributedAt": "2026-05-08T14:22:31Z",
      "dimensionsContributed": [
        "automaticity",
        "decodingEfficiency",
        "forgettingSlope",
        "persistence",
        "workingPace",
        "interventionResponsiveness",
        "masteryVelocity"
      ]
    },
    "math_academy": {
      "lastContributedAt": null,
      "dimensionsContributed": []
    }
  }
}
```

`value` is in [0, 1] or `null` (no evidence yet). `confidence` is in [0, 1] — how much weight downstream consumers should put on `value`. `samples` is the underlying evidence count, used by the orchestration layer's confidence math.

---

## Contributor protocol

Every vertical app exposes one endpoint:

```
GET /api/cognitive-contribution?student=<uuid>
```

It returns its slice of evidence for the universal dimensions:

```jsonc
{
  "studentId": "uuid",
  "appId": "reading_academy",
  "schemaVersion": "cognitive-profile/v1",
  "computedAt": "2026-05-08T14:22:31Z",
  "contributions": [
    {
      "dimension": "automaticity",
      "value": 0.62,
      "confidence": 0.71,
      "samples": 184,
      "evidence": {
        "method": "fsrs_stability_aggregate",
        "details": "Mean stability across 38 nodes weighted by attempts."
      }
    },
    {
      "dimension": "decodingEfficiency",
      "value": 0.71,
      "confidence": 0.82,
      "samples": 240,
      "evidence": {
        "method": "cvc_blend_accuracy_x_latency",
        "details": "FL_01 + FL_02 cold-read WCPM vs grade-norm baseline."
      }
    }
  ]
}
```

Rules every contributor MUST follow:

1. **Dimensions are universal.** Apps do not invent new dimensions. They contribute to the 8 above. If an app needs to express something else, it goes in the per-app `evidence.details` field.
2. **Confidence is honest.** Don't return `confidence: 1.0` because the math is correct — confidence reflects the *evidence base*. 5 attempts ≠ 500. The orchestration layer's merger will discount low-confidence signals automatically.
3. **`null` is a legitimate value.** If the app has no evidence for a dimension (e.g. Reading Academy on math fluency), omit it from the array. Don't synthesize a 0.5.
4. **Stateless.** No session, no JWT — the orchestration layer calls server-side with a service-role key and trusts the response. CORS is open.
5. **Idempotent.** Calling twice in 1 second returns the same answer. The orchestration layer may cache.
6. **Schema-versioned.** Response includes `schemaVersion`. The launcher can fall back to older versions if needed.

---

## Orchestration-layer merger

When the launcher receives contributions from N apps, it merges each dimension by **confidence-weighted average**:

```
merged.value = Σ(contribution.value * contribution.confidence) / Σ(contribution.confidence)
merged.confidence = clip(Σ(contribution.confidence) / N_apps, 0, 1)
merged.samples = Σ(contribution.samples)
```

Edge cases:
- If only one app contributes a dimension, the merged value = that app's value, with confidence preserved.
- If a contribution arrives with `confidence < 0.05`, it's dropped (noise).
- If two apps' values for the same dimension differ by > 0.4 *and* both have high confidence, the launcher emits a `cognitive_disagreement` event for human review and falls back to whichever app has more samples.

The merged result is persisted in `student_cognitive_profiles` (see schema migration M10-H). Each contribution write is also logged in `cognitive_contributions_log` so the merger is auditable and replayable.

---

## Update cadence

- **On-demand.** The launcher polls `/api/cognitive-contribution` for each app when it needs a fresh profile (e.g. when the teacher opens a dashboard, or when the student finishes a session).
- **Scheduled.** A nightly Vercel cron call updates every active student's profile so the morning dashboard isn't cold.
- **Event-driven.** When an app emits a `mastery_awarded` or `mastery_revoked` telemetry event for a student, the orchestration layer can opportunistically refetch.

The profile is **eventually consistent**. There is no real-time guarantee. Within a session, expect 1–2 minute staleness.

---

## Reading Academy's specific contributions

Reading Academy contributes to seven of the eight dimensions:

| Dimension | Method | Notes |
|---|---|---|
| automaticity | FSRS stability aggregate weighted by attempts | High signal once a node has > 5 reviews |
| workingPace | items / minute averaged across last 5 sessions | Low confidence early; needs ≥ 3 sessions |
| persistence | session-length distribution + lapse-rate | Drops when sessions end after first wrong answer |
| forgettingSlope | FSRS w[9] proxy + per-node lapse rate | Stable signal once student has > 30 attempts |
| decodingEfficiency | CVC + blend accuracy × latency, normalized to grade | Reading Academy's strongest signal |
| mathFluency | (none — Reading Academy emits no contribution) | |
| interventionResponsiveness | Mastery transition delta after a triggered intervention | Needs intervention events; low confidence pre-pilot |
| masteryVelocity | new-mastery-events per active session, smoothed | Composite, requires ≥ 10 sessions for stability |

Pure-functional code that derives these lives in `src/lib/cognitive/contribution.ts` (M10-I). The endpoint `/api/cognitive-contribution.js` (M10-J) wraps it.

---

## What this enables

- **Teacher dashboard** that says "Sofia: low intervention responsiveness across reading + math — flag for diagnostic referral."
- **Cross-app daily plan** that says "Mateo's working pace is high today + persistence is high — give him three apps in sequence, not one."
- **Parent recap** that says "Ava's decoding efficiency moved from 0.58 to 0.71 in two months."
- **Adaptive curriculum** that says "decoding efficiency stalled at 0.6 — branch to a more concrete intervention sequence."
- **Research pipeline** that says "we now have 5,000 students × 8 dimensions × time series — this is a real dataset."

The unified profile is what makes the system a learning OS instead of a curriculum library. Everything else compounds on top of it.

---

## Versioning + change rules

- Adding a new dimension is a major version bump (v1 → v2). All apps must update their contributors before the launcher reads the new dimension.
- Adding new fields to existing dimensions (e.g., `evidence.method` taxonomy) is non-breaking.
- Removing or renaming a dimension is a major version bump and requires a migration runbook.
- Confidence math (the merger) is part of the spec; changing it is a minor version bump and requires re-merging all stored profiles.

---

## Change log

- v1.0 (2026-05-08): Initial spec. 8 dimensions, contributor protocol, merger math.
