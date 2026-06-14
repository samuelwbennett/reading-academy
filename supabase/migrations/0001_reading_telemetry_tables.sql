-- ================================================================
-- Reading Academy — telemetry tables (M5-B)
--
-- Adds the four append-only event tables specified in
-- docs/data/supabase-schema-v1.md, namespaced with `reading_` so
-- they can't collide with anything else in the shared VPA Supabase
-- project (Math Academy, ESL Academy, etc.).
--
-- Assumes these tables already exist from the broader VPA setup:
--   - learning_apps   (id uuid, slug text, ...)
--   - students        (id uuid, auth_user_id uuid, ...)
--   - student_app_accounts (student_id, app_id, state jsonb, enabled, ...)
--
-- Idempotent: safe to re-run. Apply via Supabase SQL editor or CLI:
--   supabase db push
-- ================================================================

-- ---- reading_skill_attempts --------------------------------------
-- One row per terminal item event (response_correct / response_incorrect).
-- Idempotent on attempt_id which is client-generated.

create table if not exists public.reading_skill_attempts (
  attempt_id     uuid primary key,
  student_id     uuid not null references public.students(id) on delete cascade,
  app_id         uuid not null references public.learning_apps(id),
  node_id        text not null,
  item_id        text not null,
  correct        boolean not null,
  latency_ms     integer not null check (latency_ms >= 0),
  hint_count     integer not null default 0,
  surface        text not null,
  attempt_n      integer not null default 1,
  session_id     uuid,
  xp_awarded     integer not null default 0,
  transcript     text,
  expected       text,
  confidence     real,
  client_ts      timestamptz,
  server_ts      timestamptz not null default now()
);

create index if not exists reading_skill_attempts_student_node_ts_idx
  on public.reading_skill_attempts (student_id, app_id, node_id, server_ts desc);
create index if not exists reading_skill_attempts_session_idx
  on public.reading_skill_attempts (session_id);
create index if not exists reading_skill_attempts_server_ts_idx
  on public.reading_skill_attempts (server_ts);

-- ---- reading_passage_attempts ------------------------------------

create table if not exists public.reading_passage_attempts (
  passage_attempt_id  uuid primary key,
  student_id          uuid not null references public.students(id) on delete cascade,
  app_id              uuid not null references public.learning_apps(id),
  passage_id          text not null,
  gate_id             text not null,
  is_cold             boolean not null,
  wcpm                real not null check (wcpm >= 0),
  accuracy            real not null check (accuracy >= 0 and accuracy <= 1),
  errors              integer not null default 0,
  duration_ms         integer not null check (duration_ms >= 0),
  self_corrections    integer,
  session_id          uuid,
  client_ts           timestamptz,
  server_ts           timestamptz not null default now()
);

create index if not exists reading_passage_attempts_student_gate_ts_idx
  on public.reading_passage_attempts (student_id, app_id, gate_id, server_ts desc);

-- ---- reading_mastery_snapshots -----------------------------------
-- Materialized log of every state-machine transition. Read-mostly.

create table if not exists public.reading_mastery_snapshots (
  snapshot_id      uuid primary key,
  student_id       uuid not null references public.students(id) on delete cascade,
  app_id           uuid not null references public.learning_apps(id),
  node_id          text not null,
  from_status      text not null,
  to_status        text not null,
  reason           text,
  evidence         jsonb,
  transitioned_at  timestamptz not null default now()
);

create index if not exists reading_mastery_snapshots_student_node_idx
  on public.reading_mastery_snapshots (student_id, app_id, node_id, transitioned_at desc);

-- ---- reading_telemetry_events ------------------------------------
-- Catch-all for non-attempt envelopes (session_started, hint_used, etc.).

create table if not exists public.reading_telemetry_events (
  event_id     uuid primary key,
  student_id   uuid references public.students(id) on delete cascade,
  app_id       uuid not null references public.learning_apps(id),
  event        text not null,
  payload      jsonb,
  session_id   uuid,
  client_ts    timestamptz,
  server_ts    timestamptz not null default now()
);

create index if not exists reading_telemetry_events_student_event_idx
  on public.reading_telemetry_events (student_id, app_id, event, server_ts desc);
create index if not exists reading_telemetry_events_session_idx
  on public.reading_telemetry_events (session_id);

-- ================================================================
-- Row-Level Security
-- ================================================================

alter table public.reading_skill_attempts     enable row level security;
alter table public.reading_passage_attempts   enable row level security;
alter table public.reading_mastery_snapshots  enable row level security;
alter table public.reading_telemetry_events   enable row level security;

-- Helper: the auth user → student_id mapping used for self-reads.
-- Define if not present.

create or replace function public.current_student_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.students where auth_user_id = auth.uid() limit 1;
$$;

-- reading_skill_attempts
drop policy if exists reading_skill_attempts_self_insert on public.reading_skill_attempts;
drop policy if exists reading_skill_attempts_self_select on public.reading_skill_attempts;
create policy reading_skill_attempts_self_insert
  on public.reading_skill_attempts for insert
  with check (student_id = public.current_student_id());
create policy reading_skill_attempts_self_select
  on public.reading_skill_attempts for select
  using (student_id = public.current_student_id());

-- reading_passage_attempts
drop policy if exists reading_passage_attempts_self_insert on public.reading_passage_attempts;
drop policy if exists reading_passage_attempts_self_select on public.reading_passage_attempts;
create policy reading_passage_attempts_self_insert
  on public.reading_passage_attempts for insert
  with check (student_id = public.current_student_id());
create policy reading_passage_attempts_self_select
  on public.reading_passage_attempts for select
  using (student_id = public.current_student_id());

-- reading_mastery_snapshots
drop policy if exists reading_mastery_snapshots_self_insert on public.reading_mastery_snapshots;
drop policy if exists reading_mastery_snapshots_self_select on public.reading_mastery_snapshots;
create policy reading_mastery_snapshots_self_insert
  on public.reading_mastery_snapshots for insert
  with check (student_id = public.current_student_id());
create policy reading_mastery_snapshots_self_select
  on public.reading_mastery_snapshots for select
  using (student_id = public.current_student_id());

-- reading_telemetry_events (allow null student_id for anonymous emits)
drop policy if exists reading_telemetry_events_self_insert on public.reading_telemetry_events;
drop policy if exists reading_telemetry_events_self_select on public.reading_telemetry_events;
create policy reading_telemetry_events_self_insert
  on public.reading_telemetry_events for insert
  with check (
    student_id is null
    or student_id = public.current_student_id()
  );
create policy reading_telemetry_events_self_select
  on public.reading_telemetry_events for select
  using (student_id = public.current_student_id());

-- ================================================================
-- Done.
-- ================================================================
