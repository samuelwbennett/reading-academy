-- ================================================================
-- VPA Learning OS — Student Cognitive Profile (M10-H)
--
-- Owned by the orchestration layer. Reading Academy and other
-- vertical apps CONTRIBUTE evidence; the launcher merges and writes
-- the unified profile here.
--
-- Two tables:
--   - student_cognitive_profiles : current merged profile per student
--   - cognitive_contributions_log : append-only log of every per-app
--                                   contribution, for audit + replay
--
-- Idempotent. Safe to re-run.
-- ================================================================

-- ---- student_cognitive_profiles ----------------------------------
-- One row per student. The full v1 profile lives in `dimensions`
-- JSONB; convenience columns mirror common fields for indexing.

create table if not exists public.student_cognitive_profiles (
  student_id      uuid primary key references public.students(id) on delete cascade,
  schema_version  text not null default 'cognitive-profile/v1',
  dimensions      jsonb not null default '{}'::jsonb,
  contributors    jsonb not null default '{}'::jsonb,
  -- Convenience denorms for cohort queries (re-derived from dimensions on every write).
  automaticity            real,
  decoding_efficiency     real,
  math_fluency            real,
  mastery_velocity        real,
  forgetting_slope        real,
  total_samples           integer not null default 0,
  updated_at              timestamptz not null default now()
);

create index if not exists scp_decoding_idx
  on public.student_cognitive_profiles (decoding_efficiency);
create index if not exists scp_velocity_idx
  on public.student_cognitive_profiles (mastery_velocity);
create index if not exists scp_updated_idx
  on public.student_cognitive_profiles (updated_at desc);

-- ---- cognitive_contributions_log ---------------------------------
-- Append-only. Every time the launcher pulls a contribution from any
-- app, it logs the raw response here. Lets us replay the merger and
-- audit which app moved which dimension when.

create table if not exists public.cognitive_contributions_log (
  contribution_id  uuid primary key default gen_random_uuid(),
  student_id       uuid not null references public.students(id) on delete cascade,
  app_id           uuid not null references public.learning_apps(id),
  schema_version   text not null,
  contributions    jsonb not null,
  computed_at      timestamptz,
  ingested_at      timestamptz not null default now()
);

create index if not exists ccl_student_app_idx
  on public.cognitive_contributions_log (student_id, app_id, ingested_at desc);
create index if not exists ccl_ingested_idx
  on public.cognitive_contributions_log (ingested_at desc);

-- ================================================================
-- Row-Level Security
-- ================================================================

alter table public.student_cognitive_profiles    enable row level security;
alter table public.cognitive_contributions_log   enable row level security;

-- Helper from the M5 migration. Recreated here as `create or replace`
-- so the cognitive-profile migration is independent.
create or replace function public.current_student_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.students where auth_user_id = auth.uid() limit 1;
$$;

-- A student can read their own profile + log entries.
drop policy if exists scp_self_select on public.student_cognitive_profiles;
create policy scp_self_select
  on public.student_cognitive_profiles for select
  using (student_id = public.current_student_id());

drop policy if exists ccl_self_select on public.cognitive_contributions_log;
create policy ccl_self_select
  on public.cognitive_contributions_log for select
  using (student_id = public.current_student_id());

-- Writes happen via the orchestration layer's service-role key —
-- no client-side INSERT/UPDATE policies. Service role bypasses RLS
-- by design; that's how the orchestration layer maintains the
-- merged profile.

-- ================================================================
-- Convenience: an updated_at trigger so the convenience columns
-- and the timestamp stay in sync when `dimensions` changes.
-- ================================================================

create or replace function public.scp_sync_denorms()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  -- Pull the convenience denorms straight out of the dimensions blob.
  new.automaticity := (new.dimensions -> 'automaticity' ->> 'value')::real;
  new.decoding_efficiency := (new.dimensions -> 'decodingEfficiency' ->> 'value')::real;
  new.math_fluency := (new.dimensions -> 'mathFluency' ->> 'value')::real;
  new.mastery_velocity := (new.dimensions -> 'masteryVelocity' ->> 'value')::real;
  new.forgetting_slope := (new.dimensions -> 'forgettingSlope' ->> 'value')::real;
  new.total_samples := coalesce((
    select sum((d.value ->> 'samples')::int)
    from jsonb_each(new.dimensions) as d
    where d.value ? 'samples'
  ), 0);
  return new;
end;
$$;

drop trigger if exists scp_sync_trigger on public.student_cognitive_profiles;
create trigger scp_sync_trigger
  before insert or update on public.student_cognitive_profiles
  for each row execute procedure public.scp_sync_denorms();

-- ================================================================
-- Done.
-- ================================================================
