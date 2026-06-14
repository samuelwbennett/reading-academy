-- ================================================================
-- VPA Learning OS — Student invites (M13-B)
--
-- A teacher creates a student row first (via /api/provision-student),
-- then mints an invite. The invite carries a random token; the
-- student opens the URL, signs in (creating their auth.users row),
-- and the claim endpoint links that auth user to the pre-existing
-- students row.
--
-- Tokens are single-use, expire after a window, and only readable +
-- claimable through the serverless endpoints (service-role).
--
-- Idempotent. Safe to re-run.
-- ================================================================

create table if not exists public.student_invites (
  invite_id      uuid primary key default gen_random_uuid(),
  token          text not null unique,
  student_id     uuid not null references public.students(id) on delete cascade,
  created_by     uuid not null references auth.users(id) on delete cascade,
  expires_at     timestamptz not null default (now() + interval '14 days'),
  claimed_at     timestamptz,
  claimed_by_auth_user_id uuid references auth.users(id) on delete set null,
  revoked_at     timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists si_token_idx
  on public.student_invites (token) where claimed_at is null and revoked_at is null;
create index if not exists si_student_idx
  on public.student_invites (student_id);
create index if not exists si_creator_idx
  on public.student_invites (created_by);

-- ================================================================
-- Row-Level Security
-- ================================================================

alter table public.student_invites enable row level security;

-- Teachers can read invites they created (so the roster can show
-- "this student has 1 outstanding invite link"). They cannot
-- mutate via direct INSERT — minting goes through the serverless
-- endpoint so the token is generated server-side.
drop policy if exists si_creator_select on public.student_invites;
create policy si_creator_select
  on public.student_invites for select
  using (created_by = auth.uid());

-- Teachers can revoke their own invites.
drop policy if exists si_creator_update on public.student_invites;
create policy si_creator_update
  on public.student_invites for update
  using (created_by = auth.uid())
  with check (created_by = auth.uid());

-- Inserts + claims happen via service-role (no client policy).

-- ================================================================
-- Done.
-- ================================================================
