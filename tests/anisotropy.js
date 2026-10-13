#!/usr/bin/env node
// Anisotropy consistency check (f13ld-vault-push.js 1.1.1).
//   node tests/anisotropy.js
// Sweep v0.32.0 leaves pore-level axes out of anisotropy and caps it at 99;
// the check must accept both, and still refuse a value that matches no axes.
'use strict';
const fs = require('fs'), path = require('path');
require(path.join(__dirname, '..', 'f13ld-vault-push.js'));
const V = globalThis.F13LDVault;
const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tpms-gyroid-sheet.json'), 'utf8')).designs[0];

function design(E, aniso) {
  const d = JSON.parse(JSON.stringify(base));
  Object.assign(d.browser, { Ex_norm: E[0], Ey_norm: E[1], Ez_norm: E[2], anisotropy: aniso });
  return d;
}
let bad = 0;
function check(name, ok, detail) { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); if (!ok) bad++; }
function accepts(name, d) { const r = V.validateDesign(d); check(name + ' is accepted', r === null, r || ''); }
function refuses(name, d) { const r = V.validateDesign(d); check(name + ' is refused', typeof r === 'string', r || 'accepted'); }

accepts('the fixture design', base);
accepts('three load axes, ratio over all three', design([0.020, 0.015, 0.010], 2.0));
accepts('z at the pore-material level, anisotropy over x and y', design([0.020, 0.015, 0.0012], 1.333));
accepts('x at the pore-material level, anisotropy over y and z', design([0.0009, 0.015, 0.030], 2.0));
accepts('true ratio 150, Sweep capped at 99', design([0.03, 0.0002, 0.0002], 99));
accepts('one live axis, anisotropy null', design([0.02, 0.0012, 0], null));
accepts('two live axes, third disconnected (0)', design([0.02, 0.01, 0], 2.0));
refuses('anisotropy matching no pair of axes', design([0.020, 0.015, 0.010], 7.0));
refuses('anisotropy 99 on a ratio of 2', design([0.020, 0.015, 0.010], 99));
refuses('anisotropy below 1', design([0.020, 0.015, 0.010], 0.5));

console.log(bad ? 'FAIL: ' + bad + ' problem(s)' : 'PASS: anisotropy check');
process.exitCode = bad ? 1 : 0;
