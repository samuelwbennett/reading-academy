# Reading Academy — Role-based account testing

> Set up three test accounts (admin / teacher / student), verify each role sees only what it should, and run the full end-to-end flow without guessing.

## TL;DR

```
# 1. Apply migrations (Supabase project dashboard or CLI)
supabase db push        # OR paste each supabase/migrations/*.sql into the SQL editor

# 2. Create two Auth users in Supabase Dashboard → Authentication → Users
#       admin@test.readingacademy.local
#       teacher@test.readingacademy.local
#    Set passwords you can remember. The seed script does not touch passwords.

# 3. Add both emails to the allowlist env vars (Vercel project settings,
#    or .env.local for dev):
#       ADMIN_EMAIL_ALLOWLIST="admin@test.readingacademy.local"
#       TEACHER_EMAIL_ALLOWLIST="teacher@test.readingacademy.local"

# 4. Run the seed (idempotent):
SEED_DEMO_PINS=1 \
SUPABASE_URL=... \
SUPABASE_SERVICE_ROLE_KEY=... \
node scripts/seed-test-accounts.js
```

You now have:

| Role | How they sign in | Credentials |
|---|---|---|
| Admin | `/reading/signin` email + password | `admin@test.readingacademy.local` / your password |
| Teacher | `/reading/signin` email + password | `teacher@test.readingacademy.local` / your password |
| Student (Ava) | `/student` class code + avatar + PIN | code `TEST1`, avatar 🦊, PIN `1111` |
| Student (Ben) | `/student` | code `TEST1`, avatar 🐶, PIN `2222` |
| Student (Mia) | `/student` | code `TEST1`, avatar 🌟, PIN `3333` |

The class is **Test Class A**, owned by the teacher account, code `TEST1`. All three students are enrolled.

---

## What lives where

| Concern | Storage | Surfaced via |
|---|---|---|
| Adult login | Supabase Auth (`auth.users`) | `useAuth()` |
| Adult product role | `public.user_profiles.role` ∈ {`teacher`, `student`, `admin`, `parent`} | `useAuth().profile.role` |
| Student identity | `public.students` (no auth row required) | API endpoints |
| Student session | `public.student_sessions` (token sha256 hash only) | `useStudentSession()` |
| Class ownership | `public.teacher_classes.teacher_user_id` = auth.uid() | RLS + `teacher_can_see_student()` |
| Class roster | `public.class_memberships` (M:N) | RLS + `teacher_can_see_student()` |
| Class code | `public.teacher_classes.class_code` (5-char unique) | `/api/class-set-code`, `/api/student-roster-by-code` |

**The authoritative security boundary is Postgres RLS.** React route guards exist for UX (don't show a teacher zero-state to a student); the actual data fence is in SQL. Migrations to review:

- `0004_teacher_roster.sql` — teacher_classes, class_memberships, `teacher_can_see_student()`, `is_teacher()`
- `0005_user_profiles.sql` — user_profiles, role lock trigger, `current_user_role()`
- `0006_role_architecture.sql` — organizations, teachers, org_id columns
- `0008_student_passwordless_auth.sql` — student passwordless columns + student_sessions

---

## Step 1 — Apply migrations

If your Supabase project hasn't seen one of these yet, paste it into the SQL editor (Supabase Dashboard → SQL → New query), or run `supabase db push` if you have the CLI configured.

All migrations are idempotent (`if not exists` everywhere). Safe to re-run after each deploy.

---

## Step 2 — Create the two Auth users

Reading Academy decides role based on the user's email at first sign-in:

1. Supabase Dashboard → Authentication → Users → **Add user → Create new user**.
2. Email `admin@test.readingacademy.local`. Pick any password ≥ 6 chars. Tick "Auto Confirm User" so you don't need to click an email link.
3. Repeat for `teacher@test.readingacademy.local`.

**Never reuse these credentials in production.** They exist solely so we can test the three-role flow on staging/dev without registering real teachers.

---

## Step 3 — Allowlist env vars

In Vercel (Project Settings → Environment Variables) or your `.env.local`:

```bash
ADMIN_EMAIL_ALLOWLIST="admin@test.readingacademy.local"
TEACHER_EMAIL_ALLOWLIST="teacher@test.readingacademy.local"
```

These drive `api/_handlers/provision-self.js`. When a user signs in:

- Email in `ADMIN_EMAIL_ALLOWLIST` → `user_profiles.role = 'admin'`
- Else email in `TEACHER_EMAIL_ALLOWLIST` → `user_profiles.role = 'teacher'`
- Else → `user_profiles.role = 'student'`

The role assignment is server-side. Clients can't pick it. Multiple emails can be listed (whitespace OR comma-separated).

---

## Step 4 — Run the seed

```bash
SEED_DEMO_PINS=1 \
SUPABASE_URL="https://<your-project>.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="<service role key>" \
node scripts/seed-test-accounts.js
```

`SEED_DEMO_PINS=1` is the safety latch — without it the script refuses to plant weak PINs. `NODE_ENV=development` also unlocks it.

Expected output:

```
→ Looking up test Auth users…
   admin    admin@test.readingacademy.local    <uuid>
   teacher  teacher@test.readingacademy.local  <uuid>
→ Ensuring pilot organization…
→ Upserting user_profiles…
→ Upserting teachers row…
→ Upserting test class…
   class    Test Class A  <uuid>  code=TEST1
→ Upserting students…
   student  Ava A.  <uuid>  pin=1111
   student  Ben B.  <uuid>  pin=2222
   student  Mia M.  <uuid>  pin=3333
→ Enrolling students in test class…

✓ Seed complete.
```

Idempotent. Re-running produces the same UUIDs (students keyed on `first_name + last_initial + created_by_teacher`).

---

## Step 5 — Run the three logins

Open three browser windows / profiles so the sessions don't bleed.

### Window 1 — Admin (normal Chrome)

1. Go to `/reading/signin`.
2. Sign in as `admin@test.readingacademy.local`.
3. Should land on `/reading`.
4. Open the Debug page at `/reading/debug` — the new **Account / role verification** panel should show:
   - Resolved role: **admin**
   - Student session: none
   - All teacher routes: ✓ allowed
5. `/reading/roster` should load. Admin sees only classes they explicitly own via `teacher_user_id`; in this seed admin owns nothing, so the roster will be empty.  ✓ (admin's omnipotence here is via service-role admin tooling, not class ownership — that distinction is intentional.)

### Window 2 — Teacher (Chrome Incognito)

1. Go to `/reading/signin`.
2. Sign in as `teacher@test.readingacademy.local`.
3. `/reading/roster` should show **Test Class A** with three students.
4. Click the **Get class code** button if the code isn't already shown — it should already say `TEST1`.
5. Under the per-class panel, expand **Set PINs and avatars** — three students with avatars.
6. Try `/reading/student/<student-id>` — works. Try `/reading/debug` — works (shows "Resolved role: teacher").
7. Try clicking any URL that hits `auth.users` you don't own → RLS returns zero rows.

### Window 3 — Student (different Incognito profile / private window)

1. Go to `/student`.
2. Type `TEST1` → tap **Next**.
3. The avatar grid shows Ava 🦊, Ben 🐶, Mia 🌟. Tap Ava.
4. Type `1111` on the keypad → submits automatically.
5. Lands on `/reading` as Ava (the Today header shows "Hi, Ava").
6. Try `/reading/roster` → see the **Not authorized** panel (RequireRole + the passwordless session forces a redirect to `/reading`).
7. Try `/reading/debug` → same — redirected.
8. The mic-driven drill works as Ava; mastery state writes to `localStorage` under the device-anonymous key for now.

---

## Permission expectations

| Action | Admin | Teacher | Student | Anonymous |
|---|---|---|---|---|
| `/student` | ✓ | ✓ | ✓ (already signed in → redirect to `/reading`) | ✓ |
| `/reading` | ✓ | ✓ | ✓ | ✓ |
| `/reading/diagnostic`, `/drill`, `/passage`, `/fluency` | ✓ | ✓ | ✓ | ✓ |
| `/reading/signin` | (already signed in) | (already signed in) | ✓ | ✓ |
| `/reading/roster` | ✓ (sees own classes — RLS) | ✓ (sees own classes) | ✗ blocked | ✗ signed-out fallback |
| `/reading/debug` | ✓ | ✓ | ✗ blocked | ✗ signed-out fallback |
| `/reading/actions` | ✓ | ✓ | ✗ blocked | ✗ signed-out fallback |
| `/reading/student/:id` | ✓ (RLS still applies — sees only assigned students) | ✓ | ✗ blocked | ✗ signed-out fallback |
| Create class | ✓ | ✓ | n/a — RLS blocks INSERT | n/a |
| Rotate class code via `/api/class-set-code` | ✓ (only own classes) | ✓ (only own classes) | 403 — not_class_owner | 401 |
| Rotate student PIN via `/api/student-set-pin` | ✓ (only visible students) | ✓ (only visible students) | 403 — student_not_in_caller_classes | 401 |
| Cross-teacher visibility | ✗ — RLS sees only `teacher_user_id = auth.uid()` | ✗ same | ✗ | ✗ |

The four-row block at the bottom is the most-tested boundary: **a teacher cannot see another teacher's classes, students, or progress**, regardless of whether the SPA tried to fetch them. RLS is the wall.

---

## Troubleshooting

| Symptom | Probable cause | Fix |
|---|---|---|
| Seed script "auth user not found" | You haven't created the user in Supabase Dashboard yet | Auth → Users → Add user (see Step 2) |
| Seed script "refusing to seed weak demo PINs" | Production safety latch | Add `SEED_DEMO_PINS=1` to the env. Never set this in prod. |
| Admin/teacher login lands with role `student` | Email not in the right allowlist when the JWT was minted | Add the email to `ADMIN_EMAIL_ALLOWLIST` / `TEACHER_EMAIL_ALLOWLIST`, then sign out and sign back in (provision-self re-runs and updates the role row via service-role write) |
| `/api/student-login` returns 401 `bad_credentials` | PIN mismatch OR student not in that class OR student inactive | Use the **Account / role verification** panel in `/reading/debug` to confirm class membership and is_active |
| `/api/student-login` returns 404 `unknown_class_code` | Code never minted, or class archived | Sign in as teacher → roster panel → **Get class code** |
| `/api/student-session` returns 410 `session_expired` | Token past 30-day TTL | Student re-runs `/student` flow. Sessions older than 30 days are auto-expired by the schema default. |
| `/reading/roster` empty for the teacher | RLS sees no rows because `teacher_user_id != auth.uid()` for any class | Re-run `seed-test-accounts.js`. Or check Supabase Auth ID matches what's in `teacher_classes.teacher_user_id`. |
| `/reading/roster` empty for the admin | Admin owns no classes in seed | This is by design — admin gets RLS visibility through their own class ownership only, not by virtue of being admin. A future migration could add an `admin_can_see_all_classes()` RLS escape hatch if you want that. |
| Manual UPDATE of `user_profiles.role` in Supabase SQL editor errors `P0001: role changes require service-role access` | The `user_profiles_role_lock` trigger blocks role changes from non-service-role sessions; the SQL editor connects as `postgres`, not `service_role` | Wrap your UPDATE in `begin; set local role service_role; … commit;`. See `scripts/quick-fix-teacher-role.sql` for the exact recipe. |
| Student session sticks across browser refresh BUT teacher routes "Not authorized" | `useStudentMode()` correctly forces student chrome whenever a passwordless session exists | Sign out the student session: open DevTools → Application → Local Storage → delete `ra:student-session` key |
| Build warnings about missing env in `/api/*` | Vercel project missing `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Vercel → Project Settings → Environment Variables. Don't expose the service-role key client-side. |
| Print roster shows `—` for PIN | PINs are only displayed in-session at rotation time. Click **Rotate PIN** before printing | Working as designed |

---

## Security checklist before going to prod

- [ ] **Demo PINs deleted**. The seed script's `1111` / `2222` / `3333` are dev-only. Use the roster panel's **Rotate PIN** to generate real PINs before pilot.
- [ ] **Demo emails removed**. `admin@test.readingacademy.local` and `teacher@test.readingacademy.local` should be deactivated or deleted in Supabase Auth.
- [ ] **Service-role key never in client bundle**. Only on Vercel server env. Grep the build artifact: `grep -r 'service_role' dist/` should return nothing.
- [ ] **`SEED_DEMO_PINS` not set in prod env**. Otherwise a future careless re-run could plant demo PINs in real data.
- [ ] **Class codes rotated** if any printed roster sheet was photographed / shared / lost.
- [ ] **Parent email collected for consent only**, never for student login (already enforced — no code path uses `parent_email` to log in).
- [ ] **Rate-limit middleware in front of `/api/student-roster-by-code` and `/api/student-login`** before opening to public traffic. Currently unlimited; the 28^5 ≈ 17 M class-code space provides some protection but it's not a substitute for rate-limiting.

---

## Where the code lives

| File | Purpose |
|---|---|
| `src/lib/auth/AuthProvider.jsx` | Supabase session + role provisioning bridge |
| `src/lib/auth/RequireRole.jsx` | Route-level role guard (M19-3) |
| `src/lib/auth/useStudentSession.js` | Passwordless student session hook (M16-L5) |
| `src/lib/auth/useStudentMode.js` | UI mode resolver — student vs teacher chrome |
| `api/_handlers/provision-self.js` | Role assignment on first sign-in |
| `api/_handlers/student-login.js` | Passwordless student login (verifies PIN, mints session) |
| `api/_handlers/student-session.js` | Validates a session token |
| `api/_handlers/student-set-pin.js` | Teacher rotates a student's PIN |
| `api/_handlers/class-set-code.js` | Teacher mints/rotates the class code |
| `api/_handlers/_lib/student-auth.js` | scrypt PIN hashing + token generation + class-code alphabet |
| `scripts/seed-test-accounts.js` | This document's prerequisite seed (M19-2) |
| `supabase/migrations/0004…0008` | The five role/student migrations |
