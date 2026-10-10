// The push window in headless Chromium, database mocked.
//   node tests/push-window.js [out-folder]
// Opens push-demo.html at desktop and phone widths, walks the window
// through form → validation errors → push (dry run and a mocked real
// push) → done, checks there is no horizontal overflow and no text under
// 12 px, and writes screenshots to out-folder (default tests/shots).
'use strict';
const fs = require('fs'), path = require('path');
let chromium;
try { ({ chromium } = require('playwright-core')); } catch (e) { ({ chromium } = require('playwright')); }
const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'shots'));
fs.mkdirSync(OUT, { recursive: true });

let bad = 0;
function check(name, ok, detail) { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); if (!ok) bad++; }

async function setup(browser, width, height, state) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { state.errors.push(String(e)); });
  await page.route(/^http:\/\/demo\.localhost\//, (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'push-demo.html';
    const f = path.join(ROOT, p);
    return fs.existsSync(f) ? route.fulfill({ path: f }) : route.fulfill({ status: 404, body: '' });
  });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, body: '' }));
  await page.route(/supabase\.co\/rest\/v1\//, async (route) => {
    const req = route.request(), url = new URL(req.url());
    const cors = { 'access-control-allow-origin': '*' };
    if (req.method() === 'POST') {
      state.posts.push({ table: url.pathname.split('/').pop(), rows: JSON.parse(req.postData() || '[]') });
      return route.fulfill({ status: 201, headers: cors, body: '' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '[]' });
  });
  await page.goto('http://demo.localhost/push-demo.html');
  await page.waitForFunction(() => /designs/.test(document.getElementById('fxInfo').textContent));
  return { ctx, page };
}

async function layoutCheck(page, label) {
  const r = await page.evaluate(() => {
    const box = document.querySelector('.f13vp');
    const over = [];
    box.querySelectorAll('*').forEach((el) => {
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible' && el.clientWidth > 0) over.push(el.className || el.tagName);
    });
    const small = [];
    box.querySelectorAll('*').forEach((el) => {
      if (el.childNodes.length && Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())) {
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (fs < 12) small.push(el.tagName + ':' + fs);
      }
    });
    const rect = box.getBoundingClientRect();
    return { over, small, docOver: document.documentElement.scrollWidth > window.innerWidth,
             fits: rect.left >= 0 && rect.right <= window.innerWidth + 0.5 };
  });
  check(label + ': no horizontal overflow', !r.over.length && !r.docOver && r.fits, r.over.join(',') || (r.fits ? '' : 'window wider than screen'));
  check(label + ': no text under 12 px', !r.small.length, r.small.slice(0, 4).join(','));
}

(async () => {
  const browser = await chromium.launch();
  for (const [w, h, tag] of [[1280, 860, 'desktop'], [390, 844, 'phone']]) {
    // ── Sweep push of the edge cases: dry run ──
    const st = { errors: [], posts: [] };
    const { ctx, page } = await setup(browser, w, h, st);
    await page.selectOption('#fx', 'tests/fixtures/edge-cases.json');
    await page.waitForFunction(() => /edge-cases/.test(document.getElementById('fxInfo').textContent));
    await page.click('#goSweep');
    await page.waitForSelector('#f13vp-name');
    await page.click('.f13vp-det summary');
    await layoutCheck(page, tag + ' form');
    await page.screenshot({ path: path.join(OUT, tag + '-1-form.png') });
    const stats = await page.$$eval('.f13vp-stat b', (els) => els.map((e) => e.textContent));
    check(tag + ': edge-case counts ready / in Vault / failed', stats.join(',') === '7,1,17', stats.join(','));

    // validation: push with nothing filled
    await page.fill('#f13vp-name', ''); await page.fill('#f13vp-contact', '');
    await page.click('.f13vp-ft .f13vp-btn');
    const errs = await page.$$eval('.f13vp-f .err', (els) => els.map((e) => e.textContent).filter(Boolean));
    check(tag + ': empty fields stop the push with inline errors', errs.length >= 2 && st.posts.length === 0, errs.join(' / '));
    await page.screenshot({ path: path.join(OUT, tag + '-2-errors.png') });

    await page.fill('#f13vp-name', 'Demo Tester');
    await page.fill('#f13vp-contact', 'demo@example.com');
    await page.check('#f13vp-cc');
    await page.click('.f13vp-ft .f13vp-btn');
    await page.waitForSelector('[data-close]');
    await layoutCheck(page, tag + ' done');
    await page.screenshot({ path: path.join(OUT, tag + '-3-done.png') });
    const doneText = await page.textContent('.f13vp-bd');
    check(tag + ': dry run sends nothing', st.posts.length === 0 && /would be added/.test(doneText), st.posts.length + ' posts');
    await page.click('[data-close]');
    await page.waitForFunction(() => !document.querySelector('.f13vp-scrim'));

    // ── Lab push: contributor remembered, licence remembered, Lab solves ──
    await page.selectOption('#fx', 'tests/fixtures/tpms-gyroid-sheet.json');
    await page.waitForFunction(() => /tpms-gyroid/.test(document.getElementById('fxInfo').textContent));
    await page.click('#goLab');
    await page.waitForSelector('#f13vp-name');
    const remembered = await page.evaluate(() => [document.getElementById('f13vp-name').value, document.getElementById('f13vp-cc').checked]);
    check(tag + ': contributor and licence tick remembered', remembered[0] === 'Demo Tester' && remembered[1] === true, JSON.stringify(remembered));
    await layoutCheck(page, tag + ' lab form');
    await page.screenshot({ path: path.join(OUT, tag + '-4-lab.png') });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.f13vp-scrim'));
    check(tag + ': Escape closes the window', true);

    // ── Mocked real push of a Lab run (not dry run) ──
    await page.evaluate(() => {
      return fetch('tests/fixtures/tpms-gyroid-sheet.json').then((r) => r.json()).then((j) => {
        window.__p = F13LDVault.openPushDialog({ json: j, source: 'F13LD.lab', provenanceKind: 'lab', accent: '#E06A6F',
          labResults: [0, 1].map((i) => ({ designIndex: i, result: { lab_version: '0.27.0', grid_n: 64, ex_norm: 0.1, extra_thing: 3 } })) });
      });
    });
    await page.waitForSelector('#f13vp-name');
    await page.click('.f13vp-ft .f13vp-btn');
    await page.waitForSelector('[data-close]');
    const des = st.posts.filter((p) => p.table === 'f13ld_designs').flatMap((p) => p.rows);
    const lab = st.posts.filter((p) => p.table === 'f13ld_lab_results').flatMap((p) => p.rows);
    const order = st.posts.map((p) => p.table).join('>');
    check(tag + ': Lab push sends designs first, then Lab solves', order === 'f13ld_designs>f13ld_lab_results', order);
    check(tag + ': design rows marked lab, contributor attached',
          des.length === 4 && des.every((r) => r.provenance_kind === 'lab' && r.contributor_name === 'Demo Tester'), des.length + ' rows');
    check(tag + ': Lab rows tied to their design, extras in results_extended',
          lab.length === 2 && lab.every((r) => r.content_hash.length === 64 && r.solve_hash.length === 64 &&
            r.source_tool === 'f13ld.lab' && r.results_extended.extra_thing === 3 && !('extra_thing' in r)) &&
          lab[0].content_hash === des[0].content_hash, lab.length + ' Lab rows');
    await page.screenshot({ path: path.join(OUT, tag + '-5-lab-done.png') });
    check(tag + ': no page errors', !st.errors.length, st.errors.join(' | '));
    await ctx.close();
  }
  await browser.close();
  console.log(bad ? 'FAIL: ' + bad + ' problem(s)' : 'PASS: push window checks');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
