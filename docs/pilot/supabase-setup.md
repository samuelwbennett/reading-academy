# Reading Academy — Supabase Setup Runbook

Version 1.0 · 2026-05-08
Audience: Sam (or whoever runs the pilot deploy)

This is the step-by-step to take Reading Academy from "anonymous local
storage" to "telemetry flushing into Supabase, state syncing across
devices, sign-in working." All steps are reversible.

The Reading Academy + Math Academy + VPA Learning OS share a single
Supabase project (`dtkrnyberbpfdmikpdnw`). The base schema
(`learning_apps`, `students`, `student_app_accounts`) is already in
place from the orchestration setup. M5 only adds the four new event
tables.

---

## 1. Apply the migration (5 minutes)

The new SQL lives at `supabase/migrations/0001_reading_telemetry_tables.sql`.
You have two options to apply it:

### Option A — Supabase dashboard (easiest)

1. Open https://supabase.com/dashboard/project/dtkrnyberbpfdmikpdnw/sql/new
2. Open `supabase/migrations/0001_reading_telemetry_tables.sql` in your editor.
3. Copy the entire file into the SQL editor.
4. Click **Run**. You should see "Success. No rows returned."
5. Verify in **Table Editor** that these four tables now exist:
   `reading_skill_attempts`, `reading_passage_attempts`, `reading_mastery_snapshots`, `reading_telemetry_events`.

> Note: tables use a `reading_` prefix to avoid colliding with any
> existing `skill_attempts` / `telemetry_events` tables in the shared
> VPA Supabase project (Math Academy may own the unprefixed names).

### Option B — Supabase CLI

```bash
brew install supabase/tap/supabase
cd /Users/samuelbennett/Desktop/reading-academy
supabase link --project-ref dtkrnyberbpfdmikpdnw   # one-time
supabase db push
```

The migration is idempotent (`create table if not exists`), so re-runs
are safe.

---

## 2. Set the anon key (3 minutes)

The `VITE_SUPABASE_ANON_KEY` env var is currently empty in `.env.example`.
You need to populate it locally and in Vercel.

### Local

1. Find the anon key: https://supabase.com/dashboard/project/dtkrnyberbpfdmikpdnw/settings/api
2. Copy it.
3. Create `.env.local` in the repo root:

```bash
cp .env.example .env.local
# edit .env.local and paste the anon key after VITE_SUPABASE_ANON_KEY=
```

### Vercel

```bash
cd /Users/samuelbennett/Desktop/reading-academy
npx vercel env add VITE_SUPABASE_ANON_KEY production
# paste the anon key when prompted
npx vercel env add VITE_SUPABASE_ANON_KEY preview
# paste it again
```

If you also have the Vercel functions in `api/` running (snapshot,
mastery), set the server-side keys too:

```bash
npx vercel env add SUPABASE_URL production
npx vercel env add SUPABASE_SERVICE_ROLE_KEY production   # KEEP THIS SECRET
```

---

## 3. Smoke-test sign-in (5 minutes)

```bash
cd /Users/samuelbennett/Desktop/reading-academy
npm run build
npx vercel --prod
```

Then on the live site:

1. Open `https://reading-academy.vercel.app/reading/signin`.
2. Enter your email, click **Send sign-in link**.
3. Open the link from your inbox. It bounces back to the app.
4. The header at `/reading` should now read **"Signed in · <email>"**.
5. Open `/reading/debug`. The **Telemetry queue** tile should still
   show 0 because sync caches reset on auth change.
6. Run a single drill on `/reading/drill`. Wait ~30 seconds (the
   auto-flush tick). Refresh the debug page. The queue should drain
   to 0 and the **Mastery + Per-node** tables should show your
   attempts.
7. Verify server-side: in the Supabase dashboard → Table Editor →
   `reading_skill_attempts`, you should see one row per drill item,
   with your `student_id` populated.

---

## 4. Link an auth user to a student row (one-time per pilot user)

The flush worker writes only when the signed-in auth user has a
`students.auth_user_id` link. For your own dev account this needs
to be set once.

In the Supabase SQL editor:

```sql
-- Replace email + display_name as appropriate.
with u as (
  select id from auth.users where email = 'samuel.bennett425@gmail.com'
)
insert into public.students (auth_user_id, display_name, grade_level)
select id, 'Sam', 'K' from u
on conflict (auth_user_id) do nothing;
```

For a real classroom rollout you'd wrap this in an admin UI, but a
single SQL block per pilot teacher is fine for the smoke test.

---

## 5. Confirm RLS is doing its job

```sql
-- As the *anon* role (i.e. when no JWT is set), this should return 0:
set role anon;
select count(*) from public.reading_skill_attempts;
reset role;
```

You'll see RLS reject reads for unauthenticated requests. The
authenticated-user path (via the SPA's JWT) sees only their own rows
because the `current_student_id()` helper resolves
`auth.uid() → students.id` and the policies match on it.

---

## 6. Roll back (if needed)

The migration only adds tables and policies. To undo:

```sql
drop table if exists public.reading_telemetry_events;
drop table if exists public.reading_mastery_snapshots;
drop table if exists public.reading_passage_attempts;
drop table if exists public.reading_skill_attempts;
-- Only drop current_student_id() if no other Reading/Math/etc. table uses it.
-- drop function if exists public.current_student_id();
```

The base `learning_apps` / `students` / `student_app_accounts` tables
stay untouched.

---

## 7. Cross-device sync verification

A pilot teacher will move between an iPad and a laptop; this is the
test path to confirm state survives the swap.

1. **Device A** (e.g., iPad, signed in as the pilot user):
   - Run a single drill at `/reading/drill`. Mark a few items correct.
   - Wait 30 s for the auto-flush tick (or close the tab — the
     `pagehide` handler triggers a flush too).
   - Open `/reading/debug`. Note the **Mastered nodes** count and
     the latest entry in the **Telemetry queue (last 50)** table —
     screenshot it.
2. Sign out of device A: tap the header's "Signed in" link →
   "Sign out" on `/reading/signin`.
3. **Device B** (e.g., MacBook): sign in with the same email. Open
   `/reading`.
4. Expected:
   - The auth chip in the header shows the same email + linked
     student name within ~2 s.
   - `/reading/debug` shows the same **Mastered nodes** count.
   - The session plan card on `/reading` reflects the same active
     node and review queue.
5. If counts differ, check the Supabase row directly:

   ```sql
   select student_id, updated_at,
          jsonb_path_query_array(state, '$.modelV2.nodes ?? "{}"') as nodes
   from public.student_app_accounts
   where app_id = (select id from public.learning_apps where slug = 'reading_academy')
   order by updated_at desc
   limit 5;
   ```

   The most-recent row's `state.modelV2.nodes` should match the
   active device's local model, byte-for-byte.

Common drift causes:
- The 4-second debounced push hadn't fired yet on device A. Wait,
  refresh, retry.
- Device B's local model migration ran before the remote pull
  finished. The `reconcileOnSignIn` step picks the higher
  `updatedAt`, but if the local migration just stamped a fresh
  `updatedAt` the local copy can win incorrectly. Mitigation: clear
  device B's local state via `/reading/debug` "reset student model"
  before signing in for the first time.

---

## 8. Failure modes & how to spot them

| symptom | likely cause | fix |
|---|---|---|
| Debug page queue grows but never drains | not signed in OR no linked student row | sign in + run the SQL in §4 |
| Browser console: `learning_apps lookup failed` | anon key missing or wrong | re-check `VITE_SUPABASE_ANON_KEY` in Vercel and locally |
| Debug page queue drains but Supabase rows are empty | RLS rejected the insert silently | check `current_student_id()` returns a UUID for your user |
| Sign-in email never arrives | Supabase Auth email provider not configured | dashboard → Authentication → Email — verify SMTP or use Supabase's default |
| Queue + Supabase both empty after a drill | `enabled` flag on the bridge is off | check console for `[reading.telemetry]` lines; bridge errors there |

---

## 9. Enable AI features (M8)

Two endpoints use Anthropic Claude:
- `/api/recap?student=<id>` — 100–180 word weekly progress narrative
- `/api/insight-recommendation` — per-insight teacher recommendation

Both fall back to deterministic templates when no API key is
configured, so they never break — they just stop being "AI" and
become "template" (visible in the small chip below each card).

To enable:

1. Get a key at https://console.anthropic.com/settings/keys
2. Add it to Vercel:

   ```bash
   cd /Users/samuelbennett/Desktop/reading-academy
   npx vercel env add ANTHROPIC_API_KEY production
   npx vercel env add ANTHROPIC_API_KEY preview
   ```

3. Redeploy: `npx vercel --prod`
4. Open `/reading/debug` → the **Weekly recap** chip should read
   "AI-generated"; the per-insight **Get recommendation** button
   should return a Claude-written tip.

### Privacy notes

The functions send only:
- aggregate stats (counts, accuracy %, top skills practiced, mastered
  skill labels, best WCPM)
- one rule-engine insight at a time (rule, severity, headline,
  detail, node id, evidence object)

They do **not** send:
- student name, email, or any PII
- raw transcripts of attempts
- per-attempt latencies or item-by-item history

Anthropic's [usage policies](https://www.anthropic.com/legal/usage-policy)
and the data-handling terms of your API account apply. For pilot use
this is consistent with FERPA's "directory information" treatment
since no individually identifying data is sent.

If you want to disable AI calls for a particular pilot regardless of
the env var, set `ANTHROPIC_API_KEY` to the literal string `disabled`
in Vercel — the helper treats unrecognized keys as missing and falls
back cleanly.

---

## 10. What's still optional after this runbook

- **Teacher dashboard with cohort views** — out of M5 scope, lands in
  M6. The data is already collecting; the UI just needs to be built.
- **Edge function flush path** — currently the SPA writes directly to
  the four tables via the anon JWT. For higher-throughput pilots
  (>20 students), front it with a Supabase Edge Function for batch
  validation + idempotency at the server.
- **Cross-app dashboard** — `/api/snapshot` and `/api/mastery` serve
  the universal `student_app_accounts.state` to the orchestration
  dashboard. Those don't need changes; they keep reading the legacy
  blob, while the M3 `state.modelV2` co-locates next to it.
