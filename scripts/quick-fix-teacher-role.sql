-- ============================================================
-- Quick-fix: promote a user with class ownership to teacher role
-- (M19-8 diagnostic / unblock)
--
-- Use this when:
--   * The teacher account exists in auth.users
--   * The seed script ran and created teacher_classes rows owned by them
--   * BUT user_profiles.role is still 'student' (because the
--     TEACHER_EMAIL_ALLOWLIST env var wasn't set on Vercel when they
--     first signed in)
--
-- IMPORTANT — Supabase SQL editor caveats:
--   (1) The SQL editor connects as the `postgres` superuser, not as
--       `service_role`. The `user_profiles_role_lock` trigger (M12-A1)
--       raises "role changes require service-role access" when
--       `auth.role()` isn't `service_role`. To unblock, switch the
--       session role for the transaction:
--           set local role service_role;
--       That call is included in Step 2 below. Do not remove it.
--
--   (2) After `set local role service_role`, this session loses
--       postgres privileges. In some projects `service_role` does
--       NOT have SELECT on `auth.users`, so any join through
--       auth.users will fail with "permission denied for table users".
--       This file avoids that join by accepting the auth user UUIDs
--       directly (paste them into the variables in Step 2 below;
--       grab them from Supabase Dashboard → Authentication → Users).
--
--   FASTEST ALTERNATIVE TO THIS SQL: re-run
--       node scripts/seed-test-accounts.js
--   It goes through supabase-js (which uses PostgREST, has the
--   right grants, and bypasses the role-lock trigger correctly).
--   This SQL exists only for when you can't run Node.

-- Step 0 — Confirm the class is connected to that auth user:
-- ----------------------------------------------------------------
select
  tc.id,
  tc.name,
  tc.class_code,
  tc.teacher_user_id,
  u.email
from public.teacher_classes tc
left join auth.users u on u.id = tc.teacher_user_id
where u.email = 'teacher@test.readingacademy.local';

-- Expected: one row, name='Test Class A', class_code='TEST1'.
-- If no rows: the seed didn't run, or it used a different teacher user id.
-- Re-run `node scripts/seed-test-accounts.js` and recheck.

-- Step 1 — Show current profile state for the teacher:
-- ----------------------------------------------------------------
select up.auth_user_id, u.email, up.role, up.display_name, up.organization_id
from public.user_profiles up
join auth.users u on u.id = up.auth_user_id
where u.email = 'teacher@test.readingacademy.local';

-- Step 2 — Promote to teacher + admin in one transaction.
-- This SQL does NOT join auth.users (service_role may lack SELECT
-- on it). Paste each user's UUID into the placeholders below.
-- Find them in Supabase Dashboard → Authentication → Users
-- (the "User UID" column).
-- ----------------------------------------------------------------
begin;
set local role service_role;

-- ↓↓↓ REPLACE THESE TWO UUIDS ↓↓↓
-- teacher@test.readingacademy.local:
update public.user_profiles
   set role = 'teacher', updated_at = now()
 where auth_user_id = '<TEACHER_AUTH_UID_HERE>'::uuid
   and role <> 'teacher';

-- admin@test.readingacademy.local:
update public.user_profiles
   set role = 'admin', updated_at = now()
 where auth_user_id = '<ADMIN_AUTH_UID_HERE>'::uuid
   and role <> 'admin';
-- ↑↑↑ REPLACE THESE TWO UUIDS ↑↑↑

-- Step 3 — Ensure a teachers row exists for the teacher account
-- (mirror of upsertTeacherRow in the seed script):
insert into public.teachers (auth_user_id, display_name, organization_id)
values (
  '<TEACHER_AUTH_UID_HERE>'::uuid,
  'Test Teacher',
  (select id from public.organizations where slug = 'vpa-pilot')
)
on conflict (auth_user_id) do update
   set display_name = excluded.display_name,
       organization_id = excluded.organization_id,
       updated_at = now();

commit;

-- Step 4 — Verify roles are now correct:
-- ----------------------------------------------------------------
-- service_role can read user_profiles via PostgREST grants, no
-- auth.users join needed.
select auth_user_id, role, display_name, updated_at
from public.user_profiles
where auth_user_id in (
  '<TEACHER_AUTH_UID_HERE>'::uuid,
  '<ADMIN_AUTH_UID_HERE>'::uuid
);

-- Step 5 — In the teacher browser, sign out and back in (or click
-- the Refresh button on the SignIn page) to pick up the new role.
-- The SignIn page should now show "Teacher account ready" and the
-- "Open roster" button. /reading/roster should show Test Class A
-- with three students.
