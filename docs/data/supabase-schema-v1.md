# Reading Academy — Supabase Schema v1

Version 1.0 · 2026-05-07
Owner: Agent #7 — Chief Integration
Scope: Multi-tenant Postgres schema for the orchestration layer.
Status: **Spec only.** No live integration in M4. Built in M5.

---

## Design principles

1. **Multi-tenant from day one.** Reading Academy is one app among many on
   the VPA Learning OS. Every row that holds learner data is keyed by
   `app_id` so the same student can have parallel state in Reading,
   Math, ESL, etc. without cross-contamination.
2. **Append-only event log.** `skill_attempts` is the source of truth.
   Every other table is materializable from it (with cost). Mastery
   snapshots are a cache, not a source.
3. **Deterministic IDs from the client.** `attempt_id` and `passage_attempt_id`
   are UUID v4 generated client-side at emit time. This makes the queue
   idempotent: a flush retry never duplicates a row.
4. **Row-level security by default.** A learner reads/writes their own
   rows; a teacher reads their roster's rows; an admin reads everything
   in their org. RLS policies are mandatory, never disabled.
5. **FERPA-aware.** Student PII (names, parent emails) lives in a
   separate `students` table from learning events. Events join on
   `student_id` only. No PII in `skill_attempts`.

---

## Tables

### `learning_apps`

Catalog of apps that share this database. Reading Academy is one row.

| column         | type      | notes                                             |
|----------------|-----------|---------------------------------------------------|
| `app_id`       | text PK   | e.g. `"reading-academy"`.                         |
| `display_name` | text      | "Reading Academy".                                |
| `version`      | text      | Active app version, e.g. `"1.0.0"`.               |
| `created_at`   | timestamptz | default `now()`.                                |

Seeded once. Referenced by `student_app_accounts.app_id`.

### `orgs`

A school, district, or family unit. Tenant boundary for RLS.

| column        | type        | notes                                  |
|---------------|-------------|----------------------------------------|
| `org_id`      | uuid PK     | gen_random_uuid().                     |
| `name`        | text        |                                        |
| `org_type`    | text        | `school` \| `district` \| `family`.    |
| `metadata`    | jsonb       | flexible (locale, time zone, etc.).    |
| `created_at`  | timestamptz | default `now()`.                       |

### `users`

The auth principal. One row per Supabase Auth user.

| column        | type        | notes                                                  |
|---------------|-------------|--------------------------------------------------------|
| `user_id`     | uuid PK     | matches `auth.users.id`.                              |
| `org_id`      | uuid FK     | references `orgs(org_id)`.                            |
| `role`        | text        | `student` \| `teacher` \| `parent` \| `admin`.        |
| `display_name`| text        |                                                        |
| `email`       | text        | optional.                                             |
| `created_at`  | timestamptz | default `now()`.                                      |

### `students`

Learner identity. Separate from `users` because younger students may
not have their own auth account; a parent or teacher proxies in.

| column         | type        | notes                                            |
|----------------|-------------|--------------------------------------------------|
| `student_id`   | uuid PK     | gen_random_uuid().                              |
| `org_id`       | uuid FK     | references `orgs(org_id)`.                      |
| `display_name` | text        | "Sam B." — short, FERPA-light.                  |
| `grade_level`  | text        | `"K"` \| `"1"` \| `"2"`.                        |
| `birth_year`   | int         | year only, no full DOB. Optional.               |
| `created_at`   | timestamptz | default `now()`.                                |
| `updated_at`   | timestamptz |                                                  |

PII (full name, parent emails, addresses) goes in a separate
`students_pii` table that only the admin role can read.

### `student_app_accounts`

The bridge between a `student` and one app on the platform. The
canonical mastery state for an app lives here.

| column           | type          | notes                                                |
|------------------|---------------|------------------------------------------------------|
| `account_id`     | uuid PK       |                                                      |
| `student_id`     | uuid FK       | references `students(student_id)`.                  |
| `app_id`         | text FK       | references `learning_apps(app_id)`.                 |
| `state`          | jsonb         | full canonical `StudentModel` JSON (M3 schema).     |
| `state_version`  | text          | matches `student-model/v1` for migration.           |
| `mastered_count` | int           | denormalized for quick queries.                     |
| `current_gate`   | text          | active fluency gate id.                             |
| `streak_days`    | int           |                                                      |
| `total_xp`       | int           |                                                      |
| `created_at`     | timestamptz   |                                                      |
| `updated_at`     | timestamptz   |                                                      |

Unique on `(student_id, app_id)`. The `state` column is the
authoritative source after a flush; intermediate rebuilds happen via
`mastery_snapshots`.

### `skill_attempts`

The append-only event log. One row per terminal item event
(`response_correct` or `response_incorrect`). Hint-only or
session-lifecycle events are stored in `telemetry_events` (below).

| column          | type         | notes                                                  |
|-----------------|--------------|--------------------------------------------------------|
| `attempt_id`    | uuid PK      | client-generated; idempotency key.                    |
| `student_id`    | uuid FK      |                                                        |
| `app_id`        | text FK      |                                                        |
| `node_id`       | text         | matches `skill_nodes.json#id`.                        |
| `item_id`       | text         | matches item bank id.                                 |
| `correct`       | boolean      |                                                        |
| `latency_ms`    | int          |                                                        |
| `hint_count`    | int          | 0 = no hints used.                                    |
| `surface`       | text         | `drill` \| `fluency` \| `diagnostic` \| etc.         |
| `attempt_n`     | int          | 1-indexed within session.                             |
| `session_id`    | uuid         |                                                        |
| `xp_awarded`    | int          | 0 if none.                                            |
| `transcript`    | text         | the learner's raw response (for ASR analysis).        |
| `expected`      | text         | the expected answer.                                  |
| `confidence`    | float        | optional ASR confidence in [0,1].                     |
| `client_ts`     | timestamptz  | client-side timestamp at emit.                        |
| `server_ts`     | timestamptz  | default `now()`; authoritative.                       |

Indexes:
- `(student_id, app_id, node_id, server_ts DESC)` — per-node history queries.
- `(session_id)` — session reconstructions.
- `(server_ts)` — analytics roll-ups.

### `passage_attempts`

Same idea as `skill_attempts` but for cold/practice passage reads.
Kept separate because the columns differ enough (wcpm, accuracy,
errors) that mixing them muddies the schema.

| column           | type        | notes                                              |
|------------------|-------------|----------------------------------------------------|
| `passage_attempt_id` | uuid PK |                                                    |
| `student_id`     | uuid FK     |                                                    |
| `app_id`         | text FK     |                                                    |
| `passage_id`     | text        | matches passages bank.                            |
| `gate_id`        | text        | `FL_01..FL_04`.                                   |
| `is_cold`        | boolean     |                                                    |
| `wcpm`           | float       |                                                    |
| `accuracy`       | float       | in [0,1].                                         |
| `errors`         | int         | word-level miscues.                               |
| `duration_ms`    | int         |                                                    |
| `self_corrections` | int       | optional.                                         |
| `session_id`     | uuid        |                                                    |
| `client_ts`      | timestamptz |                                                    |
| `server_ts`      | timestamptz | default `now()`.                                  |

### `mastery_snapshots`

Materialized cache of derived state at each mastery transition.
Powers the teacher dashboard without re-folding the full event log.

| column         | type         | notes                                            |
|----------------|--------------|--------------------------------------------------|
| `snapshot_id`  | uuid PK      |                                                  |
| `student_id`   | uuid FK      |                                                  |
| `app_id`       | text FK      |                                                  |
| `node_id`      | text         |                                                  |
| `from_status`  | text         |                                                  |
| `to_status`    | text         |                                                  |
| `reason`       | text         | `acquisition` \| `regression` \| `automaticity`. |
| `evidence`     | jsonb        | `{ accuracy, avgLatencyMs, attempts }`.          |
| `transitioned_at` | timestamptz |                                              |

Read-mostly; written exactly once per transition.

### `telemetry_events`

Catch-all sink for non-attempt events (`session_started`,
`session_ended`, `hint_used`, etc.). Useful for engagement analytics
and debugging without bloating `skill_attempts`.

| column        | type        | notes                                            |
|---------------|-------------|--------------------------------------------------|
| `event_id`    | uuid PK     |                                                  |
| `student_id`  | uuid FK     | nullable (anonymous mode).                       |
| `app_id`      | text FK     |                                                  |
| `event`       | text        | matches the v1 taxonomy.                         |
| `payload`     | jsonb       |                                                  |
| `session_id`  | uuid        |                                                  |
| `client_ts`   | timestamptz |                                                  |
| `server_ts`   | timestamptz | default `now()`.                                 |

### `rosters` (M5)

Class lists. Bridge of teacher → students.

| column        | type        | notes                              |
|---------------|-------------|------------------------------------|
| `roster_id`   | uuid PK     |                                    |
| `org_id`      | uuid FK     |                                    |
| `teacher_id`  | uuid FK     | references `users(user_id)`.       |
| `student_id`  | uuid FK     |                                    |
| `created_at`  | timestamptz |                                    |

---

## Row-level security

Each table is enabled with RLS. Policies (sketch):

**`student_app_accounts`**
- A user with role `student` may `SELECT/UPDATE` rows where
  `student_id = (SELECT student_id FROM users_students WHERE user_id = auth.uid())`.
- A teacher may `SELECT` rows for any `student_id` on their roster
  (join through `rosters`).
- An admin may `SELECT/UPDATE` rows where `org_id = (their org)`.

**`skill_attempts`, `passage_attempts`, `telemetry_events`**
- A student may `INSERT` rows where `student_id = self`.
- A student may `SELECT` rows where `student_id = self`.
- A teacher may `SELECT` rows whose `student_id` is on their roster.
- An admin: same scope as the teacher within their org.

**`students`**
- A student may `SELECT` their own row.
- A teacher may `SELECT` rows of their roster.
- An admin may `SELECT/UPDATE` rows in their org.
- `students_pii` is admin-only.

---

## Ingest path

1. The client emits a canonical envelope through
   `src/lib/telemetry/emit.ts`. It lands in the localStorage queue.
2. A periodic flush (M5) batches up to 50 envelopes, POSTs them to a
   Supabase Edge Function `/ingest/telemetry`, with the user's JWT.
3. The Edge Function:
   - Validates each envelope server-side using a port of
     `validateEnvelope`.
   - Splits attempt-class events into `skill_attempts`, passage-class
     into `passage_attempts`, mastery transitions into
     `mastery_snapshots`, everything else into `telemetry_events`.
   - Updates `student_app_accounts.state` via a stored procedure that
     re-runs `updateNodeMastery` server-side for each attempt to keep
     client and server identical.
4. On success the client drains the queue. On any 4xx the queue
   retains the rows; on 5xx it backs off and retries.

The deterministic, client-generated UUIDs make re-flushes safe: an
INSERT with an existing `attempt_id` is a no-op.

---

## Data retention

| table              | retention                  |
|--------------------|----------------------------|
| `skill_attempts`   | 365 days hot, archive cold |
| `passage_attempts` | 365 days hot, archive cold |
| `telemetry_events` | 90 days                    |
| `mastery_snapshots`| forever (small)            |
| `student_app_accounts.state` | forever         |

PII and student rows persist until org deletion request, then purge
within 30 days per FERPA notice.

---

## Migration path from M3 client state

The client's `student-model/v1` JSON maps 1:1 to
`student_app_accounts.state`. First sync after a learner signs in:

1. Read local `StudentModel`.
2. POST it to `/sync/upsert-student-model` with the user's JWT.
3. Edge function upserts into `student_app_accounts`.
4. Subsequent flushes only POST telemetry; the server is now the
   authority for `state`.

If two devices conflict (rare), the server picks `state.updatedAt`
max and rebuilds from the union of `skill_attempts` since both
candidates' `createdAt`. The `state` column is a cache; the truth is
in the event log.

---

## Open questions for M5

- Per-row CRDT vs. last-write-wins for offline reconciliation?
  Current decision: LWW with append-only event log. Revisit if
  cross-device usage shows real conflict rates.
- Edge function language: Deno (Supabase native) vs. Node? Lean Deno
  to keep the function colocated with the database.
- IRT / FSRS parameter store: a separate `mastery_models` table
  keyed by `node_id`? Out of scope until M5 has telemetry.
