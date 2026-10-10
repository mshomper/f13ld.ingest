/* ============================================================
   F13LD · f13ld-vault-push.js
   The one set of rules for writing to F13LD.vault.

   Loaded by F13LD.ingest (file drops), F13LD.sweep (Push to Vault) and
   F13LD.lab (Push to Vault). Served from
     https://mshomper.github.io/f13ld.ingest/f13ld-vault-push.js
   so a rule change here reaches every tool when Ingest deploys.

   What it does
     · validateDesign / policyCheckRow / buildRow — the per-design checks
       and the row shape, unchanged from F13LD.ingest v0.9.1
     · analyze(json)       a Sweep-shape export → per-design status
                           (valid / dupe / invalid + reason) and hash
     · buildRows(...)      valid designs → rows, with the contributor,
                           domain and provenance kind (sweep · lab · file)
     · insertDesigns(rows) batched insert; a batch that hits a duplicate
                           is retried one design at a time
     · prepareLabRows / insertLabResults — F13LD.lab solves into
                           f13ld_lab_results, tied to a design's hash
     · contributor details (browser storage shared by every F13LD tool on
       mshomper.github.io) and the CC0 rights confirmation (once per
       browser session)
     · openPushDialog(opts) the push window Sweep and Lab show

   Database (2026-10-10 migration): the public key reads named columns
   only (never contributor_contact), inserts, and cannot update, delete
   or truncate. f13ld_lab_results rows need a design row with the same
   content_hash; the database stamps created_at.

   Rule changes: validateDesign, policyCheckRow and buildRow below are the
   only copies (F13LD.ingest's index.html calls them from here). If the
   database insert policy changes, change policyCheckRow in step.
   ============================================================ */
(function (root) {

var VERSION = '1.0.0';

// ── Config ─────────────────────────────────────────────────────────────
var SUPABASE_URL = 'https://axinljpecycnvfncyhfs.supabase.co';
var SUPABASE_KEY = 'sb_publishable_DAlrNLqbUZiwkaA6wPSMIw_YUNY85LX';
var TABLE        = 'f13ld_designs';
var LAB_TABLE    = 'f13ld_lab_results';
var BATCH_SIZE   = 50;
var HASH_CHUNK   = 60;      // hashes per duplicate-check request
var LICENSE_TAG  = 'CC0-1.0';
var VAULT_URL    = 'https://mshomper.github.io/f13ld.vault/';


// VF acceptance window (percent). Sparse PI-TPMS designs run < 2.5%.
// Two-tier floor: anything > VF_MIN passes the volume floor, but designs
// below VF_LOW_THRESHOLD must additionally be connected in ≥1 axis
// (connect_idx ≥ MIN_CONNECT_IDX) to rule out disconnected powder.
var VF_MIN           = 0.50;
var VF_LOW_THRESHOLD = 1.25;
var VF_MAX           = 80.0;
var MIN_CONNECT_IDX  = 0.33;  // 1 of 3 axes — connect_idx scale {0, 0.33, 0.67, 1}

var KNOWN_FAMILIES = ['tpms', 'noise', 'grain', 'beam', 'foam', 'wave', 'bundle'];   // v0.9.0: foam, wave, bundle (Sweep v0.27+)

// ── Canonical JSON for hashing (stable key order) ──────────────────────
function canonicalize(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  var keys = Object.keys(v).sort();
  return '{' + keys.map(function(k){
    return JSON.stringify(k) + ':' + canonicalize(v[k]);
  }).join(',') + '}';
}

async function contentHash(recipe) {
  var json = canonicalize(recipe);
  var buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return Array.from(new Uint8Array(buf))
    .map(function(b){ return b.toString(16).padStart(2, '0'); })
    .join('');
}

// ── Per-family validation ──────────────────────────────────────────────
// Returns null if valid, otherwise a short reason string.
//
// IMPORTANT: per-design metrics live in `d.browser`, not `design.homogenization`.
// The homogenization block in the recipe currently mirrors the *base* recipe's
// MIL-HS values across every iteration — it's not per-design until the next
// Sweep version computes Gxy/nu_eff/surface_complexity per iteration.
function validateDesign(d) {
  var design = d.design;
  if (!design)        return 'missing design block';
  if (!design.family) return 'missing family discriminator';
  if (KNOWN_FAMILIES.indexOf(design.family) < 0)
    return 'unknown family "' + design.family + '"';

  var b = d.browser;
  if (!b) return 'missing browser metrics block (per-design Ex/Ey/Ez/VF)';

  // ── Universal physics — all checks against per-design browser values ─
  if (typeof b.volume_fraction !== 'number')
    return 'volume_fraction missing or non-numeric';
  if (b.volume_fraction <= VF_MIN || b.volume_fraction >= VF_MAX)
    return 'VF ' + b.volume_fraction.toFixed(2) + '% out of range (' + VF_MIN.toFixed(2) + '–' + VF_MAX + '%)';

  // Sparse-VF connectivity floor: below VF_LOW_THRESHOLD, the design must
  // be connected in at least one axis (otherwise it's disconnected powder).
  if (b.volume_fraction < VF_LOW_THRESHOLD) {
    var ci = b.connect_idx;
    if (typeof ci !== 'number' || ci < MIN_CONNECT_IDX) {
      var ciStr = (typeof ci === 'number') ? ci.toFixed(2) : '—';
      return 'VF ' + b.volume_fraction.toFixed(2) + '% sparse — connect_idx ' +
             ciStr + ' < ' + MIN_CONNECT_IDX + ' (need ≥1 connected axis)';
    }
  }

  // ── Sweep schema version tripwire ───────────────────────────────────
  // Vault schema v5 prefers v0.14.1+ canonical metrics, but accepts v0.13+
  // (older exports get nulls for v0.14-only fields like solver_validity,
  // directionality, cg_iters, cg_converged). Hard-required fields below
  // were present in v0.13 — exports lacking them are rejected.
  if (typeof b.linear_cap_active !== 'boolean')
    return 'missing linear_cap_active — Sweep v0.13+ required';
  if (typeof b.stiffness_density_norm !== 'number')
    return 'missing stiffness_density_norm — Sweep v0.13+ required';
  if (typeof b.H_mean_abs !== 'number')
    return 'missing H_mean_abs — Sweep v0.13+ required (this looks like a v0.12 export)';
  if (typeof b.throat_ratio !== 'number')
    return 'missing throat_ratio — Sweep v0.13+ required';
  if (typeof b.tortuosity_x !== 'number')
    return 'missing tortuosity_x — Sweep v0.13+ required';

  // v5: anisotropy is NULLABLE in v0.14.0+ (when fewer than 2 axes percolate).
  // Older v0.13 exports never produce null, so null indicates v0.14+ export.
  if (b.anisotropy !== null && typeof b.anisotropy !== 'number')
    return 'anisotropy must be a number or null';
  if (typeof b.anisotropy === 'number' && b.anisotropy < 1.0 - 0.005)
    return 'anisotropy ' + b.anisotropy.toFixed(2) + ' < 1.0 (impossible)';

  // v5: solver_validity validation (v0.14.0+ only — accept missing for v0.13)
  if (b.solver_validity !== undefined && b.solver_validity !== null) {
    if (b.solver_validity !== 'valid' &&
        b.solver_validity !== 'partial' &&
        b.solver_validity !== 'invalid')
      return "solver_validity must be 'valid', 'partial', or 'invalid'";
  }

  // v5: cg_iters / cg_converged validation (v0.14.0+ only)
  if (b.cg_iters !== undefined && b.cg_iters !== null) {
    if (typeof b.cg_iters !== 'number' || b.cg_iters < 0 || b.cg_iters !== Math.floor(b.cg_iters))
      return 'cg_iters must be a non-negative integer';
  }
  if (b.cg_converged !== undefined && b.cg_converged !== null) {
    if (typeof b.cg_converged !== 'boolean')
      return 'cg_converged must be a boolean';
  }

  // Stiffness sanity — switched from Ex_GPa to Ex_norm in v0.7.0 since
  // norm fields are guaranteed and the GPa fields are no longer stored.
  // Same physics either way: negative stiffness is impossible.
  var axes = ['Ex_norm', 'Ey_norm', 'Ez_norm'];
  for (var i = 0; i < axes.length; i++) {
    var v = b[axes[i]];
    if (typeof v !== 'number') return axes[i] + ' missing or non-numeric';
    if (v < 0)                 return axes[i] + ' = ' + v + ' (negative — impossible)';
  }

  // Anisotropy consistency — only enforced where ≥ 2 axes are connected
  // AND anisotropy is not null. Null anisotropy from v0.14+ means fewer
  // than 2 axes percolate at the canonical (hi-res) level — consistency
  // check doesn't apply.
  if (typeof b.anisotropy === 'number') {
    var connected = axes.map(function(a){ return b[a]; }).filter(function(e){ return e > 1e-7; });
    if (connected.length >= 2) {
      var computed = Math.max.apply(null, connected) / Math.min.apply(null, connected);
      if (Math.abs(computed - b.anisotropy) / Math.max(computed, 0.001) > 0.30)
        return 'anisotropy ' + b.anisotropy.toFixed(2) + ' inconsistent with E_x/E_y/E_z (computed ' + computed.toFixed(2) + ')';
    }
  }

  // ── Family-specific recipe structure (still on the recipe, not browser) ─
  if (design.family === 'tpms') {
    if (!design.surface) return 'TPMS missing surface block';
    if (design.surface.type === 'terms' && (!Array.isArray(design.surface.terms) || design.surface.terms.length === 0))
      return 'TPMS surface.terms is empty — not reconstructable';
  }
  if (design.family === 'noise') {
    if (!design.surface) return 'noise missing surface block';
    if (!design.surface.noise_type) return 'noise missing noise_type';
  }
  if (design.family === 'grain') {
    if (!design.field) return 'grain missing field block';
    if (!design.field.type) return 'grain missing field.type';
  }
  if (design.family === 'beam') {
    // Beam recipes are structurally distinct from surface/field families:
    // discriminators live in `topology` (preset name + beam count) and the
    // strut endpoints sit in a top-level `beams[]` array. Both are required
    // for F13LD.mesh to reconstruct the lattice.
    if (!design.topology) return 'beam missing topology block';
    if (!Array.isArray(design.beams) || design.beams.length === 0)
      return 'beam missing beams[] array — not reconstructable';
  }

  // v0.9.0 — the families Sweep added in v0.27+ (F13LD.foam / .wave / .bundle exports)
  if (design.family === 'foam') {
    if (!design.seeds) return 'foam missing seeds block';
    if (design.domain && design.domain.periodic === false) return 'foam is not periodic — not a valid unit cell';
    var sd = design.seeds;
    var hasPos = Array.isArray(sd.positions) && sd.positions.length >= 3;
    if (!hasPos && !(sd.mode && (sd.count > 0)))
      return 'foam has neither seed positions nor seed settings to rebuild them — not reconstructable';
  }
  if (design.family === 'wave') {
    if (!design.field || !Array.isArray(design.field.modes) || design.field.modes.length === 0)
      return 'wave missing field.modes — not reconstructable';
    // v0.9.1 — one wave cell is periodic only with whole-number mode indices
    // (a fractional index repeats over several cells; Sweep, Lab and F13LD.wave
    // solve one cell), as F13LD.sweep v0.29.0 refuses them at load
    for (var wi = 0; wi < design.field.modes.length; wi++) {
      var wm = design.field.modes[wi] || {}, wk = ['n', 'm', 'p'];
      for (var wj = 0; wj < 3; wj++) {
        var wv = wm[wk[wj]];
        if (typeof wv !== 'number' || !isFinite(wv)) return 'wave mode ' + (wi + 1) + ' missing its ' + wk[wj] + ' index';
        if (Math.abs(wv - Math.round(wv)) > 1e-9)
          return 'wave mode ' + (wi + 1) + ' has ' + wk[wj] + ' = ' + wv + ' — fractional indices are not one periodic cell';
      }
    }
    if (!design.geometry) return null;   // wave keeps its settings in field
  }
  if (design.family === 'bundle') {
    if (!design.surface || !design.surface.structure) return 'bundle missing surface.structure';
  }

  if (!design.geometry) return 'missing geometry block';

  return null; // valid
}

// ── Server policy pre-flight ───────────────────────────────────────────
// Mirrors the RLS WITH CHECK predicate on f13ld_designs so a row that
// would fail server-side gets flagged here with a clear field name
// instead of bouncing as a generic 42501 mid-batch. Update this in
// lockstep with the policy if the policy ever changes.
//
// Policy (as of 2026-05): all of content_hash, family, schema_version,
// domain, contributor_name, contributor_contact must be non-empty
// strings; license must be non-null; family must be in KNOWN_FAMILIES.
//
// Returns null if the row would pass server-side, otherwise a short
// reason string in the same shape as validateDesign().
function policyCheckRow(row) {
  function nonEmpty(v) { return typeof v === 'string' && v.length > 0; }
  if (!nonEmpty(row.content_hash))
    return 'policy: content_hash empty (row builder bug)';
  if (!nonEmpty(row.family))
    return 'policy: family empty';
  if (KNOWN_FAMILIES.indexOf(row.family) < 0)
    return 'policy: family "' + row.family + '" not in {' +
           KNOWN_FAMILIES.join(', ') + '} — likely stale cached ingest';
  if (!nonEmpty(row.schema_version))
    return 'policy: schema_version empty — sweep meta missing tool_version';
  if (!nonEmpty(row.domain))
    return 'policy: domain empty (Domain field blank?)';
  if (!nonEmpty(row.contributor_name))
    return 'policy: contributor_name empty';
  if (!nonEmpty(row.contributor_contact))
    return 'policy: contributor_contact empty';
  if (row.license == null)
    return 'policy: license null';
  return null;
}

// ── Build the row that gets POSTed to Supabase ─────────────────────────
// fc — the file-level context from readFileContext(json): material card,
// sigma_ref, cell size and voxel size (Ingest's page globals until
// f13ld-vault-push.js took over the row builder).
function buildRow(d, hash, meta, contributor, context, sweepContext, fc) {
  fc = fc || {};
  var design  = d.design;
  var browser = d.browser || {};

  // ── Material card: jsonb carrying the full material as a unit ──────
  // Pulled straight from the sweep context (cached on file drop). The
  // ingest UI no longer asks the contributor to type material info —
  // the file is the source of truth.
  var materialCard = fc.material || null;

  // ── Cap-affected NULL-ing ──────────────────────────────────────────
  // When linear_cap_active === true, the compliance metrics come back
  // pinned to the structural-foam ceiling and would skew histograms.
  // NULL them here; the flag itself is preserved for audit. Geometry,
  // stiffness, and thermal stay populated since the cap doesn't touch
  // them. Pre-cap values remain recoverable from ex_norm × e_solid_gpa.
  var capActive = browser.linear_cap_active === true;
  function nullIfCapped(v) { return capActive ? null : (v ?? null); }

  // ── Pore percentile normalization (μm → fraction-of-cell) ──────────
  // Sweep emits pore_size_p10/p50/p90 in μm. Schema stores them on the
  // same cell-invariant scale as pore_size_norm, so we divide here.
  // Returns null if the source field is missing OR cell size is missing.
  var cellUm = (fc.cellSizeMm != null) ? fc.cellSizeMm * 1000 : null;
  function poreUmToNorm(umVal) {
    if (typeof umVal !== 'number' || cellUm == null || cellUm <= 0) return null;
    return umVal / cellUm;
  }

  // ── Transport rollups (per-axis → min/max/avg) ─────────────────────
  // Returns null if any axis is missing — partial rollups would be misleading.
  function tripleRollup(x, y, z, op) {
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null;
    if (op === 'min') return Math.min(x, y, z);
    if (op === 'max') return Math.max(x, y, z);
    if (op === 'avg') return (x + y + z) / 3;
    return null;
  }
  var tortMin    = tripleRollup(browser.tortuosity_x, browser.tortuosity_y, browser.tortuosity_z, 'min');
  var tortAvg    = tripleRollup(browser.tortuosity_x, browser.tortuosity_y, browser.tortuosity_z, 'avg');
  var dEffMaxN   = tripleRollup(browser.D_eff_x_norm, browser.D_eff_y_norm, browser.D_eff_z_norm, 'max');
  var dEffAvgN   = tripleRollup(browser.D_eff_x_norm, browser.D_eff_y_norm, browser.D_eff_z_norm, 'avg');
  // v4: thermal rollups for the thermal Z-compound
  var keffMaxN   = tripleRollup(browser.keff_x_norm, browser.keff_y_norm, browser.keff_z_norm, 'max');
  var keffAvgN   = tripleRollup(browser.keff_x_norm, browser.keff_y_norm, browser.keff_z_norm, 'avg');

  // ── Recognized field set — used to compute metrics_extended sidecar ─
  // Anything in browser that ISN'T promoted to a first-class column
  // and ISN'T a dimensional original (which we drop) lands in
  // metrics_extended. This means future sweep versions can add new
  // browser fields without an ingest update.
  var FIRST_CLASS = {
    // Geometry — v5: axial_dominance dropped, directionality added (v0.14.0)
    volume_fraction:1, connect_idx:1, perc_idx:1, stiff_axis:1,
    anisotropy:1, directionality:1, ortho_contrast:1,
    aniso_efficiency:1, surface_complexity:1,
    // Stiffness — Es-decoupled
    Ex_norm:1, Ey_norm:1, Ez_norm:1, stiffness_density_norm:1,
    // Thermal — ks-decoupled
    keff_x_norm:1, keff_y_norm:1, keff_z_norm:1, thermal_anisotropy:1,
    // Compliance — load-decoupled
    microstrain_x_per_GPa:1, microstrain_y_per_GPa:1, microstrain_z_per_GPa:1,
    microstrain_avg_per_GPa:1, U_compliance:1,
    // Pore — throat_efficiency dropped in v0.13, throat_ratio added
    pore_size_norm:1, throat_size_norm:1, throat_ratio:1,
    pore_size_p10:1, pore_size_p50:1, pore_size_p90:1,  // consumed by poreUmToNorm
    pore_size_cv:1,
    // Curvature — v0.13 redefined h_mean, added H_mean_abs and H_std
    H_mean:1, H_mean_abs:1, H_std:1,
    K_gauss_mean:1, curvature_uniformity:1, MIH:1,
    // Topology — only genus_per_cell promoted; raw genus & euler_char go to jsonb
    genus_per_cell:1,
    // Transport rollups consume per-axis values → marked first-class so they
    // don't double up in metrics_extended
    tortuosity_x:1, tortuosity_y:1, tortuosity_z:1,
    D_eff_x_norm:1, D_eff_y_norm:1, D_eff_z_norm:1,
    // Solver diagnostics & cap flags
    linear_cap_active:1, eps_yield_um_used:1, linear_cap_kind:1,
    degenerate:1,                                    // v4: solver degeneracy flag
    solver_validity:1, cg_iters:1, cg_converged:1,   // v5: v0.14.0 connectivity-informed solver state
    // Dimensional originals — explicitly dropped (recoverable via view)
    Ex_GPa:1, Ey_GPa:1, Ez_GPa:1, stiffness_density:1,
    keff_x:1, keff_y:1, keff_z:1, k_density:1,
    U_strain:1, microstrain_x:1, microstrain_y:1, microstrain_z:1, microstrain_avg:1,
    pore_size:1, throat_size:1
  };

  // metrics_extended absorbs:
  //   - per-axis breakdowns we explicitly send to jsonb (connect_x/y/z,
  //     perc_x/y/z, tortuosity_x/y/z, D_eff_x/y/z_norm) — these aren't
  //     in FIRST_CLASS for "send to extended" purposes, so we add them
  //     manually below
  //   - euler_char and genus (raw) — kept for audit, not promoted
  //   - any future sweep field not yet in FIRST_CLASS
  var metricsExtended = {};
  Object.keys(browser).forEach(function(k){
    if (!FIRST_CLASS[k]) metricsExtended[k] = browser[k];
  });
  // Per-axis values that ARE in FIRST_CLASS (because they feed rollups)
  // but should ALSO land in metrics_extended for power users / audit.
  var ALSO_TO_EXTENDED = [
    'connect_x', 'connect_y', 'connect_z',
    'perc_x', 'perc_y', 'perc_z',
    'tortuosity_x', 'tortuosity_y', 'tortuosity_z',
    'D_eff_x_norm', 'D_eff_y_norm', 'D_eff_z_norm',
    'euler_char', 'genus'
  ];
  ALSO_TO_EXTENDED.forEach(function(k){
    if (browser[k] !== undefined) metricsExtended[k] = browser[k];
  });

  // ── Build the row ───────────────────────────────────────────────────

  return {
    // Identity
    content_hash:        hash,
    schema_version:      meta.tool_version || meta.version || null,
    family:              design.family,

    // Provenance
    source_tool:         meta.tool         || null,
    source_version:      meta.tool_version || meta.version || null,
    exported_at:         meta.exported     || null,
    preset:              design.meta?.preset || meta.preset || null,
    solver:              meta.solver       || null,

    // Contributor
    contributor_name:    contributor.name,
    contributor_contact: contributor.contact,
    contributor_notes:   contributor.notes || null,

    // Application context — provenance for re-derivation
    domain:              context.domain,
    material:            materialCard,
    e_solid_gpa:         (materialCard && materialCard.E_GPa != null)
                           ? materialCard.E_GPa
                           : null,
    sigma_ref_gpa:       fc.sigmaRefGPa,
    cell_size_mm:        fc.cellSizeMm,
    voxel_to_um:         fc.voxelToUm,

    // Geometry — material-agnostic (axial_dominance dropped in v0.14.0,
    // directionality added). v0.14.1 makes anisotropy + aniso_efficiency
    // nullable when fewer than 2 axes percolate (mathematically undefined).
    volume_fraction:     browser.volume_fraction   ?? null,
    connect_idx:         browser.connect_idx       ?? null,
    perc_idx:            browser.perc_idx          ?? null,
    stiff_axis:          browser.stiff_axis        ?? null,
    anisotropy:          browser.anisotropy        ?? null,
    directionality:      browser.directionality    ?? null,   // v5: NEW (replaces axial_dominance)
    ortho_contrast:      browser.ortho_contrast    ?? null,
    aniso_efficiency:    browser.aniso_efficiency  ?? null,
    surface_complexity:  browser.surface_complexity ?? null,

    // Stiffness — Es-decoupled
    ex_norm:                 browser.Ex_norm                ?? null,
    ey_norm:                 browser.Ey_norm                ?? null,
    ez_norm:                 browser.Ez_norm                ?? null,
    stiffness_density_norm:  browser.stiffness_density_norm ?? null,

    // Thermal — ks-decoupled (max/avg rollups added in v4)
    keff_x_norm:             browser.keff_x_norm        ?? null,
    keff_y_norm:             browser.keff_y_norm        ?? null,
    keff_z_norm:             browser.keff_z_norm        ?? null,
    keff_max_norm:           keffMaxN,
    keff_avg_norm:           keffAvgN,
    thermal_anisotropy:      browser.thermal_anisotropy ?? null,

    // Compliance — load-decoupled (NULLed when cap active)
    microstrain_x_per_gpa:   nullIfCapped(browser.microstrain_x_per_GPa),
    microstrain_y_per_gpa:   nullIfCapped(browser.microstrain_y_per_GPa),
    microstrain_z_per_gpa:   nullIfCapped(browser.microstrain_z_per_GPa),
    microstrain_avg_per_gpa: nullIfCapped(browser.microstrain_avg_per_GPa),
    u_compliance:            nullIfCapped(browser.U_compliance),

    // Pore architecture — cell-decoupled (percentiles normalized at ingest;
    // throat_efficiency dropped in v0.13, replaced by raw throat_ratio)
    pore_size_norm:          browser.pore_size_norm    ?? null,
    pore_size_p10_norm:      poreUmToNorm(browser.pore_size_p10),
    pore_size_p50_norm:      poreUmToNorm(browser.pore_size_p50),
    pore_size_p90_norm:      poreUmToNorm(browser.pore_size_p90),
    pore_size_cv:            browser.pore_size_cv      ?? null,
    throat_size_norm:        browser.throat_size_norm  ?? null,
    throat_ratio:            browser.throat_ratio      ?? null,

    // Curvature — v0.13 redefined h_mean as signed; raw H_mean_abs/H_std added
    h_mean:                  browser.H_mean               ?? null,
    h_mean_abs:              browser.H_mean_abs           ?? null,
    h_std:                   browser.H_std                ?? null,
    k_gauss_mean:            browser.K_gauss_mean         ?? null,
    curvature_uniformity:    browser.curvature_uniformity ?? null,
    mih:                     browser.MIH                  ?? null,

    // Topology — only genus_per_cell promoted; raw euler_char/genus → metrics_extended
    genus_per_cell:          browser.genus_per_cell ?? null,

    // Transport — rollups (per-axis → metrics_extended)
    tortuosity_min:          tortMin,
    tortuosity_avg:          tortAvg,
    d_eff_max_norm:          dEffMaxN,
    d_eff_avg_norm:          dEffAvgN,

    // Solver diagnostics & cap flags (degenerate added in v4;
    // solver_validity/cg_iters/cg_converged added in v5 from sweep v0.14.0)
    linear_cap_active:       browser.linear_cap_active === true,
    eps_yield_um_used:       browser.eps_yield_um_used ?? null,
    linear_cap_kind:         browser.linear_cap_kind   ?? null,
    degenerate:              browser.degenerate === true,
    solver_validity:         browser.solver_validity   ?? null,   // v5: 'valid'|'partial'|'invalid'|null(v0.13)
    cg_iters:                browser.cg_iters          ?? null,   // v5: total CG iterations
    cg_converged:            (typeof browser.cg_converged === 'boolean')
                               ? browser.cg_converged
                               : null,                            // v5: tri-state (true|false|null for v0.13)

    // Future-proofing — per-axis breakdowns + any unrecognized fields
    metrics_extended:        metricsExtended,

    // Full provenance blobs
    recipe:              design,
    context:             sweepContext || null,

    license:             LICENSE_TAG
  };
}


// ═══════════════════════════════════════════════════════════════════════
// Everything below is new in f13ld-vault-push.js v1.0.0
// ═══════════════════════════════════════════════════════════════════════

var PROVENANCE_KINDS = ['sweep', 'lab', 'file'];

// ── File-level context (what Ingest read from a sweep export on drop) ──
function readFileContext(json) {
  var ctx = json.context || {};
  var designs = json.designs || [];
  var meta = json.meta || {};
  var domain = ctx.domain ||
               (designs[0] && designs[0].design && designs[0].design.domain) ||
               (designs[0] && designs[0].design && designs[0].design.meta && designs[0].design.meta.domain) ||
               meta.domain || null;
  var matRaw = ctx.material, material;
  if (matRaw && typeof matRaw === 'object') material = matRaw;
  else if (typeof matRaw === 'string')      material = { key: matRaw };
  else                                      material = null;
  return {
    domain:      domain,
    material:    material,
    sigmaRefGPa: (typeof ctx.sigma_ref_GPa === 'number') ? ctx.sigma_ref_GPa : null,
    cellSizeMm:  (typeof ctx.cellSize_mm   === 'number') ? ctx.cellSize_mm   : null,
    voxelToUm:   (typeof ctx.voxelToUm_um  === 'number') ? ctx.voxelToUm_um  : null
  };
}

// ── Database helpers ───────────────────────────────────────────────────
function dbHeaders(extra) {
  var h = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY };
  if (extra) for (var k in extra) h[k] = extra[k];
  return h;
}
function restUrl(table, query) {
  return SUPABASE_URL + '/rest/v1/' + table + (query ? '?' + query : '');
}

// Number of designs in Vault (null when the count can't be read).
async function countDesigns() {
  try {
    var res = await fetch(restUrl(TABLE, 'select=content_hash&limit=1'),
      { headers: dbHeaders({ Prefer: 'count=exact' }) });
    if (!res.ok) return null;
    var cr = res.headers.get('content-range') || '';
    var m = /\/(\d+)$/.exec(cr);
    return m ? parseInt(m[1], 10) : null;
  } catch (e) { return null; }
}

// Which of these hashes are already stored? Asks only about the given
// hashes (in chunks), so the database's per-request row limit (1,000 by
// default) never truncates the answer.
async function fetchExistingHashes(hashes, table, column) {
  table  = table  || TABLE;
  column = column || 'content_hash';
  var uniq = Array.from(new Set(hashes || [])).filter(function (h) { return typeof h === 'string' && h.length; });
  var found = new Set();
  for (var i = 0; i < uniq.length; i += HASH_CHUNK) {
    var chunk = uniq.slice(i, i + HASH_CHUNK);
    var q = 'select=' + column + '&' + column + '=in.(' + chunk.map(encodeURIComponent).join(',') + ')';
    var res = await fetch(restUrl(table, q), { headers: dbHeaders() });
    if (!res.ok) {
      var t = '';
      try { t = await res.text(); } catch (e) { /* ignore */ }
      throw new Error('HTTP ' + res.status + (t ? ' — ' + t.slice(0, 160) : ''));
    }
    var rows = await res.json();
    rows.forEach(function (r) { found.add(r[column]); });
  }
  return found;
}

// ── Analyze an export ──────────────────────────────────────────────────
// json: a Sweep-shape export { meta, context?, designs: [{ id, browser, design }] }
// opts.existingHashes: a Set to use instead of asking the database
// Returns { meta, context, fileContext, items, counts, hashCheck }
//   items[i] = { index, status: 'valid'|'dupe'|'invalid', reason, d, hash }
// File-level policy problems (an empty schema_version, an unknown family)
// show here; the contributor and domain are checked when rows are built.
async function analyze(json, opts) {
  opts = opts || {};
  if (!json || !json.meta || !Array.isArray(json.designs))
    throw new Error('Invalid sweep export — missing meta or designs[] array');
  var meta = json.meta;
  var fc = readFileContext(json);
  var items = [];

  for (var i = 0; i < json.designs.length; i++) {
    var d = json.designs[i];
    var reason = validateDesign(d);
    if (reason) { items.push({ index: i, status: 'invalid', reason: reason, d: d }); continue; }
    items.push({ index: i, status: 'pending', d: d, hash: await contentHash(d.design) });
  }

  var hashCheck = { ok: true, error: null, found: 0 };
  var existing;
  if (opts.existingHashes) {
    existing = opts.existingHashes;
  } else {
    try {
      existing = await fetchExistingHashes(items.filter(function (it) { return it.status === 'pending'; })
                                                .map(function (it) { return it.hash; }));
    } catch (e) {
      existing = new Set();
      hashCheck.ok = false;
      hashCheck.error = e.message;
    }
  }
  hashCheck.found = existing.size;

  var seen = new Set();
  var placeholder = { name: '-', contact: '-', notes: '' };
  items.forEach(function (it) {
    if (it.status !== 'pending') return;
    if (existing.has(it.hash) || seen.has(it.hash)) {
      it.status = 'dupe';
      it.reason = existing.has(it.hash) ? 'already in F13LD.vault' : 'repeated in this file';
      return;
    }
    var probe = buildRow(it.d, it.hash, meta, placeholder, { domain: '-' }, json.context || null, fc);
    var policyReason = policyCheckRow(probe);
    if (policyReason) { it.status = 'invalid'; it.reason = policyReason; return; }
    it.status = 'valid';
    it.reason = null;
    seen.add(it.hash);
  });

  var counts = { total: items.length, valid: 0, dupe: 0, invalid: 0 };
  items.forEach(function (it) { counts[it.status]++; });

  return { meta: meta, context: json.context || null, fileContext: fc,
           items: items, counts: counts, hashCheck: hashCheck };
}

// ── Build rows for the valid designs ───────────────────────────────────
// who: { contributor: {name, contact, notes}, domain, provenanceKind }
// Returns { rows, rejected: [{ item, reason }] }
function buildRows(analysis, who) {
  who = who || {};
  var kind = who.provenanceKind || 'file';
  if (PROVENANCE_KINDS.indexOf(kind) < 0) throw new Error('unknown provenance kind "' + kind + '"');
  var contributor = who.contributor || {};
  var c = { name: (contributor.name || '').trim(), contact: (contributor.contact || '').trim(),
            notes: (contributor.notes || '').trim() };
  var context = { domain: (who.domain || '').trim() };
  var rows = [], rejected = [];
  analysis.items.forEach(function (it) {
    if (it.status !== 'valid') return;
    var row = buildRow(it.d, it.hash, analysis.meta, c, context, analysis.context, analysis.fileContext);
    row.provenance_kind = kind;
    var reason = policyCheckRow(row);
    if (reason) { rejected.push({ item: it, reason: reason }); return; }
    it.row = row;
    rows.push(row);
  });
  return { rows: rows, rejected: rejected };
}

// ── Batched insert ─────────────────────────────────────────────────────
// A batch that fails on a duplicate key (HTTP 409) — someone else pushed
// the same design a moment ago — is retried one row at a time, so one
// duplicate never sinks the other 49.
async function postRows(table, rows) {
  var res = await fetch(restUrl(table), {
    method: 'POST',
    headers: dbHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify(rows)
  });
  if (res.ok) return { ok: true, status: res.status };
  var text = '';
  try { text = await res.text(); } catch (e) { /* ignore */ }
  return { ok: false, status: res.status, text: text };
}
function isDuplicateError(r) {
  return r.status === 409 && /23505|duplicate key/i.test(r.text || '');
}

// opts: { onProgress(evt), dryRun }
//   evt = { level: 'info'|'warn'|'error'|'success', message, done, total }
// Returns { inserted, duplicates, failed, errors: [message] }
async function insertBatched(table, rows, opts) {
  opts = opts || {};
  var say = opts.onProgress || function () {};
  var out = { inserted: 0, duplicates: 0, failed: 0, errors: [] };
  var nBatches = Math.ceil(rows.length / BATCH_SIZE);
  for (var i = 0; i < rows.length; i += BATCH_SIZE) {
    var batch = rows.slice(i, i + BATCH_SIZE);
    var bn = Math.floor(i / BATCH_SIZE) + 1;
    var done = Math.min(i + BATCH_SIZE, rows.length);
    if (opts.dryRun) {
      out.inserted += batch.length;
      say({ level: 'info', message: 'Batch ' + bn + ' of ' + nBatches + ' — ' + batch.length + ' rows (dry run, not sent)', done: done, total: rows.length });
      continue;
    }
    var r;
    try { r = await postRows(table, batch); }
    catch (e) { r = { ok: false, status: 0, text: e.message }; }
    if (!r.ok && r.status === 0) {           // network blip: one retry
      try { r = await postRows(table, batch); } catch (e2) { r = { ok: false, status: 0, text: e2.message }; }
    }
    if (r.ok) {
      out.inserted += batch.length;
      say({ level: 'info', message: 'Batch ' + bn + ' — inserted ' + batch.length + ' rows', done: done, total: rows.length });
    } else if (isDuplicateError(r) && batch.length > 1) {
      say({ level: 'warn', message: 'Batch ' + bn + ' hit a design already in F13LD.vault — sending it one at a time', done: done, total: rows.length });
      for (var j = 0; j < batch.length; j++) {
        var one;
        try { one = await postRows(table, [batch[j]]); } catch (e3) { one = { ok: false, status: 0, text: e3.message }; }
        if (one.ok) out.inserted++;
        else if (isDuplicateError(one)) out.duplicates++;
        else { out.failed++; out.errors.push((one.text || ('HTTP ' + one.status)).slice(0, 200)); }
      }
    } else if (isDuplicateError(r)) {
      out.duplicates += batch.length;
    } else {
      out.failed += batch.length;
      var msg = (r.status ? 'HTTP ' + r.status + ' — ' : '') + (r.text || '').slice(0, 160);
      out.errors.push(msg);
      say({ level: 'error', message: 'Batch ' + bn + ' failed: ' + msg, done: done, total: rows.length });
    }
  }
  return out;
}
function insertDesigns(rows, opts)    { return insertBatched(TABLE, rows, opts); }
function insertLabResults(rows, opts) { return insertBatched(LAB_TABLE, rows, opts); }

// ── F13LD.lab solves ───────────────────────────────────────────────────
// Columns of f13ld_lab_results the public key may insert. Anything else a
// Lab result carries goes into results_extended.
var LAB_COLUMNS = [
  'content_hash', 'solve_hash', 'lab_version',
  'grid_n', 'partial_volume', 'void_ratio', 'cg_tol', 'converged', 'cube_solved',
  'material', 'material_key', 'e_solid_gpa', 'sigma_y_solid_mpa', 'cell_size_mm',
  'ex_norm', 'ey_norm', 'ez_norm', 'gyz_norm', 'gxz_norm', 'gxy_norm', 'nu_xy', 'nu_xz', 'nu_yz', 'c_tensor',
  'lambda_cr', 'buckling_axis', 'buckling_per_axis', 'pcr_py',
  'sigma_y_x_mpa', 'sigma_y_y_mpa', 'sigma_y_z_mpa', 'sigma_peak_mpa', 'crush_e0_norm',
  'failure_mode', 'yield_is_bound',
  'thermal', 'k_rel_water',
  'porosity', 'surface_area_density_m2m3', 'hydraulic_diameter_mm', 'open_axes',
  'source_tool', 'contributor_name', 'contributor_contact', 'contributor_notes', 'license',
  'results_extended'
];
var LAB_SET = {};
LAB_COLUMNS.forEach(function (c) { LAB_SET[c] = 1; });

// Mirrors the f13ld_lab_results insert policy (2026-10-10).
function policyCheckLabRow(row) {
  function nonEmpty(v) { return typeof v === 'string' && v.length > 0; }
  if (!nonEmpty(row.content_hash) || row.content_hash.length !== 64)
    return 'policy: Lab result has no design hash';
  if (!nonEmpty(row.solve_hash))          return 'policy: solve_hash empty';
  if (!nonEmpty(row.lab_version))         return 'policy: lab_version empty';
  if (!nonEmpty(row.contributor_name))    return 'policy: contributor_name empty';
  if (!nonEmpty(row.contributor_contact)) return 'policy: contributor_contact empty';
  if (row.license == null)                return 'policy: license null';
  if (row.source_tool !== 'f13ld.lab')    return 'policy: source_tool must be f13ld.lab';
  return null;
}

// labResults: [{ designIndex, result: { lab_version, grid_n, ex_norm, … } }]
//   designIndex — the design's position in the export's designs[]
// Lab results for a design that failed its checks are dropped (reason given);
// designs already in Vault keep theirs (the Vault → Lab → Vault round trip).
// Returns { rows, rejected: [{ designIndex, reason }] }
async function prepareLabRows(analysis, labResults, contributor) {
  var byIndex = {};
  analysis.items.forEach(function (it) { byIndex[it.index] = it; });
  var c = contributor || {};
  var rows = [], rejected = [];
  for (var i = 0; i < (labResults || []).length; i++) {
    var lr = labResults[i] || {};
    var it = byIndex[lr.designIndex];
    if (!it) { rejected.push({ designIndex: lr.designIndex, reason: 'no such design in the export' }); continue; }
    if (it.status === 'invalid') { rejected.push({ designIndex: lr.designIndex, reason: 'design failed its checks: ' + it.reason }); continue; }
    var src = lr.result || {};
    var row = {}, extra = {};
    Object.keys(src).forEach(function (k) {
      if (k === 'results_extended' && src[k] && typeof src[k] === 'object') {
        Object.keys(src[k]).forEach(function (k2) { extra[k2] = src[k][k2]; });
      } else if (LAB_SET[k] && ['content_hash', 'contributor_name', 'contributor_contact', 'contributor_notes', 'license', 'source_tool', 'solve_hash'].indexOf(k) < 0) {
        row[k] = src[k];
      } else if (!LAB_SET[k]) {
        extra[k] = src[k];
      }
    });
    row.results_extended = extra;
    row.content_hash = it.hash;
    row.solve_hash = await contentHash({ design: it.hash, result: row });
    row.source_tool = 'f13ld.lab';
    row.contributor_name = (c.name || '').trim();
    row.contributor_contact = (c.contact || '').trim();
    row.contributor_notes = (c.notes || '').trim() || null;
    row.license = LICENSE_TAG;
    var reason = policyCheckLabRow(row);
    if (reason) { rejected.push({ designIndex: lr.designIndex, reason: reason }); continue; }
    rows.push(row);
  }
  return { rows: rows, rejected: rejected };
}

// ── Contributor details (shared by every F13LD tool on this site) ──────
var LS = {
  name:    'f13ld.ingest.contributor.name',
  contact: 'f13ld.ingest.contributor.contact',
  notes:   'f13ld.ingest.contributor.notes'
};
function loadContributor() {
  var c = { name: '', contact: '', notes: '' };
  try {
    c.name    = localStorage.getItem(LS.name)    || '';
    c.contact = localStorage.getItem(LS.contact) || '';
    c.notes   = localStorage.getItem(LS.notes)   || '';
  } catch (e) { /* private mode */ }
  return c;
}
function saveContributor(c) {
  try {
    localStorage.setItem(LS.name,    (c.name    || '').trim());
    localStorage.setItem(LS.contact, (c.contact || '').trim());
    localStorage.setItem(LS.notes,   (c.notes   || '').trim());
  } catch (e) { /* ignore */ }
}

// ── CC0 rights confirmation: once per browser session ──────────────────
// A session cookie (no expiry) on the whole site: one tick covers Ingest,
// Sweep and Lab in every tab until the browser closes.
var CONSENT_COOKIE = 'f13ld_cc0_ok';
function hasConsent() {
  try { return document.cookie.split(';').some(function (p) { return p.trim() === CONSENT_COOKIE + '=1'; }); }
  catch (e) { return false; }
}
function setConsent(on) {
  try {
    var secure = (typeof location !== 'undefined' && location.protocol === 'https:') ? '; Secure' : '';
    document.cookie = CONSENT_COOKIE + '=' + (on ? '1' : '') + '; path=/; SameSite=Lax' + secure +
                      (on ? '' : '; Max-Age=0');
  } catch (e) { /* ignore */ }
}
var LICENSE_TEXT =
  'I confirm I have the right to share these designs and release them under ' +
  '<strong>CC0 1.0 Universal</strong> (public domain dedication). Designs and metadata ' +
  'become publicly available in F13LD.vault. Contributor name and notes are public; ' +
  'contact is stored privately and revealed only on request. ' +
  '<a href="https://creativecommons.org/publicdomain/zero/1.0/" target="_blank" rel="noopener">Read the license</a>.';

// ═══════════════════════════════════════════════════════════════════════
// Push window
// ═══════════════════════════════════════════════════════════════════════
// opts = {
//   json            Sweep-shape export (required)
//   source          'F13LD.sweep' | 'F13LD.lab' — shown in the header
//   provenanceKind  'sweep' | 'lab'
//   labResults      optional, see prepareLabRows
//   accent          the tool's accent colour (default F13LD neon-lime)
//   dryRun          true: everything but the database writes
//   heldBack        optional [{ label, reason }] — designs the tool kept
//                   out before the push (e.g. Lab's stretched cells)
// }
// Resolves when the window closes:
//   { pushed: bool, designs: insertResult|null, lab: insertResult|null }

var ICON = {
  vault: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4.5 5.5v6.5c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8V5.5M4.5 12v6.5c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8V12" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  up:    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 19V6M6.5 11.5L12 6l5.5 5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  alert: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 4l9 15.5H3L12 4z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 10v4.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="16.9" r="1.1" fill="currentColor"/></svg>',
  chev:  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  out:   '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8M17 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  spin:  '<svg class="f13v-spin" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="2.2"/><path d="M12 4a8 8 0 0 1 8 8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>'
};

var CSS = [
'.f13v-scrim{position:fixed;inset:0;z-index:2147483000;background:rgba(3,5,8,.72);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;overflow:hidden}',
'.f13v{--a:#c8f542;--g:#06080c;--p:#0d1117;--p2:#131a22;--l:#232c37;--t:#e7ecef;--m:#8b97a3;--ok:#1D9E75;--bad:#e06a6f;--warn:#e0b45a;',
'font-family:"Exo 2",system-ui,-apple-system,"Segoe UI",sans-serif;font-size:14px;line-height:1.45;color:var(--t);background:var(--p);border:1px solid var(--l);border-radius:14px;',
'width:100%;max-width:560px;max-height:calc(100vh - 32px);display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box}',
'.f13v *{box-sizing:border-box}',
// host pages (Sweep, Lab) style button/input globally; reset what leaks in
'.f13v button,.f13v input,.f13v a{margin:0;box-shadow:none;text-transform:none;letter-spacing:normal;min-width:0;max-width:none;height:auto;line-height:1.2}',
'.f13v svg{flex:none;display:block}',
'.f13v :focus-visible{outline:2px solid var(--a);outline-offset:2px}',
'.f13v-hd{display:flex;align-items:center;gap:12px;padding:16px 18px;border-bottom:1px solid var(--l)}',
'.f13v-hd .ic{color:var(--a);display:flex}',
'.f13v-ttl{font-size:16px;font-weight:600;letter-spacing:.01em}',
'.f13v-sub{font-size:12px;color:var(--m);font-family:"IBM Plex Mono",ui-monospace,monospace;overflow-wrap:anywhere}',
'.f13v-x{margin-left:auto;background:none;border:1px solid transparent;color:var(--m);border-radius:8px;width:32px;height:32px;padding:0;display:flex;align-items:center;justify-content:center;cursor:pointer;flex:none}',
'.f13v-x:hover{color:var(--t);border-color:var(--l)}',
'.f13v-hd .f13v-x{margin-left:auto}',
'.f13v-bd{padding:16px 18px;overflow-y:auto;overflow-x:hidden;flex:1 1 auto;display:flex;flex-direction:column;gap:16px}',
'.f13v-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px}',
'.f13v-stat{background:var(--p2);border:1px solid var(--l);border-radius:10px;padding:10px 12px;min-width:0}',
'.f13v-stat b{display:block;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:20px;font-weight:500}',
'.f13v-stat span{font-size:12px;color:var(--m)}',
'.f13v-stat.ok b{color:var(--ok)}.f13v-stat.bad b{color:var(--bad)}.f13v-stat.mut b{color:var(--m)}.f13v-stat.lab b{color:var(--a)}',
'.f13v-det{border:1px solid var(--l);border-radius:10px;background:var(--p2)}',
'.f13v-det summary{list-style:none;cursor:pointer;padding:10px 12px;display:flex;align-items:center;gap:8px;font-size:13px;color:var(--m)}',
'.f13v-det summary::-webkit-details-marker{display:none}',
'.f13v-det summary .chev{display:flex;transition:transform .15s}',
'.f13v-det[open] summary .chev{transform:rotate(90deg)}',
'.f13v-list{margin:0;padding:0 12px 10px;list-style:none;max-height:180px;overflow-y:auto;overflow-x:hidden}',
'.f13v-list li{font-size:12px;padding:5px 0;border-top:1px solid var(--l);display:flex;gap:8px;min-width:0}',
'.f13v-list .id{font-family:"IBM Plex Mono",ui-monospace,monospace;color:var(--t);flex:none}',
'.f13v-list .why{color:var(--m);overflow-wrap:anywhere;min-width:0}',
'.f13v-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
'.f13v-f{display:flex;flex-direction:column;gap:4px;min-width:0}',
'.f13v-f.wide{grid-column:1/-1}',
'.f13v-f label{font-size:12px;color:var(--m)}',
'.f13v-f label i{color:var(--a);font-style:normal}',
'.f13v-f input{font:inherit;font-size:14px;color:var(--t);background:var(--g);border:1px solid var(--l);border-radius:8px;padding:8px 10px;width:100%;min-width:0}',
'.f13v-f input:focus{outline:none;border-color:var(--a)}',
'.f13v-f .err{font-size:12px;color:var(--bad);min-height:0}',
'.f13v-sec{font-size:12px;color:var(--m);text-transform:none;letter-spacing:.02em;margin-bottom:-6px}',
'.f13v-cc{display:flex;gap:10px;align-items:flex-start;background:var(--p2);border:1px solid var(--l);border-radius:10px;padding:12px;cursor:pointer;font-size:12px;color:var(--m)}',
'.f13v-cc input{margin:2px 0 0;accent-color:var(--a);width:16px;height:16px;flex:none}',
'.f13v-cc strong{color:var(--t);font-weight:600}.f13v-cc a{color:var(--a)}',
'.f13v-cc.need{border-color:var(--bad)}',
'.f13v-note{display:flex;gap:8px;align-items:flex-start;font-size:12px;color:var(--m);padding:10px 12px;border-radius:10px;background:var(--p2);border:1px solid var(--l)}',
'.f13v-note .ic{display:flex;flex:none;color:var(--warn)}',
'.f13v-note.ok .ic{color:var(--ok)}.f13v-note.bad .ic{color:var(--bad)}',
'.f13v-ft{display:flex;align-items:center;gap:12px;padding:14px 18px;border-top:1px solid var(--l);flex-wrap:wrap}',
'.f13v-status{font-size:12px;color:var(--m);flex:1 1 180px;min-width:0;overflow-wrap:anywhere}',
'.f13v-btn{font:inherit;font-size:14px;font-weight:600;display:inline-flex;align-items:center;gap:8px;border-radius:9px;padding:9px 16px;cursor:pointer;border:1px solid var(--a);background:var(--a);color:var(--g);text-decoration:none;white-space:nowrap}',
'.f13v-btn:disabled{opacity:.4;cursor:not-allowed}',
'.f13v-btn.ghost{background:transparent;color:var(--t);border-color:var(--l)}',
'.f13v-btn.ghost:hover{border-color:var(--m)}',
'.f13v-bar{height:3px;background:var(--l);border-radius:2px;overflow:hidden}',
'.f13v-bar>div{height:100%;width:0;background:var(--a);transition:width .25s}',
'.f13v-dry{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:12px;color:var(--warn);border:1px solid var(--warn);border-radius:6px;padding:1px 6px;flex:none}',
'.f13v-load{display:flex;align-items:center;gap:10px;color:var(--m);font-size:13px;padding:24px 0;justify-content:center}',
'.f13v-spin{animation:f13vspin .9s linear infinite}',
'@keyframes f13vspin{to{transform:rotate(360deg)}}',
'@media (prefers-reduced-motion:reduce){.f13v-spin{animation-duration:2.4s}}',
'@media (max-width:600px){.f13v-scrim{padding:0;align-items:flex-end}.f13v{max-width:none;max-height:92vh;border-radius:14px 14px 0 0}.f13v-grid{grid-template-columns:1fr}}'
].join('');

function injectCss() {
  if (document.getElementById('f13v-style')) return;
  var st = document.createElement('style');
  st.id = 'f13v-style';
  st.textContent = CSS;
  document.head.appendChild(st);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
function designLabel(it) {
  var d = it.d || {}, des = d.design || {};
  return '#' + (d.id != null ? d.id : it.index) + (des.family ? ' ' + des.family : '');
}

function openPushDialog(opts) {
  opts = opts || {};
  injectCss();
  var kind = opts.provenanceKind || 'sweep';
  var source = opts.source || 'F13LD.sweep';
  var nDesigns = (opts.json && opts.json.designs) ? opts.json.designs.length : 0;
  var prevFocus = document.activeElement;

  var scrim = document.createElement('div');
  scrim.className = 'f13v-scrim';
  scrim.innerHTML =
    '<div class="f13v" role="dialog" aria-modal="true" aria-labelledby="f13v-ttl">' +
      '<div class="f13v-hd"><span class="ic">' + ICON.vault + '</span>' +
        '<div style="min-width:0"><div class="f13v-ttl" id="f13v-ttl">Push to F13LD.vault</div>' +
        '<div class="f13v-sub">' + esc(source) + ' · ' + plural(nDesigns, 'design') + '</div></div>' +
        (opts.dryRun ? '<span class="f13v-dry" title="Nothing is written to the database">dry run</span>' : '') +
        '<button class="f13v-x" type="button" aria-label="Close">' + ICON.close + '</button></div>' +
      '<div class="f13v-bd"><div class="f13v-load">' + ICON.spin + 'Checking designs against F13LD.vault</div></div>' +
      '<div class="f13v-ft"><div class="f13v-status"></div>' +
        '<button class="f13v-btn" type="button" disabled>' + ICON.up + '<span>Push</span></button></div>' +
    '</div>';
  if (opts.accent) scrim.firstChild.style.setProperty('--a', opts.accent);
  document.body.appendChild(scrim);

  var box = scrim.firstChild;
  var bd = box.querySelector('.f13v-bd');
  var statusEl = box.querySelector('.f13v-status');
  var btn = box.querySelector('.f13v-ft .f13v-btn');
  var btnLabel = btn.querySelector('span');
  var xBtn = box.querySelector('.f13v-x');
  var busy = false, analysis = null, result = { pushed: false, designs: null, lab: null };
  var resolveFn;
  var done = new Promise(function (r) { resolveFn = r; });

  function close() {
    if (busy) return;
    document.removeEventListener('keydown', onKey, true);
    scrim.remove();
    try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (e) { /* ignore */ }
    resolveFn(result);
  }
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
  document.addEventListener('keydown', onKey, true);
  xBtn.addEventListener('click', close);
  scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) close(); });

  function note(cls, icon, html) {
    return '<div class="f13v-note ' + cls + '"><span class="ic">' + icon + '</span><div>' + html + '</div></div>';
  }
  function reasonList(title, entries) {
    if (!entries.length) return '';
    return '<details class="f13v-det"><summary><span class="chev">' + ICON.chev + '</span>' + esc(title) + '</summary>' +
           '<ul class="f13v-list">' + entries.map(function (e) {
             return '<li><span class="id">' + esc(e.label) + '</span><span class="why">' + esc(e.reason) + '</span></li>';
           }).join('') + '</ul></details>';
  }

  function renderForm() {
    var c = analysis.counts;
    var labN = (opts.labResults || []).length;
    var held = opts.heldBack || [];
    var stats =
      '<div class="f13v-stats">' +
        '<div class="f13v-stat ok"><b>' + c.valid + '</b><span>ready to add</span></div>' +
        '<div class="f13v-stat mut"><b>' + c.dupe + '</b><span>already in Vault</span></div>' +
        '<div class="f13v-stat bad"><b>' + c.invalid + '</b><span>failed checks</span></div>' +
        (labN ? '<div class="f13v-stat lab"><b>' + labN + '</b><span>Lab ' + (labN === 1 ? 'solve' : 'solves') + '</span></div>' : '') +
        (held.length ? '<div class="f13v-stat mut"><b>' + held.length + '</b><span>held back</span></div>' : '') +
      '</div>';
    var failed = analysis.items.filter(function (it) { return it.status === 'invalid'; })
      .map(function (it) { return { label: designLabel(it), reason: it.reason }; });
    var dupes = analysis.items.filter(function (it) { return it.status === 'dupe'; })
      .map(function (it) { return { label: designLabel(it), reason: it.reason }; });
    var hc = analysis.hashCheck.ok ? '' :
      note('', ICON.alert, 'Could not check for designs already in F13LD.vault (' + esc(analysis.hashCheck.error) +
           '). Designs already there will be skipped by the database.');
    var who = loadContributor();
    var consented = hasConsent();
    var dom = (analysis.fileContext.domain && typeof analysis.fileContext.domain === 'string') ? analysis.fileContext.domain : '';
    bd.innerHTML = stats + hc +
      reasonList('Why ' + plural(failed.length, 'design') + ' failed', failed) +
      reasonList(plural(dupes.length, 'design') + ' already in F13LD.vault', dupes) +
      reasonList(plural(held.length, 'design') + ' held back by ' + source, held) +
      '<div class="f13v-sec">Contributor — attached to every design in this push</div>' +
      '<div class="f13v-grid">' +
        '<div class="f13v-f"><label for="f13v-name">Name <i>*</i></label><input id="f13v-name" maxlength="120" autocomplete="name" placeholder="e.g. Matt Shomper, Acme Lattice Labs"><div class="err"></div></div>' +
        '<div class="f13v-f"><label for="f13v-contact">Contact <i>*</i></label><input id="f13v-contact" maxlength="200" placeholder="email · ORCID · GitHub · lab URL"><div class="err"></div></div>' +
        '<div class="f13v-f wide"><label for="f13v-notes">Notes</label><input id="f13v-notes" maxlength="280" placeholder="e.g. Submitted alongside RAPID 2026 paper"><div class="err"></div></div>' +
        '<div class="f13v-f wide"><label for="f13v-domain">Domain <i>*</i></label><input id="f13v-domain" maxlength="80" placeholder="e.g. orthopedic"><div class="err"></div></div>' +
      '</div>' +
      '<label class="f13v-cc"><input type="checkbox" id="f13v-cc"><span>' + LICENSE_TEXT +
        (consented ? ' <br><span style="color:var(--ok)">Confirmed earlier this browser session.</span>' : '') + '</span></label>' +
      '<div class="f13v-bar" hidden><div></div></div>';
    box.querySelector('#f13v-name').value = who.name;
    box.querySelector('#f13v-contact').value = who.contact;
    box.querySelector('#f13v-notes').value = who.notes;
    box.querySelector('#f13v-domain').value = dom;
    box.querySelector('#f13v-cc').checked = consented;
    ['f13v-name', 'f13v-contact', 'f13v-domain'].forEach(function (id) {
      box.querySelector('#' + id).addEventListener('input', function () { fieldErr(id, ''); refresh(); });
    });
    box.querySelector('#f13v-cc').addEventListener('change', function () { box.querySelector('.f13v-cc').classList.remove('need'); refresh(); });
    var nothing = c.valid === 0 && !labN;
    btn.disabled = nothing;
    btnLabel.textContent = c.valid ? 'Push ' + plural(c.valid, 'design') : (labN ? 'Push ' + plural(labN, 'Lab solve') : 'Nothing to push');
    refresh();
  }
  function fieldErr(id, msg) {
    var el = box.querySelector('#' + id);
    if (el) el.parentNode.querySelector('.err').textContent = msg;
  }
  function val(id) { var el = box.querySelector('#' + id); return el ? el.value.trim() : ''; }
  function refresh() {
    if (!analysis || busy) return;
    var missing = [];
    if (!val('f13v-name')) missing.push('name');
    if (!val('f13v-contact')) missing.push('contact');
    if (!val('f13v-domain')) missing.push('domain');
    if (!box.querySelector('#f13v-cc').checked) missing.push('rights confirmation');
    statusEl.textContent = missing.length ? 'Needs: ' + missing.join(', ') : 'Ready';
  }

  async function push() {
    var ok = true;
    [['f13v-name', 'Enter a name'], ['f13v-contact', 'Enter a contact'], ['f13v-domain', 'Enter a domain']].forEach(function (p) {
      if (!val(p[0])) { fieldErr(p[0], p[1]); ok = false; }
    });
    var cc = box.querySelector('#f13v-cc');
    if (!cc.checked) { box.querySelector('.f13v-cc').classList.add('need'); ok = false; }
    if (!ok) {
      statusEl.textContent = 'Fill in the marked fields first';
      var firstBad = Array.prototype.find.call(bd.querySelectorAll('.f13v-f .err'), function (e) { return e.textContent; });
      var target = firstBad ? firstBad.parentNode : box.querySelector('.f13v-cc.need');
      if (target && target.scrollIntoView) target.scrollIntoView({ block: 'nearest' });
      return;
    }

    var contributor = { name: val('f13v-name'), contact: val('f13v-contact'), notes: val('f13v-notes') };
    saveContributor(contributor);
    setConsent(true);

    busy = true;
    btn.disabled = true; xBtn.disabled = true;
    btnLabel.textContent = 'Pushing';
    Array.prototype.forEach.call(bd.querySelectorAll('input'), function (i) { i.disabled = true; });
    var bar = bd.querySelector('.f13v-bar'); bar.hidden = false;
    var fill = bar.firstChild;
    function progress(evt) {
      if (evt.total) fill.style.width = Math.round(evt.done / evt.total * 100) + '%';
      statusEl.textContent = evt.message;
    }

    var built = buildRows(analysis, { contributor: contributor, domain: val('f13v-domain'), provenanceKind: kind });
    var lab = null, labPrep = null;
    try {
      if (built.rows.length) {
        statusEl.textContent = 'Adding ' + plural(built.rows.length, 'design');
        result.designs = await insertDesigns(built.rows, { onProgress: progress, dryRun: !!opts.dryRun });
      }
      if ((opts.labResults || []).length) {
        fill.style.width = '0%';
        labPrep = await prepareLabRows(analysis, opts.labResults, contributor);
        if (labPrep.rows.length) {
          statusEl.textContent = 'Adding ' + plural(labPrep.rows.length, 'Lab solve');
          lab = await insertLabResults(labPrep.rows, { onProgress: progress, dryRun: !!opts.dryRun });
          result.lab = lab;
        }
      }
    } catch (e) {
      result.error = e.message;
    }
    busy = false; xBtn.disabled = false;
    result.pushed = !!((result.designs && result.designs.inserted) || (lab && lab.inserted));
    renderDone(built, labPrep);
  }

  function renderDone(built, labPrep) {
    var D = result.designs || { inserted: 0, duplicates: 0, failed: 0, errors: [] };
    var L = result.lab;
    var bad = D.failed || (L && L.failed) || built.rejected.length || result.error;
    var lines = [];
    lines.push(plural(D.inserted, 'design') + (opts.dryRun ? ' would be added' : ' added'));
    if (D.duplicates) lines.push(plural(D.duplicates, 'design') + ' were already in F13LD.vault');
    if (L) lines.push(plural(L.inserted, 'Lab solve') + (opts.dryRun ? ' would be added' : ' added') + (L.duplicates ? ' · ' + L.duplicates + ' already there' : ''));
    var errs = [];
    built.rejected.forEach(function (r) { errs.push({ label: designLabel(r.item), reason: r.reason }); });
    if (labPrep) labPrep.rejected.forEach(function (r) { errs.push({ label: 'Lab #' + r.designIndex, reason: r.reason }); });
    D.errors.forEach(function (m) { errs.push({ label: 'designs', reason: m }); });
    if (L) L.errors.forEach(function (m) { errs.push({ label: 'Lab', reason: m }); });
    if (result.error) errs.push({ label: 'error', reason: result.error });
    if (D.failed) lines.push(plural(D.failed, 'design') + ' could not be added');
    if (L && L.failed) lines.push(plural(L.failed, 'Lab solve') + ' could not be added');
    bd.innerHTML =
      note(bad ? 'bad' : 'ok', bad ? ICON.alert : ICON.check, lines.map(esc).join('<br>')) +
      reasonList('Details', errs) +
      (opts.dryRun ? note('', ICON.alert, 'Dry run: nothing was written to the database.') : '');
    statusEl.textContent = '';
    btn.outerHTML = '<a class="f13v-btn ghost" href="' + VAULT_URL + '" target="_blank" rel="noopener">' + ICON.out + '<span>Open F13LD.vault</span></a>' +
                    '<button class="f13v-btn" type="button" data-close>' + ICON.check + '<span>Done</span></button>';
    box.querySelector('[data-close]').addEventListener('click', close);
    box.querySelector('[data-close]').focus();
  }

  btn.addEventListener('click', function () { if (!busy && analysis) push(); });

  analyze(opts.json).then(function (a) {
    analysis = a;
    renderForm();
    var first = box.querySelector('#f13v-name');
    if (first && !first.value) first.focus(); else btn.focus();
  }).catch(function (e) {
    bd.innerHTML = note('bad', ICON.alert, 'Could not read this export: ' + esc(e.message));
    btnLabel.textContent = 'Nothing to push';
  });

  return done;
}

// ── Exports ────────────────────────────────────────────────────────────
root.F13LDVault = {
  VERSION: VERSION,
  CONFIG: { SUPABASE_URL: SUPABASE_URL, SUPABASE_KEY: SUPABASE_KEY, TABLE: TABLE, LAB_TABLE: LAB_TABLE,
            BATCH_SIZE: BATCH_SIZE, LICENSE_TAG: LICENSE_TAG, KNOWN_FAMILIES: KNOWN_FAMILIES.slice(),
            VF_MIN: VF_MIN, VF_LOW_THRESHOLD: VF_LOW_THRESHOLD, VF_MAX: VF_MAX, MIN_CONNECT_IDX: MIN_CONNECT_IDX,
            VAULT_URL: VAULT_URL },
  canonicalize: canonicalize,
  contentHash: contentHash,
  validateDesign: validateDesign,
  policyCheckRow: policyCheckRow,
  buildRow: buildRow,
  readFileContext: readFileContext,
  countDesigns: countDesigns,
  fetchExistingHashes: fetchExistingHashes,
  analyze: analyze,
  buildRows: buildRows,
  insertDesigns: insertDesigns,
  LAB_COLUMNS: LAB_COLUMNS.slice(),
  policyCheckLabRow: policyCheckLabRow,
  prepareLabRows: prepareLabRows,
  insertLabResults: insertLabResults,
  loadContributor: loadContributor,
  saveContributor: saveContributor,
  hasConsent: hasConsent,
  setConsent: setConsent,
  LICENSE_TEXT: LICENSE_TEXT,
  openPushDialog: openPushDialog
};

})(typeof window !== 'undefined' ? window : globalThis);
