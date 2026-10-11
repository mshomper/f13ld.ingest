-- F13LD.vault — fixed noise only (2026-10-11, F13LD.ingest v0.11.0 / f13ld-vault-push.js 1.1.0)
--
-- Noise designs must carry recipe.surface.noise_rev >= 2 (F13LD.noise v0.12.0+).
-- Revision 1 (no noise_rev) is F13LD.noise v0.11.0 and older, whose CPU simplex had a
-- lattice error; it keeps building in Mesh / Lab / Sweep but stays out of Vault.
--
-- A RESTRICTIVE policy is ANDed with the existing permissive insert policy, so this adds the
-- rule without touching (or needing the text of) the current one. Other families are
-- unaffected. f13ld-vault-push.js policyCheckRow mirrors it.
--
-- Run in the Supabase SQL editor. Step 1 is read-only.

-- 1. Check: noise rows already in the table that would not pass (expect 0 after the wipe)
select count(*) as legacy_noise_rows
from public.f13ld_designs
where family = 'noise'
  and not (jsonb_typeof(recipe->'surface'->'noise_rev') = 'number'
           and (recipe->'surface'->>'noise_rev')::numeric >= 2);

-- 2. The rule
create policy f13ld_designs_noise_rev2 on public.f13ld_designs
  as restrictive
  for insert to anon, authenticated
  with check (
    family <> 'noise'
    or (jsonb_typeof(recipe->'surface'->'noise_rev') = 'number'
        and (recipe->'surface'->>'noise_rev')::numeric >= 2)
  );

-- 3. Confirm it is in place
select policyname, permissive, cmd, roles
from pg_policies
where schemaname = 'public' and tablename = 'f13ld_designs'
order by policyname;
