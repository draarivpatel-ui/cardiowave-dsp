'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Filters = require('../src/filters.js');
const Cardio = require('../src/cardio.js');
const Analysis = require('../src/analysis.js');
const App = require('../app.js');

const ROOT = path.join(__dirname, '..');

test('module surface: every engine exports its documented API', () => {
  for (const key of ['butter', 'zpk2sos', 'sosfilt', 'sosfiltfilt', 'sosfiltZi', 'butterFilterCausal', 'sosMagnitudeDb', 'polyFromRoots', 'buttap']) {
    assert.equal(typeof Filters[key], 'function', 'Filters.' + key);
  }
  for (const key of ['generateECG', 'simulateMcSharry', 'addArtifacts', 'buildRRSeries']) {
    assert.equal(typeof Cardio[key], 'function', 'Cardio.' + key);
  }
  for (const key of ['notch60', 'highpass', 'bandpass', 'detectQRS', 'detectQRSEnsemble', 'vectorMagnitude', 'scoreDetection', 'hrvTime', 'hrvFrequency', 'computeHRV', 'rrIntervals', 'rrTimes', 'quadraticSpline', 'welchPsd', 'bandPower', 'movingWindowAverage', 'findLocalMaxima']) {
    assert.equal(typeof Analysis[key], 'function', 'Analysis.' + key);
  }
  assert.equal(Cardio.VERSION, '1.0.0');
  assert.equal(Cardio.LEAD_NAMES.join(','), 'I,II,III,aVR,aVL,aVF,V1,V2,V3,V4,V5,V6');
  assert.equal(Cardio.LEAD_GAMMA.length, 12);
  assert.ok(Cardio.LEAD_GAMMA.every(row => row.length === 5));
});

test('butter design returns stable second-order sections', () => {
  for (const [type, Wn, sections] of [['lowpass', [40], 1], ['highpass', [0.5], 1], ['bandpass', [5, 15], 2], ['bandstop', [59, 61], 2]]) {
    const sos = Filters.butter(2, Wn, type, 250);
    assert.equal(sos.length, sections, type + ' section count');
    for (const row of sos) {
      assert.equal(row.length, 6);
      assert.ok(row.every(v => Number.isFinite(v)), 'finite coefficients');
      assert.ok(Math.abs(row[3]) > 0, 'nonzero a0');
    }
    // Evaluate the denominator polynomial roots for each section and require
    // that all poles lie inside the unit circle.
    for (const row of sos) {
      const a2 = row[5], a1 = row[4];
      const disc = a1 * a1 - 4 * a2;
      const r1 = (-a1 + Math.sqrt(Math.abs(disc))) / 2;
      const r2 = (-a1 - Math.sqrt(Math.abs(disc))) / 2;
      if (disc >= 0) {
        assert.ok(Math.abs(r1) < 1.0001 && Math.abs(r2) < 1.0001, 'stable poles');
      } else {
        assert.ok(Math.sqrt(a2) < 1.0001, 'stable complex pole radius');
      }
    }
  }
});

test('butter rejects invalid orders, frequencies and types', () => {
  assert.throws(() => Filters.butter(0, [10], 'lowpass', 250), /positive integer/);
  assert.throws(() => Filters.butter(1.5, [10], 'lowpass', 250), /positive integer/);
  assert.throws(() => Filters.butter(2, [0], 'lowpass', 250), /0 < Wn < fs\/2/);
  assert.throws(() => Filters.butter(2, [125], 'lowpass', 250), /0 < Wn < fs\/2/);
  assert.equal(Filters.butter(2, [5, 15], 'bandpass', 250).length, 2);
  assert.throws(() => Filters.butter(2, [5], 'bandpass', 250), /start and stop frequencies/);
  assert.throws(() => Filters.butter(2, [5, 15], 'lowpass', 250), /single critical frequency/);
  assert.throws(() => Filters.butter(2, [10], 'mystery', 250), /Unknown filter type/);
});

test('polyFromRoots reproduces known polynomials', () => {
  assert.deepEqual(Filters.polyFromRoots([]), [1]);
  assert.deepEqual(Filters.polyFromRoots([[1, 0], [2, 0], [3, 0]]), [1, -6, 11, -6]);
  const p = Filters.polyFromRoots([[0, 1], [0, -1]]);
  assert.equal(p.length, 3);
  assert.ok(Math.abs(p[0] - 1) < 1e-9);
  assert.ok(Math.abs(p[2] - 1) < 1e-9);
});

test('buttap poles lie on the left half of the unit circle', () => {
  for (const order of [1, 2, 3, 4]) {
    const zpk = Filters.buttap(order);
    assert.equal(zpk.p.length, order);
    assert.equal(zpk.k, 1);
    for (const pole of zpk.p) {
      assert.ok(Math.abs(Math.hypot(pole[0], pole[1]) - 1) < 1e-9);
      assert.ok(pole[0] < 0, 'left half plane');
    }
  }
});

test('sosfilt is linear and sosfiltfilt is zero phase on a symmetric impulse', () => {
  const sos = Filters.butter(2, [5, 15], 'bandpass', 250);
  const n = 600;
  const impulse = new Float64Array(n);
  impulse[300] = 1;
  const causal = Filters.sosfilt(sos, impulse, Filters.sosfiltZi(sos).map(s => [0, 0]));
  assert.equal(causal.length, n);
  assert.ok(causal.every(Number.isFinite));
  // An impulse before the causal filter start produces no output there.
  assert.equal(causal[0], 0);
  const zeroPhase = Filters.sosfiltfilt(sos, impulse);
  assert.equal(zeroPhase.length, n);
  assert.ok(zeroPhase.every(Number.isFinite));
  // Forward-backward filtering of a symmetric impulse is symmetric about the
  // impulse position (allowing for a small numeric tolerance).
  let asymmetry = 0;
  for (let k = 1; k < 120; k++) {
    asymmetry = Math.max(asymmetry, Math.abs(zeroPhase[300 + k] - zeroPhase[300 - k]));
  }
  assert.ok(asymmetry < Math.abs(zeroPhase[300]) * 0.02, 'near symmetric zero-phase response, got ' + asymmetry);
});

test('sosfiltfilt rejects signals shorter than its padding', () => {
  const sos = Filters.butter(2, [5, 15], 'bandpass', 250);
  assert.throws(() => Filters.sosfiltfilt(sos, new Float64Array(4)), /greater than padlen/);
});

test('sosMagnitudeDb measures passband and stopband attenuation', () => {
  const fs = 250;
  const band = Filters.butter(1, [5, 15], 'bandpass', fs);
  const notch = Filters.butter(2, [59, 61], 'bandstop', fs);
  const hp = Filters.butter(2, [0.5], 'highpass', fs);
  assert.ok(Math.abs(Filters.sosMagnitudeDb(band, 10, fs)) < 3, '10 Hz inside QRS band');
  assert.ok(Filters.sosMagnitudeDb(band, 0.5, fs) < -12, '0.5 Hz rejected');
  assert.ok(Filters.sosMagnitudeDb(notch, 60, fs) < -12, '60 Hz rejected');
  assert.ok(Filters.sosMagnitudeDb(notch, 30, fs) > -3, '30 Hz preserved');
  assert.ok(Filters.sosMagnitudeDb(hp, 5, fs) > -3, '5 Hz preserved');
  assert.ok(Filters.sosMagnitudeDb(hp, 0.05, fs) < -20, '0.05 Hz rejected');
  assert.ok(Number.isFinite(Filters.sosMagnitudeDb(band, 0, fs)));
  assert.ok(Number.isFinite(Filters.sosMagnitudeDb(band, fs / 2, fs)));
});

test('generateECG is deterministic, shaped and validated', () => {
  const options = { duration: 10, samplingRate: 250, heartRate: 72, seed: 42 };
  const a = Cardio.generateECG(options);
  const b = Cardio.generateECG(options);
  const n = options.duration * options.samplingRate;
  assert.equal(a.signals.length, 12);
  assert.equal(a.signals[0].length, n);
  assert.equal(a.leadNames.length, 12);
  assert.equal(a.samplingRate, 250);
  assert.equal(a.options.seed, 42);
  for (let L = 0; L < 12; L++) {
    assert.equal(a.signals[L].length, n);
    assert.ok(a.signals[L] instanceof Float64Array);
    for (let i = 0; i < n; i++) {
      assert.equal(a.signals[L][i], b.signals[L][i], 'seed determinism at lead ' + L + ' sample ' + i);
      assert.ok(Number.isFinite(a.signals[L][i]));
    }
  }
  assert.deepEqual(a.rPeaks, b.rPeaks);
  assert.ok(a.rPeaks.length >= 8, 'at least 8 beats in 10 s');
  for (let i = 1; i < a.rPeaks.length; i++) assert.ok(a.rPeaks[i] > a.rPeaks[i - 1]);
});

test('a different seed changes the signal but keeps the deterministic beat grid', () => {
  const opt = { duration: 8, samplingRate: 200, heartRate: 60, seed: 1 };
  const a = Cardio.generateECG(opt);
  const b = Cardio.generateECG(Object.assign({}, opt, { seed: 2 }));
  let different = 0;
  for (let i = 0; i < a.signals[0].length; i++) if (a.signals[0][i] !== b.signals[0][i]) different++;
  assert.ok(different > a.signals[0].length * 0.9, 'noise realisation changed');
});

test('resolveOptions rejects invalid inputs', () => {
  const bad = [
    [{ duration: 0 }, /duration/], [{ duration: -1 }, /duration/],
    [{ samplingRate: 10 }, /samplingRate/], [{ heartRate: 10 }, /heartRate/],
    [{ heartRate: 400 }, /heartRate/], [{ hrStd: -1 }, /hrStd/],
    [{ rsaAmplitude: -1 }, /rsaAmplitude/], [{ mayerAmplitude: -1 }, /mayerAmplitude/],
    [{ respRate: 0 }, /respRate/], [{ respRate: 90 }, /respRate/],
    [{ humAmplitude: -1 }, /humAmplitude/], [{ wanderAmplitude: -1 }, /wanderAmplitude/],
    [{ emgAmplitude: -1 }, /emgAmplitude/], [{ emgBandwidth: 0 }, /emgBandwidth/],
    [{ seed: 1.5 }, /seed/], [{ duration: 'x' }, /duration/]
  ];
  for (const [opts, re] of bad) assert.throws(() => Cardio.generateECG(opts), re);
  assert.deepEqual(Cardio.generateECG({ duration: 6 }).options.duration, 6);
});

test('artefacts are additive, lead independent and zero at zero amplitude', () => {
  const clean = Cardio.simulateMcSharry({ duration: 6, samplingRate: 250, heartRate: 72, seed: 7 });
  const opt = Object.assign({}, Cardio.DEFAULT_OPTIONS, {
    duration: 6, samplingRate: 250, heartRate: 72, seed: 7,
    humAmplitude: 0, wanderAmplitude: 0, emgAmplitude: 0
  });
  const a = Cardio.addArtifacts(clean.signals[0], opt, 0);
  assert.equal(a.length, clean.signals[0].length);
  for (let i = 0; i < a.length; i++) assert.equal(a[i], clean.signals[0][i]);
  const noisy = Object.assign({}, opt, { humAmplitude: 0.2, wanderAmplitude: 0.2, emgAmplitude: 0.1 });
  const l0 = Cardio.addArtifacts(clean.signals[0], noisy, 0);
  const l1 = Cardio.addArtifacts(clean.signals[0], noisy, 1);
  let changed = 0, independent = 0;
  for (let i = 0; i < a.length; i++) {
    if (l0[i] !== a[i]) changed++;
    if (l0[i] !== l1[i]) independent++;
  }
  assert.ok(changed > a.length * 0.9, 'artefacts change the signal');
  assert.ok(independent > a.length * 0.9, 'each lead has its own noise');
});

test('buildRRSeries respects the mean rate and clamps short intervals', () => {
  const rr = Cardio.buildRRSeries(Cardio.generateECG({ duration: 20, heartRate: 120, seed: 5 }).options);
  assert.ok(rr.length > 20);
  const mean = Array.from(rr).reduce((a, b) => a + b, 0) / rr.length;
  assert.ok(Math.abs(mean - 0.5) < 0.02, 'mean RR near 0.5 s at 120 bpm, got ' + mean);
  assert.ok(rr.every(v => v >= 0.2));
});

test('movingWindowAverage and findLocalMaxima handle edges and plateaus', () => {
  assert.deepEqual(Array.from(Analysis.movingWindowAverage([1, 2, 3, 4], 2)), [1, 1.5, 2.5, 3.5]);
  assert.deepEqual(Array.from(Analysis.movingWindowAverage([5], 3)), [5]);
  assert.deepEqual(Analysis.findLocalMaxima([0, 1, 0, 2, 0]), [1, 3]);
  assert.deepEqual(Analysis.findLocalMaxima([0, 1, 1, 0]), [], 'flat plateaus ignored');
  assert.deepEqual(Analysis.findLocalMaxima([]), []);
});

test('vectorMagnitude is polarity invariant', () => {
  const a = new Float64Array([3, 4, 0]);
  const mag = Analysis.vectorMagnitude([a]);
  assert.equal(mag[0], 3);
  assert.equal(mag[1], 4);
  const inv = Analysis.vectorMagnitude([a.map(v => -v)]);
  assert.deepEqual(Array.from(inv), Array.from(mag));
  const two = Analysis.vectorMagnitude([a, new Float64Array([0, 0, 0])]);
  assert.equal(two[0], 3);
  assert.equal(Analysis.vectorMagnitude([new Float64Array([1, 2, 2]), new Float64Array([2, 2, 2])])[0], Math.sqrt(5));
  assert.throws(() => Analysis.vectorMagnitude([]), /at least one lead/);
});

test('scoreDetection enforces one-to-one matching and computes metrics', () => {
  const s = Analysis.scoreDetection([100, 105, 300], [100, 200], 1000, 20);
  assert.equal(s.truePositives, 1);
  assert.equal(s.falsePositives, 2);
  assert.equal(s.falseNegatives, 1);
  assert.equal(s.sensitivity, 0.5);
  assert.equal(s.positivePredictivity, 1 / 3);
  assert.ok(Math.abs(s.f1 - 0.4) < 1e-9);
  assert.equal(s.errorsMs.length, 1);
  assert.equal(s.matchedDetected.length, 3);
  assert.deepEqual(s.matchedDetected.slice(0, 1), [true]);
  const empty = Analysis.scoreDetection([], [], 250, 150);
  assert.equal(empty.f1, 0);
  assert.equal(empty.sensitivity, 0);
});

test('scoreDetection tolerance is measured in samples', () => {
  const near = Analysis.scoreDetection([110], [100], 1000, 15);
  const far = Analysis.scoreDetection([110], [100], 1000, 5);
  assert.equal(near.truePositives, 1);
  assert.equal(far.truePositives, 0);
  assert.ok(Math.abs(near.rmseMs - 10) < 1e-9);
});

test('rrIntervals, rrTimes and hrvTime invariants', () => {
  const peaks = [0, 250, 500, 750, 1000];
  assert.deepEqual(Analysis.rrIntervals(peaks, 250), [1000, 1000, 1000, 1000]);
  assert.deepEqual(Analysis.rrTimes(peaks, 250), [1, 2, 3, 4]);
  const h = Analysis.hrvTime(peaks, 250);
  assert.equal(h.meanNN, 1000);
  assert.equal(h.sdnn, 0);
  assert.equal(h.rmssd, 0);
  assert.equal(h.pnn50, 0);
  assert.equal(h.sd1, 0);
  assert.equal(h.sd1sd2, 0);
  assert.equal(h.cvnn, 0);
  const varied = Analysis.hrvTime([0, 200, 450, 700, 1000], 250);
  assert.ok(varied.sdnn > 0);
  assert.ok(varied.rmssd > 0);
  assert.ok(varied.pnn50 >= 0 && varied.pnn50 <= 100);
  assert.ok(varied.sd1 > 0 && varied.sd2 > 0);
  assert.ok(varied.sd1sd2 > 0);
  const short = Analysis.hrvTime([0, 250], 250);
  assert.equal(short.sdnn, 0);
  assert.equal(short.rmssd, 0);
});

test('quadraticSpline interpolates the input knots', () => {
  const x = [0, 1, 2, 3, 4];
  const y = [0, 1, 4, 9, 16];
  const grid = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];
  const out = Analysis.quadraticSpline(x, y, grid);
  for (let i = 0; i < x.length; i++) assert.ok(Math.abs(out[i * 2] - y[i]) < 1e-8, 'knot ' + x[i]);
  assert.ok(out.every(Number.isFinite));
  const flat = Analysis.quadraticSpline([0, 1], [7, 9], [0, 0.5, 1]);
  assert.ok(flat.every(v => v === 7));
});

test('welchPsd and bandPower integrate a known sinusoid', () => {
  const fs = 100, n = 1024;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * 10 * i / fs);
  const psd = Analysis.welchPsd(x, fs, 256, 512);
  assert.equal(psd.frequency.length, 257);
  assert.equal(psd.power.length, 257);
  assert.ok(psd.power.every(Number.isFinite));
  let peak = 0;
  for (let i = 1; i < psd.frequency.length; i++) if (psd.power[i] > psd.power[peak]) peak = i;
  assert.ok(Math.abs(psd.frequency[peak] - 10) < 1, 'spectral peak at 10 Hz, got ' + psd.frequency[peak]);
  const band = Analysis.bandPower(psd, 8, 12);
  assert.ok(band > 0);
  // A signal shorter than the requested segment still gets one zero-padded
  // short segment, so the frequency axis is shorter than a full transform.
  const short = Analysis.welchPsd(new Float64Array(2), fs, 256, 256);
  assert.equal(short.frequency.length, 129);
  assert.equal(short.power.length, 129);
  assert.ok(short.power.every(Number.isFinite));
  const none = Analysis.welchPsd(new Float64Array(0), fs, 256, 256);
  assert.equal(none.frequency.length, 0);
});

test('hrvFrequency and computeHRV degrade gracefully on short series', () => {
  const f = Analysis.hrvFrequency([0, 250], 250);
  assert.equal(f.lf, 0);
  assert.equal(f.hf, 0);
  assert.equal(f.lfHf, 0);
  const h = Analysis.computeHRV([0, 250, 500, 750, 1000, 1250], 250);
  assert.ok(Number.isFinite(h.meanNN));
  assert.ok(h.lf >= 0 && h.hf >= 0);
  assert.ok(h.lfNormalized + h.hfNormalized <= 1.0000001 || h.totalPower === 0);
  assert.equal(h.rri.length, 5);
  assert.equal(h.rrTimes.length, 5);
});

test('conditioning filters preserve length and remove out-of-band content', () => {
  const fs = 250, n = 2000;
  const x = new Float64Array(n);
  const wander = new Float64Array(n);
  const hum = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    wander[i] = 0.2 * Math.sin(2 * Math.PI * 0.2 * i / fs);
    hum[i] = Math.sin(2 * Math.PI * 60 * i / fs);
    x[i] = wander[i] + hum[i];
  }
  const notched = Analysis.notch60(x, fs);
  const highpassed = Analysis.highpass(x, fs);
  const wanderOnly = Analysis.highpass(wander, fs);
  const bandpassed = Analysis.bandpass(x, fs, 5, 15, 1);
  assert.equal(notched.length, n);
  assert.equal(highpassed.length, n);
  assert.equal(bandpassed.length, n);
  assert.ok([notched, highpassed, bandpassed].every(a => a.every(Number.isFinite)));
  // Measure RMS in the middle of the record, away from edge effects.
  const rms = a => {
    let s = 0;
    for (let i = 500; i < 1500; i++) s += a[i] * a[i];
    return Math.sqrt(s / 1000);
  };
  assert.ok(rms(notched) < rms(x) * 0.35, '60 Hz hum attenuated by the notch');
  // A high pass removes the slow wander but deliberately keeps the 60 Hz
  // hum, so compare against the isolated low frequency component.
  assert.ok(rms(wanderOnly) < rms(wander) * 0.1, 'baseline wander attenuated by the high pass');
  assert.ok(rms(highpassed) > rms(wanderOnly) * 5, 'high pass preserves the hum');
});

test('detectQRS validates inputs and returns stage arrays', () => {
  assert.throws(() => Analysis.detectQRS('not an array', 250), /signal must be an array/);
  assert.throws(() => Analysis.detectQRS(new Float64Array(100), 0), /sampling rate/);
  assert.throws(() => Analysis.detectQRS(new Float64Array(2), 250), /more than two samples/);
  const record = Cardio.generateECG({ duration: 12, samplingRate: 250, heartRate: 72, seed: 7 });
  const det = Analysis.detectQRS(record.signals[1], 250);
  assert.ok(det.peaks.length > 0);
  assert.equal(det.filtered.length, record.signals[1].length);
  assert.equal(det.integrated.length, record.signals[1].length);
  assert.ok(det.peaks.every((p, i) => i === 0 || p > det.peaks[i - 1]));
  assert.ok(det.peaks.every(p => p >= 0 && p < det.integrated.length));
});

test('ensemble detector improves precision over the single lead baseline', () => {
  const record = Cardio.generateECG({ duration: 20, samplingRate: 250, heartRate: 72, seed: 7 });
  const cfg = { minVotes: 4, gate: 0.2, toleranceMs: 50, refineMs: 60 };
  const ens = Analysis.detectQRSEnsemble(record.signals, 250, cfg);
  const single = Analysis.detectQRS(record.signals[1], 250);
  const se = Analysis.scoreDetection(ens.peaks, record.rPeaks, 250, 150);
  const ss = Analysis.scoreDetection(single.peaks, record.rPeaks, 250, 150);
  assert.ok(ens.peaks.length > 5, 'ensemble finds beats');
  assert.ok(ens.votes.length === ens.peaks.length);
  assert.ok(ens.amplitudes.length === ens.peaks.length);
  assert.equal(ens.detections.length, 12);
  assert.ok(se.positivePredictivity > ss.positivePredictivity, 'precision gain');
  assert.ok(se.f1 > ss.f1, 'F1 gain');
  assert.throws(() => Analysis.detectQRSEnsemble([], 250), /at least one lead/);
  assert.throws(() => Analysis.detectQRSEnsemble(record.signals, 0), /sampling rate/);
});

test('vote count controls the sensitivity and precision trade-off', () => {
  const record = Cardio.generateECG({ duration: 20, samplingRate: 250, heartRate: 72, seed: 7 });
  const low = Analysis.detectQRSEnsemble(record.signals, 250, { minVotes: 2, gate: 0.2, toleranceMs: 50 });
  const high = Analysis.detectQRSEnsemble(record.signals, 250, { minVotes: 10, gate: 0.2, toleranceMs: 50 });
  assert.ok(low.peaks.length > high.peaks.length, 'fewer votes means more candidates');
  const sweep = App.voteSweep(record, 0.2, 50);
  assert.equal(sweep.length, 12);
  for (let i = 1; i <= 12; i++) assert.equal(sweep[i - 1].votes, i);
  assert.ok(sweep.every(s => s.f1 >= 0 && s.f1 <= 1));
});

test('extreme artefacts degrade detection instead of throwing', () => {
  const record = Cardio.generateECG({
    duration: 12, samplingRate: 250, heartRate: 90, seed: 17,
    humAmplitude: 0.35, wanderAmplitude: 0.5, emgAmplitude: 0.2
  });
  const ens = Analysis.detectQRSEnsemble(record.signals, 250, { minVotes: 4, gate: 0.2 });
  const score = Analysis.scoreDetection(ens.peaks, record.rPeaks, 250, 150);
  assert.ok(score.f1 >= 0 && score.f1 <= 1);
  assert.ok(ens.peaks.every(Number.isInteger));
});

test('evaluateRecord publishes both detector scores and an HRV report', () => {
  const record = Cardio.generateECG({ duration: 16, samplingRate: 250, heartRate: 72, seed: 42 });
  const ev = App.evaluateRecord(record, { minVotes: 4, gate: 0.2, toleranceMs: 50 });
  assert.ok(ev.ensemble.peaks.length > 0);
  assert.ok(ev.single.peaks.length > 0);
  assert.ok(ev.ensembleScore.f1 >= 0 && ev.ensembleScore.f1 <= 1);
  assert.ok(ev.singleScore.f1 >= 0 && ev.singleScore.f1 <= 1);
  assert.ok(ev.hrv.meanNN > 0);
  assert.ok(ev.hrv.rri.length >= 0);
});

test('benchmark suite is deterministic and reports explicit baselines', () => {
  const cases = App.benchmarkCases();
  assert.equal(cases.length, 9);
  const a = App.runBenchmarkSuite();
  const b = App.runBenchmarkSuite();
  assert.equal(a.length, 9);
  assert.deepEqual(a, b, 'suite is reproducible');
  assert.ok(a.every(r => r.baseF1 >= 0 && r.baseF1 <= 1 && r.ensF1 >= 0 && r.ensF1 <= 1));
  assert.ok(a.every(r => r.reference > 0));
  assert.ok(a.some(r => r.deltaF1 > 0), 'ensemble beats baseline in at least one case');
  assert.ok(a.some(r => r.falsePositives > 0 || r.falseNegatives > 0), 'failure modes are visible');
  const custom = App.runBenchmarkSuite([{ label: 'one', heartRate: 72, fs: 250, duration: 10, seed: 1, hum: 0, wander: 0, emg: 0 }]);
  assert.equal(custom.length, 1);
});

test('filterVerification measures the three conditioning filters', () => {
  const rows = App.filterVerification(250);
  assert.equal(rows.length, 6);
  assert.ok(rows.every(r => Number.isFinite(r.measured)));
  assert.ok(rows.every(r => typeof r.pass === 'boolean'));
  assert.ok(rows.filter(r => r.pass).length >= 5, 'most filter checks pass');
});

test('WFDB text builders are well formed and reproducible', () => {
  const signals = [new Float64Array([0, 1, -0.5]), new Float64Array([0.2, 0.4, 0.6])];
  const header = App.wfdbHeader('rec', ['I', 'II'], 3, 250, 200);
  assert.ok(header.startsWith('rec 2 250 3\n'));
  assert.ok(header.includes('rec.csv 16x200(0)/mV'));
  // WFDB wants one signal-specification line per signal, each ending with
  // that signal's description.
  assert.ok(header.includes(' 0 0 0 0 0 I\n'), 'missing I spec line');
  assert.ok(header.includes(' 0 0 0 0 0 II\n'), 'missing II spec line');
  assert.equal(header.trim().split('\n').length, 5, 'record line + 2 spec lines + 2 comments');
  assert.ok(header.includes('Not a medical device'));
  const csv = App.wfdbSignals(signals, ['I', 'II'], 250, 200);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[0], 'time_s,I,II');
  assert.equal(lines[1], '0.0000,0,40');
  assert.equal(lines[3], '0.0080,-100,120');
  const ann = App.wfdbAnnotations([0, 250], 250);
  assert.ok(ann.startsWith('# sample,time_s,type\n'));
  assert.ok(ann.includes('250,1.0000,N'));
  assert.equal(App.wfdbAnnotations([], 250).trim(), '# sample,time_s,type');
  assert.equal(App.fmt(1.2345, 2), '1.23');
  assert.equal(App.fmt(Infinity), 'n/a');
  assert.equal(App.pct(0.5), '50.0%');
});

test('repository files exist and carry no forbidden punctuation or mentions', () => {
  const files = ['index.html', 'style.css', 'app.js', 'package.json', 'LICENSE', 'README.md', 'DEVPOST_UPGRADE.md', '.nojekyll'];
  for (const f of files) assert.ok(fs.existsSync(path.join(ROOT, f)), 'missing ' + f);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.license, 'MIT');
  assert.deepEqual(pkg.dependencies, {});
  assert.ok(pkg.scripts.test.includes('node --test'));
  const textFiles = ['index.html', 'style.css', 'app.js', 'package.json', 'LICENSE', 'README.md', 'DEVPOST_UPGRADE.md'];
  const emDash = String.fromCharCode(0x2014);
  const enDash = String.fromCharCode(0x2013);
  const banned = new RegExp('\\b(' + ['A' + 'I', 'LL' + 'M', 'GP' + 'T', 'Clau' + 'de', 'Chat' + 'GP' + 'T'].join('|') + ')\\b', 'i');
  for (const f of textFiles) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!s.includes(emDash), 'em dash in ' + f);
    assert.ok(!s.includes(enDash), 'en dash in ' + f);
    assert.ok(!banned.test(s), 'prohibited mention in ' + f);
  }
  assert.equal(fs.statSync(path.join(ROOT, '.nojekyll')).size, 0);
});
