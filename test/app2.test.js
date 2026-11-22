'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers.js');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ids = H.parseHtmlIds(html);
const tabIds = H.parseTabIds(html);

function freshApp(extraWin) {
  delete require.cache[require.resolve('../app.js')];
  const App = require('../app.js');
  const doc = H.createDom(ids, tabIds);
  const win = Object.assign({
    devicePixelRatio: 1,
    addEventListener: function () {},
    setTimeout: function (fn) { fn(); }
  }, extraWin || {});
  const state = App.boot(doc, win);
  return { App, doc, win, state };
}

function el(doc, id) { return doc.getElementById(id); }
function txt(doc, id) { const e = el(doc, id); return e ? e.textContent : ''; }

/* ---------- new controls exist and boot ---------- */

test('boot exposes the new engine modules', () => {
  const { App } = freshApp();
  assert.equal(typeof App.clinicalFiles, 'function');
  assert.equal(typeof App.hashEncode, 'function');
  assert.equal(typeof App.hashDecode, 'function');
});

test('boot normalises the poincare and strip controls', () => {
  const { doc } = freshApp();
  assert.equal(el(doc, 'poincare-source').value, 'detected');
  assert.equal(el(doc, 'strip-lead').value, '1');
  assert.equal(el(doc, 'strip-seconds').value, '10');
  assert.equal(el(doc, 'poincare-ellipse').checked, true);
  assert.equal(el(doc, 'poincare-ectopy').checked, true);
});

test('boot disables the clinical download buttons', () => {
  const { doc } = freshApp();
  for (const id of ['download-csv', 'download-json', 'download-svg', 'print-strip']) {
    assert.equal(el(doc, id).disabled, true, id);
  }
});

/* ---------- rhythm card after run ---------- */

test('run fills the rhythm card with a classified label', () => {
  const { doc, state } = freshApp();
  state.run();
  const label = txt(doc, 'rhythm-label');
  assert.notEqual(label, 'no run yet');
  assert.ok(label.length > 3);
  assert.ok(state.rhythm && state.rhythm.key);
});

test('run fills the rhythm stat grid and reasons list', () => {
  const { doc, state } = freshApp();
  state.run();
  assert.ok(el(doc, 'rhythm-stats').children.length >= 4);
  assert.ok(el(doc, 'rhythm-reasons').children.length >= 1);
});

test('run fills artefact flags with at least one chip', () => {
  const { doc, state } = freshApp();
  state.run();
  const flags = el(doc, 'artifact-flags');
  assert.ok(flags.children.length >= 1);
});

test('run populates the live poincare stat grid', () => {
  const { doc, state } = freshApp();
  state.run();
  assert.ok(el(doc, 'poincare-stats').children.length >= 4);
});

test('poincare source toggle re-renders with ground truth peaks', () => {
  const { doc, state } = freshApp();
  state.run();
  el(doc, 'poincare-source').value = 'truth';
  el(doc, 'poincare-source').dispatch('change');
  assert.ok(el(doc, 'poincare-stats').children.length >= 4);
});

test('poincare ellipse toggle re-renders without errors', () => {
  const { doc, state } = freshApp();
  state.run();
  el(doc, 'poincare-ellipse').checked = false;
  el(doc, 'poincare-ellipse').dispatch('change');
  el(doc, 'poincare-ectopy').checked = false;
  el(doc, 'poincare-ectopy').dispatch('change');
  assert.ok(true);
});

/* ---------- rhythm benchmark in the UI ---------- */

test('rhythm benchmark fills the six-class metrics table', () => {
  const { doc, state } = freshApp();
  el(doc, 'run-rhythm-bench').click();
  const body = el(doc, 'rhythm-metrics-body');
  assert.equal(body.children.length, 6);
});

test('rhythm benchmark fills the per-strip results table', () => {
  const { doc, state } = freshApp();
  el(doc, 'run-rhythm-bench').click();
  assert.equal(el(doc, 'rhythm-bench-body').children.length, 10);
});

test('rhythm benchmark summary reports accuracy and bpm MAE', () => {
  const { doc, state } = freshApp();
  el(doc, 'run-rhythm-bench').click();
  const grid = el(doc, 'rhythm-bench-summary');
  assert.ok(grid.children.length >= 4);
  const res = state.getRhythmBench();
  assert.equal(res.accuracy, 1);
  assert.ok(res.maeBpm < 15);
  assert.ok(txt(doc, 'rhythm-bench-time').includes('ms'));
});

/* ---------- clinical export ---------- */

test('build-clinical produces csv, json and svg with a fingerprint', () => {
  const { doc, state } = freshApp();
  state.run();
  state.buildClinical();
  const files = state.getClinicalFiles();
  assert.ok(files.csv.startsWith('time_s,'));
  assert.ok(files.json.includes('"fingerprint"'));
  assert.ok(files.svg.includes('25 mm/s'));
  assert.match(files.fingerprint, /^[0-9a-f]{64}$/);
});

test('build-clinical enables the four clinical buttons', () => {
  const { doc, state } = freshApp();
  state.run();
  state.buildClinical();
  for (const id of ['download-csv', 'download-json', 'download-svg', 'print-strip']) {
    assert.equal(el(doc, id).disabled, false, id);
  }
});

test('build-clinical previews the strip and report text', () => {
  const { doc, state } = freshApp();
  state.run();
  state.buildClinical();
  assert.ok(el(doc, 'strip-preview').src.startsWith('data:image/svg+xml'));
  assert.ok(txt(doc, 'report-preview').includes('SHA-256'));
  assert.ok(txt(doc, 'clinical-state').includes('ready'));
});

test('build-clinical mirrors the strip into the print area', () => {
  const { doc, state } = freshApp();
  state.run();
  state.buildClinical();
  const area = el(doc, 'print-area');
  assert.equal(area.children.length, 1);
  assert.ok(area.children[0].src.startsWith('data:image/svg+xml'));
});

test('build-clinical warns before a record exists', () => {
  const { doc, state } = freshApp();
  state.buildClinical();
  assert.ok(txt(doc, 'status').includes('Generate a record'));
});

test('clinical CSV, JSON and SVG are deterministic for a fixed record', () => {
  const { App, state } = freshApp();
  state.run();
  state.buildClinical();
  const first = state.getClinicalFiles();
  const again = App.clinicalFiles(state.getRecord(), state.getEvaluation(), { leadIndex: 1, seconds: 10 });
  assert.equal(first.csv, again.csv);
  assert.equal(first.json, again.json);
  assert.equal(first.svg, again.svg);
});

test('strip lead and seconds controls rebuild the files', () => {
  const { doc, state } = freshApp();
  state.run();
  state.buildClinical();
  el(doc, 'strip-lead').value = '6';
  el(doc, 'strip-lead').dispatch('change');
  assert.equal(state.getClinicalFiles().lead, 'V1');
});

test('print-strip warns when no strip is built', () => {
  const { doc, state } = freshApp();
  state.printStrip();
  assert.ok(txt(doc, 'status').includes('Build the clinical strip'));
});

test('print-strip toggles print mode and records the request', () => {
  const { doc, state } = freshApp();
  state.run();
  state.buildClinical();
  state.printStrip();
  assert.equal(state.printRequested, true);
});

/* ---------- URL hash recovery ---------- */

test('hashEncode and hashDecode round-trip the default controls', () => {
  const { App, state } = freshApp();
  const cfg = state.readControls();
  const enc = App.hashEncode(cfg);
  const dec = App.hashDecode('#' + enc);
  assert.equal(Number(dec.heartRate), cfg.heartRate);
  assert.equal(dec.detectorMode, 'ensemble');
});

test('hashDecode ignores malformed input', () => {
  const { App } = freshApp();
  assert.deepEqual(App.hashDecode(''), {});
  assert.deepEqual(App.hashDecode('#'), {});
  assert.deepEqual(App.hashDecode('#broken'), {});
});

test('applyHash restores numeric settings into the controls', () => {
  const { doc, state } = freshApp();
  const applied = state.applyHash('#heartRate=91&respRate=22&seed=77');
  assert.ok(applied >= 3);
  assert.equal(el(doc, 'heartRate').value, '91');
  assert.equal(el(doc, 'respRate').value, '22');
  assert.equal(el(doc, 'seed').value, '77');
});

test('applyHash skips non-numeric values for numeric controls', () => {
  const { doc, state } = freshApp();
  el(doc, 'heartRate').value = '72';
  const applied = state.applyHash('#heartRate=garbage');
  assert.equal(applied, 0);
  assert.equal(el(doc, 'heartRate').value, '72');
});

test('applyHash honours the single detector mode', () => {
  const { doc, state } = freshApp();
  state.applyHash('#detectorMode=single');
  assert.equal(el(doc, 'detectorMode').value, 'single');
});

test('boot restores controls from the URL hash', () => {
  const { doc } = freshApp({ location: { hash: '#heartRate=88&humAmplitude=0.12' } });
  assert.equal(el(doc, 'heartRate').value, '88');
  assert.equal(el(doc, 'humAmplitude').value, '0.12');
  assert.ok(txt(doc, 'status').includes('Restored'));
});

test('unknown hash keys are ignored', () => {
  const { doc, state } = freshApp();
  const applied = state.applyHash('#nonexistent=5&heartRate=82');
  assert.equal(applied, 1);
  assert.equal(el(doc, 'heartRate').value, '82');
});

/* ---------- deterministic clinicalFiles api ---------- */

test('clinicalFiles svg honours the requested lead', () => {
  const { App, state } = freshApp();
  state.run();
  const files = App.clinicalFiles(state.getRecord(), state.getEvaluation(), { leadIndex: 6, seconds: 10 });
  assert.equal(files.lead, 'V1');
  assert.ok(files.svg.includes('Lead V1'));
});

test('clinicalFiles clamps nonsense lead indices', () => {
  const { App, state } = freshApp();
  state.run();
  const files = App.clinicalFiles(state.getRecord(), state.getEvaluation(), { leadIndex: 99, seconds: 10 });
  assert.equal(files.lead, 'V6');
});

test('clinicalFiles works before an evaluation exists', () => {
  const { App, state } = freshApp();
  state.run();
  const files = App.clinicalFiles(state.getRecord(), null, { leadIndex: 1, seconds: 5 });
  assert.ok(files.csv.length > 100);
  assert.match(files.fingerprint, /^[0-9a-f]{64}$/);
});
