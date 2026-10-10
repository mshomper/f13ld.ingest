# F13LD — direct push to F13LD.vault (plan for approval)

Status: proposal, 2026-10-10. Nothing has been changed in any repo. The SQL below is a draft for review, not to run yet.

Builds on `f13ld.lab/docs/VAULT_ROUNDTRIP_SCOPE.md`, with Matt's answers from 2026-10-10:

- Ingest is mostly a format checker, plus the rights / CC0 tick and contributor provenance.
- A Sweep push sends the whole run.
- Lab pushes are marked differently in provenance.
- A Vault design run in Lab and pushed back has its properties updated.
- Vault gains columns for yield and its metrics, buckling, crush, thermal.
- The schema change happens first, before the Vault wipe and reseed.

---

## What the code shows today

- **Ingest** (`index.html`, one file) does five things: reads a Sweep export, runs `validateDesign` (per-family and physics checks), hashes the recipe (`canonicalize` + SHA-256), builds a row (`buildRow`), pre-checks the database rule (`policyCheckRow`), and inserts in batches of 50 into `f13ld_designs` with the public key.
- **Contributor details** are saved in browser storage under `f13ld.ingest.contributor.*`. Every F13LD tool runs on `mshomper.github.io`, so Sweep and Lab can read the same saved name and contact. The push window can be pre-filled.
- **The rights tick** is unticked on each load and must be ticked before Insert.
- **Vault never asks for `contributor_contact`**, but that is a choice in Vault's code. Nothing in the code shows the database itself hiding that column from the public key. If it doesn't, anyone with the public key can read contacts, which conflicts with the "stored privately" promise in Ingest's licence text. Phase 1 closes this.
- **Lab** keeps per-design results: elastic tensor (C, E, G, ν), buckling (`lambda_cr`, critical axis, per-axis, `pcr_py`), crush (`sigma_y_eff`, `E0`, curve, failure mode, yield bound), thermal per filler, geometry (porosity, surface area density, hydraulic diameter, open axes). None of it reaches Vault.
- **Lab's recipe differs from Vault's.** The handoff adds `cell_size_mm` and Lab adds a title, so Lab cannot re-find a Vault row by hashing its own copy.

---

## Phase 1 — Vault schema (Matt runs the SQL; before the reseed)

### Why a separate Lab results table, not editing the Vault row

The public key is in every tool's page source. If the database allowed updates, anyone could overwrite any design's numbers. A separate table that only accepts new rows lets Lab "update" a design without anyone being able to change what is already there. It also keeps every solve (grid, material, Lab version), so Vault can show the best one and the history stays auditable.

Vault reads both tables and shows a design's Lab values in place of Sweep's estimates when a Lab solve exists. To the user, the design's properties are updated.

### New table `f13ld_lab_results` (one row per Lab solve)

| Group | Columns |
|---|---|
| Identity | `id`, `created_at`, `content_hash` (the Vault design it belongs to), `lab_version`, `solve_hash` (stops the same solve going in twice) |
| Settings | `grid_n`, `partial_volume`, `void_ratio`, `cg_tol`, `converged`, `cube_solved` (true for stretched cells until Lab solves them) |
| Material | `material` (jsonb card), `e_solid_gpa`, `sigma_y_solid_mpa`, `cell_size_mm` |
| Elastic | `ex_norm`, `ey_norm`, `ez_norm`, `gyz_norm`, `gxz_norm`, `gxy_norm`, `nu_xy`, `nu_xz`, `nu_yz`, `c_tensor` (jsonb 6×6) |
| Buckling | `lambda_cr`, `buckling_axis`, `buckling_per_axis` (jsonb), `pcr_py` |
| Crush / yield | `sigma_y_x_mpa`, `sigma_y_y_mpa`, `sigma_y_z_mpa`, `sigma_peak_mpa`, `crush_e0_norm`, `failure_mode`, `yield_is_bound` |
| Thermal | `thermal` (jsonb per filler: kx, ky, kz, k_rel, ρc, α), `k_rel_water` (first-class for filtering) |
| Geometry | `porosity`, `surface_area_density_m2m3`, `hydraulic_diameter_mm`, `open_axes` |
| Provenance | `source_tool` = `f13ld.lab`, `contributor_name`, `contributor_contact` (private), `contributor_notes`, `license` |
| Overflow | `results_extended` (jsonb, anything new, so Lab can add results without a schema change) |

Stiffnesses are stored divided by the solid modulus, the same way the Vault row stores them. Yield and buckling are stored in MPa with the material card beside them.

### Changes to `f13ld_designs`

- `provenance_kind` text: `sweep`, `lab` or `file` (Ingest drop). Sweep and file rows behave as today.
- Nothing else. Lab values live in the new table, so the reseed doesn't need to fill Lab columns.

### Privacy fix (both tables)

Remove the public key's right to read `contributor_contact`, while keeping its right to insert it. After this, contact cannot be read through the public key, whatever a tool asks for.

### Draft SQL (for review — not to run yet)

```sql
-- 1. Lab results: one row per Lab solve, insert-only
create table public.f13ld_lab_results (
  id                bigint generated always as identity primary key,
  created_at        timestamptz not null default now(),
  content_hash      text not null,
  solve_hash        text not null unique,
  lab_version       text not null,
  grid_n            int, partial_volume boolean, void_ratio double precision,
  cg_tol            double precision, converged boolean, cube_solved boolean default false,
  material          jsonb, e_solid_gpa double precision, sigma_y_solid_mpa double precision,
  cell_size_mm      double precision,
  ex_norm double precision, ey_norm double precision, ez_norm double precision,
  gyz_norm double precision, gxz_norm double precision, gxy_norm double precision,
  nu_xy double precision, nu_xz double precision, nu_yz double precision,
  c_tensor          jsonb,
  lambda_cr double precision, buckling_axis text, buckling_per_axis jsonb, pcr_py double precision,
  sigma_y_x_mpa double precision, sigma_y_y_mpa double precision, sigma_y_z_mpa double precision,
  sigma_peak_mpa double precision, crush_e0_norm double precision,
  failure_mode text, yield_is_bound boolean,
  thermal jsonb, k_rel_water double precision,
  porosity double precision, surface_area_density_m2m3 double precision,
  hydraulic_diameter_mm double precision, open_axes text,
  source_tool text not null default 'f13ld.lab',
  contributor_name text not null, contributor_contact text not null,
  contributor_notes text, license text not null,
  results_extended  jsonb
);
create index on public.f13ld_lab_results (content_hash);

alter table public.f13ld_lab_results enable row level security;
create policy lab_results_insert on public.f13ld_lab_results
  for insert to anon with check (
    length(content_hash) = 64 and length(lab_version) > 0 and
    length(contributor_name) > 0 and length(contributor_contact) > 0 and
    license is not null and source_tool = 'f13ld.lab'
  );
create policy lab_results_read on public.f13ld_lab_results
  for select to anon using (true);
-- no update or delete policy: rows can't be changed through the public key

-- 2. Provenance kind on the designs table
alter table public.f13ld_designs add column provenance_kind text default 'sweep';

-- 3. Hide contributor_contact from the public key on both tables
revoke select on public.f13ld_designs     from anon;
revoke select on public.f13ld_lab_results from anon;
-- then grant select on every column except contributor_contact
-- (the session writes out the full column lists from the live table)
```

Before Matt runs it, the session checks the live table's existing policies and grants with Matt (the Supabase dashboard shows them), so the draft matches what is there.

---

## Phase 2 — one shared push module

`f13ld-vault-push.js`, kept in the Ingest repo and served from `mshomper.github.io/f13ld.ingest/`. It holds everything Ingest does today: validation, hashing, row building, rule pre-check, duplicate check, batched insert, and the new Lab-results path.

- Ingest loads it too, so there is one rule set. A rule change in Ingest reaches Sweep and Lab the moment it deploys.
- **Push window** (drawn by the module, styled per tool): name, contact and notes pre-filled from saved details; domain pre-filled from the run; the CC0 rights tick; a count of valid, duplicate and failed designs before Insert; a per-design reason list for failures.
- Ingest stays for file drops, backfills and anyone with an exported file.

## Phase 3 — Sweep

- **Push to Vault** sends the whole run, using the export it already builds. Auto-target rounds stay out, as they do from the export.
- The export file shape does not change.
- Rows get `provenance_kind = sweep`.

## Phase 4 — Lab

- Vault's **Open in Lab** adds the row's hash (`&v=<hash>`). Lab keeps it on the design along with an untouched copy of Vault's recipe.
- If the design is edited in Lab, its hash changes and it becomes a new design.
- **Push to Vault** per design, with Push all for a set of results.
- A design that came from Vault gets a new `f13ld_lab_results` row tied to its hash.
- A design that was never in Vault: Lab runs Sweep's pipeline on it and pushes a full row plus its Lab solve (see Decisions).
- Stretched cells: held back until Lab solves them.

## Phase 5 — Vault display

- **Lab-verified** filter chip and colour mode.
- Inspector shows Lab values in place of Sweep's estimates, with Sweep's value beside each one.
- New filterable columns: yield per axis, buckling strain, failure mode (yield- vs buckling-limited), thermal k_rel, shear moduli.
- **Sweep vs Lab gap** metric by family and grid, showing where the fast estimate drifts.
- Compare shows both.

## Order

1. Phase 1 schema (Matt runs the SQL)
2. Phase 2 shared module, with Ingest switched over to it
3. Phase 3 Sweep push
4. Vault wipe and reseed through the new Sweep push (this tests the push path on real data)
5. Phase 4 Lab push and Phase 5 Vault display
6. Bundle (Sweep v0.30.0) after that

Each phase goes on a branch and waits for Matt's click-test before main.

---

## Decisions (Matt, 2026-10-10, 17:05)

1. **Lab can push new designs to Vault.** Lab computes Sweep's results for each design it pushes, so a Lab-new design arrives as a complete Vault row, not one with blank columns. The extra time is small next to Lab's own solve.
2. **Lab holds back stretched cells** until it can solve them (on the roadmap soon). The push window lists them with a note instead of sending them.
3. **Several Lab solves of one design:** Vault shows the newest by default.
4. **Rights tick:** required at least once per browser session (remembered in session storage, cleared when the browser closes).

### How Lab gets Sweep's results (proposed)

Sweep's whole per-design pipeline is one call, `estimateHomogenization(recipe, opts)` in `54-estimate.js`: geometry, VF and connectivity gates, pores, curvature, topology, tortuosity, the fast solve and every derived metric.

- At push time, Lab loads Sweep's pipeline files from Sweep's live site (`mshomper.github.io/f13ld.sweep/`) into a worker and runs that call on each design, at Sweep's Fast settings.
- **Why load from Sweep, not copy into Lab:** a Lab-pushed row then carries the same numbers a Sweep push of that design would. One rule set again, like the validator. Sweep's version goes into the row's provenance.
- If Sweep's site can't be reached, Lab's solving still works; only the push waits, with a note.
- The result is a Sweep-shaped record, so it goes through the same shared validator and row builder as a Sweep push. The row gets `provenance_kind = lab` and its Lab solve goes in `f13ld_lab_results`.
- Licences: Sweep's metric files are MIT and its solver files already carry Lab's PolyForm licence, so Lab can load both.

## Phase 1 status (2026-10-10, 18:06)

Live database checks found:
- Contributor contact was readable through the public key (column read permission). Fixed in the migration.
- Designs could not be updated or deleted (row-level security, read and insert rules only), but the public key held truncate, which row-level security does not cover. It is not reachable through the web API; revoked anyway.
- The backup and archive tables had row-level security on with no rules, so they were not exposed. The archive is removed; the backup is replaced by `f13ld_designs_backup_20261010`.
- The view uses invoker security but listed contributor contact. Rebuilt without it.

Scripts, in order: `F13LD_VAULT_1_BACKUP.sql`, then `F13LD_VAULT_2_MIGRATION.sql`. Both were run against a local Postgres 16 copy of the live table's shape and passed every check (named reads work; contact, `select *`, update, delete and truncate refused; Lab rows need a real design; duplicate solves and fake timestamps refused; deleting a design clears its Lab rows).

After the migration:
- **Wiping Vault for the reseed:** use `delete from public.f13ld_designs;`. It also clears the Lab results. `truncate` now fails because of the link to the Lab results table (it would need `truncate ... cascade`).
- **Any new column** on either table needs a `grant select (column)` line, or Vault cannot read it.

## Earlier step

Before writing final SQL, check the live table. `F13LD_VAULT_CHECK.sql` is read-only: it lists the table's columns, rules, permissions and indexes, and changes nothing. Matt runs it in the Supabase SQL editor and pastes back the one result cell.
