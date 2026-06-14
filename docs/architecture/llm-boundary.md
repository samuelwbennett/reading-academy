# LLM Boundary — Architecture Rule

Version 1.0 · 2026-05-08
Owner: Agent #7 — Chief Integration
Status: **load-bearing**. This rule overrides product, design, or "just this once" arguments.

---

## The rule

> **No LLM call may be load-bearing for instruction.**
>
> Every LLM-driven surface must have a deterministic fallback that produces a correct, useful, shippable result. The deterministic version is the contract. The LLM version is the upgrade.

If you can't answer "what does the system do when the LLM is unavailable?" with "exactly the right thing, just less polished" — you've crossed the line and you must redesign.

---

## Why this rule exists

In a K–5 mastery system you can't have:

- A child stalled because Anthropic had a 503
- A teacher dashboard that shows different recommendations on Tuesday than Monday because the model was nondeterministic
- A pilot that becomes uninvestigatable because the AI's reasoning isn't reproducible
- A privacy fault where transcripts of children's voices end up in someone else's training set
- A core engine that can't be tested deterministically because its behavior depends on a model release version

Every one of those is a real failure mode that has happened to other education products. The boundary keeps Reading Academy / VPA on the safe side of all of them.

---

## What stays deterministic — always

These layers are **closed to LLM influence** at the engine level. They can be tested, replayed, and audited. They produce the same output on the same inputs forever.

| Layer | Module | Property |
|---|---|---|
| Mastery scoring | `src/lib/mastery/masteryEngine.ts` | Same attempts → same state transition |
| FSRS scheduling | `src/lib/review/fsrs.ts` | Same review history → same `dueAt` |
| Spaced-review queue | `src/lib/review/reviewScheduler.ts` | Same model → same queue order |
| Session orchestration | `src/lib/session/sessionPlanner.ts` | Same model → same plan |
| Insights rule engine | `src/lib/insights/insightsEngine.ts` | Same model → same insight list |
| Cognitive contribution | `src/lib/cognitive/contribution.ts` | Same model → same dimensions |
| Telemetry validation | `src/lib/telemetry/validate.ts` | Same envelope → same verdict |
| Content validator | `scripts/validate-content.js` | Same content → same errors |
| Knowledge graph layout | `src/lib/graph/layout.ts` | Same nodes → same coordinates |

Tests assert this. The TypeScript strict mode + the validator catch drift. If a future change tries to call an LLM from inside any of these — reject the change. There's a comment block at the top of each engine module reminding the reader.

---

## Where LLMs are allowed

LLMs sit at the **surface**, never in the engine. They polish, narrate, suggest. They never decide.

| Surface | Module | Purpose | Fallback |
|---|---|---|---|
| Weekly recap | `api/recap.js` | Parent-friendly narrative summary | Deterministic template paragraph |
| Per-insight recommendation | `api/insight-recommendation.js` | 1–2 sentence teacher tip | Per-rule canned recommendation |
| (Future M11) Action queue narration | TBD | Human-friendly cohort action list | Bulleted rule-engine output |
| (Future M10+) Curriculum expansion | TBD | Propose new skill nodes for grade 3+ | Hand-author |
| (Future M11) Adaptive item generation | TBD | Produce extra items in a constrained inventory | Use the existing 1,079-item bank |

Every LLM-driven endpoint MUST:

1. Accept missing-API-key as a normal condition. Return the deterministic fallback with status 200.
2. Tag every response with an `llmUsed: true | false` flag.
3. Surface that flag visibly in the UI (e.g. a small "AI" / "template" chip next to the result).
4. Never block a deterministic flow. The recap loads after the page, not before.
5. Send the smallest payload that does the job. No raw transcripts, no PII, no per-attempt latencies. Aggregate stats only.
6. Log the prompt + response (server-side) for audit. The orchestration layer keeps a 90-day retention.

---

## Decision rule for new features

When considering whether to add an LLM call, ask in order:

1. **Can a deterministic rule produce the right answer?** If yes, do that first. Add an LLM polish layer only if there's measurable user value above the deterministic baseline.
2. **What happens when the LLM is unavailable?** If the answer is anything other than "the deterministic version runs and the user is fine," redesign.
3. **Is this surface or engine?** If engine — stop. Move it to surface or use a deterministic technique.
4. **What's the privacy footprint?** If the call requires sending child transcripts, full names, or per-attempt timing — stop. Aggregate first.
5. **How will we test this?** If the answer involves snapshots of LLM outputs, the test isn't valid. The deterministic fallback is what gets tested.

If the feature passes all five, it can ship as an LLM-augmented surface.

---

## Privacy boundary

LLM calls send the smallest possible payload. Specifically:

**Allowed:**
- Aggregate counts (attempts, mastered nodes, mean accuracy)
- Skill node *labels* (topic, skill name) — these are curriculum content, not student data
- Insight rule + severity + headline + detail (already abstracted from raw signals)
- WCPM aggregates (not per-passage transcripts)

**Forbidden:**
- Student name, email, parent email
- Audio transcripts
- Per-attempt latencies (only aggregates)
- Photos, mic recordings, IP address, device identifiers
- Any unique identifier other than the random `student_id` UUID (and even that is opaque to the LLM)

This is consistent with FERPA's "directory information" treatment for the data we do send. Anthropic's [usage policies](https://www.anthropic.com/legal/usage-policy) and our DPA terms cover the rest.

If a future feature wants to expand this list, it requires an explicit DPA review *before* the prompt design.

---

## Vendor independence

The system must be able to switch LLM vendors without rewriting product surfaces. Concretely:

- The two existing endpoints (`api/recap.js`, `api/insight-recommendation.js`) call Anthropic via `fetch` directly, with the prompt + max_tokens + model name in plain code.
- They do not depend on Anthropic-specific SDKs.
- The fallback path makes them shippable even if Anthropic is unreachable.
- Migration to OpenAI / Google / on-prem Llama / etc. is a one-day change if needed.

Lock-in is itself a form of load-bearing. We avoid it.

---

## Reproducibility

Telemetry + the deterministic engines together give us full reproducibility. Given any student's `skill_attempts` history we can:

- Replay the mastery engine and get the same state
- Replay the FSRS scheduler and get the same review queue
- Re-run the insights engine and get the same observations
- Recompute the cognitive contribution and get the same numbers

LLM-narrated views won't replay byte-identically (model versions drift), but the *underlying signal* will. That's the contract.

---

## What this rule protects

- **Pilot integrity** — a teacher can rerun a child's session in the dashboard and see consistent inferences.
- **Research validity** — the mastery + spacing + insight signals are reproducible across deploys.
- **Investor trust** — "the engine is deterministic; the AI is sweetener" is a credible claim under scrutiny.
- **Regulatory posture** — FERPA / state DPA reviews see a small, well-bounded LLM surface, not a black-box recommender.
- **Future-proofing** — LLM costs/policies/vendors will change. The engine will not.

---

## When this rule is wrong

It's not. But the next failure mode to watch for is **deterministic creep**: rules accumulating to the point that the engine becomes inscrutable in its own right. If the insights rule engine grows past ~12 rules, or the session planner has more than ~6 conditional branches, that's a signal to refactor — not to invoke an LLM.

The fix for too many rules is a smaller rule set, not a smarter model.

---

## Change log

- v1.0 (2026-05-08): Initial rule. Two LLM surfaces in place (recap, insight recommendations), both with deterministic fallbacks.
