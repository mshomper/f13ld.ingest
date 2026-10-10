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
