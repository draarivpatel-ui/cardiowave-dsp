'use strict';
/* Third engine suite: conditioning filter options, Pan-Tompkins stage
   internals, ensemble voting internals, scoring edges, spline edges,
   artifact structure, generator contract, and filter-primitive details. */
const test = require('node:test');
const assert = require('node:assert/strict');
const Filters = require('../src/filters.js');
const Cardio = require('../src/cardio.js');
const Analysis = require('../src/analysis.js');

function close(a, b, tol, msg) {
  assert.ok(Math.abs(a - b) <= tol, `${msg || 'value'}: ${a} vs ${b} (tol ${tol})`);
}
function tone(fs, n, f, amp) {
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = (amp || 1) * Math.sin(2 * Math.PI * f * i / fs);
  return s;
}
function energy(x, lo, hi) {
  let e = 0;
  for (let i = lo; i < hi; i++) e += x[i] * x[i];
  return e;
}
function peaksFromRRI(rriMs, fs) {
  // Build sample indices so that successive differences equal rriMs.
  const peaks = [0];
  let acc = 0;
  for (const ms of rriMs) { acc += ms; peaks.push(Math.round(acc * fs / 1000)); }
  return peaks;
}

/* ------------------------------------------------------------------ */
/* Conditioning filter options                                          */
/* ------------------------------------------------------------------ */

test('notch60 honors a custom centre frequency', () => {
  var fs = 500, n = 3000;
  var sig = tone(fs, n, 50);
  var out = Analysis.notch60(sig, fs, { center: 50, width: 2, order: 2 });
  var before = energy(sig, 1000, 2000), after = energy(out, 1000, 2000);
  assert.ok(after < before * 1e-4, `50 Hz notch: ${before} -> ${after}`);
});

test('notch60 with a wider band attenuates neighbouring frequencies more', () => {
  var fs = 500, n = 3000;
  var sig = tone(fs, n, 58);
  var narrow = Analysis.notch60(sig, fs, { center: 60, width: 2 });
  var wide = Analysis.notch60(sig, fs, { center: 60, width: 8 });
  var eN = energy(narrow, 1000, 2000), eW = energy(wide, 1000, 2000);
  assert.ok(eW < eN, `wide notch ${eW} should beat narrow ${eN} at 58 Hz`);
});

test('highpass with a higher cutoff removes more low-frequency energy', () => {
  var fs = 250, n = 3000;
  var sig = tone(fs, n, 1);
  var lo = Analysis.highpass(sig, fs, { cutoff: 0.5 });
  var hi = Analysis.highpass(sig, fs, { cutoff: 3 });
  var eLo = energy(lo, 1000, 2000), eHi = energy(hi, 1000, 2000);
  assert.ok(eHi < eLo * 0.5, `cutoff 3 Hz ${eHi} vs cutoff 0.5 Hz ${eLo}`);
});

test('highpass preserves a tone well above the cutoff', () => {
  var fs = 250, n = 3000;
  var sig = tone(fs, n, 15);
  var out = Analysis.highpass(sig, fs, { cutoff: 0.5 });
  var before = energy(sig, 500, 2500), after = energy(out, 500, 2500);
  close(after / before, 1, 0.05, 'passband energy ratio');
});

test('bandpass output is causal: it cannot anticipate the input', () => {
  var fs = 250, n = 1000;
  var sig = new Float64Array(n);
  for (var i = 600; i < 800; i++) sig[i] = Math.sin(2 * Math.PI * 10 * (i - 600) / fs);
  var out = Analysis.bandpass(sig, fs, 5, 15, 1);
  assert.ok(energy(out, 0, 300) < 1e-20, 'causal filter produced output before input');
});

test('conditioning filters keep the signal length', () => {
  var sig = tone(250, 777, 8);
  assert.equal(Analysis.bandpass(sig, 250, 5, 15).length, 777);
  assert.equal(Analysis.highpass(sig, 250).length, 777);
  assert.equal(Analysis.notch60(sig, 250).length, 777);
});

test('higher bandpass order steepens the stopband', () => {
  var fs = 250, n = 3000;
  var sig = tone(fs, n, 1);
  var o1 = Analysis.bandpass(sig, fs, 5, 15, 1);
  var o3 = Analysis.bandpass(sig, fs, 5, 15, 3);
  var e1 = energy(o1, 1000, 2000), e3 = energy(o3, 1000, 2000);
  assert.ok(e3 < e1, `order 3 ${e3} should reject 1 Hz better than order 1 ${e1}`);
});

/* ------------------------------------------------------------------ */
/* Pan-Tompkins stage internals                                         */
/* ------------------------------------------------------------------ */

test('detectQRS exposes filtered and integrated stage arrays', () => {
  var rec = Cardio.generateECG({ duration: 6, samplingRate: 250, heartRate: 72, seed: 5, humAmplitude: 0, wanderAmplitude: 0, emgAmplitude: 0 });
  var det = Analysis.detectQRS(rec.signals[1], 250);
  assert.ok(det.filtered instanceof Float64Array);
  assert.ok(det.integrated instanceof Float64Array);
  assert.equal(det.filtered.length, rec.signals[1].length);
  assert.equal(det.integrated.length, rec.signals[1].length);
});

test('detectQRS integrated signal is nonnegative (squaring stage)', () => {
  var rec = Cardio.generateECG({ duration: 6, samplingRate: 250, heartRate: 72, seed: 5 });
  var det = Analysis.detectQRS(rec.signals[1], 250);
  for (const v of det.integrated) assert.ok(v >= 0, 'integrated stage went negative');
});

test('detectQRS reports peaks on an inverted R wave', () => {
  // Squaring makes the detector polarity-blind; an inverted QRS must still
  // be found.
  var rec = Cardio.generateECG({ duration: 8, samplingRate: 250, heartRate: 72, seed: 5, humAmplitude: 0, wanderAmplitude: 0, emgAmplitude: 0 });
  var sig = rec.signals[1];
  var inv = Float64Array.from(sig, v => -v);
  var d1 = Analysis.detectQRS(sig, 250).peaks;
  var d2 = Analysis.detectQRS(inv, 250).peaks;
  assert.ok(Math.abs(d1.length - d2.length) <= 1, `inversion changed beat count ${d1.length} -> ${d2.length}`);
});

test('detectQRS honour a narrow custom band', () => {
  var rec = Cardio.generateECG({ duration: 6, samplingRate: 250, heartRate: 72, seed: 5 });
  var det = Analysis.detectQRS(rec.signals[1], 250, { lowcut: 8, highcut: 20 });
  assert.ok(det.peaks.length > 0);
});

test('detected peaks are increasing sample indices', () => {
  var rec = Cardio.generateECG({ duration: 10, samplingRate: 250, heartRate: 80, seed: 11 });
  var peaks = Analysis.detectQRS(rec.signals[0], 250).peaks;
  for (var i = 1; i < peaks.length; i++) assert.ok(peaks[i] > peaks[i - 1]);
});

/* ------------------------------------------------------------------ */
/* Ensemble detector internals                                          */
/* ------------------------------------------------------------------ */

test('ensemble votes never exceed the lead count and stay positive', () => {
  var rec = Cardio.generateECG({ duration: 8, samplingRate: 250, heartRate: 72, seed: 3 });
  var out = Analysis.detectQRSEnsemble(rec.signals, 250, { minVotes: 3 });
  assert.equal(out.votes.length, out.peaks.length);
  for (const v of out.votes) { assert.ok(v >= 3 && v <= rec.signals.length, 'vote ' + v); }
});

test('ensemble amplitudes are finite and nonnegative', () => {
  var rec = Cardio.generateECG({ duration: 8, samplingRate: 250, heartRate: 72, seed: 3 });
  var out = Analysis.detectQRSEnsemble(rec.signals, 250);
  assert.equal(out.amplitudes.length, out.peaks.length);
  for (const a of out.amplitudes) assert.ok(Number.isFinite(a) && a >= 0);
});

test('ensemble detections array reports one single-lead result per lead', () => {
  var rec = Cardio.generateECG({ duration: 8, samplingRate: 250, heartRate: 72, seed: 3 });
  var out = Analysis.detectQRSEnsemble(rec.signals.slice(0, 4), 250);
  assert.equal(out.detections.length, 4);
  for (const d of out.detections) assert.ok(Array.isArray(d.peaks) || d.peaks.length >= 0);
});

test('ensemble with minVotes equal to lead count keeps only universal beats', () => {
  var rec = Cardio.generateECG({ duration: 8, samplingRate: 250, heartRate: 72, seed: 3 });
  var out = Analysis.detectQRSEnsemble(rec.signals, 250, { minVotes: 12 });
  for (const v of out.votes) assert.equal(v, 12);
});

test('ensemble refinement keeps peaks inside the record bounds', () => {
  var rec = Cardio.generateECG({ duration: 8, samplingRate: 250, heartRate: 72, seed: 3 });
  var n = rec.signals[0].length;
  var out = Analysis.detectQRSEnsemble(rec.signals, 250, { refineMs: 60 });
  for (const p of out.peaks) { assert.ok(p >= 0 && p < n, 'peak ' + p + ' outside [0,' + n + ')'); }
});

/* ------------------------------------------------------------------ */
/* Scoring edges                                                        */
/* ------------------------------------------------------------------ */

test('scoreDetection tolerates detections before the first reference', () => {
  var s = Analysis.scoreDetection([10, 1000], [1000, 2000], 1000, 50);
  assert.equal(s.truePositives, 1);
  assert.equal(s.falsePositives, 1);
  assert.equal(s.falseNegatives, 1);
});

test('scoreDetection at exactly the tolerance boundary still counts a match', () => {
  // tolerance 50 ms at 1000 Hz = 50 samples.
  var s = Analysis.scoreDetection([1050], [1000], 1000, 50);
  assert.equal(s.truePositives, 1);
});

test('scoreDetection just beyond tolerance is a miss', () => {
  var s = Analysis.scoreDetection([1051], [1000], 1000, 50);
  assert.equal(s.truePositives, 0);
  assert.equal(s.falsePositives, 1);
});

test('scoreDetection prefers the closest free reference, not the first one', () => {
  var s = Analysis.scoreDetection([990, 1010], [1000, 1030], 1000, 40);
  assert.equal(s.truePositives, 2);
  assert.equal(s.f1, 1);
});

test('scoreDetection f1 is harmonic mean of sensitivity and precision', () => {
  var s = Analysis.scoreDetection([100, 200, 999], [100, 200, 300, 400], 1000, 30);
  var se = 2 / 4, pp = 2 / 3;
  close(s.sensitivity, se, 1e-9);
  close(s.positivePredictivity, pp, 1e-9);
  close(s.f1, 2 * se * pp / (se + pp), 1e-9, 'f1');
});

test('scoreDetection with no detections gives sensitivity 0', () => {
  var s = Analysis.scoreDetection([], [100, 200], 1000, 50);
  assert.equal(s.sensitivity, 0);
  assert.equal(s.falseNegatives, 2);
});

/* ------------------------------------------------------------------ */
/* Spline and spectral helpers                                          */
/* ------------------------------------------------------------------ */

test('quadraticSpline with fewer than 3 knots returns the first value', () => {
  var out = Analysis.quadraticSpline([1, 2], [10, 20], [0, 1.5, 3]);
  assert.deepEqual(Array.from(out), [10, 10, 10]);
});

test('quadraticSpline preserves values at repeated query of every knot', () => {
  var x = [0, 1, 2, 3, 4, 5];
  var y = x.map(v => Math.sin(v));
  var out = Analysis.quadraticSpline(x, y, x);
  for (var i = 0; i < x.length; i++) close(out[i], y[i], 1e-6, 'knot ' + i);
});

test('quadraticSpline stays finite outside the knot range', () => {
  var x = [0, 1, 2, 3, 4];
  var y = [0, 1, 4, 9, 16];
  var out = Analysis.quadraticSpline(x, y, [-2, -1, 5, 8]);
  for (const v of out) assert.ok(Number.isFinite(v));
});

test('bandPower over a zero-width band is bounded by a bin', () => {
  var psd = { frequency: new Float64Array([0, 1, 2, 3]), power: new Float64Array([1, 2, 3, 4]) };
  var p = Analysis.bandPower(psd, 1, 1);
  assert.ok(p >= 0 && Number.isFinite(p));
});

test('bandPower outside the frequency axis is zero', () => {
  var psd = { frequency: new Float64Array([0, 1, 2]), power: new Float64Array([1, 1, 1]) };
  assert.equal(Analysis.bandPower(psd, 10, 20), 0);
});

test('welchPsd frequency axis starts at DC and stays below Nyquist', () => {
  var psd = Analysis.welchPsd(tone(100, 512, 10), 100, 128, 128);
  assert.equal(psd.frequency[0], 0);
  var last = psd.frequency[psd.frequency.length - 1];
  assert.ok(last <= 50 + 1e-9, 'last bin ' + last + ' above Nyquist');
});

test('welchPsd power is never negative', () => {
  var rng = 12345;
  var sig = new Float64Array(300);
  for (var i = 0; i < sig.length; i++) { rng = (rng * 1103515245 + 12345) % 2147483648; sig[i] = rng / 2147483648 - 0.5; }
  var psd = Analysis.welchPsd(sig, 100, 64, 64);
  for (const v of psd.power) assert.ok(v >= 0 && Number.isFinite(v));
});

/* ------------------------------------------------------------------ */
/* computeHRV combined surface                                          */
/* ------------------------------------------------------------------ */

test('computeHRV rri and rrTimes describe the same intervals', () => {
  var peaks = peaksFromRRI([800, 850, 780, 820], 500);
  var h = Analysis.computeHRV(peaks, 500);
  assert.equal(h.rri.length, 4);
  assert.equal(h.rrTimes.length, 4);
  for (var i = 1; i < h.rrTimes.length; i++) {
    close((h.rrTimes[i] - h.rrTimes[i - 1]) * 1000, h.rri[i], 2, 'interval ' + i);
  }
});

test('computeHRV lfHf equals lf/hf when hf is nonzero', () => {
  var peaks = [0], acc = 0;
  for (var i = 0; i < 200; i++) { acc += 0.8 + 0.08 * Math.sin(2 * Math.PI * 0.1 * acc); peaks.push(Math.round(acc * 100)); }
  var h = Analysis.computeHRV(peaks, 100);
  if (h.hf > 0) close(h.lfHf, h.lf / h.hf, 1e-6, 'lfHf');
  assert.ok(h.lfNormalized + h.hfNormalized <= 100.5);
});

test('computeHRV on a real record produces plausible resting metrics', () => {
  var rec = Cardio.generateECG({ duration: 20, samplingRate: 250, heartRate: 65, seed: 21, humAmplitude: 0.02, wanderAmplitude: 0.05, emgAmplitude: 0.01 });
  var h = Analysis.computeHRV(rec.rPeaks, 250);
  assert.ok(h.meanNN > 700 && h.meanNN < 1100, 'meanNN ' + h.meanNN);
  assert.ok(h.sdnn >= 0 && h.rmssd >= 0 && h.pnn50 >= 0 && h.pnn50 <= 100);
});

/* ------------------------------------------------------------------ */
/* Artifact structure                                                   */
/* ------------------------------------------------------------------ */

test('hum artifact adds a measurable 60 Hz component', () => {
  var quiet = Cardio.generateECG({ duration: 8, samplingRate: 500, heartRate: 70, seed: 4, humAmplitude: 0, wanderAmplitude: 0, emgAmplitude: 0 });
  var hummed = Cardio.generateECG({ duration: 8, samplingRate: 500, heartRate: 70, seed: 4, humAmplitude: 0.4, wanderAmplitude: 0, emgAmplitude: 0 });
  var diff = Float64Array.from(hummed.signals[1], (v, i) => v - quiet.signals[1][i]);
  var psd = Analysis.welchPsd(diff, 500, 1024, 2048);
  var pk = 1;
  for (var b = 2; b < psd.power.length; b++) if (psd.power[b] > psd.power[pk]) pk = b;
  assert.ok(Math.abs(psd.frequency[pk] - 60) < 5, 'hum peak at ' + psd.frequency[pk] + ' Hz');
});

test('wander artifact adds low-frequency content', () => {
  var quiet = Cardio.generateECG({ duration: 8, samplingRate: 250, heartRate: 70, seed: 4, humAmplitude: 0, wanderAmplitude: 0, emgAmplitude: 0 });
  var wandered = Cardio.generateECG({ duration: 8, samplingRate: 250, heartRate: 70, seed: 4, humAmplitude: 0, wanderAmplitude: 0.8, emgAmplitude: 0 });
  var diff = Float64Array.from(wandered.signals[1], (v, i) => v - quiet.signals[1][i]);
  var psd = Analysis.welchPsd(diff, 250, 512, 1024);
  var pk = 1;
  for (var b = 2; b < psd.power.length; b++) if (psd.power[b] > psd.power[pk]) pk = b;
  assert.ok(psd.frequency[pk] < 1.5, 'wander peak at ' + psd.frequency[pk] + ' Hz');
});

test('EMG artifact adds broadband high-frequency noise (aliasing regression)', () => {
  // Before the fix the EMG band frequencies were passed to bandNoise in
  // hertz against a per-sample index, so every whole-number component
  // aliased to sin(2*pi*k*i) == 0 and the EMG channel was silent.
  var quiet = Cardio.generateECG({ duration: 6, samplingRate: 250, heartRate: 70, seed: 4, humAmplitude: 0, wanderAmplitude: 0, emgAmplitude: 0 });
  var noisy = Cardio.generateECG({ duration: 6, samplingRate: 250, heartRate: 70, seed: 4, humAmplitude: 0, wanderAmplitude: 0, emgAmplitude: 0.3, emgBandwidth: 60 });
  var diff = Float64Array.from(noisy.signals[1], (v, i) => v - quiet.signals[1][i]);
  var rms = Math.sqrt(diff.reduce((a, v) => a + v * v, 0) / diff.length);
  assert.ok(rms > 0.01, 'EMG diff rms ' + rms + ' should be well above zero');
  var psd = Analysis.welchPsd(diff, 250, 512, 1024);
  var lo = Analysis.bandPower(psd, 0, 10), hi = Analysis.bandPower(psd, 20, 60);
  assert.ok(hi > lo, 'EMG noise should live above 20 Hz: lo ' + lo + ' hi ' + hi);
});

test('all-zero artifact amplitudes leave the morphology channel untouched', () => {
  var a = Cardio.generateECG({ duration: 6, samplingRate: 250, heartRate: 72, seed: 8, humAmplitude: 0, wanderAmplitude: 0, emgAmplitude: 0 });
  var b = Cardio.generateECG({ duration: 6, samplingRate: 250, heartRate: 72, seed: 8, humAmplitude: 0, wanderAmplitude: 0, emgAmplitude: 0 });
  assert.deepEqual(Array.from(a.signals[1]), Array.from(b.signals[1]));
});

/* ------------------------------------------------------------------ */
/* Generator contract                                                   */
/* ------------------------------------------------------------------ */

test('generateECG sample count equals duration times sampling rate', () => {
  for (const [dur, fs] of [[5, 250], [7, 500], [3, 125]]) {
    var rec = Cardio.generateECG({ duration: dur, samplingRate: fs, heartRate: 70, seed: 2 });
    assert.equal(rec.signals[0].length, dur * fs, `${dur}s@${fs}`);
  }
});

test('generateECG returns 12 named leads', () => {
  var rec = Cardio.generateECG({ duration: 3, samplingRate: 250, seed: 2 });
  assert.equal(rec.signals.length, 12);
  assert.equal(Cardio.LEAD_NAMES.length, 12);
});

test('rPeaksByLead has an entry for every lead', () => {
  var rec = Cardio.simulateMcSharry({ duration: 6, samplingRate: 250, seed: 2 });
  assert.equal(rec.rPeaksByLead.length, 12);
  for (const list of rec.rPeaksByLead) assert.ok(list.length > 0);
});

test('buildRRSeries mean matches the requested heart rate', () => {
  var rr = Cardio.buildRRSeries({ duration: 30, heartRate: 80, hrStd: 0, rsaAmplitude: 0, mayerAmplitude: 0, seed: 1 });
  var m = rr.reduce((a, v) => a + v) / rr.length;
  close(m, 60 / 80, 0.02, 'mean RR');
});

test('buildRRSeries clamps intervals at the physiological floor', () => {
  var rr = Cardio.buildRRSeries({ duration: 10, heartRate: 240, hrStd: 20, rsaAmplitude: 500, mayerAmplitude: 500, seed: 1 });
  for (const v of rr) assert.ok(v >= 0.2, 'interval ' + v + ' below 200 ms floor');
});

test('LEAD_GAMMA rows cover every lead and stage', () => {
  assert.equal(Cardio.LEAD_GAMMA.length, 12);
  for (const row of Cardio.LEAD_GAMMA) assert.ok(row.length >= 5, 'row ' + row);
});

/* ------------------------------------------------------------------ */
/* Filter primitives                                                    */
/* ------------------------------------------------------------------ */

test('sosfiltZi returns one 2-tap state per section', () => {
  var sos = Filters.butter(2, [5, 15], 'bandpass', 250);
  var zi = Filters.sosfiltZi(sos);
  assert.equal(zi.length, sos.length);
  for (const s of zi) {
    assert.equal(s.length, 2, 'section state must be a 2-tap vector');
    for (const v of s) assert.ok(Number.isFinite(v), 'non-finite zi entry');
  }
});

test('sosfilt with the step steady state reproduces a constant input', () => {
  // Filtering a constant signal with zi scaled by that constant must
  // return the constant: the section is at steady state.
  var sos = Filters.butter(1, 5, 'lowpass', 250);
  var zi = Filters.sosfiltZi(sos).map(function (s) { return [s[0] * 3, s[1] * 3]; });
  var out = Filters.sosfilt(sos, new Float64Array(64).fill(3), zi);
  for (const v of out) close(v, 3, 1e-9, 'steady state');
});

test('sosfiltfilt output length equals the input length', () => {
  var sos = Filters.butter(2, 0.5, 'highpass', 250);
  var x = tone(250, 1500, 5);
  var y = Filters.sosfiltfilt(sos, x);
  assert.equal(y.length, x.length);
});

test('sosMagnitudeDb of a lowpass is ~0 dB at DC and deep at Nyquist', () => {
  var sos = Filters.butter(3, 10, 'lowpass', 250);
  assert.ok(Math.abs(Filters.sosMagnitudeDb(sos, 0.01, 250)) < 0.5, 'DC gain');
  assert.ok(Filters.sosMagnitudeDb(sos, 124, 250) < -40, 'Nyquist gain');
});

test('butter lowpass at a trivial cutoff stays finite', () => {
  var sos = Filters.butter(1, 1, 'lowpass', 250);
  var out = Filters.sosfilt(sos, tone(250, 200, 0.5));
  for (const v of out) assert.ok(Number.isFinite(v));
});

test('zpk2sos gain reproduces the DC gain of a lowpass', () => {
  var sos = Filters.butter(2, 20, 'lowpass', 250);
  // DC gain of the digital filter is H(z=1) = sum(b)/sum(a) per section.
  var gain = 1;
  for (const row of sos) {
    gain *= (row[0] + row[1] + row[2]) / (row[3] + row[4] + row[5]);
  }
  close(gain, 1, 1e-3, 'lowpass DC gain');
});

test('movingWindowAverage with window larger than the signal averages the prefix', () => {
  var out = Analysis.movingWindowAverage(new Float64Array([2, 4, 6]), 10);
  assert.deepEqual(Array.from(out), [2, 3, 4]);
});

test('findLocalMaxima never reports the endpoints', () => {
  var peaks = Analysis.findLocalMaxima([5, 1, 1, 1, 1, 9]);
  assert.deepEqual(peaks, []);
});

test('findLocalMaxima on a monotone sequence finds nothing', () => {
  assert.deepEqual(Analysis.findLocalMaxima([1, 2, 3, 4, 5]), []);
  assert.deepEqual(Analysis.findLocalMaxima([5, 4, 3, 2, 1]), []);
});
