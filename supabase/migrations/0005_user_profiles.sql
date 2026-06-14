-- ================================================================
-- VPA Learning OS — user_profiles (M12-A1)
--
-- Single explicit "who is this auth user" record. Lets the SPA
-- answer "am I a teacher? a student? unassigned?" without inferring
-- from side tables (students, teacher_classes, …).
--
-- Provisioning policy:
--   - Self-serve sign-up via SignIn → role defaults to 'teacher'.
--   - Students are created by a teacher through /api/provision-student;
--     they may or may not have an auth.users row immediately. When
--     they do (later magic-link invite), their user_profile is created
--     by /api/provision-self and the role is set explicitly.
--   - 'admin' and 'parent' roles are reserved for future use.
--
-- Idempotent. Safe to re-run.
-- ================================================================

create table if not exists public.user_profiles (
  auth_user_id   uuid primary key references auth.users(id) on delete cascade,
  role           text not null
    check (role in ('teacher', 'student', 'admin', 'parent')),
  display_name   text,
  organization   text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists user_profiles_role_idx
  on public.user_profiles (role);

-- Helper: returns the role of the calling auth user, or null if no
-- profile row exists yet (i.e. they haven't been provisioned).
create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.user_profiles where auth_user_id = auth.uid() limit 1;
$$;

-- Helper: returns true iff the calling auth user has role 'teacher'
-- or 'admin'. Useful inside RLS policies that grant write access.
create or replace function public.is_teacher()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role in ('teacher', 'admin') from public.user_profiles where auth_user_id = auth.uid()),
    false
  );
$$;

-- ================================================================
-- Row-Level Security
-- ================================================================

alter table public.user_profiles enable row level security;

-- Self-read: every signed-in user can read their own profile.
drop policy if exists user_profiles_self_select on public.user_profiles;
create policy user_profiles_self_select
  on public.user_profiles for select
  using (auth_user_id = auth.uid());

-- Teacher-read: a teacher can read profiles of students in their roster.
-- Useful for the roster page to label rows.
drop policy if exists user_profiles_teacher_select on public.user_profiles;
create policy user_profiles_teacher_select
  on public.user_profiles for select
  using (
    exists (
      select 1
      from public.students s
      where s.auth_user_id = user_profiles.auth_user_id
        and public.teacher_can_see_student(s.id)
    )
  );

-- Self-update: a user can change their own display_name only.
-- Role changes go through admin-only paths (not exposed in v1).
drop policy if exists user_profiles_self_update on public.user_profiles;
create policy user_profiles_self_update
  on public.user_profiles for update
  using (auth_user_id = auth.uid())
  with check (
    auth_user_id = auth.uid()
    -- The role check below is enforced by the API path; row-level
    -- update policies can't directly compare new vs old, but the
    -- /api/provision-self endpoint never accepts a role override
    -- from clients. Defense in depth via the trigger below.
  );

-- Defense in depth: a trigger that raises if a non-service-role
-- update tries to change the role column.
create or replace function public.user_profiles_role_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'UPDATE' and old.role is distinct from new.role then
    -- auth.role() is 'service_role' for service-key writes; allow those.
    if coalesce(auth.role(), '') <> 'service_role' then
      raise exception 'role changes require service-role access';
    end if;
  end if;
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_profiles_role_lock_trigger on public.user_profiles;
create trigger user_profiles_role_lock_trigger
  before update on public.user_profiles
  for each row execute procedure public.user_profiles_role_lock();

-- Inserts go through the /api/provision-self serverless function
-- (service-role). No client-side INSERT policy is granted.

-- ================================================================
-- Done.
-- ================================================================
