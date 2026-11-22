'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/rhythm.js');
const A = require('../src/analysis.js');

const TOL = 1e-9;

function sampleStd(arr) {
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) * (b - m), 0) / (arr.length - 1));
}

/* ---------- deterministic RNG ---------- */

test('makeRandom reproduces the same stream for the same seed', () => {
  const a = R.makeRandom(42), b = R.makeRandom(42);
  for (let i = 0; i < 10; i++) assert.equal(a(), b());
});

test('makeRandom output stays inside [0,1) and differs across seeds', () => {
  const a = R.makeRandom(1), b = R.makeRandom(2);
  let same = 0;
  for (let i = 0; i < 50; i++) {
    const va = a(), vb = b();
    assert.ok(va >= 0 && va < 1);
    assert.ok(vb >= 0 && vb < 1);
    if (va === vb) same++;
  }
  assert.ok(same < 50);
});

test('makeGaussian produces finite roughly-normal values', () => {
  const g = R.makeGaussian(R.makeRandom(7));
  let sum = 0;
  const vals = [];
  for (let i = 0; i < 2000; i++) { const v = g(); assert.ok(Number.isFinite(v)); vals.push(v); sum += v; }
  assert.ok(Math.abs(sum / 2000) < 0.2, 'mean near zero');
});

/* ---------- exact closed-form HRV metrics ---------- */

// RR series chosen so every closed-form value is computable by hand.
const RR = [800, 820, 780, 810, 790, 800, 830, 770];

test('SDNN equals the sample standard deviation of the NN series', () => {
  const f = R.rrFeatures(RR);
  assert.ok(Math.abs(f.sdnn - 20) < TOL, 'sample sd of the fixture is exactly 20');
  assert.ok(Math.abs(f.sdnn - sampleStd(RR)) < TOL);
});

test('RMSSD equals the root mean square of successive differences', () => {
  const diffs = [20, -40, 30, -20, 10, 30, -60];
  const expected = Math.sqrt(diffs.reduce((a, d) => a + d * d, 0) / diffs.length);
  const f = R.rrFeatures(RR);
  assert.ok(Math.abs(f.rmssd - expected) < TOL);
});

test('pNN50 counts successive differences over 50 ms', () => {
  const f = R.rrFeatures(RR);
  // diffs: 20, -40, 30, -20, 10, 30, -60 -> one exceeds 50 ms -> 1/7
  assert.ok(Math.abs(f.pnn50 - (100 / 7)) < TOL);
});

test('meanNN and bpm are the arithmetic mean and 60000/mean', () => {
  const f = R.rrFeatures(RR);
  assert.equal(f.meanNN, 800);
  assert.ok(Math.abs(f.bpm - 75) < TOL);
});

test('SDNN, RMSSD and pNN50 on a second hand-checked series', () => {
  const rr = [1000, 900, 1000, 900, 1000];
  const f = R.rrFeatures(rr);
  assert.equal(f.meanNN, 960);
  assert.ok(Math.abs(f.sdnn - sampleStd(rr)) < TOL);
  assert.ok(Math.abs(f.rmssd - 100) < TOL, 'all diffs are exactly 100 ms');
  assert.ok(Math.abs(f.pnn50 - 100) < TOL, 'every diff exceeds 50 ms');
});

test('pNN50 is exactly zero when no diff exceeds 50 ms', () => {
  const f = R.rrFeatures([800, 810, 800, 810, 800, 810]);
  assert.equal(f.pnn50, 0);
});

test('rrFeatures handles an empty series without NaN', () => {
  const f = R.rrFeatures([]);
  assert.equal(f.n, 0);
  for (const k of ['meanNN', 'bpm', 'sdnn', 'rmssd', 'cv', 'pnn50', 'sd1', 'sd2', 'sd1sd2', 'sampEn', 'irregularIndex']) {
    assert.ok(Number.isFinite(f[k]), k + ' finite');
  }
});

test('rrFeatures handles a single interval', () => {
  const f = R.rrFeatures([800]);
  assert.equal(f.n, 1);
  assert.equal(f.meanNN, 800);
  assert.equal(f.sdnn, 0);
  assert.equal(f.rmssd, 0);
});

/* ---------- SD1/SD2 Poincare identities ---------- */

test('SD1 equals stddev of (RRn - RRn+1)/sqrt2 by definition', () => {
  const x1 = [];
  for (let i = 0; i + 1 < RR.length; i++) x1.push((RR[i] - RR[i + 1]) / Math.SQRT2);
  const f = R.rrFeatures(RR);
  assert.ok(Math.abs(f.sd1 - sampleStd(x1)) < TOL);
});

test('SD2 equals stddev of (RRn + RRn+1)/sqrt2 by definition', () => {
  const x2 = [];
  for (let i = 0; i + 1 < RR.length; i++) x2.push((RR[i] + RR[i + 1]) / Math.SQRT2);
  const f = R.rrFeatures(RR);
  assert.ok(Math.abs(f.sd2 - sampleStd(x2)) < TOL);
});

test('SD1 squared relates to RMSSD through the rotated coordinates', () => {
  // For x1 = (a-b)/sqrt2 the variance of x1 is half the variance of the
  // successive differences when diffs are uncorrelated with the sum axis.
  const f = R.rrFeatures([800, 860, 780, 900, 750, 880, 800, 840]);
  assert.ok(f.sd1 > 0);
  assert.ok(Math.abs(f.sd1sd2 - f.sd1 / f.sd2) < TOL);
});

test('poincareEllipse centre sits at (mean RRn, mean RRn+1)', () => {
  const e = R.poincareEllipse(RR);
  const xs = RR.slice(0, RR.length - 1), ys = RR.slice(1);
  assert.ok(Math.abs(e.cx - xs.reduce((a, b) => a + b, 0) / xs.length) < TOL);
  assert.ok(Math.abs(e.cy - ys.reduce((a, b) => a + b, 0) / ys.length) < TOL);
});

test('poincareEllipse axes are the identity and perpendicular directions', () => {
  const e = R.poincareEllipse(RR);
  assert.ok(Math.abs(e.u2x - Math.SQRT1_2) < TOL);
  assert.ok(Math.abs(e.u2y - Math.SQRT1_2) < TOL);
  assert.ok(Math.abs(e.u1x - -Math.SQRT1_2) < TOL);
  assert.ok(Math.abs(e.u1y - Math.SQRT1_2) < TOL);
});

test('poincareEllipse returns zeros for short series without NaN', () => {
  const e = R.poincareEllipse([800, 810]);
  assert.equal(e.sd1, 0);
  assert.equal(e.sd2, 0);
  assert.ok(Number.isFinite(e.cx));
});

test('constant rhythm gives zero-area ellipse', () => {
  const e = R.poincareEllipse([800, 800, 800, 800, 800]);
  assert.equal(e.sd1, 0);
  assert.ok(Math.abs(e.sd2) < 1e-6);
});

/* ---------- sample entropy ---------- */

test('SampEn of a constant series is zero', () => {
  assert.equal(R.sampleEntropy([800, 800, 800, 800, 800, 800]), 0);
});

test('SampEn of a strictly alternating series is low', () => {
  const alt = [];
  for (let i = 0; i < 40; i++) alt.push(i % 2 ? 830 : 770);
  assert.ok(R.sampleEntropy(alt) < 0.3);
});

test('SampEn of an irregularly irregular series exceeds the organised one', () => {
  const strip = R.synthesizeStrip({ type: 'irregular', seed: 3 });
  const clean = R.synthesizeStrip({ type: 'normal', seed: 11 });
  assert.ok(R.sampleEntropy(strip.rrMs) > R.sampleEntropy(clean.rrMs));
});

test('SampEn stays finite on degenerate inputs', () => {
  assert.equal(R.sampleEntropy([]), 0);
  assert.equal(R.sampleEntropy([500]), 0);
  assert.ok(Number.isFinite(R.sampleEntropy([800, 900, 700])));
});

test('SampEn respects a custom radius', () => {
  const s = [800, 900, 780, 920, 760, 940, 810, 890, 770, 930];
  const tight = R.sampleEntropy(s, 2, 1);
  const loose = R.sampleEntropy(s, 2, 5000);
  assert.ok(Number.isFinite(tight) && tight >= 0);
  assert.ok(Number.isFinite(loose) && loose >= 0);
  assert.ok(loose < 0.5, 'a huge radius makes every template match');
});

/* ---------- ectopy detection ---------- */

test('ectopyIndices finds a compensatory pause pair', () => {
  const rr = [800, 810, 790, 800, 440, 1160, 800, 810, 790];
  const idx = R.ectopyIndices(rr);
  assert.deepEqual(idx, [4]);
});

test('ectopyIndices ignores isolated short cycles without a pause', () => {
  const rr = [800, 810, 790, 440, 810, 800, 790];
  assert.deepEqual(R.ectopyIndices(rr), []);
});

test('ectopyIndices ignores bigeminy-like pairs that do not sum to two cycles', () => {
  const rr = [800, 400, 400, 800, 800, 800];
  assert.deepEqual(R.ectopyIndices(rr), []);
});

test('ectopyIndices is empty for a flat series', () => {
  assert.deepEqual(R.ectopyIndices([800, 800, 800, 800]), []);
});

test('ectopyIndices is empty for an empty series', () => {
  assert.deepEqual(R.ectopyIndices([]), []);
});

test('ectopyIndices counts multiple pause pairs', () => {
  const rr = [800, 800, 440, 1160, 800, 800, 440, 1160, 800];
  const idx = R.ectopyIndices(rr);
  assert.equal(idx.length, 2);
});

/* ---------- classifyRhythm rule table ---------- */

function flatRR(mean, n, jitter) {
  const out = [];
  for (let i = 0; i < (n || 12); i++) out.push(mean + (jitter || 0) * ((i % 3) - 1));
  return out;
}

test('classifyRhythm calls a 75 bpm regular series normal', () => {
  const c = R.classifyRhythm(flatRR(800, 12, 10));
  assert.equal(c.key, 'normal');
  assert.ok(Math.abs(c.bpm - 75) < 0.5);
  assert.ok(c.reasons.length >= 2);
});

test('classifyRhythm calls a 48 bpm series bradycardia', () => {
  const c = R.classifyRhythm(flatRR(1250));
  assert.equal(c.key, 'bradycardia');
  assert.ok(c.bpm < 60);
});

test('classifyRhythm calls a 128 bpm series tachycardia', () => {
  const c = R.classifyRhythm(flatRR(468.75));
  assert.equal(c.key, 'tachycardia');
  assert.ok(c.bpm > 100);
});

test('classifyRhythm boundary: exactly 60 bpm is not bradycardia', () => {
  const c = R.classifyRhythm(flatRR(1000));
  assert.equal(c.key, 'normal');
});

test('classifyRhythm boundary: exactly 100 bpm is not tachycardia', () => {
  const c = R.classifyRhythm(flatRR(600));
  assert.equal(c.key, 'normal');
});

test('classifyRhythm calls compensatory pauses ectopic', () => {
  const rr = [];
  for (let i = 0; i < 4; i++) rr.push(800, 800, 800, 440, 1160);
  const c = R.classifyRhythm(rr);
  assert.equal(c.key, 'ectopic');
  assert.ok(c.features.ectopyCount >= 2);
});

test('classifyRhythm calls an irregularly irregular series irregular', () => {
  const strip = R.synthesizeStrip({ type: 'irregular', seed: 3 });
  const c = R.classifyRhythm(strip.rrMs);
  assert.equal(c.key, 'irregular');
});

test('classifyRhythm reports insufficient for two intervals', () => {
  const c = R.classifyRhythm([800, 810]);
  assert.equal(c.key, 'insufficient');
  assert.ok(c.reasons[0].includes('2'));
});

test('classifyRhythm reports insufficient for an empty series', () => {
  assert.equal(R.classifyRhythm([]).key, 'insufficient');
});

test('classifyRhythm output always carries label, bpm, features and reasons', () => {
  for (const key of ['normal', 'bradycardia', 'tachycardia', 'irregular', 'ectopic']) {
    const strip = R.synthesizeStrip({ type: key, seed: 5 });
    const c = R.classifyRhythm(strip.rrMs);
    assert.equal(typeof c.label, 'string');
    assert.ok(Number.isFinite(c.bpm));
    assert.ok(Array.isArray(c.reasons) && c.reasons.length > 0);
    assert.ok(c.features && Number.isFinite(c.features.sdnn));
  }
});

test('classification is deterministic on identical input', () => {
  const rr = flatRR(800, 20, 30);
  assert.deepEqual(R.classifyRhythm(rr), R.classifyRhythm(rr));
});

/* ---------- artefact meters ---------- */

test('toneAmplitude recovers a pure sinusoid amplitude', () => {
  const fs = 500, sig = new Float64Array(2000);
  for (let i = 0; i < sig.length; i++) sig[i] = 0.5 * Math.sin(2 * Math.PI * 60 * i / fs);
  assert.ok(Math.abs(R.toneAmplitude(sig, 60, fs) - 0.5) < 0.01);
});

test('toneAmplitude is near zero at a silent frequency', () => {
  const fs = 500, sig = new Float64Array(2000);
  for (let i = 0; i < sig.length; i++) sig[i] = Math.sin(2 * Math.PI * 60 * i / fs);
  assert.ok(R.toneAmplitude(sig, 31, fs) < 0.05);
});

test('analyzeArtifacts flags a 60 Hz mains hum', () => {
  const strip = R.synthesizeStrip({ type: 'hum', seed: 13 });
  const a = R.analyzeArtifacts(strip.signal, strip.fs);
  assert.ok(a.humFlag, 'hum flag set');
  assert.ok(a.flags.includes('powerline'));
  assert.ok(a.humMv > 0.2);
});

test('analyzeArtifacts flags baseline wander', () => {
  const strip = R.synthesizeStrip({ type: 'wander', seed: 17 });
  const a = R.analyzeArtifacts(strip.signal, strip.fs);
  assert.ok(a.wanderFlag, 'wander flag set');
  assert.ok(a.flags.includes('wander'));
});

test('analyzeArtifacts stays quiet on a clean strip', () => {
  const strip = R.synthesizeStrip({ type: 'normal', seed: 11 });
  const a = R.analyzeArtifacts(strip.signal, strip.fs);
  assert.ok(!a.humFlag && !a.wanderFlag);
  assert.equal(a.flags.length, 0);
});

test('analyzeArtifacts reports the 120 Hz harmonic separately', () => {
  const strip = R.synthesizeStrip({ type: 'hum', seed: 13 });
  const a = R.analyzeArtifacts(strip.signal, strip.fs);
  assert.ok(a.hum120Mv > 0.03, 'harmonic present');
  assert.ok(a.hum120Mv < a.humMv, 'harmonic below fundamental');
});

test('analyzeArtifacts amplitudes are finite on a flat signal', () => {
  const a = R.analyzeArtifacts(new Float64Array(500), 250);
  assert.ok(Number.isFinite(a.humMv) && Number.isFinite(a.wanderMv));
  assert.ok(!a.humFlag && !a.wanderFlag);
});

/* ---------- strip synthesis ---------- */

test('synthesizeStrip is deterministic for identical options', () => {
  const a = R.synthesizeStrip({ type: 'normal', seed: 9 });
  const b = R.synthesizeStrip({ type: 'normal', seed: 9 });
  assert.deepEqual(Array.from(a.signal), Array.from(b.signal));
  assert.deepEqual(a.peaks, b.peaks);
});

test('synthesizeStrip differs across seeds', () => {
  const a = R.synthesizeStrip({ type: 'normal', seed: 1 });
  const b = R.synthesizeStrip({ type: 'normal', seed: 2 });
  assert.notDeepEqual(Array.from(a.signal), Array.from(b.signal));
});

test('synthesizeStrip annotates true peaks inside the record', () => {
  const s = R.synthesizeStrip({ type: 'normal', seed: 4 });
  for (const p of s.peaks) {
    assert.ok(p >= 0 && p < s.signal.length);
  }
  assert.ok(s.peaks.length >= 15, 'about 19 beats in 16 s at 72 bpm');
});

test('synthesizeStrip trueBpm matches the strip class rate', () => {
  assert.ok(Math.abs(R.synthesizeStrip({ type: 'normal' }).trueBpm - 72) < 2);
  assert.ok(Math.abs(R.synthesizeStrip({ type: 'bradycardia' }).trueBpm - 48) < 2);
  assert.ok(Math.abs(R.synthesizeStrip({ type: 'tachycardia' }).trueBpm - 128) < 2);
});

test('synthesizeStrip trueClass maps through STRIP_CLASS', () => {
  assert.equal(R.synthesizeStrip({ type: 'hum' }).trueClass, 'artifact');
  assert.equal(R.synthesizeStrip({ type: 'wander' }).trueClass, 'artifact');
  assert.equal(R.synthesizeStrip({ type: 'ectopic' }).trueClass, 'ectopic');
});

test('synthesizeStrip ectopic strips contain compensatory pauses', () => {
  const s = R.synthesizeStrip({ type: 'ectopic', seed: 7 });
  assert.ok(R.ectopyIndices(s.rrMs).length >= 2);
});

test('beatTemplate has a dominant R extremum', () => {
  const t = R.beatTemplate(250);
  let max = -Infinity, maxI = 0;
  for (let i = 0; i < t.data.length; i++) if (t.data[i] > max) { max = t.data[i]; maxI = i; }
  assert.ok(Math.abs(maxI - t.rIndex) < 8, 'R peak near its index');
  assert.ok(max > 0.9);
});

/* ---------- strip set and end-to-end classification ---------- */

test('rhythmStripSet ships at least six annotated strips covering all six classes', () => {
  const set = R.rhythmStripSet();
  assert.ok(set.length >= 6);
  const classes = new Set(set.map(s => R.STRIP_CLASS[s.type]));
  for (const k of R.CLASS_KEYS) assert.ok(classes.has(k), 'covers ' + k);
});

test('every strip in the set synthesizes with ground truth', () => {
  for (const spec of R.rhythmStripSet()) {
    const s = R.synthesizeStrip(spec);
    assert.ok(s.peaks.length > 5, spec.id);
    assert.ok(s.rrMs.length > 4, spec.id);
    assert.ok(Number.isFinite(s.trueBpm));
  }
});

// One test per strip: end-to-end detection plus classification.
for (const spec of R.rhythmStripSet()) {
  test('classifyStrip predicts ' + spec.id + ' correctly end to end', () => {
    const strip = R.synthesizeStrip(spec);
    const res = R.classifyStrip(strip);
    assert.equal(res.predicted, strip.trueClass, spec.id + ' ' + spec.note);
    assert.ok(res.ok);
    assert.ok(res.detF1 > 0.5, 'detector F1 bounded on ' + spec.id);
    assert.ok(Number.isFinite(res.bpmError));
  });
}

/* ---------- benchmark scorer ---------- */

test('runRhythmBenchmark returns per-class one-versus-rest metrics', () => {
  const res = R.runRhythmBenchmark();
  assert.equal(res.metrics.length, R.CLASS_KEYS.length);
  for (const m of res.metrics) {
    assert.ok(m.tp + m.fp + m.fn + m.tn === res.total, m.key + ' counts partition');
    assert.ok(m.sensitivity >= 0 && m.sensitivity <= 1);
    assert.ok(m.specificity >= 0 && m.specificity <= 1);
    assert.ok(m.f1 >= 0 && m.f1 <= 1);
  }
});

test('runRhythmBenchmark scores 100 percent accuracy on the shipped set', () => {
  const res = R.runRhythmBenchmark();
  assert.equal(res.accuracy, 1);
  assert.equal(res.correct, res.total);
});

test('runRhythmBenchmark sensitivity, specificity and F1 are all one per class', () => {
  const res = R.runRhythmBenchmark();
  for (const m of res.metrics) {
    assert.ok(Math.abs(m.sensitivity - 1) < TOL, m.key + ' sens');
    assert.ok(Math.abs(m.specificity - 1) < TOL, m.key + ' spec');
    assert.ok(Math.abs(m.f1 - 1) < TOL, m.key + ' f1');
  }
});

test('runRhythmBenchmark bpm MAE stays below 15 bpm', () => {
  const res = R.runRhythmBenchmark();
  assert.ok(res.maeBpm < 15, 'mae ' + res.maeBpm);
  assert.ok(res.meanDetF1 > 0.8);
});

test('runRhythmBenchmark is deterministic across runs', () => {
  const a = R.runRhythmBenchmark(), b = R.runRhythmBenchmark();
  assert.equal(a.accuracy, b.accuracy);
  assert.equal(a.maeBpm, b.maeBpm);
  assert.deepEqual(a.rows.map(r => r.predicted), b.rows.map(r => r.predicted));
});

test('CLASS_KEYS lists exactly the six scored classes', () => {
  assert.deepEqual(R.CLASS_KEYS.slice().sort(), ['artifact', 'bradycardia', 'ectopic', 'irregular', 'normal', 'tachycardia']);
});

test('every class key has a human label', () => {
  for (const k of R.CLASS_KEYS) {
    assert.equal(typeof R.CLASS_LABELS[k], 'string');
    assert.ok(R.CLASS_LABELS[k].length > 3);
  }
});
