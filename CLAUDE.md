# F13LD.ingest — working notes for Claude

Validates Sweep-shape exports and writes them to F13LD.vault (Supabase table
`f13ld_designs`; Lab solves in `f13ld_lab_results`). Static site on GitHub Pages:
https://mshomper.github.io/f13ld.ingest

## Rules

- **Ask Matt before pushing or merging to `main`.** Work on a branch, push the
  branch, and wait for his click-test and explicit OK.
- **No claude.ai session links** in commit messages or PR descriptions.
  A `Co-Authored-By: Claude …` trailer is fine.
- **Analyse and propose first**: when an issue is reported, explain the cause
  and the proposed change before editing code.
- **Bump the version** in `index.html` (`fh-version`) and, for rule or push
  changes, `VERSION` in `f13ld-vault-push.js`.
- **`f13ld-vault-push.js` is live in other tools.** F13LD.sweep and F13LD.lab
  load it from this site, so a change here reaches them on deploy. Keep its
  `window.F13LDVault` calls backward compatible, and run `tests/parity.js`
  and `tests/push-window.js` before asking to merge.
- **Database policy mirror**: `policyCheckRow` / `policyCheckLabRow` mirror the
  Supabase insert policies. Change them in step with any SQL change; Matt runs
  SQL in the Supabase dashboard, the session writes the exact statement. A new
  column needs a `grant select (column) … to anon, authenticated`.
- **Privacy**: `contributor_contact` is insert-only for the public key; never
  read or display it.
- **UI**: never horizontal scrolling; no emoji or symbol-glyph icons in new UI —
  every icon is drawn (inline SVG); 12 px minimum text.
- **Words**: never use "genuine" or "genuinely" in UI text or docs.
- **Heavy checks run on Matt's machine**, not in the VM: hand him the command.
- **Noise revisions (push 1.1.0)**: Vault takes noise with `surface.noise_rev` 2 only (`noiseRevReason`, `NOISE_REV_VAULT`); the database enforces it with the restrictive policy `f13ld_designs_noise_rev2` (`docs/sql/2026-10-11_noise_rev2.sql`). Check with `node tests/noise-rev.js`. Spec: F13LD.noise `docs/NOISE_REV2.md`.

- **Anisotropy check (push 1.1.1)**: Sweep v0.32.0 leaves pore-level axes out of anisotropy and caps it at 99, so `validateDesign` accepts a value that matches max ÷ min over any two or three connected axes (capped at `ANISO_CAP`). Check with `node tests/anisotropy.js`.

## Notes
- Latest session recap: `docs/SESSION_RECAP_2026-10-11.md` (v0.11.0, fixed noise only). Previous: `docs/SESSION_RECAP_2026-10-10.md`.
