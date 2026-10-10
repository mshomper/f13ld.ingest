-- F13LD.vault — step 1 of 2: fresh backup, then remove the old backup and the v5 archive.
-- Run this BEFORE F13LD_VAULT_2_MIGRATION.sql.
-- Paste into the Supabase SQL editor and press Run. It runs as one unit:
-- if any line fails, nothing changes.
-- The result shows the row count of the live table and of the new backup.
-- They must match.

begin;

-- 1. Copy the live table into a new backup
create table public.f13ld_designs_backup_20261010 as
  table public.f13ld_designs;

-- 2. Lock the backup: row-level security on, no public access at all
alter table public.f13ld_designs_backup_20261010 enable row level security;
revoke all on public.f13ld_designs_backup_20261010 from anon, authenticated;

-- 3. Remove the previous backup and the v5 archive
drop table public.f13ld_designs_backup_20261009;
drop table public.f13ld_designs_v5_archive;

commit;

-- 4. Check: both counts must be the same
select
  (select count(*) from public.f13ld_designs)                as live_rows,
  (select count(*) from public.f13ld_designs_backup_20261010) as backup_rows;
