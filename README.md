# F13LD · Ingest

**Part of the [F13LD suite](https://f13ld.app) by [Not a Robot Engineering](https://notarobot-eng.com)**

**[Open the Tool](https://mshomper.github.io/f13ld.ingest)**

Ingest is the bridge between the F13LD design tools and the Vault database. It accepts a JSON export from the Sweep tool, runs a series of structural and physics plausibility checks on each design, and uploads validated records to the PostgreSQL backend that powers Vault queries.

---

## Workflow

```
Sweep export (.json)  →  Ingest  →  Vault (PostgreSQL / Supabase)
F13LD.sweep · Push to Vault  ─┐
F13LD.lab   · Push to Vault  ─┼─→  f13ld-vault-push.js  →  Vault
F13LD.ingest · file drop     ─┘
```

1. Drag and drop a Sweep export JSON into the tool
2. Ingest validates the file and each design record within it
3. Validated records are uploaded to the database in batches
4. A summary and per-record log are displayed showing pass / fail / duplicate status

### The shared push file (v0.10.0)

`f13ld-vault-push.js` holds the one copy of the rules — `validateDesign`, `policyCheckRow`, `buildRow`, hashing, the duplicate check and the batched insert — plus the push window F13LD.sweep and F13LD.lab show. Ingest loads it from this folder; Sweep and Lab load it from `https://mshomper.github.io/f13ld.ingest/f13ld-vault-push.js`, so a rule change here reaches every tool when Ingest deploys. It exposes `window.F13LDVault`:

| Call | What it does |
|---|---|
| `analyze(json)` | per-design status (valid · dupe · invalid + reason) and content hash; asks the database only about this file's hashes |
| `buildRows(analysis, {contributor, domain, provenanceKind})` | rows for the valid designs; `provenance_kind` is `sweep`, `lab` or `file` (Ingest drops) |
| `insertDesigns(rows, {onProgress, dryRun})` | batches of 50; a batch that hits a duplicate is retried one row at a time |
| `prepareLabRows(analysis, labResults, contributor)` · `insertLabResults(rows)` | F13LD.lab solves into `f13ld_lab_results`, tied to the design's hash; unknown fields go to `results_extended` |
| `openPushDialog(opts)` | the push window: counts, reasons, contributor, domain, CC0 tick, progress, result |
| `loadContributor` · `saveContributor` · `hasConsent` · `setConsent` | contributor details shared by every F13LD tool on this site; the CC0 tick is remembered for the browser session (a session cookie) |

`push-demo.html` opens the push window on bundled exports in dry-run mode (reads Vault for duplicates, never writes).

## Validation checks

Each design must pass all of the following before it is accepted:

**Structural checks**
- File must contain a valid `meta` block and a `designs` array — confirming it was produced by the F13LD Sweep tool
- Each record must contain both a `metrics` block and a `design` block
- Surface `terms` must be present and non-empty (required for geometry reconstruction)
- Per family: TPMS `surface.terms`, noise `noise_type`, grain `field.type`, beam `topology` + `beams[]`, foam seeds (periodic), wave `field.modes` with **whole-number mode indices** (v0.9.1 — a fractional index is not one periodic cell; F13LD.sweep v0.29 refuses those too), bundle `surface.structure`

**Physics plausibility checks**
- `volume_fraction` must be in the range (0%, 75%)
- `connect_idx` must be one of the valid discrete values: `0`, `0.33`, `0.67`, or `1.0`
- `connect_idx` must be internally consistent with the reported directional stiffnesses (`Ex`, `Ey`, `Ez`) — connected axes must have `E > 0`, disconnected axes must be zero
- `anisotropy` must be ≥ 1.0 (values below 1 are geometrically impossible)
- Reported `anisotropy` must be consistent with the ratio of max/min directional stiffness (within 25% tolerance)

**Duplicate detection**
- A content hash is computed for each record before upload
- Records already present in the database are flagged as duplicates and skipped, not re-inserted

---

## Status and next steps

- **v0.10.1 (2026-10-10):** the push window's CSS classes and ids move to the prefix `f13vp-` (push file v1.0.1). `f13v-` clashed with the shared F13LD-VIEW block, which owns `.f13v` in every design tool and pinned the window to the top-left corner in F13LD.sweep. No rule changes.
- **v0.10.0 (2026-10-10):** the rules move into `f13ld-vault-push.js`, shared with F13LD.sweep and F13LD.lab. Same checks, same rows (`tests/parity.js` compares old and new Ingest on real Sweep v0.29.1 exports). Changes: rows carry `provenance_kind` (`file` for Ingest drops); the duplicate check asks only about the file's hashes, so the database's 1,000-row response limit no longer hides duplicates (Vault passed 1,000 designs); a batch that hits a duplicate is retried one design at a time instead of failing all 50; the contributor and domain can be filled in after the drop; the CC0 tick is remembered for the browser session; a design repeated inside one file reads "repeated in this file".
- **Database (2026-10-10 migration):** the public key reads named columns only and never `contributor_contact`; it inserts but cannot update, delete or truncate. New table `f13ld_lab_results` (one row per Lab solve, insert-only, tied to a design by `content_hash`, cleared with it). A new column on either table needs a `grant select (column)` before Vault can read it. To wipe Vault: `delete from public.f13ld_designs;` (also clears Lab results).
- **v0.9.1 (2026-10-10):** wave designs need whole-number mode indices. Sweep v0.29.1 exports (Wave family, cell stretch `field.stretch`, every family's curvature / topology now measured, `metrics_N`) validate unchanged — new fields land in `metrics_extended`.
- **Found, not changed:** a beam recipe loaded into Sweep without a `topology` block (the F13LD.mesh test recipe `beam-bcc`) exports its reference design without one, and Ingest rejects it ("beam missing topology block"); the jittered designs carry `topology`. Either Sweep fills `topology` on the reference design or the check accepts `beams[]` alone.
- **Next:** Sweep v0.29.2 Push to Vault shipped (Phase 3). Matt wipes and re-seeds Vault through it; then F13LD.lab Push to Vault (Phase 4) and the Vault display of Lab results (Phase 5) — plan `docs/F13LD_VAULT_PUSH_PLAN.md`, recap `docs/SESSION_RECAP_2026-10-10.md`. When Sweep adds Bundle (v0.30.0), check its exports against the bundle structure check.

## Output summary

After validation, the tool displays:

| Metric | Description |
|---|---|
| Total | Total designs found in the file |
| Valid | Designs that passed all checks and are ready to upload |
| Duplicates | Designs already present in Vault |
| Failed | Designs that failed one or more checks, with reasons logged |

---

## Tests

Dev-only (`npm install playwright-core`, Chromium via `npx playwright install chromium`). The database is mocked; nothing leaves the machine.

| Script | What it checks |
|---|---|
| `node tests/make-fixtures.js` | builds the edge-case, 130-design and no-version fixtures from the real Sweep exports in `tests/fixtures/` |
| `node tests/parity.js <old-ingest-folder>` | old vs new Ingest on every fixture: per-design status and reason, summary, preview table, every POSTed row; then contributor-after-drop, a duplicate race during insert, the session licence tick |
| `node tests/push-window.js [out]` | the push window at desktop and phone widths: counts, inline errors, dry run, remembered contributor and tick, Lab push order and rows, no horizontal overflow, no text under 12 px; screenshots to `tests/shots` |

## Requirements

- A Sweep export JSON produced by the F13LD Sweep tool
- A live Supabase connection (configured at deploy time via `SUPABASE_URL` and anon key)
- No installation required — runs entirely in the browser

---

## Part of the F13LD suite

| Tool | Description |
|---|---|
| [TPMS](https://github.com/mshomper/f13ld.tpms) | Implicit TPMS & PI-TPMS surface design |
| [Sweep](https://github.com/mshomper/f13ld.sweep) | Parameter space exploration |
| [Grain](https://github.com/mshomper/f13ld.grain) | Spinodoids, GRFs & hyperuniform fields |
| [Noise](https://github.com/mshomper/f13ld.noise) | Stochastic isosurface lattices |
| **Ingest** | Validation & database pipeline |
| [Vault](https://github.com/mshomper/f13ld.vault) | Curated structure library |
