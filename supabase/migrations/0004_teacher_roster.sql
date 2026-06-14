-- ================================================================
-- VPA Learning OS — Teacher / Roster permissions (M12-A + M12-B)
--
-- Design rules (do not break):
--   1. Explicit relationship tables. No JSON permission soup.
--   2. RLS-enforced. No service-role exposure to the SPA.
--   3. Students stay self-only. Teachers extend visibility, never
--      replace student access.
--   4. LLMs do not influence permissions. Policies live in SQL.
--   5. PII stays out of these tables. Names + grades only on
--      students; this migration adds class membership, nothing more.
--
-- One teacher → many classes → many students. A student can be in
-- multiple classes (e.g., reading group + math group). Teachers see
-- a student iff a class they own contains that student.
--
-- Idempotent. Safe to re-run.
-- ================================================================

-- ---- teacher_classes ---------------------------------------------
-- One row per class. The teacher_user_id is the auth.users.id of the
-- person who owns the class.

create table if not exists public.teacher_classes (
  id              uuid primary key default gen_random_uuid(),
  teacher_user_id uuid not null references auth.users(id) on delete cascade,
  name            text not null,
  grade_level     text,                -- "K", "1", "2", "1-2", etc.
  archived        boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists tc_teacher_idx
  on public.teacher_classes (teacher_user_id);
create index if not exists tc_active_idx
  on public.teacher_classes (teacher_user_id) where archived = false;

-- ---- class_memberships -------------------------------------------
-- Many-to-many between classes and students. Composite primary key
-- enforces "one membership per (class, student)".

create table if not exists public.class_memberships (
  class_id    uuid not null references public.teacher_classes(id) on delete cascade,
  student_id  uuid not null references public.students(id) on delete cascade,
  joined_at   timestamptz not null default now(),
  primary key (class_id, student_id)
);

create index if not exists cm_student_idx
  on public.class_memberships (student_id);
create index if not exists cm_class_idx
  on public.class_memberships (class_id);

-- ================================================================
-- Helper functions
-- ================================================================

-- Recreate to keep this migration self-contained (idempotent).
create or replace function public.current_student_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.students where auth_user_id = auth.uid() limit 1;
$$;

-- True iff the calling auth user owns a class that contains the
-- given student. Security-definer so RLS policies on the underlying
-- tables don't recurse.
create or replace function public.teacher_can_see_student(target_student_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.class_memberships cm
    join public.teacher_classes tc on tc.id = cm.class_id
    where cm.student_id = target_student_id
      and tc.teacher_user_id = auth.uid()
      and tc.archived = false
  );
$$;

-- Convenience wrapper a UI can call: returns the array of student
-- ids the calling teacher can see. Used by the roster + actions
-- routes when they need a definitive list (RLS-filtered selects
-- still work, but this is faster than a join via the SPA).
create or replace function public.teacher_assigned_student_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select distinct cm.student_id
  from public.class_memberships cm
  join public.teacher_classes tc on tc.id = cm.class_id
  where tc.teacher_user_id = auth.uid()
    and tc.archived = false;
$$;

-- ================================================================
-- Row-Level Security on the new tables
-- ================================================================

alter table public.teacher_classes    enable row level security;
alter table public.class_memberships  enable row level security;

-- teacher_classes: only the owning teacher can see / mutate.
drop policy if exists tc_owner_select on public.teacher_classes;
drop policy if exists tc_owner_insert on public.teacher_classes;
drop policy if exists tc_owner_update on public.teacher_classes;
drop policy if exists tc_owner_delete on public.teacher_classes;

create policy tc_owner_select
  on public.teacher_classes for select
  using (teacher_user_id = auth.uid());

create policy tc_owner_insert
  on public.teacher_classes for insert
  with check (teacher_user_id = auth.uid());

create policy tc_owner_update
  on public.teacher_classes for update
  using (teacher_user_id = auth.uid())
  with check (teacher_user_id = auth.uid());

create policy tc_owner_delete
  on public.teacher_classes for delete
  using (teacher_user_id = auth.uid());

-- class_memberships: the owning teacher of the class can see and
-- mutate; the student themselves can read their own memberships
-- (so they can see what classes they're in).
drop policy if exists cm_owner_select  on public.class_memberships;
drop policy if exists cm_self_select   on public.class_memberships;
drop policy if exists cm_owner_insert  on public.class_memberships;
drop policy if exists cm_owner_delete  on public.class_memberships;

create policy cm_owner_select
  on public.class_memberships for select
  using (
    exists (
      select 1 from public.teacher_classes tc
      where tc.id = class_memberships.class_id
        and tc.teacher_user_id = auth.uid()
    )
  );

create policy cm_self_select
  on public.class_memberships for select
  using (student_id = public.current_student_id());

create policy cm_owner_insert
  on public.class_memberships for insert
  with check (
    exists (
      select 1 from public.teacher_classes tc
      where tc.id = class_memberships.class_id
        and tc.teacher_user_id = auth.uid()
    )
  );

create policy cm_owner_delete
  on public.class_memberships for delete
  using (
    exists (
      select 1 from public.teacher_classes tc
      where tc.id = class_memberships.class_id
        and tc.teacher_user_id = auth.uid()
    )
  );

-- ================================================================
-- Extend RLS on existing tables so teachers can see assigned
-- students. Drop-and-recreate is idempotent and lets us re-run.
-- Student self-only policies stay in place; teacher policies are
-- additive.
-- ================================================================

-- ---- students ----------------------------------------------------
-- Self-read may already exist via the original schema; we add the
-- teacher-read variant.
alter table public.students enable row level security;

drop policy if exists students_self_select   on public.students;
drop policy if exists students_teacher_select on public.students;

create policy students_self_select
  on public.students for select
  using (auth_user_id = auth.uid());

create policy students_teacher_select
  on public.students for select
  using (public.teacher_can_see_student(id));

-- ---- student_app_accounts ---------------------------------------
alter table public.student_app_accounts enable row level security;

drop policy if exists saa_self_select    on public.student_app_accounts;
drop policy if exists saa_teacher_select on public.student_app_accounts;
drop policy if exists saa_self_upsert    on public.student_app_accounts;

-- Self: the student row's auth user can read + upsert (this is what
-- the SPA's storage.js / sync.ts already relies on).
create policy saa_self_select
  on public.student_app_accounts for select
  using (
    student_id = public.current_student_id()
  );

create policy saa_self_upsert
  on public.student_app_accounts for insert
  with check (student_id = public.current_student_id());

-- A separate update policy so existing rows can be modified.
drop policy if exists saa_self_update on public.student_app_accounts;
create policy saa_self_update
  on public.student_app_accounts for update
  using (student_id = public.current_student_id())
  with check (student_id = public.current_student_id());

-- Teacher: read-only across assigned students. No write (state is
-- the student's; teachers should never mutate it through the SPA).
create policy saa_teacher_select
  on public.student_app_accounts for select
  using (public.teacher_can_see_student(student_id));

-- ---- student_cognitive_profiles ---------------------------------
-- (M10-H) — extend self-only with teacher read.
alter table public.student_cognitive_profiles enable row level security;

drop policy if exists scp_teacher_select on public.student_cognitive_profiles;
create policy scp_teacher_select
  on public.student_cognitive_profiles for select
  using (public.teacher_can_see_student(student_id));

-- ---- reading_skill_attempts -------------------------------------
-- (M5-B) — teachers can read their roster's history.
alter table public.reading_skill_attempts enable row level security;

drop policy if exists reading_skill_attempts_teacher_select on public.reading_skill_attempts;
create policy reading_skill_attempts_teacher_select
  on public.reading_skill_attempts for select
  using (public.teacher_can_see_student(student_id));

-- ---- reading_passage_attempts -----------------------------------
alter table public.reading_passage_attempts enable row level security;

drop policy if exists reading_passage_attempts_teacher_select on public.reading_passage_attempts;
create policy reading_passage_attempts_teacher_select
  on public.reading_passage_attempts for select
  using (public.teacher_can_see_student(student_id));

-- ---- reading_mastery_snapshots ----------------------------------
alter table public.reading_mastery_snapshots enable row level security;

drop policy if exists reading_mastery_snapshots_teacher_select on public.reading_mastery_snapshots;
create policy reading_mastery_snapshots_teacher_select
  on public.reading_mastery_snapshots for select
  using (public.teacher_can_see_student(student_id));

-- ---- reading_telemetry_events -----------------------------------
alter table public.reading_telemetry_events enable row level security;

drop policy if exists reading_telemetry_events_teacher_select on public.reading_telemetry_events;
create policy reading_telemetry_events_teacher_select
  on public.reading_telemetry_events for select
  using (public.teacher_can_see_student(student_id));

-- ---- reading_action_completions ---------------------------------
-- (M11-C) — teachers can read + write completions for their roster.
alter table public.reading_action_completions enable row level security;

drop policy if exists rac_teacher_select on public.reading_action_completions;
drop policy if exists rac_teacher_insert on public.reading_action_completions;
drop policy if exists rac_teacher_update on public.reading_action_completions;

create policy rac_teacher_select
  on public.reading_action_completions for select
  using (public.teacher_can_see_student(student_id));

create policy rac_teacher_insert
  on public.reading_action_completions for insert
  with check (public.teacher_can_see_student(student_id));

create policy rac_teacher_update
  on public.reading_action_completions for update
  using (public.teacher_can_see_student(student_id))
  with check (public.teacher_can_see_student(student_id));

-- ================================================================
-- Done. The student self-only policies from earlier migrations
-- remain in force; teacher policies are additive (Postgres OR's
-- across multiple SELECT policies on the same role).
-- ================================================================
