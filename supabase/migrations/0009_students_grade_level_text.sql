-- ================================================================
-- READING ACADEMY — students.grade_level → text  (M17)
--
-- The base `students` table (created upstream in the guardians-era
-- schema) typed `grade_level` as an integer. That rejects "K" and
-- any grade range ("K-2", "3-5"), even though every other part of
-- the system treats grade labels as text. Provisioning a
-- kindergartner failed with:
--     invalid input syntax for type integer: "K"
--
-- This widens the column to text. Existing integer values become
-- their string form (1 -> "1"); nulls stay null.
--
-- Idempotent: only alters if the column is still an integer type.
-- Safe to re-run.
-- ================================================================

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'students'
      and column_name  = 'grade_level'
      and data_type in ('integer', 'bigint', 'smallint')
  ) then
    alter table public.students
      alter column grade_level type text
      using grade_level::text;
    raise notice 'students.grade_level widened to text';
  else
    raise notice 'students.grade_level is already non-integer — no change';
  end if;
end $$;

-- ================================================================
-- Done. M17 schema landed.
-- ================================================================
