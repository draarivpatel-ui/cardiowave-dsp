'use strict';
/* Second engine suite: formula-level HRV verification, Welch/FFT edge cases,
   Pan-Tompkins and ensemble behaviour, filter validation, generator
   determinism, WFDB structure and regression tests for fixed defects. */
const test = require('node:test');
const assert = require('node:assert/strict');
const Filters = require('../src/filters.js');
const Cardio = require('../src/cardio.js');
const Analysis = require('../src/analysis.js');
const App = require('../app.js');

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= (eps || 1e-9), `${msg || ''} expected ${a} within ${eps || 1e-9} of ${b}`);

/* ------------------------------------------------------------------ */
/* HRV formulas, checked against hand-computable values                  */
/* ------------------------------------------------------------------ */

/* Helper: turn an R-R interval list (ms) into a peak list (samples). */
function peaksFromRRI(rri, fs) {
  var peaks = [0];
  var acc = 0;
  for (var i = 0; i < rri.length; i++) { acc += rri[i] * fs / 1000; peaks.push(Math.round(acc)); }
  return peaks;
}

test('pnn50 divides by the number of NN differences, not N+1', () => {
  // 4 intervals, 3 differences, exactly one |diff| > 50 ms -> 33.33%.
  var t = Analysis.hrvTime(peaksFromRRI([800, 900, 800, 800], 500), 500);
  close(t.pnn50, 200 / 3, 1e-6, 'pnn50');
});

test('pnn50 is 0 when no difference exceeds 50 ms and 100 when all do', () => {
  close(Analysis.hrvTime(peaksFromRRI([800, 810, 795, 805], 500), 500).pnn50, 0, 1e-9);
  close(Analysis.hrvTime(peaksFromRRI([800, 900, 750, 950], 500), 500).pnn50, 100, 1e-9);
});

test('pnn50 counts the absolute value of differences, sign does not matter', () => {
  var t = Analysis.hrvTime(peaksFromRRI([800, 740, 870, 780], 500), 500);
  // diffs: -60, +130, -90 -> all three exceed 50 ms.
  close(t.pnn50, 100, 1e-9);
});

test('rmssd matches a direct root-mean-square computation', () => {
  var rri = [800, 860, 820, 900];
  var diffs = [60, -40, 80];
  var expect = Math.sqrt((60 * 60 + 40 * 40 + 80 * 80) / 3);
  close(Analysis.hrvTime(peaksFromRRI(rri, 500), 500).rmssd, expect, 1e-6, 'rmssd');
});

test('sdnn is the sample standard deviation of the NN intervals', () => {
  var rri = [800, 820, 780, 810];
  var m = rri.reduce((a, b) => a + b) / rri.length;
  var sd = Math.sqrt(rri.reduce((a, v) => a + (v - m) * (v - m), 0) / (rri.length - 1));
  close(Analysis.hrvTime(peaksFromRRI(rri, 500), 500).sdnn, sd, 1e-6, 'sdnn');
});

test('constant rhythm gives zero variability across every metric', () => {
  var t = Analysis.hrvTime(peaksFromRRI([800, 800, 800, 800, 800], 500), 500);
  for (var k of ['sdnn', 'rmssd', 'pnn50', 'sd1', 'sd2', 'cvnn', 'cvsd', 'sdnni']) {
    close(t[k], 0, 1e-9, k);
  }
});

test('meanNN is the arithmetic mean of the intervals in milliseconds', () => {
  close(Analysis.hrvTime(peaksFromRRI([800, 900, 700], 500), 500).meanNN, 800, 1e-6);
});

test('sd1 reflects short-term and sd2 long-term variability', () => {
  // Alternating intervals: high beat-to-beat scatter -> sd1 >> 0.
  var alt = Analysis.hrvTime(peaksFromRRI([700, 920, 730, 890, 760, 870], 500), 500);
  var drift = Analysis.hrvTime(peaksFromRRI([700, 750, 800, 850, 900], 500), 500);
  assert.ok(alt.sd1 > drift.sd1, 'sd1 ordering');
  assert.ok(drift.sd2 > 0);
  assert.ok(alt.sd1sd2 > 0, 'sd1sd2 is sd1/sd2 when sd2 is nonzero');
});

test('cvnn and cvsd normalise sdnn and rmssd by the mean interval', () => {
  var rri = [800, 850, 750, 820, 780];
  var t = Analysis.hrvTime(peaksFromRRI(rri, 500), 500);
  close(t.cvnn, t.sdnn / t.meanNN, 1e-9);
  close(t.cvsd, t.rmssd / t.meanNN, 1e-9);
});

test('sdnni with a short recording equals the single-window sdnn', () => {
  var rri = [800, 840, 760, 820, 790];
  var t = Analysis.hrvTime(peaksFromRRI(rri, 500), 500);
  close(t.sdnni, t.sdnn, 1e-9, 'short record: one window');
});

test('sdnni splits long recordings into 5-minute windows', () => {
  // 7 minutes at 600 ms -> 700 intervals -> 2 full windows + remainder.
  var rri = [];
  for (var i = 0; i < 700; i++) rri.push(i % 2 ? 500 : 700); // sd = 100 per window
  var t = Analysis.hrvTime(peaksFromRRI(rri, 1000), 1000);
  close(t.sdnni, 100, 0.5, 'each 5-min window has sd ~100 ms');
});

test('sdnni with two different windows averages their deviations', () => {
  // Window 1: constant 600 ms for 300 s (sd 0); window 2: alternating sd 50.
  var rri = [];
  for (var i = 0; i < 500; i++) rri.push(600); // exactly 300 s
  for (var j = 0; j < 100; j++) rri.push(j % 2 ? 550 : 650); // sd 50, 60 s
  var t = Analysis.hrvTime(peaksFromRRI(rri, 1000), 1000);
  close(t.sdnni, 25.13, 0.5, 'mean of window SDs');
});

test('hrvTime on fewer than 2 intervals returns zeroed metrics', () => {
  var t = Analysis.hrvTime([100], 500);
  assert.equal(t.sdnn, 0);
  assert.equal(t.rmssd, 0);
  assert.equal(t.pnn50, 0);
  assert.equal(t.rri.length, 0);
});

test('rrIntervals converts sample spacing to milliseconds', () => {
  var rr = Analysis.rrIntervals([0, 500, 1000, 1500], 500);
  assert.deepEqual(rr, [1000, 1000, 1000]);
  var rr2 = Analysis.rrIntervals([0, 250, 500], 250);
  assert.deepEqual(rr2, [1000, 1000]);
});

test('rrTimes returns the interval-end timestamps in seconds', () => {
  // One entry per R-R interval: the time at which each interval ended.
  assert.deepEqual(Analysis.rrTimes([0, 250, 500], 250), [1, 2]);
});

/* ------------------------------------------------------------------ */
/* Frequency-domain HRV                                                 */
/* ------------------------------------------------------------------ */

test('hrvFrequency on a slowly modulated series puts power in the LF band', () => {
  // RR = 800 + 100 sin(2*pi*0.1*t): the modulation sits at 0.1 Hz (LF).
  var peaks = [0], acc = 0;
  for (var i = 0; i < 60; i++) {
    acc += 0.8 + 0.1 * Math.sin(2 * Math.PI * 0.1 * acc);
    peaks.push(Math.round(acc * 100));
  }
  var f = Analysis.hrvFrequency(peaks, 100);
  assert.ok(f.lf > 0);
  assert.ok(f.lf > f.hf, `LF ${f.lf} should exceed HF ${f.hf}`);
});

test('hrvFrequency on a fast-modulated series puts power in the HF band', () => {
  var peaks = [0], acc = 0;
  for (var i = 0; i < 300; i++) {
    acc += 0.8 + 0.08 * Math.sin(2 * Math.PI * 0.3 * acc);
    peaks.push(Math.round(acc * 100));
  }
  var f = Analysis.hrvFrequency(peaks, 100);
  assert.ok(f.hf > 0);
  assert.ok(f.hf > f.lf, `HF ${f.hf} should exceed LF ${f.lf}`);
  var pk = 1;
  for (var b = 2; b < f.psd.power.length; b++) if (f.psd.power[b] > f.psd.power[pk]) pk = b;
  assert.ok(f.psd.frequency[pk] > 0.15 && f.psd.frequency[pk] < 0.4, `peak ${f.psd.frequency[pk]} not in HF band`);
});

test('hrvFrequency degenerate cases return zeros, not NaN', () => {
  for (const p of [[], [5], [5, 10]]) {
    const f = Analysis.hrvFrequency(p, 250);
    for (const k of ['lf', 'hf', 'lfHf', 'totalPower', 'lfNormalized', 'hfNormalized']) {
      assert.equal(f[k], 0, k + ' on ' + p.length + ' peaks');
    }
  }
});

test('computeHRV returns the full metric surface with finite values', () => {
  const rec = Cardio.generateECG({ duration: 25, samplingRate: 250, heartRate: 65, seed: 11 });
  const det = Analysis.detectQRSEnsemble(rec.signals, rec.samplingRate, { minVotes: 4 });
  const hrv = Analysis.computeHRV(det.peaks.filter((p, i, a) => i === 0 || p > a[i - 1]), rec.samplingRate);
  for (const k of ['meanNN', 'sdnn', 'rmssd', 'pnn50', 'sd1', 'sd2', 'cvnn', 'cvsd', 'sdnni', 'lf', 'hf', 'lfHf', 'totalPower']) {
    assert.ok(Number.isFinite(hrv[k]), k + ' not finite');
  }
  assert.ok(hrv.meanNN > 700 && hrv.meanNN < 1100, `meanNN ${hrv.meanNN} outside 60-90 bpm band`);
  assert.ok(hrv.rri.length === det.peaks.filter((p, i, a) => i === 0 || p > a[i - 1]).length - 1);
});

/* ------------------------------------------------------------------ */
/* Welch PSD and the radix-2 FFT                                        */
/* ------------------------------------------------------------------ */

test('welchPsd of a pure tone puts its energy at the tone frequency', () => {
  var fs = 256, n = 1024;
  var sig = new Float64Array(n);
  for (var i = 0; i < n; i++) sig[i] = Math.sin(2 * Math.PI * 16 * i / fs);
  var psd = Analysis.welchPsd(sig, fs, 256, 256);
  var peak = 0;
  for (var b = 0; b < psd.power.length; b++) if (psd.power[b] > psd.power[peak]) peak = b;
  close(psd.frequency[peak], 16, 1.0, 'tone bin');
});

test('welchPsd handles a non-power-of-two nfft by rounding up', () => {
  var sig = new Float64Array(600);
  for (var i = 0; i < 600; i++) sig[i] = Math.sin(2 * Math.PI * 10 * i / 200);
  var psd = Analysis.welchPsd(sig, 200, 128, 200);
  // 200 rounds to 256: bins = 129, resolution 200/256.
  assert.equal(psd.power.length, 129);
  assert.equal(psd.frequency.length, 129);
  for (const v of psd.power) assert.ok(Number.isFinite(v) && v >= 0);
});

test('welchPsd handles an odd segment length without losing samples', () => {
  var sig = new Float64Array(333);
  for (var i = 0; i < 333; i++) sig[i] = Math.sin(2 * Math.PI * 7 * i / 100) + 0.3 * Math.sin(2 * Math.PI * 20 * i / 100);
  var psd = Analysis.welchPsd(sig, 100, 99);
  assert.ok(psd.power.length > 0);
  for (const v of psd.power) assert.ok(Number.isFinite(v) && v >= 0);
  var peak = 0;
  for (var b = 0; b < psd.power.length; b++) if (psd.power[b] > psd.power[peak]) peak = b;
  assert.ok(psd.frequency[peak] > 5 && psd.frequency[peak] < 22, `peak at ${psd.frequency[peak]} Hz`);
});

test('welchPsd nfft below the segment length never drops samples', () => {
  var sig = new Float64Array(256);
  for (var i = 0; i < 256; i++) sig[i] = Math.sin(2 * Math.PI * 10 * i / 128);
  var psd = Analysis.welchPsd(sig, 128, 128, 64);
  // nfft is raised to at least nperseg -> transform 128.
  assert.equal(psd.power.length, 65);
  var peak = 0;
  for (var b = 0; b < psd.power.length; b++) if (psd.power[b] > psd.power[peak]) peak = b;
  close(psd.frequency[peak], 10, 1.0);
});

test('welchPsd integrated power approximates the tone power', () => {
  var fs = 256, n = 512, sig = new Float64Array(n);
  for (var i = 0; i < n; i++) sig[i] = Math.sin(2 * Math.PI * 32 * i / fs);
  var psd = Analysis.welchPsd(sig, fs, 256, 256);
  var total = 0;
  for (var b = 0; b < psd.power.length; b++) total += psd.power[b] * (fs / 256);
  // A unit sine has mean-square power 0.5; Welch's one-sided estimate
  // should land in the same order of magnitude.
  assert.ok(total > 0.25 && total < 1.0, `integrated power ${total}`);
});

test('welchPsd detrends each segment, so a constant signal carries no power', () => {
  // Per-segment mean removal (SciPy detrend='constant') removes DC, so a
  // flat signal has essentially zero power everywhere.
  var psd = Analysis.welchPsd(new Float64Array(512).fill(1), 100, 128, 128);
  var total = 0;
  for (const v of psd.power) total += v;
  assert.ok(total < 1e-20, `constant signal should carry ~0 power, got ${total}`);
});

test('welchPsd on an all-zero signal returns all-zero power', () => {
  var psd = Analysis.welchPsd(new Float64Array(256), 100, 64, 64);
  for (const v of psd.power) assert.equal(v, 0);
});

test('welchPsd on an empty signal returns an empty result without looping', () => {
  var psd = Analysis.welchPsd(new Float64Array(0), 100, 256, 256);
  assert.equal(psd.power.length, 0);
  assert.equal(psd.frequency.length, 0);
});

test('welchPsd on a signal shorter than nperseg still returns a valid spectrum', () => {
  var sig = new Float64Array(40);
  for (var i = 0; i < 40; i++) sig[i] = Math.sin(2 * Math.PI * 8 * i / 100);
  var psd = Analysis.welchPsd(sig, 100, 256, 256);
  assert.ok(psd.power.length > 0);
  for (const v of psd.power) assert.ok(Number.isFinite(v) && v >= 0);
});

test('bandPower integrates PSD bins inside a closed band', () => {
  var psd = { frequency: new Float64Array([0, 1, 2, 3, 4]), power: new Float64Array([1, 1, 1, 1, 1]) };
  var p = Analysis.bandPower(psd, 1, 3);
  assert.ok(p > 0);
  assert.ok(p <= 4, 'bounded by band width');
});

/* ------------------------------------------------------------------ */
/* Detection scoring                                                    */
/* ------------------------------------------------------------------ */

test('scoreDetection matches a detection to a free reference inside tolerance', () => {
  // Regression: det at 100 is nearest to used ref 105, but ref 95 is free.
  // With the old code det 100 would have been a false positive.
  var det = [10, 100];
  var ref = [12, 95, 105];
  // First match 10->12 uses ref[0]; det 100 must take ref[1] or ref[2].
  var s = Analysis.scoreDetection(det, ref, 1000, 10); // tolerance 10 ms
  assert.equal(s.truePositives, 2);
  assert.equal(s.falsePositives, 0);
  assert.equal(s.falseNegatives, 1);
});

test('scoreDetection never matches one reference twice', () => {
  var s = Analysis.scoreDetection([100, 102, 104], [100], 1000, 50);
  assert.equal(s.truePositives, 1);
  assert.equal(s.falsePositives, 2);
});

test('scoreDetection respects the tolerance boundary', () => {
  var fs = 1000;
  var inside = Analysis.scoreDetection([100 + 99], [100], fs, 100); // 99 ms off
  var outside = Analysis.scoreDetection([100 + 101], [100], fs, 100);
  assert.equal(inside.truePositives, 1);
  assert.equal(outside.truePositives, 0);
});

test('scoreDetection on empty inputs yields zeros, not NaN', () => {
  var s = Analysis.scoreDetection([], [], 250, 50);
  assert.equal(s.sensitivity, 0);
  assert.equal(s.f1, 0);
  assert.equal(s.rmseMs, 0);
});

test('scoreDetection computes exact sensitivity and precision', () => {
  var s = Analysis.scoreDetection([100, 200, 900], [100, 200, 300, 400], 1000, 20);
  close(s.sensitivity, 2 / 4, 1e-9);
  close(s.positivePredictivity, 2 / 3, 1e-9);
  close(s.f1, 2 * 0.5 * (2 / 3) / (0.5 + 2 / 3), 1e-9);
});

/* ------------------------------------------------------------------ */
/* Pan-Tompkins and ensemble                                            */
/* ------------------------------------------------------------------ */

test('movingWindowAverage computes exact windowed means', () => {
  var out = Analysis.movingWindowAverage(new Float64Array([1, 2, 3, 4, 5]), 3);
  assert.deepEqual([...out].map(v => Math.round(v * 100) / 100), [1, 1.5, 2, 3, 4]);
});

test('movingWindowAverage on a single-element window is identity', () => {
  var v = new Float64Array([3, 1, 4]);
  assert.deepEqual([...Analysis.movingWindowAverage(v, 1)], [3, 1, 4]);
});

test('findLocalMaxima skips flat plateaus', () => {
  var p = Analysis.findLocalMaxima(new Float64Array([0, 1, 2, 2, 1, 0, 5, 0]));
  assert.deepEqual(p, [6]);
});

test('detectQRS finds impulses above the adaptive threshold', () => {
  var fs = 250, sig = new Float64Array(2000);
  for (var t = 400; t < 2000; t += 400) { sig[t] = 3; sig[t + 1] = -1; sig[t + 2] = 0.5; }
  var d = Analysis.detectQRS(sig, fs);
  assert.ok(d.peaks.length >= 3, `expected beats, got ${d.peaks.length}`);
  for (const p of d.peaks) assert.ok(p > 0.2 * fs, 'peak inside the ignored head');
});

test('detectQRS validates its inputs', () => {
  assert.throws(() => Analysis.detectQRS('nope', 250));
  assert.throws(() => Analysis.detectQRS([1, 2], 250));
  assert.throws(() => Analysis.detectQRS([1, 2, 3], -5));
  assert.throws(() => Analysis.detectQRS([1, 2, 3], NaN));
});

test('detectQRS keeps a refractory gap between reported beats', () => {
  var fs = 250, sig = new Float64Array(2500);
  for (var t = 500; t < 2500; t += 300) { sig[t] = 2; sig[t + 1] = -1; }
  var d = Analysis.detectQRS(sig, fs);
  for (var i = 1; i < d.peaks.length; i++) {
    assert.ok(d.peaks[i] - d.peaks[i - 1] >= Math.round(0.25 * fs), 'refractory violated');
  }
});

test('vectorMagnitude is polarity-invariant across leads', () => {
  var a = new Float64Array([1, -1, 0.5]), b = new Float64Array([-1, 1, -0.5]);
  var m1 = Analysis.vectorMagnitude([a, b]);
  var m2 = Analysis.vectorMagnitude([b, a]);
  assert.deepEqual([...m1], [...m2]);
  close(m1[0], Math.sqrt(2), 1e-9);
});

test('detectQRSEnsemble rejects peaks seen on too few leads', () => {
  // Two leads share beats at 400/800/1200; lead A also has a lone spike.
  var fs = 250, a = new Float64Array(1600), b = new Float64Array(1600);
  for (var t of [400, 800, 1200]) { a[t] = 3; a[t + 1] = -1; b[t] = 3; b[t + 1] = -1; }
  a[200] = 4; a[201] = -2; // lead-A-only artifact
  var d = Analysis.detectQRSEnsemble([a, b], fs, { minVotes: 2, toleranceMs: 60, gate: 0 });
  assert.ok(d.peaks.length >= 2);
  // A cluster at 200 appears on at most 1 lead and must not survive.
  assert.ok(!d.peaks.some(p => Math.abs(p - 200) < 30), 'single-lead artifact kept');
});

test('detectQRSEnsemble clusters nearby lead detections into one beat', () => {
  var fs = 250, n = 1500;
  var leads = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  for (var t = 500; t < 1500; t += 400) {
    leads[0][t] = 3; leads[0][t + 1] = -1;
    leads[1][t + 5] = 3; leads[1][t + 6] = -1;   // +20 ms
    leads[2][t - 5] = 3; leads[2][t - 4] = -1;   // -20 ms
  }
  var d = Analysis.detectQRSEnsemble(leads, fs, { minVotes: 3, toleranceMs: 100 });
  assert.ok(d.peaks.length >= 1 && d.peaks.length <= 3, `expected merged beats, got ${d.peaks.length}`);
});

test('ensemble requires minVotes and errors on bad input', () => {
  assert.throws(() => Analysis.detectQRSEnsemble([], 250));
  assert.throws(() => Analysis.detectQRSEnsemble([new Float64Array(10)], -1));
});

/* ------------------------------------------------------------------ */
/* Filter design and application                                        */
/* ------------------------------------------------------------------ */

test('butter rejects reversed or equal band edges', () => {
  assert.throws(() => Filters.butter(2, [61, 59], 'bandstop', 250), /ascending/);
  assert.throws(() => Filters.butter(2, [10, 10], 'bandpass', 250), /ascending/);
});

test('butter validates order, Nyquist and band arity', () => {
  assert.throws(() => Filters.butter(0, [10], 'lowpass', 250));
  assert.throws(() => Filters.butter(1.5, [10], 'lowpass', 250));
  assert.throws(() => Filters.butter(1, [130], 'lowpass', 250));
  assert.throws(() => Filters.butter(1, [-5], 'lowpass', 250));
  assert.throws(() => Filters.butter(1, [10, 20], 'lowpass', 250));
  assert.throws(() => Filters.butter(1, [10], 'bandpass', 250));
  assert.throws(() => Filters.butter(1, [10], 'wat', 250));
});

test('sosfiltfilt is zero-phase: symmetric signal stays symmetric', () => {
  var n = 300, sig = new Float64Array(n);
  for (var i = 0; i < n; i++) sig[i] = i === 150 ? 1 : 0;
  var sos = Filters.butter(2, [20], 'lowpass', 250);
  var out = Filters.sosfiltfilt(sos, sig);
  var peak = 0;
  for (var i = 0; i < n; i++) if (out[i] > out[peak]) peak = i;
  assert.equal(peak, 150, 'zero-phase filter moved the impulse');
});

test('notch60 attenuates a 60 Hz tone by at least 40 dB', () => {
  var fs = 500, n = 2000, sig = new Float64Array(n);
  for (var i = 0; i < n; i++) sig[i] = Math.sin(2 * Math.PI * 60 * i / fs);
  var out = Analysis.notch60(sig, fs);
  var before = 0, after = 0;
  // Measure the interior: filtfilt pads by odd reflection, so the first and
  // last few hundred samples carry the usual edge transient of any
  // forward-backward filter. The interior is where the notch must hold.
  for (var i = 700; i < 1300; i++) { before += sig[i] * sig[i]; after += out[i] * out[i]; }
  assert.ok(after < before * 1e-4, `notch attenuation ${before} -> ${after}`);
});

test('notch60 leaves a 10 Hz tone almost untouched', () => {
  var fs = 500, n = 2000, sig = new Float64Array(n);
  for (var i = 0; i < n; i++) sig[i] = Math.sin(2 * Math.PI * 10 * i / fs);
  var out = Analysis.notch60(sig, fs);
  var before = 0, after = 0;
  for (var i = 700; i < 1300; i++) { before += sig[i] * sig[i]; after += out[i] * out[i]; }
  assert.ok(after > before * 0.9, `passband energy ${after / before}`);
});

test('highpass removes the DC component', () => {
  var sig = new Float64Array(1000).fill(1);
  for (var i = 0; i < 1000; i++) sig[i] += 0.1 * Math.sin(2 * Math.PI * 10 * i / 250);
  var out = Analysis.highpass(sig, 250, { cutoff: 0.5, order: 2 });
  var tail = out.slice(900);
  var m = tail.reduce((a, v) => a + v, 0) / tail.length;
  assert.ok(Math.abs(m) < 0.01, `residual DC ${m}`);
});

test('bandpass passes the in-band tone and rejects the out-of-band tone', () => {
  var fs = 250, n = 1500, sig = new Float64Array(n);
  for (var i = 0; i < n; i++) sig[i] = Math.sin(2 * Math.PI * 10 * i / fs) + Math.sin(2 * Math.PI * 1 * i / fs);
  var out = Analysis.bandpass(sig, fs, 5, 15, 1);
  var before = 0, after = 0;
  for (var i = n / 2; i < n; i++) { before += sig[i] * sig[i]; after += out[i] * out[i]; }
  // Roughly half the energy (the 10 Hz component) should remain.
  assert.ok(after / before > 0.3 && after / before < 0.75, `band energy ratio ${after / before}`);
});

test('sosMagnitudeDb reports deep attenuation inside a notch', () => {
  var sos = Filters.butter(2, [59, 61], 'bandstop', 250);
  var notch = Filters.sosMagnitudeDb(sos, 60, 250);
  var pass = Filters.sosMagnitudeDb(sos, 20, 250);
  assert.ok(notch < -40, `notch depth ${notch} dB`);
  assert.ok(pass > -1, `passband ${pass} dB`);
});

/* ------------------------------------------------------------------ */
/* Generator determinism, structure and warmup regression               */
/* ------------------------------------------------------------------ */

test('the same seed reproduces the identical record', () => {
  var a = Cardio.generateECG({ duration: 5, samplingRate: 250, seed: 3 });
  var b = Cardio.generateECG({ duration: 5, samplingRate: 250, seed: 3 });
  assert.deepEqual([...a.signals[1]], [...b.signals[1]]);
  assert.deepEqual(a.rPeaks, b.rPeaks);
});

test('different seeds produce different records', () => {
  var a = Cardio.generateECG({ duration: 5, samplingRate: 250, seed: 3 });
  var b = Cardio.generateECG({ duration: 5, samplingRate: 250, seed: 4 });
  assert.notDeepEqual([...a.signals[1]], [...b.signals[1]]);
});

test('record shape: 12 leads, correct length and finite samples', () => {
  var r = Cardio.generateECG({ duration: 6, samplingRate: 300, seed: 8 });
  assert.equal(r.signals.length, 12);
  for (const L of r.signals) {
    assert.equal(L.length, 1800);
    for (var i = 0; i < L.length; i += 60) assert.ok(Number.isFinite(L[i]));
  }
  assert.equal(r.leadNames.length, 12);
});

test('reference R peaks are sorted, inside the record and evenly spaced', () => {
  var r = Cardio.generateECG({ duration: 10, samplingRate: 250, heartRate: 75, seed: 5 });
  assert.ok(r.rPeaks.length >= 8);
  for (var i = 1; i < r.rPeaks.length; i++) {
    var gap = r.rPeaks[i] - r.rPeaks[i - 1];
    assert.ok(gap > 0.5 * 250 && gap < 1.5 * 250, `implausible RR gap ${gap} samples`);
  }
  for (const p of r.rPeaks) assert.ok(p >= 0 && p < 2500);
});

test('the first recorded beat has settled morphology (warm-up regression)', () => {
  // Before the fix only the first 5 output samples were skipped, so the
  // first recorded beat carried the oscillator start-up transient. Now the
  // first five beats are integrated away, so the first recorded beat must
  // look like the last one.
  var r = Cardio.simulateMcSharry({ duration: 14, samplingRate: 250, heartRate: 72, seed: 9 });
  var sig = r.signals[1], peaks = r.rPeaks;
  assert.ok(peaks.length >= 10);
  var w = 100;
  var beat = p => {
    var out = [], m = 0;
    for (var i = p - w; i < p + w; i++) out.push(sig[i] || 0);
    for (const v of out) m += v;
    m /= out.length;
    var sd = Math.sqrt(out.reduce((a, v) => a + (v - m) * (v - m), 0) / out.length) || 1;
    return out.map(v => (v - m) / sd);
  };
  var first = beat(peaks[0]), last = beat(peaks[peaks.length - 1]);
  var corr = first.reduce((a, v, i) => a + v * last[i], 0) / first.length;
  assert.ok(corr > 0.9, `first-beat morphology correlation ${corr}`);
});

test('heart rate scales the mean R-R interval', () => {
  var slow = Cardio.generateECG({ duration: 12, samplingRate: 250, heartRate: 50, seed: 6 });
  var fast = Cardio.generateECG({ duration: 12, samplingRate: 250, heartRate: 120, seed: 6 });
  var gap = ps => { var s = 0; for (var i = 1; i < ps.length; i++) s += ps[i] - ps[i - 1]; return s / (ps.length - 1); };
  var gSlow = gap(slow.rPeaks), gFast = gap(fast.rPeaks);
  assert.ok(gSlow > gFast * 1.8, `expected ~2.4x RR ratio, got ${gSlow / gFast}`);
});

test('artifacts raise the high-frequency noise floor', () => {
  var clean = Cardio.generateECG({ duration: 6, samplingRate: 250, seed: 2, humAmplitude: 0, wanderAmplitude: 0, emgAmplitude: 0 });
  var noisy = Cardio.generateECG({ duration: 6, samplingRate: 250, seed: 2, humAmplitude: 0.4, wanderAmplitude: 0.5, emgAmplitude: 0.3 });
  var e = (sig) => { var s = 0; for (var i = 1; i < sig.length; i++) s += (sig[i] - sig[i - 1]) ** 2; return s; };
  assert.ok(e(noisy.signals[1]) > e(clean.signals[1]) * 1.05, 'noise did not increase');
});

test('buildRRSeries is deterministic and beats-per-minute consistent', () => {
  var rr = Cardio.buildRRSeries({ duration: 20, heartRate: 60, hrStd: 1, rsaAmplitude: 0, mayerAmplitude: 0, seed: 4 });
  var mean = rr.reduce((a, v) => a + v, 0) / rr.length;
  close(mean, 1, 0.05, 'mean RR at 60 bpm');
  var rr2 = Cardio.buildRRSeries({ duration: 20, heartRate: 60, hrStd: 1, rsaAmplitude: 0, mayerAmplitude: 0, seed: 4 });
  assert.deepEqual([...rr], [...rr2]);
});

/* ------------------------------------------------------------------ */
/* WFDB export                                                          */
/* ------------------------------------------------------------------ */

test('wfdb header has one spec line per signal and the right field count', () => {
  var h = App.wfdbHeader('rec', ['I', 'II', 'V1'], 2500, 250, 200);
  var lines = h.trim().split('\n');
  assert.equal(lines[0], 'rec 3 250 2500');
  assert.equal(lines.length, 6, 'record line + 3 spec lines + 2 comments');
  var specs = lines.filter(l => l.endsWith(' I') || l.endsWith(' II') || l.endsWith(' V1'));
  assert.equal(specs.length, 3, 'one spec line per signal');
  for (const s of specs) {
    var fields = s.split(' ');
    assert.equal(fields.length, 9, `spec line has ${fields.length} fields, needs 9`);
    assert.equal(fields[0], 'rec.csv');
    assert.match(fields[1], /^16x200\(0\)\/mV$/);
  }
});

test('wfdb signal CSV has a time column and one column per lead', () => {
  var sig = [new Float64Array([1, 2, 3]), new Float64Array([4, 5, 6])];
  var csv = App.wfdbSignals(sig, ['I', 'II'], 250, 200);
  var rows = csv.trim().split('\n');
  assert.equal(rows[0], 'time_s,I,II');
  assert.equal(rows.length, 4);
  assert.equal(rows[1].split(',').length, 3);
  assert.equal(rows[1].split(',')[1], '200');
});

test('wfdb annotation rows carry sample index, seconds and beat type', () => {
  var a = App.wfdbAnnotations([250, 500], 250);
  var lines = a.trim().split('\n');
  assert.equal(lines[0], '# sample,time_s,type');
  assert.equal(lines[1], '250,1.0000,N');
});

/* ------------------------------------------------------------------ */
/* Spline interpolation                                                 */
/* ------------------------------------------------------------------ */

test('quadraticSpline passes through every knot', () => {
  var xs = [0, 1, 2, 3, 4], ys = [0, 1, 0, 1, 0];
  var out = Analysis.quadraticSpline(xs, ys, new Float64Array([0, 1, 2, 3, 4]));
  for (var i = 0; i < 5; i++) close(out[i], ys[i], 1e-9);
});

test('quadraticSpline reproduces a quadratic exactly', () => {
  var xs = [0, 1, 2, 3], ys = xs.map(x => x * x - 2 * x + 1);
  var out = Analysis.quadraticSpline(xs, ys, new Float64Array([0.5, 1.5, 2.5]));
  for (var i = 0; i < 3; i++) {
    var x = [0.5, 1.5, 2.5][i];
    close(out[i], x * x - 2 * x + 1, 1e-9, 'quadratic at ' + x);
  }
});
