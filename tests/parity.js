// Old Ingest vs new Ingest on the same exports, in headless Chromium.
//   node tests/parity.js <old-ingest-folder> [new-ingest-folder]
// The database is mocked: no request leaves the machine. For each fixture
// it fills the contributor, drops the file, ticks the licence, presses
// Insert, and compares per-design status and reason, the summary numbers,
// the preview table and every row POSTed. Expected differences (printed,
// not failures): provenance_kind = 'file' on new rows, and a design
// repeated inside one file reads "repeated in this file".
// Then new-only checks: contributor filled after the drop, a duplicate
// race during insert, the once-per-session licence tick.
// Exit 0 = everything matched.
'use strict';
const fs = require('fs'), path = require('path');
let chromium;
try { ({ chromium } = require('playwright-core')); } catch (e) { ({ chromium } = require('playwright')); }

const OLD = path.resolve(process.argv[2] || '');
const NEW = path.resolve(process.argv[3] || path.join(__dirname, '..'));
if (!process.argv[2] || !fs.existsSync(path.join(OLD, 'index.html'))) {
  console.error('usage: node tests/parity.js <old-ingest-folder> [new-ingest-folder]'); process.exit(2);
}
const FIX = path.join(__dirname, 'fixtures');
require(path.join(NEW, 'f13ld-vault-push.js'));
const V = globalThis.F13LDVault;

const CASES = ['tpms-gyroid-sheet', 'tpms-pi-fieldpair', 'beam-bcc', 'foam-open-lloyd',
               'wave-schwarzp-solid', 'edge-cases', 'big-run', 'no-version'];

async function existingFor(json) {
  // the database "already has" design #1 and, for the big run, every 40th design
  const out = new Set();
  for (let i = 0; i < json.designs.length; i++) {
    if (i === 1 || (json.designs.length > 100 && i % 40 === 5)) {
      if (json.designs[i].design) out.add(await V.contentHash(json.designs[i].design));
    }
  }
  return out;
}

function mockDb(page, state) {
  return page.route(/supabase\.co\/rest\/v1\//, async (route) => {
    const req = route.request(), url = new URL(req.url());
    const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range' };
    if (req.method() === 'GET') {
      const inq = url.searchParams.get('content_hash');
      let rows;
      if (inq && inq.startsWith('in.(')) {
        const want = inq.slice(4, -1).split(',');
        state.inQueries++;
        rows = want.filter((h) => state.existing.has(h)).map((h) => ({ content_hash: h }));
      } else if (url.searchParams.get('limit') === '1') {
        rows = [];
      } else {
        rows = Array.from(state.existing).map((h) => ({ content_hash: h }));
      }
      return route.fulfill({ status: 200, contentType: 'application/json',
        headers: Object.assign({ 'content-range': '0-0/1042' }, cors), body: JSON.stringify(rows) });
    }
    if (req.method() === 'POST') {
      const body = JSON.parse(req.postData() || '[]');
      state.posts++;
      if (state.raceHash && body.some((r) => r.content_hash === state.raceHash)) {
        return route.fulfill({ status: 409, contentType: 'application/json', headers: cors,
          body: JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint "f13ld_designs_pkey"' }) });
      }
      body.forEach((r) => state.rows.push(r));
      return route.fulfill({ status: 201, headers: cors, body: '' });
    }
    return route.fulfill({ status: 204, headers: cors, body: '' });
  });
}

async function openIngest(browser, folder, host) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { page.__errors = (page.__errors || []).concat(String(e)); });
  await page.route(new RegExp('^http://' + host + '/'), (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
    const f = path.join(folder, p);
    if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: 'nope' });
    return route.fulfill({ path: f });
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, body: '' }));
  return { ctx, page };
}

async function runCase(browser, folder, host, fixture, opts) {
  opts = opts || {};
  const json = JSON.parse(fs.readFileSync(path.join(FIX, fixture + '.json'), 'utf8'));
  const state = { existing: await existingFor(json), rows: [], posts: 0, inQueries: 0, raceHash: opts.raceHash || null };
  const { ctx, page } = await openIngest(browser, folder, host);
  await mockDb(page, state);
  await page.goto('http://' + host + '/index.html');
  await page.waitForFunction(() => document.getElementById('dbStatus').className.includes('connected'));
  if (!opts.contributorAfter) {
    await page.fill('#cName', 'Parity Tester');
    await page.fill('#cContact', 'parity@example.com');
    await page.fill('#cNotes', 'parity run');
  }
  await page.setInputFiles('#fileInput', path.join(FIX, fixture + '.json'));
  await page.waitForFunction(() => document.getElementById('summaryGrid').style.display === 'grid' ||
    /Invalid sweep|Failed to parse/.test(document.getElementById('logBody').textContent), null, { timeout: 60000 });
  if (opts.contributorAfter) {
    await page.fill('#cName', 'Parity Tester');
    await page.fill('#cContact', 'parity@example.com');
    await page.fill('#cNotes', 'parity run');
  }
  const snap = await page.evaluate(() => ({
    items: processedRows.map((p) => ({ status: p.status, reason: p.reason || null, hash: p.hash || null })),
    summary: ['sumTotal', 'sumValid', 'sumDupes', 'sumInvalid'].map((id) => document.getElementById(id).textContent),
    preview: Array.from(document.querySelectorAll('#previewBody tr')).map((tr) =>
      Array.from(tr.children).slice(0, 10).map((td) => td.textContent).join('|')),
    domain: document.getElementById('cDomain').value,
    insertLabel: document.getElementById('insertBtn').textContent
  }));
  let inserted = null;
  const canInsert = await page.evaluate(() => processedRows.some((p) => p.status === 'valid'));
  if (canInsert) {
    if (!(await page.isChecked('#cLicense'))) await page.click('#cLicense');
    await page.click('#insertBtn');
    await page.waitForFunction(() => /inserted|failed/.test(document.getElementById('insertBtn').textContent) &&
      !/Inserting/.test(document.getElementById('insertBtn').textContent), null, { timeout: 60000 });
    inserted = await page.evaluate(() => document.getElementById('insertBtn').textContent);
  }
  const log = await page.evaluate(() => document.getElementById('logBody').textContent);
  const errors = page.__errors || [];
  await ctx.close();
  return { snap, rows: state.rows, posts: state.posts, inQueries: state.inQueries, inserted, log, errors };
}

function stripRow(r) { const o = Object.assign({}, r); delete o.provenance_kind; return o; }
function sameJSON(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

(async () => {
  const browser = await chromium.launch();
  let bad = 0;
  const notes = [];
  for (const c of CASES) {
    const A = await runCase(browser, OLD, 'old.localhost', c);
    const B = await runCase(browser, NEW, 'new.localhost', c);
    const diffs = [];
    if (A.errors.length || B.errors.length) diffs.push('page errors old=' + A.errors.join(';') + ' new=' + B.errors.join(';'));
    const normItems = B.snap.items.map((it) => it.reason === 'repeated in this file'
      ? Object.assign({}, it, { reason: 'already in F13LD.vault' }) : it);
    if (normItems.some((it, i) => it !== B.snap.items[i])) notes.push(c + ': in-file repeat reads "repeated in this file"');
    if (!sameJSON(A.snap.items.map((i) => [i.status, i.reason]), normItems.map((i) => [i.status, i.reason]))) {
      diffs.push('per-design status/reason differ');
      A.snap.items.forEach((a, i) => { const b = normItems[i] || {};
        if (a.status !== b.status || a.reason !== b.reason) diffs.push('  #' + i + ' old ' + a.status + ' ' + a.reason + ' | new ' + b.status + ' ' + b.reason); });
    }
    if (!sameJSON(A.snap.summary, B.snap.summary)) diffs.push('summary ' + A.snap.summary + ' vs ' + B.snap.summary);
    if (!sameJSON(A.snap.preview, B.snap.preview)) diffs.push('preview table differs');
    if (A.snap.domain !== B.snap.domain) diffs.push('domain ' + A.snap.domain + ' vs ' + B.snap.domain);
    if (A.rows.length !== B.rows.length) diffs.push('rows posted ' + A.rows.length + ' vs ' + B.rows.length);
    else {
      for (let i = 0; i < A.rows.length; i++) {
        if (!sameJSON(A.rows[i], stripRow(B.rows[i]))) {
          const keys = Object.keys(Object.assign({}, A.rows[i], B.rows[i])).filter((k) => k !== 'provenance_kind' && !sameJSON(A.rows[i][k], B.rows[i][k]));
          diffs.push('row ' + i + ' differs in ' + keys.join(','));
          break;
        }
      }
      if (B.rows.some((r) => r.provenance_kind !== 'file')) diffs.push('new rows not all provenance_kind=file');
    }
    if (A.posts !== B.posts) diffs.push('POST count ' + A.posts + ' vs ' + B.posts);
    const s = B.snap.summary;
    console.log((diffs.length ? 'DIFF ' : 'SAME ') + c.padEnd(20) + ' designs ' + s[0] + ' · valid ' + s[1] + ' · dupes ' + s[2] +
                ' · invalid ' + s[3] + ' · rows ' + B.rows.length + ' · batches ' + B.posts + ' · hash queries ' + B.inQueries);
    diffs.forEach((d) => console.log('     ' + d));
    if (diffs.length) bad++;
  }
  notes.forEach((n) => console.log('note: ' + n));

  // ── New-only checks ────────────────────────────────────────────────
  console.log('--- new-only checks');
  function check(name, ok, detail) { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); if (!ok) bad++; }

  const late = await runCase(browser, NEW, 'new.localhost', 'tpms-gyroid-sheet', { contributorAfter: true });
  check('contributor filled after the drop', late.rows.length === 3 && late.rows.every((r) => r.contributor_name === 'Parity Tester'),
        late.rows.length + ' rows');

  const bigJson = JSON.parse(fs.readFileSync(path.join(FIX, 'big-run.json'), 'utf8'));
  const raceHash = await V.contentHash(bigJson.designs[60].design);
  const race = await runCase(browser, NEW, 'new.localhost', 'big-run', { raceHash: raceHash });
  check('duplicate race during insert: the rest of the batch still goes in',
        race.rows.length === Number(race.snap.summary[1]) - 1 && /already in F13LD\.vault — skipped/.test(race.log),
        race.rows.length + ' rows · ' + race.inserted);

  // licence tick remembered for the browser session (session cookie)
  {
    const { ctx, page } = await openIngest(browser, NEW, 'new.localhost');
    await mockDb(page, { existing: new Set(), rows: [], posts: 0, inQueries: 0 });
    await page.goto('http://new.localhost/index.html');
    const before = await page.isChecked('#cLicense');
    await page.click('#cLicense');
    await page.reload();
    const after = await page.isChecked('#cLicense');
    const cookie = (await ctx.cookies()).find((k) => k.name === 'f13ld_cc0_ok');
    check('licence tick remembered for the session', !before && after && cookie && cookie.expires === -1,
          'before ' + before + ' · after reload ' + after + ' · session cookie ' + !!(cookie && cookie.expires === -1));
    await ctx.close();
  }

  await browser.close();
  console.log(bad ? 'FAIL: ' + bad + ' problem(s)' : 'PASS: old and new Ingest match on every case');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
