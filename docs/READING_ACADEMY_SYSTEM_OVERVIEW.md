# Reading Academy — System Overview

Version 2.0 · 2026-05-08
Audience: investors, technical advisors, partners, future engineers

---

## 1. What Reading Academy Is

Reading Academy is a **mastery-based literacy operating system** for K–2 readers. It is not a worksheet app, not a video library, and not a leveled-reader catalogue. It is a learning engine that decides what each child should practice next, measures whether they actually learned it, and routes them through structured progressions until decoding and fluency are automatic.

The system is built on twelve foundational components:

1. **Mastery-based K–2 literacy engine** — every interaction maps to a skill node and updates that skill's mastery state.
2. **Skill graph with prerequisite progression** — a directed acyclic graph of 55 K–2 decoding nodes (PA → letter–sound → CVC → blends → digraphs → silent-e → vowel teams → r-controlled → multisyllabic → grade-2 fluency). Nothing unlocks until prerequisites are mastered.
3. **Assessment item banks** — ~1,079 hand-authored items spanning 11 item types (phoneme isolation, blend, segment, deletion, substitution, letter-sound, read-aloud, cold passage, etc.).
4. **Decodable fluency passages** — 24 cold-read passages across four fluency gates (FL_01–FL_04), each constrained to the inventory unlocked at that gate.
5. **Telemetry pipeline** — 13 canonical event types with a versioned envelope, runtime validation, a localStorage queue, and an authenticated flush worker that writes to Supabase.
6. **Student-state model** — a versioned, persisted record of every learner's per-node mastery, per-gate fluency, and global session/XP/streak history. Backfilled automatically from the legacy state shape so existing learners don't lose progress.
7. **Mastery engine** — deterministic, rule-based scoring that combines accuracy, latency, and cold-read evidence to drive an 8-state mastery state machine.
8. **Spaced-review scheduler** — Leitner-style review cadence with fragility-aware interval shrinking and forgetting-risk-driven queue ordering.
9. **Daily session orchestrator** — picks today's reviews, active lesson, fluency drill, and cold-read in priority order. Wired to the dashboard's primary CTA.
10. **Intervention insights engine** — rule-based observations across the StudentModel: stalled skills, latency drift, cold-read regressions, forgetting clusters, ready-to-advance flags, and diagnostic gaps. Severity-tiered.
11. **Auth + cross-device sync** — Supabase Auth (magic-link), per-student state cached in `student_app_accounts.state.modelV2`, append-only events in `reading_skill_attempts` / `reading_passage_attempts` / `reading_mastery_snapshots` / `reading_telemetry_events`. RLS-enforced self-only by default.
12. **Validator-enforced content quality** — a CI-grade content validator that blocks deploys on broken graph references, undersized item banks, predictable-pattern passages, duplicate IDs, telemetry/code drift, and gate-cold-pool minimums.

These components are the substrate. The product surface (drills, passages, course tree, XP ring, teacher dashboard) is rendered on top of them.

---

## 2. What Has Been Built So Far

### M1 — Vertical slice

A working learner experience for the smallest end-to-end loop: diagnostic placement → daily session → drill with self-scoring + ASR → reading-facts fluency drill → cold-read passage with WCPM scoring. Includes an integrated XP ring, course tree, and progress view. Deployed and runnable; the launcher hosts Reading Academy as a `/reading/*` subroute of the broader VPA Learning OS shell.

### M2 — Content layer

The full K–2 decoding curriculum was authored, validated, and committed. 50 nodes with assessment item banks, ~1,079 items across 11 item types, 24 cold-read passages across 4 fluency gates, plus a bank-min-overrides schema for curriculum-bound floors and a passage validator that enforces decodability against `gpcInventory`.

### M3 — Telemetry + student-model infrastructure

The intelligence layer below the UI. Canonical 13-event taxonomy (`docs/telemetry/events.md`), sync-safe emitter, runtime validator, localStorage queue, session-rolling on 30-min idle, persistent clientId UUID. Versioned `StudentModel` with per-node history, per-gate fluency history, global state. Deterministic mastery engine with 8-state machine, hinted-attempt half-weighting, latency-penalized accuracy, regression on sustained dip. Leitner-style review scheduler (1, 2, 4, 8, 16, 30, 60, 120 day ladder) with fragility multiplier and forgetting-risk-sorted queue.

### M4 — Pilot-readiness wiring

UI ↔ telemetry shim wired so every existing call site emits canonical events. Mastery-state persistence bridge that auto-mirrors UI attempts into the StudentModel. Daily session orchestrator. Teacher / engineering debug dashboard at `/reading/debug`. Supabase schema spec. Pilot readiness checklist. Plus four hotfixes: TTS auto-play in Diagnostic, full PA-level drill runtime (not just read_aloud), Reading Facts node fallback for phoneme-level active nodes, Passage availability UX rewrite.

### M5 — Hosted pilot

Magic-link sign-in via Supabase Auth, persistent client/session IDs, anonymous fallback. Database migrations for the four append-only event tables (namespaced `reading_*` to avoid collision in the shared VPA project). Auto-flush worker drains the queue every 30 s + on visibility change + on pagehide. Idempotent via client-generated UUIDs. State sync uploads/downloads `StudentModel` into `student_app_accounts.state.modelV2` next to the legacy blob. Reconciliation on sign-in (latest-write-wins). 8-section setup runbook covering migration apply, env vars, smoke test, RLS validation, rollback, and failure-mode triage.

### M6 — Teacher tooling + intelligence

Today's dashboard now leads with the orchestrator's session plan: reviews, today's lesson, fluency drill, cold passage — each with a Start button that routes to the right surface. Legacy state auto-projects into the M3 model on first load so users with existing progress see their data. Debug dashboard extended with insights section (severity-tiered observations driven by the rule engine), inline fluency-curve SVG charts (cold = filled, practiced = hollow), and CSV export buttons for nodes / fluency / insights. Bundle code-split: Debug, SignIn, and Roster routes lazy-loaded; data files in dedicated chunks; React + Supabase vendored separately.

### M7 — Pilot polish

Roster page at `/reading/roster` (auth-gated, RLS-scoped read of the `students` table with per-student summary). Session feedback copy varies by latency: fast-correct ("Lightning fast!"), normal-correct ("Got it."), incorrect ("Almost — try again."). Cross-device sync verification path documented. Teacher onboarding 1-pager (`docs/pilot/teacher-onboarding.md`) covering day-one setup, weekly cadence, FAQs, and what to flag.

---

## 3. Current System Scale

| Asset | Count |
|---|---|
| K–2 skill nodes (DAG) | 55 |
| Nodes with authored item banks | 50 |
| Assessment items | ~1,079 |
| Item types covered | 11 |
| Fluency passages | 24 |
| Fluency gates (FL_01–FL_04) | 4 |
| Canonical telemetry event types | 13 |
| Mastery state machine states | 8 |
| Review interval ladder | 8 tiers (1 → 120 days) |
| Insight rules | 6 (stalled, latency drift, cold-read regression, forgetting cluster, ready to advance, diagnostic gap) |
| Supabase tables (Reading-namespaced) | 4 append-only event tables + shared schema |
| Auth providers | Supabase magic-link + password + anonymous fallback |
| Validator status | 0 errors · 0 warnings · clean CI gate |
| Strict TypeScript | clean across `src/lib/**/*.ts` |

Codebase: React + Vite single-page app, TypeScript modules for the new infrastructure layer (telemetry / mastery / review / insights / session / dashboard), JavaScript for the existing UI runtime. Deployed at `https://reading-academy.vercel.app`. Multi-tenant Supabase backend shared with Math Academy and the broader VPA Learning OS.

---

## 4. Why This Is Different

Most reading software is **content delivery**: a library of leveled books, a sequence of phonics videos, or a worksheet generator. The unit of value is a piece of content the child consumes.

Reading Academy is a **learning engine**. The unit of value is the inference the system makes about the learner. Every interaction tightens an estimate of what the child knows, how fluently, and how stably.

That difference shows up in eight places:

- **Mastery graph.** Skills aren't tagged onto content as keywords; they are first-class nodes in a prerequisite DAG, and progression through the graph is the primary product loop.
- **Fluency telemetry.** Latency and WCPM are recorded with the same fidelity as accuracy.
- **Automaticity.** The mastery state machine has explicit `mastered_for_acquisition` → `in_automaticity_zone` → `automatic` tiers — children graduate skills by getting them right *fast enough that they no longer compete with comprehension*.
- **Cold-read transfer.** Fluency gates score cold passages separately from practiced ones. Practiced WCPM is motivational; cold WCPM is the gate. Transfer to novel text is the only signal that survives.
- **Forgetting risk + spaced review.** Every mastered node has a continuously-updated forgetting-risk score; the review scheduler decides when each child sees each previously-mastered skill again. Mastery is a maintained state, not a one-time stamp.
- **Daily session orchestration.** The dashboard doesn't surface a generic "next lesson" — it surfaces *the right block* (review, lesson, fluency, cold-read) based on the model's current best estimate of what this child needs today.
- **Intervention insights.** A rule-based engine generates explainable observations ("stalled at silent-e for 8 days," "cold-read regression at FL_02," "ready to advance from CVC short-i") so a teacher knows where to lean in.
- **Multi-tenant by design.** The schema, auth model, and orchestration contract are shared with the broader VPA Learning OS, so the same student row drives Reading Academy, Math Academy, and any future vertical.

The platform is also built for **future orchestration-layer compatibility**: the telemetry envelope, the universal `students` / `student_app_accounts` / `skill_attempts` schema, and the queued-flush ingest contract were designed against the same multi-tenant data model that will power VPA Learning OS as a whole.

---

## 5. Investor Framing

**This is infrastructure, not a worksheet app.** The product surface is small — a course tree, a drill, a passage reader, a teacher dashboard. The infrastructure under it is large: a knowledge graph, a deterministic mastery engine, a forgetting model, a spaced-review scheduler, a session orchestrator, an insights engine, a content validator, a telemetry contract, a versioned student-state schema, and a multi-tenant Supabase backend. The first version of any worksheet app could be reproduced in a weekend; this one cannot.

**The data model becomes more valuable as usage grows.** Every session adds attempts to every learner's per-node history. Every mastery transition is a labeled event. Every cold passage produces a transfer datapoint. Within a year of pilot scale the system has tens of millions of skill-attempt rows tied to a stable curriculum graph — the kind of dataset that real spacing models (FSRS), real ability estimators (IRT), and real fluency-curve fits can be trained on. None of this is available to traditional content-library competitors because their unit of telemetry is "content viewed," not "skill attempted."

**Telemetry is a proprietary learning-data asset.** The 13-event taxonomy is append-only and versioned. As the product expands, the same event stream covers it. The asset compounds: more learners → more events → better mastery models → better learner outcomes → more learners.

**The system can expand far beyond reading.** Nothing in the mastery engine, the review scheduler, the insights engine, the telemetry pipeline, or the student-state schema is reading-specific. The skill graph is data, the item banks are data, the fluency targets are data. Swap the curriculum and the same engine drives K–2 math, ESL, music sight-reading, or any other domain where mastery + automaticity + spaced retention is the goal.

**The wedge is K–2 literacy; the platform logic is much larger.** Early literacy is the ideal beachhead: every district buys it, every parent prioritizes it, the science is settled (structured-literacy / Science of Reading), and the outcomes are measurable. The architecture being built here is a **learning operating system**. Reading is the first vertical to land on it.

---

## 6. Near-Term Roadmap

### M8 — Pilot scale-up

- **Roster CRUD.** Replace the SQL-based student-creation step with a teacher-facing admin UI: add students, assign grade level, send sign-in links.
- **Cross-student RLS.** Add `org_id` and `rosters` table; update RLS so teachers see their roster, not just self.
- **Cohort dashboard.** Aggregate views across a class — average mastered, fluency-curve overlays, intervention insight density.
- **PII separation.** Move full names and parent emails into `students_pii`, admin-only.
- **Edge-function ingest.** Front the four event tables with a Supabase Edge Function for batch validation + idempotency at the server. Currently the SPA writes directly via the anon JWT.
- **Bundle perf round 2.** Streaming passage data, prefetch on hover, image-lazy for any future media.

### M9 — Adaptive intelligence

- **Real spacing model.** Replace the Leitner ladder with FSRS or SM-2 calibrated against attempt history.
- **IRT-based item difficulty.** Calibrate item difficulty per node from telemetry; replace fixed "min items" floors with item information curves.
- **AI-assisted insights.** Move beyond rule-based observations toward LLM-summarized weekly recaps for parents and teachers.
- **Adaptive item generation.** When a learner needs more reps at a specific GPC inventory, generate fresh items on the fly within the validated decoding constraints.

### M10 — Vertical expansion

- **Math Academy interop.** Cross-product session planning ("you've worked hard on reading today — try a 5-minute math drill") via the shared orchestration layer.
- **Curriculum-as-data.** Open the skill-graph and item-bank schema so other vertical-specific curricula can be authored and validated against the same pipeline.
- **Per-locale curricula.** Spanish first; reuse the engine, swap the GPC inventory.

After M9, the platform is positioned for FSRS-quality spacing, IRT-based item calibration, LLM-assisted reporting, and cross-domain expansion onto the same learning-OS substrate.

---

*For technical depth, see `docs/build-plan/v1.0.md`, `docs/telemetry/events.md`, `docs/data/supabase-schema-v1.md`, the agent specs under `docs/agents/`, and the M3–M7 source under `src/lib/`.*
