'use strict';
/* Regression tests for defects found by the adversarial review pass.
   Each block names the finding it covers. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers.js');
const C = require('../src/cardio.js');
const A = require('../src/analysis.js');

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

/* Finding 1: duplicate ground-truth R-peak indices at high heart rate,
   where the refinement windows of neighbouring beats overlap. */
test('ground-truth R peaks are strictly increasing at the highest accepted heart rate', () => {
  for (const fs of [250, 500]) {
    const rec = C.generateECG({ duration: 10, samplingRate: fs, heartRate: 299, seed: 3 });
    for (let i = 1; i < rec.rPeaks.length; i++) {
      assert.ok(rec.rPeaks[i] > rec.rPeaks[i - 1],
        `fs=${fs} duplicate or inverted truth peak at index ${i}: ${rec.rPeaks[i - 1]} then ${rec.rPeaks[i]}`);
    }
  }
});

/* Finding 3: unbounded generator inputs could hang forever or abort the
   process on allocation. resolveOptions must reject them. */
test('generateECG rejects unbounded and absurd option values', () => {
  assert.throws(() => C.generateECG({ duration: 20, samplingRate: 1e9 }), /samplingRate/);
  assert.throws(() => C.generateECG({ duration: 1e6, samplingRate: 250 }), /duration/);
  assert.throws(() => C.generateECG({ duration: 4000, samplingRate: 250 }), /duration/);
  assert.throws(() => C.generateECG({ duration: 3600, samplingRate: 2000 }), /1000000/);
  assert.throws(() => C.generateECG({ duration: 10, samplingRate: 250, hrStd: 1e9 }), /hrStd/);
  assert.throws(() => C.generateECG({ duration: 10, samplingRate: 250, rsaAmplitude: 1e9 }), /rsaAmplitude/);
  assert.throws(() => C.generateECG({ duration: 10, samplingRate: 250, mayerAmplitude: 1e9 }), /mayerAmplitude/);
});

test('generateECG still accepts physiological and boundary-adjacent options', () => {
  const rec = C.generateECG({ duration: 4, samplingRate: 500, heartRate: 72, hrStd: 2, rsaAmplitude: 150, mayerAmplitude: 100, seed: 7 });
  assert.equal(rec.signals.length, 12);
  assert.equal(rec.signals[0].length, 2000);
});

/* Finding 4: scoreDetection must score the detection set, not its order. */
test('scoreDetection is invariant under detection ordering', () => {
  const a = A.scoreDetection([102, 95], [100, 112], 250, 40);
  const b = A.scoreDetection([95, 102], [100, 112], 250, 40);
  assert.equal(a.truePositives, 2);
  assert.equal(b.truePositives, 2);
  assert.equal(a.f1, b.f1);
  assert.equal(a.sensitivity, 1);
  assert.equal(a.positivePredictivity, 1);
});

test('scoreDetection matching remains one reference per detection', () => {
  const r = A.scoreDetection([100, 101, 102], [100], 250, 40);
  assert.equal(r.truePositives, 1);
  assert.equal(r.falsePositives, 2);
  assert.equal(r.falseNegatives, 0);
});

/* Finding 5: movingWindowAverage must reject invalid window sizes. */
test('movingWindowAverage validates its window size', () => {
  const sig = new Float64Array([1, 2, 3, 4, 5]);
  for (const w of [0, -2, 2.5, NaN, Infinity, 'x']) {
    assert.throws(() => A.movingWindowAverage(sig, w), RangeError);
  }
  const out = A.movingWindowAverage(sig, 3);
  assert.deepEqual(Array.from(out.slice(2)), [2, 3, 4]);
});

/* Finding 6: welchPsd degenerate inputs. */
test('welchPsd rejects non-positive sampling rates and fractional segments', () => {
  const sig = new Float64Array(64).fill(0.5);
  for (const fs of [0, -250, NaN, Infinity]) {
    assert.throws(() => A.welchPsd(sig, fs, 32), RangeError);
  }
  assert.throws(() => A.welchPsd(sig, 250, 32.5), RangeError);
  assert.throws(() => A.welchPsd(sig, 250, 1), RangeError);
  assert.throws(() => A.welchPsd(sig, 250, 32, 33.5), RangeError);
});

test('welchPsd returns finite non-negative power and an empty result on a single sample', () => {
  const one = A.welchPsd(new Float64Array([0.5]), 250, 32);
  assert.equal(one.power.length, 0);
  const n = 256;
  const sig = new Float64Array(n);
  for (let i = 0; i < n; i++) sig[i] = Math.sin(2 * Math.PI * 10 * i / 250);
  const psd = A.welchPsd(sig, 250, 64);
  for (let i = 0; i < psd.power.length; i++) {
    assert.ok(Number.isFinite(psd.power[i]) && psd.power[i] >= 0,
      `non-finite or negative power at bin ${i}: ${psd.power[i]}`);
  }
});

/* Finding 7: quadraticSpline must not emit silent NaN. */
test('quadraticSpline rejects empty and non-finite knots', () => {
  assert.throws(() => A.quadraticSpline([], [], [0, 1, 2]), RangeError);
  assert.throws(() => A.quadraticSpline([0, 1, NaN], [0, 1, 0], [0.5]), RangeError);
  assert.throws(() => A.quadraticSpline([0, 1, 2], [0, NaN, 0], [0.5]), RangeError);
  const fine = A.quadraticSpline([0, 1, 2], [0, 1, 0], [0.5]);
  assert.ok(Number.isFinite(fine[0]));
});

/* Finding 2: the 'both' annotation mode concatenated detected and truth
   peak lists, producing a sample column that decreases mid-file plus
   duplicated rows where the two lists agree. WFDB annotation streams must
   be non-decreasing in time. */
test('both-mode annotation export stays non-decreasing with no duplicate samples', () => {
  const { doc, state } = freshApp();
  doc.getElementById('run').click();
  doc.getElementById('run-eval').click();
  doc.getElementById('export-ann').value = 'both';
  doc.getElementById('build-export').click();
  const files = state.getExportFiles();
  const rows = files.annotations.trim().split('\n').slice(1);
  assert.ok(rows.length > 10, 'expected a real annotation list, got ' + rows.length);
  let prev = -1;
  for (const row of rows) {
    const sample = Number(row.split(',')[0]);
    assert.ok(sample > prev, `annotation stream not strictly increasing: ${prev} then ${sample}`);
    prev = sample;
  }
});

/* Finding 8: unclamped export-leads crashed on an empty signal list and
   a raw export-gain wrote nonsense into the WFDB header. */
test('export clamps lead count and ADC gain into valid ranges', () => {
  const { doc, state } = freshApp();
  doc.getElementById('run').click();
  for (const bad of ['0', '', '-3']) {
    doc.getElementById('export-leads').value = bad;
    assert.doesNotThrow(() => doc.getElementById('build-export').click(), 'leads=' + JSON.stringify(bad));
    const files = state.getExportFiles();
    assert.ok(files.signals.startsWith('time_s,'), 'signals built for leads=' + JSON.stringify(bad));
    assert.match(files.header, /^cardiowave-synthetic 1 /, 'clamped to one lead for ' + JSON.stringify(bad));
  }
  doc.getElementById('export-leads').value = '12';
  for (const [bad, expected] of [['0', '1'], ['-5', '1'], ['1e9', '10000']]) {
    doc.getElementById('export-gain').value = bad;
    doc.getElementById('build-export').click();
    const files = state.getExportFiles();
    assert.ok(files.header.includes('16x' + expected + '(0)/mV'),
      `gain ${bad} -> header ${files.header.split('\n')[1]}`);
  }
});
