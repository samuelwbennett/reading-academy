-- ================================================================
-- Reading Academy — Teacher Action completions (M11-C)
--
-- Append-only log of "the teacher marked an action as done."
-- Also records skip / dismiss with optional notes — useful as the
-- feedback loop for which interventions actually got run.
--
-- Idempotent on (student_id, action_id) — clicking complete twice
-- updates the existing row instead of inserting a duplicate.
-- ================================================================

create table if not exists public.reading_action_completions (
  completion_id   uuid primary key default gen_random_uuid(),
  student_id      uuid not null references public.students(id) on delete cascade,
  action_id       text not null,
  -- The teacher who marked it. NULL when an admin script writes.
  teacher_user_id uuid references auth.users(id) on delete set null,
  status          text not null check (status in ('completed','skipped','dismissed')),
  note            text,
  -- Snapshot of the action payload at completion time, for audit /
  -- post-hoc analysis ("what did the engine recommend before the
  -- teacher acted?").
  action_snapshot jsonb,
  completed_at    timestamptz not null default now(),
  unique (student_id, action_id)
);

create index if not exists rac_student_completed_idx
  on public.reading_action_completions (student_id, completed_at desc);
create index if not exists rac_status_idx
  on public.reading_action_completions (status);

-- ================================================================
-- Row-Level Security
-- ================================================================

alter table public.reading_action_completions enable row level security;

create or replace function public.current_student_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.students where auth_user_id = auth.uid() limit 1;
$$;

-- A signed-in user can read completions for their own student row
-- (so they see their own dashboard accurately). Cross-student reads
-- happen through the orchestration layer's service-role queries.
drop policy if exists rac_self_select on public.reading_action_completions;
create policy rac_self_select
  on public.reading_action_completions for select
  using (student_id = public.current_student_id());

-- A signed-in user can insert / update completions on their own
-- student row. M12 (real teacher RLS) will broaden this to the
-- teacher's roster.
drop policy if exists rac_self_insert on public.reading_action_completions;
create policy rac_self_insert
  on public.reading_action_completions for insert
  with check (student_id = public.current_student_id());

drop policy if exists rac_self_update on public.reading_action_completions;
create policy rac_self_update
  on public.reading_action_completions for update
  using (student_id = public.current_student_id())
  with check (student_id = public.current_student_id());

-- ================================================================
-- Done.
-- ================================================================
