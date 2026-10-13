# F13LD.ingest — session recap, 2026-10-13 · v0.11.1 (push file 1.1.1)

Branch **`v0.11.1-aniso-check`** (not merged). Goes with F13LD.sweep v0.33.0 and F13LD.vault v0.11.0, before the Vault reseed.

## The problem
F13LD.sweep v0.32.0 leaves an axis whose stiffness comes from the pore material alone out of anisotropy, and caps anisotropy at 99. `validateDesign`'s consistency check counted every axis with E > 1e-7 and compared uncapped, so a design with x and y carrying load and z at the pore level (Sweep 1.33, check 16.67) — or a true ratio of 150 (Sweep 99) — was refused at push. Nothing stored wrong; those designs would have been missing from the reseed.

## The change
The stated anisotropy passes when it matches max ÷ min over any two or three connected axes, capped at `ANISO_CAP` (99), within 30 %. A value that matches no pair is still refused. `tests/anisotropy.js` (10 cases).

## No change needed for Sweep v0.33.0
Its curvature fields (`curv_*`) are unknown to `FIRST_CLASS`, so `buildRow` puts them in `metrics_extended`, where Vault v0.11.0 reads them (checked). No database change.

## Checks run
`tests/anisotropy.js`, `tests/noise-rev.js`, `tests/push-window.js` pass; `tests/parity.js` output identical to `main`'s own run against itself; Sweep's `tests/vault-push.js` passes against this branch.
