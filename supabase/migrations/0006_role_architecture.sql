-- ================================================================
-- VPA Learning OS — Clean role-based identity architecture (M12-B1)
--
-- Layered on top of M12-A1's user_profiles. Adds:
--   - organizations  : a school / district / family unit
--   - teachers       : teacher-specific metadata (placeholder for future
--                      fields; currently mirrors user_profiles minus role)
--   - organization_id FK on user_profiles + teacher_classes
--
-- Core principle (per the M12-B brief):
--   auth.users           = login identity (Supabase-owned)
--   user_profiles        = product role (teacher / student / admin / parent)
--   students             = learner record (auth_user_id optional)
--   teachers             = teacher-specific metadata (auth_user_id required)
--   organizations        = scoping unit for multi-tenant later
--   teacher_classes      = class/group owned by a teacher within an org
--   class_memberships    = student ↔ class M:N
--
-- Idempotent. Safe to re-run.
-- ================================================================

-- ---- organizations -----------------------------------------------

create table if not exists public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text unique,
  org_type    text check (org_type in ('school', 'district', 'family', 'pilot') or org_type is null),
  metadata    jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Seed a single 'pilot' organization so existing teachers can be
-- migrated without manual UUID juggling. Only inserts if absent.
insert into public.organizations (name, slug, org_type)
select 'VPA Pilot', 'vpa-pilot', 'pilot'
where not exists (select 1 from public.organizations where slug = 'vpa-pilot');

-- ---- teachers ----------------------------------------------------
-- One row per auth user with role 'teacher'. Joins to user_profiles
-- via auth_user_id. Currently a thin denormalization, but lets us
-- attach future teacher-only fields (license #, subjects taught,
-- subject-area certifications) without touching user_profiles.

create table if not exists public.teachers (
  auth_user_id    uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete set null,
  display_name    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists teachers_org_idx
  on public.teachers (organization_id);

-- ---- user_profiles + teacher_classes : organization_id columns ---
-- Add organization_id to existing tables. Does nothing on re-run.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_profiles' and column_name = 'organization_id'
  ) then
    alter table public.user_profiles
      add column organization_id uuid references public.organizations(id) on delete set null;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'teacher_classes' and column_name = 'organization_id'
  ) then
    alter table public.teacher_classes
      add column organization_id uuid references public.organizations(id) on delete set null;
  end if;
end $$;

create index if not exists user_profiles_org_idx
  on public.user_profiles (organization_id);
create index if not exists teacher_classes_org_idx
  on public.teacher_classes (organization_id);

-- Backfill: any existing user_profile/teacher_class without an
-- organization_id gets the pilot org.
update public.user_profiles up
   set organization_id = (select id from public.organizations where slug = 'vpa-pilot')
 where up.organization_id is null;

update public.teacher_classes tc
   set organization_id = (select id from public.organizations where slug = 'vpa-pilot')
 where tc.organization_id is null;

-- ================================================================
-- Helper functions (extend the M12-A1 set)
-- ================================================================

-- current_user_role / is_teacher already exist from 0005. Add:

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role = 'admin' from public.user_profiles where auth_user_id = auth.uid()),
    false
  );
$$;

create or replace function public.current_org_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select organization_id from public.user_profiles where auth_user_id = auth.uid() limit 1;
$$;

-- Refresh the older helper to also consider admin role.
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
-- Row-Level Security on the new tables
-- ================================================================

alter table public.organizations enable row level security;
alter table public.teachers       enable row level security;

-- organizations: a user can read their own org. Admins can read all.
drop policy if exists orgs_self_select  on public.organizations;
drop policy if exists orgs_admin_select on public.organizations;
create policy orgs_self_select
  on public.organizations for select
  using (id = public.current_org_id());
create policy orgs_admin_select
  on public.organizations for select
  using (public.is_admin());

-- Writes only via service-role (no client policy).

-- teachers: a teacher reads + updates their own row.
drop policy if exists teachers_self_select on public.teachers;
drop policy if exists teachers_self_update on public.teachers;
create policy teachers_self_select
  on public.teachers for select
  using (auth_user_id = auth.uid());
create policy teachers_self_update
  on public.teachers for update
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());

-- An admin can read any teacher row in their org.
drop policy if exists teachers_admin_select on public.teachers;
create policy teachers_admin_select
  on public.teachers for select
  using (
    public.is_admin()
    and (organization_id is null or organization_id = public.current_org_id())
  );

-- Inserts go through /api/provision-self (service-role).

-- ================================================================
-- Defense in depth: a hard role-write boundary on user_profiles.
-- 0005 already added a trigger blocking role updates from non-
-- service-role callers. Replicate the same protection on
-- organization_id changes so a client can't quietly hop orgs.
-- ================================================================

create or replace function public.user_profiles_role_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'UPDATE' then
    if old.role is distinct from new.role then
      if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'role changes require service-role access';
      end if;
    end if;
    if old.organization_id is distinct from new.organization_id then
      if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'organization changes require service-role access';
      end if;
    end if;
  end if;
  new.updated_at = now();
  return new;
end;
$$;

-- ================================================================
-- Done.
-- ================================================================
