# VPA Learning OS — Launcher Integration Runbook

Version 1.0 · 2026-05-08
Audience: engineers working on the launcher (`vpa-orchestration-layer.vercel.app`)

This is the operational guide for the orchestration layer to consume Reading Academy and any future VPA vertical app under the v1 contracts. The launcher OWNS the unified Student Cognitive Profile; vertical apps CONTRIBUTE evidence.

---

## Architecture rule (do not break)

Reading Academy contributes evidence. Math Academy contributes evidence. The launcher merges them into the canonical `student_cognitive_profiles` row. **No vertical app reads or writes that table directly.**

If a vertical needs the unified profile (for cross-app context), it reads the row via its own `service_role` query — but it must treat the read as advisory, not authoritative for its own decisions. The vertical's local mastery + scheduling stays deterministic and self-contained.

---

## What the launcher does

For each connected student, on these triggers:

- **On app load** — pull the current profile + a fresh contribution from each app
- **Every 5 minutes** while the dashboard is open
- **On `mastery_awarded` / `mastery_revoked` telemetry events** (real-time hint to refetch)
- **Nightly cron** at 04:00 local time, for every student active in the last 14 days

The work it performs:

1. Fan out `GET /api/cognitive-contribution?student=<id>` to each registered app
2. Validate each response against the v1 schema
3. Merge per the confidence-weighted-average rule (`docs/architecture/cognitive-profile-v1.md` §Orchestration-layer merger)
4. Upsert into `student_cognitive_profiles`
5. Insert a row in `cognitive_contributions_log` per app response (audit trail)

---

## Endpoints exposed by every vertical

Reading Academy implements these. Each new vertical must too.

### Mandatory

| Endpoint | Purpose | Reading Academy file |
|---|---|---|
| `GET /api/cognitive-contribution?student=<id>` | The vertical's evidence for the 8 universal dimensions | `api/cognitive-contribution.js` |

### Optional but expected

| Endpoint | Purpose | Reading Academy file |
|---|---|---|
| `GET /api/snapshot?student=<id>` | Daily XP + next-action pointer | `api/snapshot.js` |
| `GET /api/mastery?student=<id>` | Strand-level mastery rollup | `api/mastery.js` |
| `GET /api/today?student=<id>` | The vertical's top recommendation for today | `api/today.js` |
| `GET /api/xp?student=<id>` | XP across multiple time windows | `api/xp.js` |

The launcher prefers the cognitive profile for routing decisions. The other endpoints are useful for the per-app card UI and as fallbacks when the profile is empty (cold-start students, no contribution yet).

---

## Registered apps

The launcher keeps a small in-memory registry. Today:

```js
const APPS = [
  {
    slug: "reading_academy",
    base: "https://reading-academy.vercel.app",
    contractVersion: "1.0",
  },
  {
    slug: "math_academy",
    base: "https://math-academy.vercel.app",
    contractVersion: "1.0", // when implemented
  },
  // …add new verticals here
];
```

Adding a vertical = appending to this array. The launcher discovers no other state from each app; everything goes through the four endpoints above.

---

## Merge implementation (sketch)

```ts
// Run on each tick / event for one student.
async function refreshProfile(studentId: string) {
  const apps = await listRegisteredApps();
  const responses = await Promise.allSettled(
    apps.map(app => fetchContribution(app.base, studentId)),
  );
  const valid = responses
    .map((r, i) => ({ app: apps[i], r }))
    .filter(({ r }) => r.status === "fulfilled" && r.value?.contributions)
    .map(({ app, r }) => ({ app, payload: r.value }));

  // Log every contribution for audit.
  await Promise.all(valid.map(({ app, payload }) =>
    db.insert("cognitive_contributions_log", {
      student_id: studentId,
      app_id: app.id,
      schema_version: payload.schemaVersion,
      contributions: payload.contributions,
      computed_at: payload.computedAt,
    })));

  // Merge by confidence-weighted average per dimension.
  const merged = mergeByDimension(valid);
  const contributors = Object.fromEntries(
    valid.map(({ app, payload }) => [
      app.slug,
      {
        lastContributedAt: payload.computedAt,
        dimensionsContributed: payload.contributions.map(c => c.dimension),
      },
    ]),
  );

  await db.upsert("student_cognitive_profiles", {
    student_id: studentId,
    schema_version: "cognitive-profile/v1",
    dimensions: merged,
    contributors,
  });
}

function mergeByDimension(valid) {
  const buckets = new Map();
  for (const { payload } of valid) {
    for (const c of payload.contributions) {
      if (c.confidence < 0.05) continue;
      const arr = buckets.get(c.dimension) || [];
      arr.push(c);
      buckets.set(c.dimension, arr);
    }
  }
  const out = {};
  for (const [dim, arr] of buckets) {
    const sumW = arr.reduce((a, c) => a + c.confidence, 0);
    if (sumW === 0) continue;
    const value = arr.reduce((a, c) => a + c.value * c.confidence, 0) / sumW;
    const samples = arr.reduce((a, c) => a + c.samples, 0);
    const confidence = Math.min(1, sumW / Math.max(arr.length, 1));
    out[dim] = { value, confidence, samples };
  }
  return out;
}
```

---

## Disagreement handling

If two apps' values for the same dimension differ by `> 0.4` *and both* have `confidence > 0.5`, write a `cognitive_disagreement` event into `telemetry_events` and pick the contribution with more samples. Do not silently average — the orchestration layer needs an audit trail when verticals disagree.

(Reading Academy and Math Academy don't currently overlap on dimensions, so this won't fire pre-pilot. It will matter when both contribute to e.g. `interventionResponsiveness`.)

---

## Failure modes & how the launcher should handle them

| Symptom | Cause | Action |
|---|---|---|
| 4xx from a vertical | Bad student id, missing query param | Drop the contribution, keep the rest |
| 5xx from a vertical | Server error in that app | Drop the contribution, log, alert if it persists |
| Network timeout (>5s) | App slow / cold start | Retry once with backoff, then drop |
| Missing `schemaVersion` field | Vertical hasn't upgraded to v1 | Treat as v0 — only use snapshot/mastery, skip the profile contribution |
| `schemaVersion` ahead of launcher | New version not yet supported | Drop the contribution, fall back to snapshot/mastery, alert ops |
| `_notProvisioned: true` | Student has no account on this app | Skip — don't include this app in the merger or the dashboard card |
| Confidence sum across all apps for a dim is 0 | No app has evidence yet | Leave dimension as `null`, surface "not enough data" in UI |

The launcher's update loop must continue successfully even if every vertical returns errors — the existing profile stays valid and the dashboard renders normally.

---

## Reading Academy: where its endpoints live

```
api/cognitive-contribution.js  ← M10-J, the contributor protocol
api/today.js                   ← M10-B, recommendation
api/xp.js                      ← M10-C, XP windows
api/snapshot.js                ← legacy, modelV2-aware (M10-D)
api/mastery.js                 ← legacy, modelV2-aware (M10-D)
api/recap.js                   ← LLM weekly summary (M8-B)
api/insight-recommendation.js  ← LLM per-insight tip (M8-C)
```

All eight read from `student_app_accounts.state` via the service-role key. None require a JWT. CORS is open. All set:

```
X-VPA-Contract-Version: 1.0
X-Cognitive-Profile-Version: cognitive-profile/v1   (cognitive-contribution only)
```

---

## Smoke test

After deploying any change to the launcher's merger:

```bash
# 1. Hit each app's contributor endpoint with a known student id.
curl https://reading-academy.vercel.app/api/cognitive-contribution?student=<uuid> | jq .

# 2. Trigger a refresh in the launcher (UI button or API call).

# 3. Verify the profile row updated.
psql $SUPABASE_URL <<EOF
select student_id, dimensions->>'decodingEfficiency' as decoding,
       contributors, updated_at
from public.student_cognitive_profiles
where student_id = '<uuid>';
EOF

# 4. Verify the contribution was logged.
psql $SUPABASE_URL <<EOF
select app_id, jsonb_array_length(contributions) as n_dims, ingested_at
from public.cognitive_contributions_log
where student_id = '<uuid>'
order by ingested_at desc limit 5;
EOF
```

The Reading Academy debug page (`/reading/debug`) also surfaces both the cognitive profile and the per-app overview — useful for verifying the launcher actually wrote the row.

---

## Adding a new vertical app

1. Implement `/api/cognitive-contribution` per `docs/architecture/cognitive-profile-v1.md`. Optional: snapshot, mastery, today, xp.
2. Add a row to `learning_apps` (slug, display name, version).
3. Add the app to the launcher's `APPS` registry.
4. Trigger a profile refresh for one test student. Verify the row populates.
5. Document the app's per-dimension methods so other engineers know what's contributing what.

---

## Change log

- v1.0 (2026-05-08): Initial runbook. Cognitive profile owned by launcher, vertical apps as contributors. Reading Academy implements the full eight-endpoint surface.
