-- F13LD.vault — step 2 of 2: schema for direct push from Sweep and Lab.
-- Run AFTER F13LD_VAULT_1_BACKUP.sql has shown matching counts.
-- Paste into the Supabase SQL editor and press Run. It runs as one unit:
-- if any line fails, nothing changes.
-- The result is a one-cell report; paste it back into the chat.
--
-- What it does
--   A. Tidies the public key's permissions on the designs table
--      (no update, delete or truncate; these were already blocked by
--      row-level security, except truncate, which ignores it)
--   B. Hides contributor_contact from the public key (still insertable)
--   C. Adds provenance_kind to the designs table: sweep, lab or file
--   D. Rebuilds the f13ld_designs_dimensional view without contributor_contact
--   E. Creates f13ld_lab_results: one row per Lab solve, insert-only,
--      tied to a design, cleared with it when the design is deleted
--
-- Note for later: the public key can now read only the columns listed in
-- section B. Any column added to f13ld_designs in future needs its own
-- "grant select (new_column)" line, or Vault cannot read it.

begin;

-- ── A. Designs table: the public key may only read and insert ──────────
revoke update, delete, truncate, references, trigger
  on public.f13ld_designs from anon, authenticated;

-- ── C. Provenance kind (added before B so B can grant it) ──────────────
alter table public.f13ld_designs
  add column provenance_kind text not null default 'sweep'
  check (provenance_kind in ('sweep', 'lab', 'file'));

-- ── B. Hide contributor_contact from the public key ────────────────────
revoke select on public.f13ld_designs from anon, authenticated;
revoke select (contributor_contact) on public.f13ld_designs from anon, authenticated;
grant select (
  content_hash, schema_version, family, source_tool, source_version, exported_at,
  preset, solver, contributor_name, contributor_notes, domain, material,
  e_solid_gpa, sigma_ref_gpa, cell_size_mm, voxel_to_um,
  volume_fraction, connect_idx, perc_idx, stiff_axis, anisotropy, directionality,
  ortho_contrast, aniso_efficiency, surface_complexity,
  ex_norm, ey_norm, ez_norm, stiffness_density_norm,
  keff_x_norm, keff_y_norm, keff_z_norm, keff_max_norm, keff_avg_norm, thermal_anisotropy,
  microstrain_x_per_gpa, microstrain_y_per_gpa, microstrain_z_per_gpa,
  microstrain_avg_per_gpa, u_compliance,
  pore_size_norm, pore_size_p10_norm, pore_size_p50_norm, pore_size_p90_norm,
  pore_size_cv, throat_size_norm, throat_ratio,
  h_mean, h_mean_abs, h_std, k_gauss_mean, curvature_uniformity, mih, genus_per_cell,
  tortuosity_min, tortuosity_avg, d_eff_max_norm, d_eff_avg_norm,
  linear_cap_active, eps_yield_um_used, linear_cap_kind, degenerate,
  solver_validity, cg_iters, cg_converged,
  metrics_extended, recipe, context, license, created_at, provenance_kind
) on public.f13ld_designs to anon, authenticated;

-- ── D. Dimensional view, rebuilt without contributor_contact ───────────
drop view public.f13ld_designs_dimensional;
create view public.f13ld_designs_dimensional with (security_invoker = true) as
select
  content_hash, schema_version, family, source_tool, source_version, exported_at,
  preset, solver, contributor_name, contributor_notes, domain, material,
  e_solid_gpa, sigma_ref_gpa, cell_size_mm, voxel_to_um,
  volume_fraction, connect_idx, perc_idx, stiff_axis, anisotropy, directionality,
  ortho_contrast, aniso_efficiency, surface_complexity,
  ex_norm, ey_norm, ez_norm, stiffness_density_norm,
  keff_x_norm, keff_y_norm, keff_z_norm, keff_max_norm, keff_avg_norm, thermal_anisotropy,
  microstrain_x_per_gpa, microstrain_y_per_gpa, microstrain_z_per_gpa,
  microstrain_avg_per_gpa, u_compliance,
  pore_size_norm, pore_size_p10_norm, pore_size_p50_norm, pore_size_p90_norm,
  pore_size_cv, throat_size_norm, throat_ratio,
  h_mean, h_mean_abs, h_std, k_gauss_mean, curvature_uniformity, mih, genus_per_cell,
  tortuosity_min, tortuosity_avg, d_eff_max_norm, d_eff_avg_norm,
  linear_cap_active, eps_yield_um_used, linear_cap_kind, degenerate,
  solver_validity, cg_iters, cg_converged,
  metrics_extended, recipe, context, license, created_at, provenance_kind,
  ex_norm * e_solid_gpa AS ex_gpa,
  ey_norm * e_solid_gpa AS ey_gpa,
  ez_norm * e_solid_gpa AS ez_gpa,
  stiffness_density_norm * e_solid_gpa AS stiffness_density,
  keff_x_norm * ((material ->> 'k_W_mK')::numeric) AS keff_x,
  keff_y_norm * ((material ->> 'k_W_mK')::numeric) AS keff_y,
  keff_z_norm * ((material ->> 'k_W_mK')::numeric) AS keff_z,
  microstrain_avg_per_gpa * sigma_ref_gpa AS microstrain_avg,
  u_compliance * sigma_ref_gpa * sigma_ref_gpa * 1000000::numeric AS u_strain,
  pore_size_norm     * cell_size_mm * 1000::numeric AS pore_size_um,
  pore_size_p10_norm * cell_size_mm * 1000::numeric AS pore_size_p10_um,
  pore_size_p50_norm * cell_size_mm * 1000::numeric AS pore_size_p50_um,
  pore_size_p90_norm * cell_size_mm * 1000::numeric AS pore_size_p90_um,
  throat_size_norm   * cell_size_mm * 1000::numeric AS throat_size_um
from public.f13ld_designs d;
revoke all on public.f13ld_designs_dimensional from anon, authenticated;
grant select on public.f13ld_designs_dimensional to anon, authenticated;

-- ── E. Lab results: one row per Lab solve ──────────────────────────────
create table public.f13ld_lab_results (
  id                         bigint generated always as identity primary key,
  created_at                 timestamptz not null default now(),

  -- identity
  content_hash               text not null
                               references public.f13ld_designs (content_hash) on delete cascade,
  solve_hash                 text not null unique,
  lab_version                text not null,

  -- solve settings
  grid_n                     integer,
  partial_volume             boolean,
  void_ratio                 numeric,
  cg_tol                     numeric,
  converged                  boolean,
  cube_solved                boolean not null default false,

  -- material and cell
  material                   jsonb,
  material_key               text,
  e_solid_gpa                numeric,
  sigma_y_solid_mpa          numeric,
  cell_size_mm               numeric,

  -- elastic (stiffness divided by the solid modulus, as on the design row)
  ex_norm numeric, ey_norm numeric, ez_norm numeric,
  gyz_norm numeric, gxz_norm numeric, gxy_norm numeric,
  nu_xy numeric, nu_xz numeric, nu_yz numeric,
  c_tensor                   jsonb,

  -- buckling
  lambda_cr                  numeric,
  buckling_axis              text,
  buckling_per_axis          jsonb,
  pcr_py                     numeric,

  -- crush and yield
  sigma_y_x_mpa numeric, sigma_y_y_mpa numeric, sigma_y_z_mpa numeric,
  sigma_peak_mpa             numeric,
  crush_e0_norm              numeric,
  failure_mode               text,
  yield_is_bound             boolean,

  -- thermal
  thermal                    jsonb,
  k_rel_water                numeric,

  -- geometry
  porosity                   numeric,
  surface_area_density_m2m3  numeric,
  hydraulic_diameter_mm      numeric,
  open_axes                  text,

  -- provenance
  source_tool                text not null default 'f13ld.lab',
  contributor_name           text not null,
  contributor_contact        text not null,
  contributor_notes          text,
  license                    text not null,

  -- anything new from Lab, without a schema change
  results_extended           jsonb not null default '{}'::jsonb
);
create index idx_f13ld_lab_results_hash    on public.f13ld_lab_results (content_hash, created_at desc);
create index idx_f13ld_lab_results_failure on public.f13ld_lab_results (failure_mode);

alter table public.f13ld_lab_results enable row level security;

create policy f13ld_lab_results_select_anon on public.f13ld_lab_results
  for select to anon using (true);

create policy f13ld_lab_results_insert_anon on public.f13ld_lab_results
  for insert to anon with check (
    length(content_hash) = 64 and
    length(solve_hash) > 0 and
    length(lab_version) > 0 and
    length(contributor_name) > 0 and
    length(contributor_contact) > 0 and
    license is not null and
    source_tool = 'f13ld.lab'
  );
-- no update or delete policy: a solve can't be changed through the public key

-- Permissions: read every column except contact; insert every column except
-- id and created_at (the database stamps the time, so "newest" can be trusted)
revoke all on public.f13ld_lab_results from anon, authenticated;
grant select (
  id, created_at, content_hash, solve_hash, lab_version,
  grid_n, partial_volume, void_ratio, cg_tol, converged, cube_solved,
  material, material_key, e_solid_gpa, sigma_y_solid_mpa, cell_size_mm,
  ex_norm, ey_norm, ez_norm, gyz_norm, gxz_norm, gxy_norm, nu_xy, nu_xz, nu_yz, c_tensor,
  lambda_cr, buckling_axis, buckling_per_axis, pcr_py,
  sigma_y_x_mpa, sigma_y_y_mpa, sigma_y_z_mpa, sigma_peak_mpa, crush_e0_norm,
  failure_mode, yield_is_bound,
  thermal, k_rel_water,
  porosity, surface_area_density_m2m3, hydraulic_diameter_mm, open_axes,
  source_tool, contributor_name, contributor_notes, license, results_extended
) on public.f13ld_lab_results to anon, authenticated;
grant insert (
  content_hash, solve_hash, lab_version,
  grid_n, partial_volume, void_ratio, cg_tol, converged, cube_solved,
  material, material_key, e_solid_gpa, sigma_y_solid_mpa, cell_size_mm,
  ex_norm, ey_norm, ez_norm, gyz_norm, gxz_norm, gxy_norm, nu_xy, nu_xz, nu_yz, c_tensor,
  lambda_cr, buckling_axis, buckling_per_axis, pcr_py,
  sigma_y_x_mpa, sigma_y_y_mpa, sigma_y_z_mpa, sigma_peak_mpa, crush_e0_norm,
  failure_mode, yield_is_bound,
  thermal, k_rel_water,
  porosity, surface_area_density_m2m3, hydraulic_diameter_mm, open_axes,
  source_tool, contributor_name, contributor_contact, contributor_notes, license,
  results_extended
) on public.f13ld_lab_results to anon, authenticated;

commit;

-- Tell the web API to pick up the new table and permissions
notify pgrst, 'reload schema';

-- ── Report: paste this cell back into the chat ─────────────────────────
select json_build_object(
  'designs_anon_table_permissions', (
    select json_agg(privilege_type) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'f13ld_designs' and grantee = 'anon'),
  'designs_anon_can_read_contact',
    has_column_privilege('anon', 'public.f13ld_designs', 'contributor_contact', 'select'),
  'designs_anon_can_insert_contact',
    has_column_privilege('anon', 'public.f13ld_designs', 'contributor_contact', 'insert'),
  'designs_anon_can_read_hash',
    has_column_privilege('anon', 'public.f13ld_designs', 'content_hash', 'select'),
  'view_has_contact', exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'f13ld_designs_dimensional'
      and column_name = 'contributor_contact'),
  'lab_rls_on', (select relrowsecurity from pg_class where oid = 'public.f13ld_lab_results'::regclass),
  'lab_policies', (
    select json_agg(policyname || ' (' || cmd || ')') from pg_policies
    where schemaname = 'public' and tablename = 'f13ld_lab_results'),
  'lab_anon_can_read_contact',
    has_column_privilege('anon', 'public.f13ld_lab_results', 'contributor_contact', 'select'),
  'lab_anon_can_set_created_at',
    has_column_privilege('anon', 'public.f13ld_lab_results', 'created_at', 'insert'),
  'provenance_kind_counts', (
    select json_object_agg(provenance_kind, n) from (
      select provenance_kind, count(*) n from public.f13ld_designs group by 1) t),
  'tables', (
    select json_agg(table_name order by table_name) from information_schema.tables
    where table_schema = 'public')
) as report;
