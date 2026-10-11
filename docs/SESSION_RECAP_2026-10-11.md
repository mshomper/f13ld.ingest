# F13LD.ingest — session recap, 2026-10-11 · v0.11.0 (push 1.1.0) fixed noise only

**Main:** v0.11.0, `f13ld-vault-push.js` 1.1.0. One release across F13LD.noise v0.12.0, F13LD.mesh v0.9.9, F13LD.lab v0.26.2, F13LD.sweep v0.29.4 and F13LD.vault v0.8.1. The spec and the checks: `f13ld.noise/docs/NOISE_REV2.md`.

## Why
F13LD.noise ≤ v0.11.0 exported noise whose CPU simplex had a lattice error: the parts and the solves differed from the tool's preview, and the normalization was skewed. Matt wiped noise from Vault and decided that only fixed noise (revision 2) goes in from now on. Old recipes are versioned, not broken: they keep building in Mesh, Lab and Sweep.

## What shipped
- `noiseRevReason` (`NOISE_REV_VAULT = 2`) in `validateDesign`: a noise design needs `surface.noise_rev` = 2. A missing revision, revision 1, a non-integer, or a revision newer than 2 is refused with a plain reason. The rule reaches Sweep's and Lab's Push to Vault on deploy.
- `policyCheckRow` mirrors the new database rule: a noise row's `recipe.surface.noise_rev` must be a number ≥ 2.
- `docs/sql/2026-10-11_noise_rev2.sql`: a check query, a restrictive insert policy `f13ld_designs_noise_rev2` (ANDed with the existing permissive policy; other families unaffected), and a confirm query. Matt runs it in the Supabase SQL editor.
- `tests/noise-rev.js` (node, instant).

## Checks
- `tests/noise-rev.js`: PASS (rev 2 accepted; absent, 1, 3, "2" and 2.5 refused; TPMS unaffected; policy mirror both ways).
- `tests/push-window.js`: PASS.
- `tests/parity.js <main>`: the same 7 reported differences as main against itself. They come from how the test compares builds and are unrelated to this change.
- F13LD.sweep `tests/vault-push.js ../f13ld.ingest`: PASS.
