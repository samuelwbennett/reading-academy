# Reading Academy — Telemetry Schema v1.0

Authored: 2026-05-07
Owner: Agent #7 — Chief Integration
Consumer: M3 student-state engine, M4 spaced-review, M5 orchestration layer

This is the canonical event taxonomy for Reading Academy. All client-side
modules emit events through `src/lib/telemetry/emit.ts`. Events are
queued in localStorage (key `reading-academy:telemetry-queue:v1`) and
later flushed to the orchestration layer's `skill_attempts` table.

The contract here is **append-only**. Adding new event types is fine.
Renaming or removing fields is a breaking change and must bump the
schema version.

---

## Envelope

Every event is wrapped in a common envelope before emission:

| field         | type   | required | notes                                                        |
|---------------|--------|----------|--------------------------------------------------------------|
| `event`       | string | yes      | One of the canonical event names below.                      |
| `ts`          | number | yes      | `Date.now()` at emission. Server-side authoritative ts wins. |
| `schema`      | string | yes      | Schema version, currently `"telemetry/v1"`.                  |
| `appId`       | string | yes      | Always `"reading-academy"` from this product.                |
| `studentId`   | string | no       | Anonymous if absent (pre-account dev mode).                  |
| `sessionId`   | string | yes      | Stable per `session_started`/`session_ended` window.         |
| `clientId`    | string | no       | UUID of the device/profile the queue lives on.               |
| `payload`     | object | yes      | Event-specific fields, see below.                            |

Timestamps are milliseconds since Unix epoch. Latency fields are durations
in milliseconds. Accuracy is a fraction in [0, 1]. WCPM is words-correct
per minute.

---

## Canonical event types

### Session lifecycle

#### `session_started`
A new logical session begins. Emitted on first interaction after app open
or after >30 min idle (rolls a new sessionId).

| field        | type   | required | notes                                  |
|--------------|--------|----------|----------------------------------------|
| `route`      | string | yes      | Initial route (e.g., `/reading/today`).|
| `cold_start` | bool   | yes      | True if app was just launched.         |

#### `session_ended`
Emitted on app close or 30-min idle. May be inferred server-side if
client never sends it (network drop).

| field            | type   | required | notes                            |
|------------------|--------|----------|----------------------------------|
| `duration_ms`    | number | yes      | Wall-clock since session_started.|
| `items_attempted`| number | yes      | Total items in this session.     |
| `xp_earned`      | number | yes      | XP awarded this session.         |

---

### Item lifecycle

Item events fire for every assessment item (drill, diagnostic, fluency
word). One `item_started` is paired with exactly one terminal event:
`item_completed`, `response_correct`, or `response_incorrect`.

#### `item_started`
| field       | type   | required | notes                                |
|-------------|--------|----------|--------------------------------------|
| `nodeId`    | string | yes      | Skill graph node id.                 |
| `itemId`    | string | yes      | Item bank id; auto-generated if N/A. |
| `attempt_n` | number | yes      | 1-indexed attempt number this session.|
| `surface`   | string | yes      | `drill` \| `diagnostic` \| `fluency` \| `passage` \| `review`. |

#### `response_submitted`
Raw response capture. Emitted regardless of correctness; downstream
classifier decides the outcome.

| field         | type    | required | notes                                  |
|---------------|---------|----------|----------------------------------------|
| `nodeId`      | string  | yes      |                                        |
| `itemId`      | string  | yes      |                                        |
| `expected`    | string  | yes      | The expected answer string.            |
| `transcript`  | string  | yes      | What the learner said/typed.           |
| `latency_ms`  | number  | yes      | From `item_started` to response.       |
| `confidence`  | number  | no       | ASR confidence in [0,1].               |
| `scoringSrc`  | string  | yes      | `asr` \| `self` \| `tap` \| `text`.    |

#### `response_correct`
Terminal-success event. Mastery engine treats this as one positive sample
for the node.

| field        | type   | required | notes                                 |
|--------------|--------|----------|---------------------------------------|
| `nodeId`     | string | yes      |                                       |
| `itemId`     | string | yes      |                                       |
| `latency_ms` | number | yes      |                                       |
| `attempt_n`  | number | yes      |                                       |

#### `response_incorrect`
Terminal-failure event. Mastery engine treats this as one negative sample.
Not the same as a hint or skip — those are separate events.

| field        | type   | required | notes                                  |
|--------------|--------|----------|----------------------------------------|
| `nodeId`     | string | yes      |                                        |
| `itemId`     | string | yes      |                                        |
| `latency_ms` | number | yes      |                                        |
| `attempt_n`  | number | yes      |                                        |
| `errorClass` | string | no       | e.g. `phoneme_substitution`, `timeout`.|

#### `hint_used`
Learner asked for or was given a hint mid-item. Hinted items still emit
`response_correct/incorrect` but the mastery engine discounts their
weight.

| field         | type    | required | notes                                  |
|---------------|---------|----------|----------------------------------------|
| `nodeId`      | string  | yes      |                                        |
| `itemId`      | string  | yes      |                                        |
| `hintLevel`   | number  | yes      | 1=phonetic spell, 2=model say.         |

#### `item_completed`
Terminal envelope event. Always fires after the correct/incorrect pair so
that downstream analytics can group "what did the student do on this item"
without joining two events.

| field          | type    | required | notes                                  |
|----------------|---------|----------|----------------------------------------|
| `nodeId`       | string  | yes      |                                        |
| `itemId`       | string  | yes      |                                        |
| `correct`      | bool    | yes      |                                        |
| `latency_ms`   | number  | yes      |                                        |
| `hint_count`   | number  | yes      | 0 if no hints used.                    |
| `xp_awarded`   | number  | yes      |                                        |

---

### Mastery transitions

Mastery state changes are first-class events so the orchestration layer
can drive notifications, badges, and review scheduling.

#### `mastery_awarded`
Node moves from `active`/`practicing` → `mastered_for_acquisition` or
higher.

| field      | type   | required | notes                                    |
|------------|--------|----------|------------------------------------------|
| `nodeId`   | string | yes      |                                          |
| `from`     | string | yes      | Previous state.                          |
| `to`       | string | yes      | New state.                               |
| `evidence` | object | yes      | `{ accuracy, avgLatencyMs, attempts }`.  |

#### `mastery_revoked`
Node regresses from a mastered state to `regressed` or `practicing`.
Only fires after the regression criteria in masteryEngine — not on a
single failed item.

| field      | type   | required | notes                                    |
|------------|--------|----------|------------------------------------------|
| `nodeId`   | string | yes      |                                          |
| `from`     | string | yes      |                                          |
| `to`       | string | yes      |                                          |
| `reason`   | string | yes      | `forgetting` \| `accuracy_drop` \| `latency_drift`. |

---

### Fluency / passages

#### `passage_started`
| field         | type   | required | notes                                  |
|---------------|--------|----------|----------------------------------------|
| `passageId`   | string | yes      |                                        |
| `gateId`      | string | yes      | One of `FL_01..FL_04`.                 |
| `isCold`      | bool   | yes      |                                        |
| `targetWordCount` | number | yes  |                                        |

#### `passage_completed`
| field             | type    | required | notes                                  |
|-------------------|---------|----------|----------------------------------------|
| `passageId`       | string  | yes      |                                        |
| `gateId`          | string  | yes      |                                        |
| `isCold`          | bool    | yes      |                                        |
| `wcpm`            | number  | yes      |                                        |
| `accuracy`        | number  | yes      | Fraction in [0,1].                     |
| `errors`          | number  | yes      | Word-level miscues.                    |
| `duration_ms`     | number  | yes      |                                        |
| `selfCorrections` | number  | no       |                                        |

#### `fluency_recorded`
Lightweight event for facts-style fluency drills (Reading Facts).
Distinct from `passage_completed` because it operates at the word level
without a passage context.

| field         | type   | required | notes                                    |
|---------------|--------|----------|------------------------------------------|
| `nodeId`      | string | yes      |                                          |
| `surface`     | string | yes      | `reading_facts` \| `passage` \| `drill`. |
| `wcpm`        | number | yes      |                                          |
| `accuracy`    | number | yes      |                                          |
| `latency_ms`  | number | yes      | Median per-word.                         |
| `personal_best` | bool | yes      | True if this attempt beat prior best.    |

---

## Field reference

| field           | shape                                            |
|-----------------|--------------------------------------------------|
| `studentId`     | UUID v4. `null`/absent in dev/anonymous mode.    |
| `nodeId`        | Matches `id` in `src/data/skill_nodes.json`.     |
| `itemId`        | Matches an item bank entry id; deterministic.    |
| `latency_ms`    | Integer ≥ 0.                                     |
| `accuracy`      | Float in [0, 1].                                 |
| `wcpm`          | Float ≥ 0.                                       |
| `attempt_n`     | Integer ≥ 1.                                     |
| `sessionId`     | UUID v4 stable per session.                      |

---

## Append-only changelog

- v1.0 (2026-05-07): initial canonical taxonomy. M3-A.
