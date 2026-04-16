# F13LD · Ingest

**Part of the [F13LD suite](https://f13ld.app) by [Not a Robot Engineering](https://notarobot-eng.com)**

**[Open the Tool](https://mshomper.github.io/f13ld.ingest)**

Ingest is the bridge between the F13LD design tools and the Vault database. It accepts a JSON export from the Sweep tool, runs a series of structural and physics plausibility checks on each design, and uploads validated records to the PostgreSQL backend that powers Vault queries.

---

## Workflow

```
Sweep export (.json)  →  Ingest  →  Vault (PostgreSQL / Supabase)
```

1. Drag and drop a Sweep export JSON into the tool
2. Ingest validates the file and each design record within it
3. Validated records are uploaded to the database in batches
4. A summary and per-record log are displayed showing pass / fail / duplicate status

---

## Validation checks

Each design must pass all of the following before it is accepted:

**Structural checks**
- File must contain a valid `meta` block and a `designs` array — confirming it was produced by the F13LD Sweep tool
- Each record must contain both a `metrics` block and a `design` block
- Surface `terms` must be present and non-empty (required for geometry reconstruction)

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

## Output summary

After validation, the tool displays:

| Metric | Description |
|---|---|
| Total | Total designs found in the file |
| Valid | Designs that passed all checks and are ready to upload |
| Duplicates | Designs already present in Vault |
| Failed | Designs that failed one or more checks, with reasons logged |

---

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
