# The Math Academy Way → Reading Academy

A working distillation of Math Academy's published design (Justin Skycak's *The Math Academy Way*, his blog at justinmath.com, and the public mathacademy.com pages) translated into product decisions for Reading Academy.

Primary source: *The Math Academy Way* PDF (free, working draft updated 2025–2026): https://www.justinmath.com/files/the-math-academy-way.pdf

> Note: I could not fetch the PDF directly from this environment. Numbers and quotes below come from public Math Academy pages, Skycak's blog, and reviews. Treat them as directional, not exact. Read the book yourself for ground truth.

---

## 1. Knowledge graph is the spine, not a feature

**What Math Academy does.** Every skill is a node in a prerequisite DAG. A topic only unlocks when *all* of its prereqs are mastered. The whole product — placement, lesson selection, review scheduling — operates on this graph. They explicitly call it the "knowledge frontier": the boundary between what the student knows and doesn't.

**What we already do.** Our 5-node chain (PA → CVC_a → CVC_i → DG_sh → FL) is exactly this, in miniature. `cascadeUnlock()` walks the graph after each mastery event.

**What we should add.** Expand to the 54-node K–2 graph (per the prior design doc). Tag every assessment item, every passage, and every dictation prompt with the *minimal node set* required to answer it. The recommender becomes one set-difference operation: `passage.required_nodes ⊆ student.mastered_nodes ∪ {active_node}`.

---

## 2. Diagnostic placement is non-negotiable

**What Math Academy does.** A 30–45 minute adaptive diagnostic on first login. It probes the graph to find the knowledge frontier, identifies skills the student already has from lower courses, and identifies gaps in foundational knowledge. Output: a starting placement on the graph plus an estimated completion date at various daily XP targets.

**What we just built.** A sequential forward-walk diagnostic. 3 items per node, pass = 3/3, fail stops the walk and that node becomes active. For 5 nodes it's ~15 items / 3 minutes; for 54 nodes it'd be ~150 items at worst, more like ~30 with smarter starting-point selection.

**What we should add next.**
- **Adaptive starting point.** Don't start at node 0 — ask one prior question ("Has the student read CVC words like 'cat' before?") or start at the chain midpoint and walk both directions.
- **Probe node skipping.** If a student aces `DG_sh`, mark all CVC nodes mastered without testing them — the graph guarantees it.
- **Estimated path output.** After diagnostic, show "you're at node 3 of 54, ~28 nodes between you and end-of-G2 fluency, ~6 weeks at 15 min/day" — this is the Math Academy "estimated completion date" hook.

---

## 3. Mastery is a gate, not a metric

**What Math Academy does.** A topic is "mastered" only when the student has demonstrated *both* accuracy and automaticity (speed). Speed matters because slow correct answers indicate working memory is fully spent on the skill itself — there's none left for anything downstream. Mastery unlocks the next portion of the graph; nothing else does.

**What we already do.** Per node: ≥90% accuracy + median latency ≤2500ms over a rolling window of 10 attempts. Both must clear, or the node stays "practicing."

**What we should refine.** Per-node thresholds, not global. Phoneme tasks tolerate higher latency than letter-sound retrieval. Fluency nodes use WCPM, not per-item latency. Our `node.mastery` schema already supports this — we just haven't filled in the variants yet.

---

## 4. Lessons vs. reviews are different task types

**What Math Academy does.** Every daily session mixes four task types:
- **Lessons** — new skill instruction.
- **Reviews** — short retrieval on previously-mastered topics.
- **Multistep** — combines several mastered skills into a richer task.
- **Quizzes** — formal assessment of recent material.

The mix is not random — it's driven by their proprietary FIRe (Fractional Implicit Repetition) scheduler, which exploits the knowledge graph: mastering a downstream skill counts as implicit review of its prereqs ("trickle-down repetitions"), so explicit reviews of prereqs can be scheduled less often.

**What we should add.** Today our drill is one type ("attempt an item on the active node"). The right next step:
- **Lesson** (new node): 6–10 items, all on the active node, ASR/bubble-scored.
- **Review** (mastered nodes): 2–4 items pulled from a spaced-review queue.
- **Cumulative read** (decodable passage): one cold passage tagged with the student's mastered GPC inventory.
- **Reading Facts drill** (fluency): 60-second timed word drill.

Daily session = orchestrator that assembles these into a fixed-format ~17 minute block.

---

## 5. Spaced review with implicit credit

**What Math Academy does.** FIRe schedules review of every mastered topic at expanding intervals. When the student does well on a downstream topic, FIRe "credits" the prereqs without explicit review — meaning the prereqs' next-review interval extends automatically. This is why Math Academy users report the system "knows" what they need to review without ever feeling like an SRS deck.

**What we should add.** Start with vanilla SM-2 / FSRS for our nodes (interval doubles on success, halves on failure, with retention target ~85%). Layer in trickle-down credit: on every successful attempt at node *N*, multiply each prereq's `next_review_due` by some factor (e.g., 1.3) up to a cap. This is two functions in `masteryEngine.js`, not a research project.

---

## 6. XP is the single motivation lever

**What Math Academy does.** Every successful task earns XP. Daily XP goal (default ~30, adjustable) is the only commitment the student is asked to keep. No streaks, no badges, no avatars, no gemstone economy — just XP and a daily target. Reviews around this design report unusually high stickiness.

**What we should add for the pilot.**
- A daily XP target (e.g., 30 XP/day, ~17 min).
- XP per item: lesson item = 1 XP, review item = 0.5 XP, passage = 5 XP, fluency drill = 10 XP. Tunable.
- One number on the dashboard: "20 / 30 today." Not bars, not animations, just the number.
- Defer streaks, badges, avatars to a later phase. They are *not* what Math Academy uses, and the published evidence suggests they don't move the needle once a working knowledge graph + daily target are in place.

---

## 7. Student agency inside a constrained menu

**What Math Academy does.** The student doesn't get one task — they get a small *menu* of tasks. Each is on-graph, each earns XP, each is a valid next step. The student picks. This is a small but meaningful design choice: feels less like a forced march, gives a sense of control, but the menu is curated so no choice is wasted.

**What we should add.** When the daily session starts, show the student a 3-item menu: "warm-up review," "today's new skill," "Reading Facts drill" — let them pick the order. All three must be done to hit the XP goal.

---

## 8. The product is the curriculum

**What Math Academy does.** The course is not "AI-generated lessons over a static textbook." It's a hand-built curriculum where every lesson, every problem set, every assessment item is authored by Math Academy staff. The AI is the scheduler and recommender, not the content engine.

**What we should mirror.** Our skill graph, item bank, decodable passages, and dictation prompts should be hand-authored and tagged. No GPT-generated practice items in the pilot. The credibility of the gain numbers depends on this.

---

## What to do next, in order

1. **Run the pilot diagnostic at 5 nodes** (we just shipped this) — confirm the flow feels right with a real K–2 child.
2. **Expand to the 54-node K–2 graph** — the design doc already exists in your session JSON.
3. **Author the item bank** — 20+ items per node, ASR-ready (we'll wire ASR after item authoring).
4. **Write the daily session orchestrator** — lesson + 2 reviews + passage + fluency drill, fixed 17-min block.
5. **Add XP tracking** — single number on the dashboard, daily target.
6. **Add FIRe-lite scheduler** — SM-2 base + trickle-down credit on prereqs.
7. **Wire ASR** — Whisper or Azure Speech for word-level scoring + latency on read-aloud tasks. This is what unlocks self-driven phonics practice without an adult in the loop.
8. **Author the decodable passage library** — 80–150 passages, each tagged with its full GPC inventory.

Steps 1–6 are weeks of work for a small team. Steps 7–8 are months. Math Academy itself took ~10 years of curriculum work to reach the product it is now — we don't need to match that depth for the pilot, but we *do* need to internalize that the curriculum is the product, not the wrapper.

---

## What I am not claiming

- I have not read the full PDF in this session (network restriction). Numbers like the 30–45 min diagnostic and the 85–90% FSRS retention target come from public mathacademy.com pages and Skycak's blog. Verify against the book before quoting them publicly.
- "FIRe" is Math Academy's proprietary algorithm; I'm describing the published *behavior*, not their source code.
- Anything that looks like a Math Academy implementation detail in our codebase is reverse-engineered from public material, not from any API or internal documentation.
