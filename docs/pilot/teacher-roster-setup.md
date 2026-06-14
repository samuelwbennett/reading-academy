# Reading Academy — Teacher & Roster Setup Runbook

Version 3.0 · 2026-05-08
Audience: Sam, the pilot teacher's tech contact, or whoever onboards a new classroom.

This is the operational guide to take Reading Academy from "one student on one device" to "one teacher seeing a real class with RLS-enforced privacy." Follow the steps in order; each is reversible.

**M12-B clean role architecture.** As of v3 of this runbook, the system has a proper role layer: `auth.users` are login identities, `user_profiles` carries the product role, and `teachers` + `organizations` give us the structure for multi-classroom + multi-school growth. Role assignment is server-side only via env-var allowlists; clients can never set their own role.

Four migrations need to be applied in order:
1. `supabase/migrations/0004_teacher_roster.sql` (M12-A: classes + memberships)
2. `supabase/migrations/0005_user_profiles.sql` (M12-A1: user_profiles)
3. `supabase/migrations/0006_role_architecture.sql` (M12-B1: organizations + teachers + role helpers)
4. `supabase/migrations/0007_student_invites.sql` (M13-B: student invite tokens)

All migrations are idempotent — safe to re-run.

---

## 1. Apply the migrations (5 min)

Open https://supabase.com/dashboard/project/dtkrnyberbpfdmikpdnw/sql/new. Run each migration in order:

1. `supabase/migrations/0004_teacher_roster.sql` — paste, **Run**
2. `supabase/migrations/0005_user_profiles.sql` — paste, **Run**
3. `supabase/migrations/0006_role_architecture.sql` — paste, **Run**

Verify in **Table Editor** that these tables exist:
- `teacher_classes`, `class_memberships` (from 0004)
- `user_profiles` (from 0005)
- `organizations`, `teachers` (from 0006)

The migrations are additive and idempotent. Re-running is safe.

---

## 2. Configure environment (2 min)

The provisioning endpoints (`/api/provision-self`, `/api/provision-student`) need the service-role key server-side. Confirm both are set in Vercel:

```bash
cd /Users/samuelbennett/Desktop/reading-academy
npx vercel env ls
```

Expected entries (production scope):
- `VITE_SUPABASE_URL` — public, in the SPA bundle
- `VITE_SUPABASE_ANON_KEY` — public, in the SPA bundle
- `SUPABASE_URL` — server-only
- `SUPABASE_SERVICE_ROLE_KEY` — server-only, **sensitive**
- `ANTHROPIC_API_KEY` — server-only, **sensitive** (only required for the LLM polish endpoints)

If `SUPABASE_SERVICE_ROLE_KEY` isn't set, see `docs/pilot/supabase-setup.md` §2.

---

## 2.5 Role architecture (read this once)

The system separates **login identity** from **product role**:

| Layer | Owner | What it is |
|---|---|---|
| `auth.users` | Supabase | Email + password / magic-link tokens. No product knowledge. |
| `user_profiles` | App | One row per auth user. Carries `role` (teacher / student / admin / parent) + `display_name` + `organization_id`. |
| `students` | App | Learner record. May or may not have an `auth_user_id` (kids without login still have one). |
| `teachers` | App | Teacher-specific metadata. One row per auth user with role=teacher. |
| `organizations` | App | School / district / pilot scoping. Pilot ships with one org (`vpa-pilot`). |
| `teacher_classes` | App | Owned by a teacher within an org. |
| `class_memberships` | App | Connects students to classes (M:N). |

**Hard rule.** Role assignment happens server-side only. Clients can't pick or change their own role. Two SQL triggers (`user_profiles_role_lock`) reject role and organization mutations from anything other than the service role.

How role is decided on first sign-in:

1. `/api/provision-self` validates the JWT and reads the auth user's email
2. If the email is in `ADMIN_EMAIL_ALLOWLIST` → role `admin`
3. Else if the email is in `TEACHER_EMAIL_ALLOWLIST` → role `teacher` (also creates a `teachers` row)
4. Otherwise → role `student`, status `awaiting_assignment`

Configure both env vars in Vercel before pilot teachers sign in:

```bash
cd /Users/samuelbennett/Desktop/reading-academy
npx vercel env add TEACHER_EMAIL_ALLOWLIST production
# paste a comma-separated list: alice@school.edu,bob@gmail.com
npx vercel env add ADMIN_EMAIL_ALLOWLIST production
# usually just your email: samuel.bennett425@gmail.com
npx vercel --prod   # redeploy so the function picks up the env vars
```

Anyone signing in whose email isn't in either list lands on the **"Account created — awaiting roster assignment"** screen until a teacher invites them via the roster (M13). For v1 pilot, students typically don't sign in independently — they use a teacher's iPad.

If the allowlist changes mid-pilot, an existing user's role auto-updates on their next sign-in (the endpoint detects the mismatch and the service-role trigger lets the role update through).

---

## 3. Sign in as a teacher (2 min)

Two paths to first sign-in:

**Magic link** (requires SMTP — see `docs/pilot/supabase-setup.md` §9): the teacher opens `/reading/signin`, enters their email, clicks the link from their inbox.

**Password** (works without SMTP): an admin pre-creates the user via Supabase dashboard:

1. Open https://supabase.com/dashboard/project/dtkrnyberbpfdmikpdnw/auth/users
2. Click **Add user → Create new user**
3. Enter the teacher's email + a temporary password
4. Check **Auto Confirm User**
5. Click **Create user**
6. The teacher opens `/reading/signin` and clicks **"Use a password instead"**

Either way, the moment the teacher signs in, the SPA POSTs to `/api/provision-self`. That endpoint:
- Validates the JWT
- Creates a `user_profiles` row with `role = 'teacher'`, default display name from the email's local part
- Returns the profile + linked student row (null for teachers)

**Expected on the SignIn page after a successful sign-in:**

> **Teacher account ready**
> &lt;email&gt; · **&lt;Display Name&gt;** · TEACHER
> You can create classes, add students, and view the cohort action queue. Open the roster to get started.

Click **Open roster**.

---

## 4. Create your first class (1 min)

On `/reading/roster`:

1. Click **+ New class**
2. Enter a class name (e.g., "Mrs. Lee — Reading K")
3. Pick a grade level (K / 1 / 2 / K-2 / Mixed)
4. Click **Create class**

The card refreshes immediately. The class appears with `0 students` underneath.

The insert goes through Supabase directly (RLS allows teachers to insert into `teacher_classes` with `teacher_user_id = auth.uid()`). No serverless function needed.

---

## 5. Add students (1 min per student)

For each student in the new class:

1. Click **+ Add student** under the class card
2. Enter the student's display name (PII-light — first name + last initial, or whatever you'd write on a folder)
3. Optionally pick a grade level (defaults to the class's grade)
4. Click **Add**

The form POSTs to `/api/provision-student`, which:
- Validates the caller is a teacher
- Confirms the class belongs to the caller
- Inserts a row in `students` (without `auth_user_id` — that comes when a student is invited to sign in, M13)
- Inserts a `class_memberships` row in the same call

The student appears in the roster table within ~1 second.

---

## 6. Verify the cohort flows (3 min)

Once a class has students:

1. Go to `/reading/actions`
2. Use the **Filter by class** dropdown to scope to your new class
3. Confirm the action queue shows actions for those students (or "no actions right now" if they have no model data yet — that's expected for freshly-added students)

Then test isolation: the dashboard at `/reading/debug` should still show only your own data, not your students'. Teachers can read student data on the roster + actions pages because RLS allows it via the `teacher_can_see_student()` function — but the per-student "deep dive" surface (`/reading/debug`) is currently scoped to the signed-in user's own model. Per-student deep-dive views land in M13.

---

## 7. Class CRUD + invites (M13)

All these are now UI-driven from `/reading/roster`. SQL fallbacks remain in §11.

### Per-class controls (top-right of each class card)
- **Rename** — inline editor; saves on Enter
- **Archive** — confirm-tap (4-second window); archived classes disappear from the roster but their data survives

### Per-student controls (rightmost column of each student row)
- **Invite** — calls `/api/create-student-invite`, returns a single-use URL
- **Remove** — confirm-tap; removes the student from this class without deleting their student record

### Inviting a student to sign in
1. On the roster page, click **Invite** in the student's row
2. The page renders the invite URL — click **Copy link**
3. Send it to the parent / student via the school's preferred channel
4. The student opens the link → lands on `/reading/signin?invite=<token>` → signs in (magic link or password)
5. The SignIn page detects the token, calls `/api/claim-student-invite`, links the new auth user to the pre-existing student row, and the role flips to **STUDENT** with the linked student name visible

Invite tokens:
- Single-use (claimed_at gates re-use)
- 14-day expiry by default
- Revocable via `update student_invites set revoked_at = now() where invite_id = '...'`
- Server-generated cryptographic random (32 bytes hex) — clients don't pick the token

### Per-student deep-dive
Clicking a student name in the roster opens `/reading/student/<studentId>` — a teacher-only deep-dive with that student's insights, action queue, today's plan, fluency charts, and full per-node table. RLS-gated; non-teachers can't open it for students they don't own.

### Multi-class enrollment (M14-A)
Each class card has a **+ Enroll existing student** picker that lists every student already in your roster (across all your classes) who isn't yet in this class. Pick one → Enroll. A student in two classes shows up in both cohort views and inherits any class-scoped settings independently.

### Bulk add via CSV (M14-D)
For onboarding a whole roster at once. Each class card has **+ Bulk add (CSV)** — paste a CSV (or upload a file) with these headers:

```
display_name,grade_level
Alice S.,K
Bob T.,K
Charlie U.,1
```

Click **Create + invite**. The endpoint creates each student, enrolls them in this class, and mints a single-use invite URL. The result panel shows a **⤓ Download invite-URL CSV** button — that file has one row per student with an `invite_url` column ready to mail-merge into a parent email.

Limits: 50 students per batch (size cap), 30-day max expiry on the minted invites. Per-row failures don't abort the batch — partial successes return 207 with the per-row breakdown.

### Archived classes (M14-B)
Below the active classes a card titled **Archived classes (N)** appears whenever you have any. Click **Show** to expand. Each archived class has:
- **Unarchive** — single click; reactivates the class, restoring it to the main roster
- **Delete** — confirm-twice gate (two clicks within 5 seconds); permanently removes the class and its memberships. Student records survive.

---

## 8. Verify isolation — the student path (5 min)

Sign out of the teacher account. Sign in as a student (or anonymously). Open `/reading/debug`. You should see:

- Only your own data
- The cognitive profile only for your own student row
- Your own action queue

The teacher's data, other classmates' data, and any cross-class students should not appear.

---

## 9. RLS smoke-test from SQL (3 min)

Confirm policies are doing what they should. As the `anon` role (no JWT), every read should return zero rows:

```sql
set role anon;
select count(*) from public.teacher_classes;
select count(*) from public.class_memberships;
select count(*) from public.reading_skill_attempts;
select count(*) from public.user_profiles;
reset role;
```

Simulate a specific auth user (uses the SQL editor's superuser to set the JWT claim):

```sql
set local request.jwt.claim.sub = '<teacher-auth-user-id>';
set local role authenticated;

select count(*) from public.teacher_classes;
select count(*) from public.class_memberships;
select count(*) from public.students;
select count(*) from public.user_profiles where auth_user_id = '<teacher-auth-user-id>';

reset role;
```

---

## 10. Manual smoke-test checklist (M12-A8)

After the migrations apply and the steps above complete, walk through this list. Each box should pass before declaring the feature pilot-ready.

### Teacher account provisioning
- [ ] Teacher signs in (magic link or password) → `/reading/signin` shows **"Teacher account ready"**
- [ ] Sync status reads `teacher_ready` (visible in the small `sync status:` line)
- [ ] Role chip on the SignIn page reads **TEACHER** (in blue)
- [ ] CTAs visible: **Open roster** + **Open actions**
- [ ] Header shows `Signed in · <name>`
- [ ] `user_profiles` row exists with `role = 'teacher'`
- [ ] `teachers` row exists with the same `auth_user_id`
- [ ] Both rows reference the pilot organization (`organization_id` not null)

### Role boundary
- [ ] An email NOT in `TEACHER_EMAIL_ALLOWLIST` signs in → SignIn shows **"Account created — awaiting roster assignment"** with role chip **STUDENT** (green)
- [ ] CTAs for the student account are limited to **Continue learning** — no roster / actions buttons
- [ ] Adding the student's email to `TEACHER_EMAIL_ALLOWLIST`, redeploying, and signing in again promotes them — role chip flips to **TEACHER** within one round trip
- [ ] Removing the email demotes them on next sign-in
- [ ] Attempting to UPDATE `user_profiles.role` from a regular client (e.g., devtools) fails with the role-lock trigger error

### Admin account
- [ ] An email in `ADMIN_EMAIL_ALLOWLIST` signs in → role chip **ADMIN** (purple)
- [ ] CTAs include **Open roster**, **Open actions**, **Teacher dashboard**

### Student invites (M13-B)
- [ ] Click **Invite** on a student row → invite URL appears
- [ ] **Copy link** copies to clipboard
- [ ] Open the URL in an incognito window → SignIn page shows "You've been invited to a class" banner
- [ ] Sign in (any email) → banner flips to "Invite accepted!" with the student name
- [ ] Role chip on SignIn becomes **STUDENT**, linked student row is displayed
- [ ] Re-using the same invite URL after claim → "invite already claimed" error
- [ ] Expired token (>14 days) → "invite expired" error

### Per-student deep-dive (M13-A)
- [ ] Click a student name in the roster → opens `/reading/student/<id>`
- [ ] Page loads insights, action queue, fluency, all-nodes table for THAT student
- [ ] Actions can be marked complete from this page (writes to reading_action_completions)
- [ ] A non-teacher signed in cannot load `/reading/student/<some-other-students-id>` (RLS rejects the read)

### Class CRUD (M13-C)
- [ ] **Rename** on a class header → inline editor → Save persists the new name
- [ ] **Archive** → confirm-tap → class disappears from the roster

### Multi-class + bulk + delete (M14)
- [ ] Each class card shows **+ Enroll existing student** when other-class students exist
- [ ] Picker excludes students already in this class
- [ ] Enrolling a student in a second class makes them appear in both class cards
- [ ] **+ Bulk add (CSV)** opens a textarea + file picker
- [ ] CSV with `display_name,grade_level` header creates students + invites in one call
- [ ] **⤓ Download invite-URL CSV** produces a downloadable file with one invite_url per row
- [ ] Per-row failures in the bulk batch are reported in the result panel; the rest still get created
- [ ] **Archived classes** card appears beneath active classes when any exist
- [ ] **Show** expands the list; **Unarchive** reactivates a class
- [ ] **Delete** requires two clicks within 5 seconds; deletes the class + memberships; student records survive

### Class + student creation via UI
- [ ] `/reading/roster` shows a **+ New class** button
- [ ] Submitting the form creates a class without errors and refreshes the page
- [ ] Each class card has a **+ Add student** button
- [ ] Submitting that form creates a student and enrolls in one call
- [ ] No SQL editor visits required

### Cohort actions
- [ ] `/reading/actions` shows students from the teacher's roster
- [ ] **Filter by class** dropdown scopes the cohort
- [ ] Daily-capacity cap (M11-G) still works

### Student isolation
- [ ] Sign out → sign in as a student
- [ ] `/reading/debug` shows only your own data
- [ ] `/reading/roster` shows the "Sign in" panel (a student isn't a teacher unless they own a class)

### Provisioning idempotence
- [ ] Sign in twice in one session — `user_profiles` row count stays at 1
- [ ] Click **Refresh** on the SignIn page — no duplicate rows
- [ ] Race two signins from two devices — no duplicate

### Privacy posture
- [ ] Service-role key never appears in any client-side bundle (grep `dist/assets/*.js`)
- [ ] Provisioning endpoints both require the bearer JWT (no JWT → 401)
- [ ] Provisioning endpoints both validate the JWT against Supabase (forged JWT → 401)
- [ ] `/api/provision-student` rejects non-teachers (`role != 'teacher'` → 403)
- [ ] `/api/provision-student` rejects classes the caller doesn't own (→ 403)

If any box fails, the policies or the endpoints are wrong. Both migrations are idempotent and the endpoints are server-side; deploy + re-test.

---

## 11. Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| "no_student" status persists after sign-in | `/api/provision-self` not deployed or env vars missing | Confirm endpoint exists; redeploy; check `SUPABASE_SERVICE_ROLE_KEY` |
| Sign-in succeeds but no `user_profiles` row | Migration 0005 not applied | Re-run `0005_user_profiles.sql` |
| **+ New class** insert fails with permission error | `teacher_classes` RLS missing | Re-run `0004_teacher_roster.sql` |
| **+ Add student** returns 403 "teacher role required" | The teacher's `user_profiles.role` is wrong | Re-run provisioning via SignIn → Refresh |
| Magic link "Error sending confirmation email" | Supabase SMTP not configured | See `docs/pilot/supabase-setup.md` §9 or use the password path |
| Students not appearing on `/reading/actions` | RLS policies missing on `students` | Re-run `0004_teacher_roster.sql` |

---

## What this enables

After this runbook completes, a real teacher can:

- Sign in (magic link or password)
- See "Teacher account ready" — no manual SQL touched
- Create classes from the roster page
- Add students inline, no SQL editor
- See the cohort action queue scoped to a chosen class
- Mark complete / skip with one tap
- Print the daily action sheet
- All without ever seeing a student outside their roster

Combined with M11's action engine, the daily capacity cap, the cognitive profile contributions, and the LLM-polished narration, this is the surface that turns Reading Academy from "interesting prototype" into "tool a teacher uses every morning."

---

## What's still on the M13 punch list

- Per-student deep-dive view (today the `/reading/debug` page is the signed-in user's own model)
- Magic-link student invites (today's `students` rows have `auth_user_id = null` until M13)
- Multi-class enrollment from the UI
- Class rename + archive + delete from the UI
- Move-student-between-classes UI

Until M13 ships, the SQL fallbacks in §7 + §11 cover those operations.

---

## Change log

- v2.0 (2026-05-08): Replaced SQL-driven onboarding with automated provisioning (M12-A1..A8). UI handles class + student creation. SQL kept as fallback only.
- v1.0 (2026-05-08): Initial runbook. SQL-only onboarding.
