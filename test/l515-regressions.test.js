'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Analysis = require('../src/analysis.js');
const H = require('./helpers.js');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ids = H.parseHtmlIds(html);
const tabIds = H.parseTabIds(html);

function freshApp() {
  delete require.cache[require.resolve('../app.js')];
  const App = require('../app.js');
  const doc = H.createDom(ids, tabIds);
  const win = { devicePixelRatio: 1, addEventListener: function () {}, setTimeout: function (fn) { fn(); } };
  const state = App.boot(doc, win);
  return { App, doc, win, state };
}

function textTree(el) {
  let out = el && el.textContent || '';
  for (const child of (el && el.children) || []) out += ' ' + textTree(child);
  return out;
}

test('L515: bandPower clips partial bins instead of overintegrating edges', () => {
  const psd = {
    frequency: new Float64Array([0, 0.03, 0.06, 0.09, 0.12, 0.15, 0.18]),
    power: new Float64Array([1, 1, 1, 1, 1, 1, 1])
  };
  assert.ok(Math.abs(Analysis.bandPower(psd, 0.04, 0.15) - 0.11) < 1e-12);
  assert.ok(Math.abs(Analysis.bandPower(psd, 0, 0.18) - 0.18) < 1e-12);
});

test('L515: RR series reject invalid rates and unordered peaks fail closed', () => {
  assert.throws(() => Analysis.rrIntervals([100, 50], 250), /strictly increasing/);
  assert.throws(() => Analysis.rrIntervals([0, Number.NaN], 250), /finite/);
  assert.throws(() => Analysis.rrIntervals([0, 250], 0), /positive sampling rate/);
  assert.throws(() => Analysis.rrTimes([0, 250], -250), /positive sampling rate/);
});

test('L515: HRV frequency options must form physical interpolation and bands', () => {
  const peaks = [0, 250, 500, 750, 1000, 1250];
  assert.throws(() => Analysis.hrvFrequency(peaks, 250, { interpolationRate: 0 }), /positive interpolation rate/);
  assert.throws(() => Analysis.hrvFrequency(peaks, 250, { lfBand: [0.15, 0.04] }), /low.*high/);
  assert.throws(() => Analysis.hrvFrequency(peaks, 250, { hfBand: [0.1, 0.4] }), /contiguous/);
});

test('L515: scoring labels report the configured matching tolerance', () => {
  const { doc, state } = freshApp();
  state.run();
  const text = textTree(doc.getElementById('stat-grid'));
  assert.match(text, /50 ms tolerance/);
  assert.doesNotMatch(text, /150 ms tolerance/);
});

test('L515: corrupted shared-link numbers clamp to the control ranges', () => {
  const { doc, state } = freshApp();
  const heart = doc.getElementById('heartRate');
  heart.min = '35'; heart.max = '180';
  const duration = doc.getElementById('duration');
  duration.min = '6'; duration.max = '30';
  state.applyHash('heartRate=999&duration=-10');
  assert.equal(Number(heart.value), 180);
  assert.equal(Number(duration.value), 6);
});

test('L515: reduced-motion and tab touch targets are real CSS rules', () => {
  const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  const media = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(media, 'missing reduced-motion media rule');
  assert.match(media[1], /transition-duration|transition:\s*none/);
  const tab = css.match(/\.tab\s*\{([\s\S]*?)\n\}/);
  assert.ok(tab, 'missing tab rule');
  assert.match(tab[1], /min-height:\s*44px/);
});
