# VPA Learning OS — Orchestration Contract v1.0

Version 1.0 · 2026-05-08
Owner: Agent #7 — Chief Integration
Audience: every VPA verticalapp (Reading Academy, Math Academy, ESL Academy, …) and the launcher that composes them.

---

## What this is

The launcher (`vpa-orchestration-layer.vercel.app`) is the parent shell that a learner opens first. Each vertical (Reading Academy, Math Academy, …) is a child app deployed independently. The launcher needs to:

- show the student a single prioritized "what should I do today?" view across every app
- show parents/teachers a unified mastery + XP overview
- single-sign-on across apps via shared Supabase Auth
- never have to know each app's internal data shape

This contract specifies the four endpoints every vertical exposes so the launcher can do all of the above without coupling to any one app's internals.

The contract is **versioned**, **append-only on the response side**, and **stateless** on the request side. New required fields require a major version bump. Adding optional fields is non-breaking.

---

## Shared identity model

All four endpoints take a single query parameter:

```
?student=<vpa-student-uuid>
```

`vpa-student-uuid` is the row id in the shared `students` table (resolved from `auth.uid()` via `students.auth_user_id`). The launcher passes the same UUID to every app.

Auth: each app's endpoint is publicly callable but reads server-side via the Supabase service-role key. The launcher does not forward JWTs. RLS doesn't apply to service-role reads, but the response only contains data for the student id passed in — apps must not include any other student's data in the response.

---

## The four endpoints

Every VPA vertical implements these at:

```
/api/snapshot     — daily XP + next-action pointer
/api/mastery      — strand-level mastery rollup
/api/today        — recommended action for today (NEW in v1.0)
/api/xp           — XP across multiple time windows (NEW in v1.0)
```

The first two existed informally before v1.0; this spec formalizes the contract so the launcher can rely on them.

### 1. `GET /api/snapshot`

What the student is doing right now. Used by the launcher's per-app card.

```jsonc
{
  "studentId": "uuid",
  "appId": "reading_academy",      // matches learning_apps.slug
  "date": "2026-05-08",            // YYYY-MM-DD in the student's timezone
  "todayXp": 18,
  "weekXp": 92,
  "dailyGoalXp": 30,
  "nextDrill": {
    "label": "Segment CVC Phonemes",
    "path": "/"                     // app-relative URL the launcher opens
  },
  "_notProvisioned": false          // true if the student has no account on this app
}
```

### 2. `GET /api/mastery`

Strand-level mastery for cross-app comparison. Used by the launcher's "mastery garden" view.

```jsonc
{
  "studentId": "uuid",
  "appId": "reading_academy",
  "strands": [
    {
      "id": "phonemic-awareness",     // url-safe strand id
      "label": "Phonemic Awareness",  // display label
      "symbol": "🔊",                 // 1-3 char compact icon (emoji or text)
      "mastered": 5,
      "attempted": 6,
      "total": 10,
      "avgScore": 0.50                 // mastered/total
    }
  ]
}
```

### 3. `GET /api/today` *(NEW v1.0)*

The vertical's top recommendation for today. Returns a single block — the launcher decides whether to surface it, ignore it, or stack it next to other apps' blocks.

```jsonc
{
  "studentId": "uuid",
  "appId": "reading_academy",
  "recommendation": {
    "kind": "drill",                          // drill | review | fluency | passage | placement | none
    "headline": "Segment CVC Phonemes",
    "subtitle": "Today's lesson",
    "estimatedMinutes": 8,
    "priority": "high",                       // high | medium | low
    "path": "/reading/drill",                 // app-relative
    "reason": "active_frontier",              // engine's rationale tag
    "details": {                              // free-form, app-specific
      "nodeId": "PA_06_segment_cvc"
    }
  },
  "blocksRemaining": 3                         // how many more blocks the planner has
}
```

If the student has no account or nothing to do, `recommendation.kind === "none"` and `headline` is a friendly message. The launcher uses this to deprioritize the app card without removing it.

### 4. `GET /api/xp` *(NEW v1.0)*

XP across time windows so the launcher can compute unified totals.

```jsonc
{
  "studentId": "uuid",
  "appId": "reading_academy",
  "today": 18,
  "yesterday": 24,
  "thisWeek": 92,
  "lastWeek": 110,
  "thisMonth": 412,
  "allTime": 1820,
  "lastEarnedAt": "2026-05-08T14:22:31Z"        // null if no XP yet
}
```

---

## Response conventions

- **All endpoints respond JSON.** Never HTML. Always status 200 on the happy path; 400 on missing query params; 500 on server failure (with `{ error, details }`).
- **CORS open** to `*` for GET. The launcher and Reading Academy live on different Vercel subdomains; CORS must allow cross-origin.
- **`_notProvisioned: true`** when the student has no row on this app. Renders the app card greyed out instead of erroring.
- **Cache-friendly.** Apps may set `Cache-Control: max-age=60` for snapshot/mastery; today/xp should be `no-cache` since they reflect just-finished sessions.
- **Stable shape.** Adding optional fields is fine. Removing or renaming any field above bumps the contract major version.

---

## Reference implementation: Reading Academy

| Endpoint | File | Status |
|---|---|---|
| `/api/snapshot` | `api/snapshot.js` | ✓ existed pre-M10 |
| `/api/mastery` | `api/mastery.js` | ✓ existed pre-M10 |
| `/api/today` | `api/today.js` | ✓ M10-B |
| `/api/xp` | `api/xp.js` | ✓ M10-C |

All four read from the shared `student_app_accounts.state` JSONB column. Reading Academy's M3 model lives at `state.modelV2`; the legacy shape lives at `state` directly. The endpoints prefer modelV2 when present, fall back to legacy.

---

## Single sign-on

All VPA apps use the same Supabase project (`dtkrnyberbpfdmikpdnw`). When a learner signs in via the launcher's magic link, the JWT cookie is set on the parent Vercel domain; child apps on subdomains read the same session.

Reading Academy's `AuthProvider` (`src/lib/auth/AuthProvider.jsx`) detects the session on mount via `supabase.auth.getSession()`. No cross-app handshake is needed — the auth library handles it.

---

## What the launcher does with this

The launcher's homepage cycles every 60 s through every connected app:

1. Fetch `/api/snapshot` — get today's XP + next-action pointer per app.
2. Fetch `/api/today` — get each app's top recommendation.
3. Sort recommendations by `priority` then `kind` order (placement > review > drill > fluency > passage).
4. Render the top 3–5 across all apps as the unified "Today" view.
5. Periodically fetch `/api/xp` for each app to keep the rolled-up XP ring accurate.

The launcher keeps a small list of registered apps (slug → base URL) and walks them in parallel. Adding a new vertical = appending to that list and shipping the four endpoints.

---

## Versioning

This spec is versioned independently of any one app. Apps declare the contract version they implement via a header on every response:

```
X-VPA-Contract-Version: 1.0
```

The launcher uses this to fall back gracefully when an app implements an older version.

---

## Change log

- v1.0 (2026-05-08): Initial contract. Formalized snapshot + mastery, added today + xp.
