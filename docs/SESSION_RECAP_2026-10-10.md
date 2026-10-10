# Session recap — 2026-10-10 (evening): direct push to F13LD.vault

Question that started it: can Sweep and Lab push to Vault without going through F13LD.ingest? Answer: yes — Ingest's rules moved into one shared file that every tool loads, and the database was tightened first. Full plan and draft SQL: [`F13LD_VAULT_PUSH_PLAN.md`](F13LD_VAULT_PUSH_PLAN.md).

## Matt's decisions

- Ingest is mostly a format checker, plus the CC0 rights tick and contributor provenance — both kept, in a push window.
- A Sweep push sends the whole run (auto-target rounds excluded, as from the export).
- Lab pushes are marked differently in provenance. A Vault design run in Lab and pushed back has its properties updated (newest solve shown by default).
- Lab can push designs that are not in Vault: Lab runs Sweep's pipeline on them so the row is complete (not left with blank Sweep columns).
- Lab holds back stretched cells until it can solve them (on the roadmap soon).
- Vault gets columns for yield, buckling, crush, thermal from Lab.
- The CC0 tick is required at least once per browser session.
- Schema change before the Vault reseed. Archive table removed; one fresh backup kept.

## Phase 1 — database (Matt ran the SQL; done)

Read-only checks found: `contributor_contact` readable through the public key; the public key also held truncate (row-level security does not cover it); the dimensional view listed contact. Backup and archive tables had row-level security on with no rules (not exposed).

Ran, in order (`docs/sql/2026-10-10_1_backup.sql`, `docs/sql/2026-10-10_2_migration.sql`; both tested first on a local Postgres 16 copy of the live table's shape):
1. Backup → `f13ld_designs_backup_20261010` (1,042 rows, no public access); dropped `f13ld_designs_backup_20261009` and `f13ld_designs_v5_archive`.
2. Migration:
   - public key on `f13ld_designs`: read named columns (never contact), insert; no update / delete / truncate
   - `provenance_kind` column: `sweep` · `lab` · `file` (existing 1,042 rows → `sweep`)
   - `f13ld_designs_dimensional` view rebuilt without contact
   - new table `f13ld_lab_results`: one row per Lab solve, insert-only, `content_hash` → `f13ld_designs` (on delete cascade), `solve_hash` unique, database-stamped `created_at`, contact insert-only

Gotchas now in force: a new column needs `grant select (column) … to anon, authenticated` before Vault can read it; wipe with `delete from public.f13ld_designs;` (truncate fails because of the Lab link).

## Phase 2 — shared push file (Ingest v0.10.0 → v0.10.1, push file v1.0.1; merged)

`f13ld-vault-push.js` (`window.F13LDVault`): Ingest's `validateDesign` / `policyCheckRow` / `buildRow` moved unchanged, plus `analyze`, `buildRows`, `insertDesigns`, the Lab path (`prepareLabRows`, `insertLabResults`, `policyCheckLabRow`), contributor storage, the session consent cookie, and `openPushDialog`.

Fixes that came with it:
- The old duplicate check fetched every hash, but Supabase returns at most 1,000 rows per request and Vault held 1,042 — designs past 1,000 were missed and sank their batch. Now it asks only about the file's hashes, and a batch that hits a duplicate retries one row at a time.
- The contributor and domain can be filled in after the drop (before, every row failed if they were empty at drop time).
- v0.10.1: the window's classes moved from `f13v-` to `f13vp-` — `.f13v` belongs to the shared F13LD-VIEW block in every design tool and pinned the window to the top-left inside Sweep.

Checks: `tests/parity.js` (old vs new Ingest on real Sweep v0.29.1 exports + 25 edge cases + a 130-design run + a no-version file: same statuses, reasons, summary, preview and every POSTed row; plus contributor-after-drop, a duplicate race, the session tick), `tests/push-window.js` (desktop and phone: counts, inline errors, dry run, remembered details, Lab push order and rows, no horizontal overflow, no text under 12 px). Click-test page: `push-demo.html` (dry run).

## Phase 3 — Sweep Push to Vault (Sweep v0.29.2; merged)

See F13LD.sweep `docs/SESSION_RECAP_2026-10-10_vault-push.md`. Rows pushed from Sweep equal what Ingest builds from the same run's exported file (`tests/vault-push.js` in Sweep).

## Found, not changed

A beam recipe without a `topology` block (the F13LD.mesh test recipe `beam-bcc`) exports its reference design without one, and Ingest rejects it ("beam missing topology block"); jittered designs carry `topology`. Either Sweep fills `topology` on the reference design or the check accepts `beams[]` alone.

## Next

1. Matt: wipe and reseed Vault through Sweep's Push to Vault (plan workbook `F13LD_Vault_Reseed_Plan.xlsx`, handed over in the session).
2. Phase 4 — F13LD.lab Push to Vault (fresh session): Vault handoff carries the hash (`&v=`), Lab runs Sweep's `estimateHomogenization` (loaded from Sweep's site) for designs new to Vault, builds a Sweep-shape record plus `labResults` and calls `F13LDVault.openPushDialog({ provenanceKind: 'lab', labResults, heldBack })`; stretched cells held back. Scope: F13LD.lab `docs/VAULT_ROUNDTRIP_SCOPE.md`.
3. Phase 5 — Vault shows Lab results: read `f13ld_lab_results` (named columns), newest solve per hash wins, Lab-verified chip and colour, Sweep vs Lab gap, new filter columns.
4. Bundle in Sweep (v0.30.0), then seed Bundle runs.
5. Decide the beam reference-design topology question.
