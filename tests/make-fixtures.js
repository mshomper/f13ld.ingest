// Builds the edge-case fixtures from the real Sweep v0.29.1 exports.
//   node tests/make-fixtures.js
// Writes tests/fixtures/edge-cases.json, big-run.json and no-version.json.
// The real exports (beam-bcc, foam-open-lloyd, tpms-gyroid-sheet,
// tpms-pi-fieldpair, wave-schwarzp-solid) come from F13LD.sweep's
// tests/harness.js run on its recipes.json cases.
'use strict';
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, 'fixtures');
const load = (n) => JSON.parse(fs.readFileSync(path.join(dir, n + '.json'), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

const tpms = load('tpms-gyroid-sheet'), wave = load('wave-schwarzp-solid'), foam = load('foam-open-lloyd');
const base = tpms.designs[1];
let nextId = 100;
function mut(label, fn, from) {
  const d = clone(from || base);
  d.id = nextId++;
  d.design.meta = Object.assign({}, d.design.meta, { preset: label });
  fn(d);
  return d;
}

const edge = clone(tpms);
edge.designs = [
  clone(tpms.designs[0]),
  clone(tpms.designs[1]),
  mut('vf-too-low',        (d) => { d.browser.volume_fraction = 0.3; }),
  mut('vf-sparse-discon',  (d) => { d.browser.volume_fraction = 0.9; d.browser.connect_idx = 0; }),
  mut('vf-sparse-ok',      (d) => { d.browser.volume_fraction = 0.9; d.browser.connect_idx = 0.67; }),
  mut('vf-too-high',       (d) => { d.browser.volume_fraction = 85; }),
  mut('no-linear-cap',     (d) => { delete d.browser.linear_cap_active; }),
  mut('no-H-mean-abs',     (d) => { delete d.browser.H_mean_abs; }),
  mut('aniso-below-one',   (d) => { d.browser.anisotropy = 0.5; }),
  mut('aniso-mismatch',    (d) => { d.browser.anisotropy = 9; }),
  mut('aniso-null',        (d) => { d.browser.anisotropy = null; }),
  mut('Ex-negative',       (d) => { d.browser.Ex_norm = -0.01; }),
  mut('validity-bogus',    (d) => { d.browser.solver_validity = 'bogus'; }),
  mut('cg-iters-frac',     (d) => { d.browser.cg_iters = 3.5; }),
  mut('cg-conv-string',    (d) => { d.browser.cg_converged = 'yes'; }),
  mut('cap-active',        (d) => { d.browser.linear_cap_active = true; }),
  mut('tpms-no-surface',   (d) => { delete d.design.surface; }),
  mut('unknown-family',    (d) => { d.design.family = 'mystery'; }),
  mut('no-browser',        (d) => { delete d.browser; }),
  mut('no-geometry',       (d) => { delete d.design.geometry; }),
  mut('wave-fractional',   (d) => { d.design.field.modes[0].n = 1.5; }, wave.designs[1]),
  mut('wave-ok',           (d) => { }, wave.designs[2]),
  mut('foam-not-periodic', (d) => { d.design.domain = Object.assign({}, d.design.domain, { periodic: false }); }, foam.designs[1]),
  mut('foam-ok',           (d) => { }, foam.designs[2]),
  clone(tpms.designs[0])                       // repeated in this file
];
edge.designs[edge.designs.length - 1].id = nextId++;
fs.writeFileSync(path.join(dir, 'edge-cases.json'), JSON.stringify(edge));

// 130 distinct designs: more than two insert batches and more than two
// duplicate-check requests
const big = clone(tpms);
big.designs = [];
for (let i = 0; i < 130; i++) {
  const d = clone(tpms.designs[1 + (i % 3)]);
  d.id = i;
  d.design.meta = Object.assign({}, d.design.meta, { preset: 'big-' + i });
  big.designs.push(d);
}
fs.writeFileSync(path.join(dir, 'big-run.json'), JSON.stringify(big));

// No tool_version in meta: every row fails the schema_version policy
const nov = clone(wave);
delete nov.meta.tool_version;
delete nov.meta.version;
fs.writeFileSync(path.join(dir, 'no-version.json'), JSON.stringify(nov));

console.log('edge-cases:', edge.designs.length, '· big-run:', big.designs.length, '· no-version:', nov.designs.length);
