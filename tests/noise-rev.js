#!/usr/bin/env node
// Noise revision rule (f13ld-vault-push.js 1.1.0): Vault takes noise_rev 2 only.
//   node tests/noise-rev.js
// Builds noise designs from tests/fixtures/tpms-gyroid-sheet.json's metrics (any valid
// browser block will do) and checks validateDesign + policyCheckRow on each revision.
'use strict';
const fs = require('fs'), path = require('path');
require(path.join(__dirname, '..', 'f13ld-vault-push.js'));
const V = globalThis.F13LDVault;
const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tpms-gyroid-sheet.json'), 'utf8')).designs[0];

function noiseDesign(rev) {
  const d = JSON.parse(JSON.stringify(base));
  d.design = { family: 'noise', meta: { tool: 'noise-scaffold-explorer', version: '0.12.0' },
    surface: { type: 'noise', noise_type: 'fbm', frequency: 0.3, octaves: 4, center: 0, half_width: 0.15, seed: 7 },
    geometry: { mode: 'shell', wall_thickness: 0.15 } };
  if (rev !== undefined) d.design.surface.noise_rev = rev;
  return d;
}
let bad = 0;
function check(name, ok, detail) { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); if (!ok) bad++; }

const ok2 = V.validateDesign(noiseDesign(2));
check('noise_rev 2 is accepted', ok2 === null, ok2 || '');
for (const [label, rev] of [['no noise_rev (revision 1)', undefined], ['noise_rev 1', 1], ['noise_rev 3', 3], ['noise_rev "2" (string)', '2'], ['noise_rev 2.5', 2.5]]) {
  const r = V.validateDesign(noiseDesign(rev));
  check(label + ' is rejected', typeof r === 'string', r || 'accepted');
}
const tp = V.validateDesign(base);
check('a TPMS design is unaffected', tp === null, tp || '');

const row = { content_hash: 'x'.repeat(64), family: 'noise', schema_version: '0.30.0', domain: 'biomedical',
  contributor_name: 'n', contributor_contact: 'c', license: 'CC-BY-4.0', recipe: noiseDesign(2).design };
check('policy mirror: rev 2 row passes', V.policyCheckRow(row) === null, V.policyCheckRow(row) || '');
const row1 = Object.assign({}, row, { recipe: noiseDesign(undefined).design });
check('policy mirror: rev 1 row is refused', typeof V.policyCheckRow(row1) === 'string');
const rowT = Object.assign({}, row, { family: 'tpms', recipe: base.design });
check('policy mirror: other families unaffected', V.policyCheckRow(rowT) === null, V.policyCheckRow(rowT) || '');

console.log(bad ? 'FAIL: ' + bad + ' problem(s)' : 'PASS: noise revision rule');
process.exit(bad ? 1 : 0);
