/*
 * CardioWave DSP / deterministic rhythm and artefact analysis.
 *
 * A rule-based, fully interpretable classifier over detected R-R intervals:
 * sinus rate bands, compensatory-pause ectopy detection, and a dispersion
 * plus sample-entropy test for irregularly irregular rhythms. Artefact
 * meters are a Goertzel powerline-hum measurement and a low-frequency
 * baseline-wander RMS measurement. The module also ships the annotated
 * synthetic strip generator and the scoring harness used by the in-page
 * benchmark panel, so every claim the UI makes is reproducible.
 *
 * For education and research only. Not a medical device and not for diagnosis.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory(require('./analysis.js'), require('./filters.js'));
  } else if (typeof define === 'function' && define.amd) {
    define(['./analysis.js', './filters.js'], factory);
  } else {
    root.CardioWaveRhythm = factory(root.CardioWaveAnalysis, root.CardioWaveFilters);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Analysis, Filters) {
  'use strict';

  var SQRT2 = Math.sqrt(2);
  var INV_SQRT2 = 1 / SQRT2;

  function mean(values) {
    if (!values.length) return 0;
    var total = 0;
    for (var i = 0; i < values.length; i++) total += values[i];
    return total / values.length;
  }

  function stddev(values) {
    var n = values.length;
    if (n < 2) return 0;
    var m = mean(values);
    var acc = 0;
    for (var i = 0; i < n; i++) {
      var d = values[i] - m;
      acc += d * d;
    }
    return Math.sqrt(acc / (n - 1));
  }

  function median(values) {
    if (!values.length) return 0;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /* Deterministic 32-bit PRNG (mulberry32), same construction as the
     generator module so strips share its noise family. */
  function makeRandom(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeGaussian(random) {
    var spare = null;
    return function () {
      if (spare !== null) {
        var s = spare;
        spare = null;
        return s;
      }
      var u = 0, v = 0, s = 0;
      do {
        u = random() * 2 - 1;
        v = random() * 2 - 1;
        s = u * u + v * v;
      } while (s === 0 || s >= 1);
      var factor = Math.sqrt((-2 * Math.log(s)) / s);
      spare = v * factor;
      return u * factor;
    };
  }

  /* ------------------------------------------------------------------ */
  /* Rhythm labels                                                       */
  /* ------------------------------------------------------------------ */

  var CLASS_KEYS = ['normal', 'bradycardia', 'tachycardia', 'irregular', 'ectopic', 'artifact'];

  var CLASS_LABELS = {
    normal: 'Normal sinus rhythm',
    bradycardia: 'Sinus bradycardia',
    tachycardia: 'Sinus tachycardia',
    irregular: 'Irregularly irregular (AFib-like)',
    ectopic: 'Premature ectopic beats (PVC-like)',
    artifact: 'Signal artefact',
    insufficient: 'Insufficient beats'
  };

  /* ------------------------------------------------------------------ */
  /* R-R feature extraction                                              */
  /* ------------------------------------------------------------------ */

  /* Sample entropy of the R-R series (m = 2, r = 0.2 * SD by default).

     SampEn measures the conditional probability that two similar
     templates of length m stay similar at length m + 1. It is high for
     irregularly irregular rhythms and low for organised variability such
     as respiratory sinus arrhythmia, which is what separates the AFib
     class from ordinary high-HRV records. Returns 0 for degenerate
     inputs so callers never see NaN or Infinity. */
  function sampleEntropy(series, m, r) {
    var n = series.length;
    var mm = m === undefined ? 2 : m;
    var radius = r === undefined ? 0.2 * stddev(series) : r;
    if (n < mm + 2 || radius === 0) return 0;

    function countMatches(len) {
      var count = 0;
      var limit = n - len;
      for (var i = 0; i < limit; i++) {
        for (var j = i + 1; j <= limit; j++) {
          var match = true;
          for (var k = 0; k < len; k++) {
            if (Math.abs(series[i + k] - series[j + k]) >= radius) {
              match = false;
              break;
            }
          }
          if (match) count++;
        }
      }
      return count;
    }

    var b = countMatches(mm);
    var a = countMatches(mm + 1);
    if (b === 0) return 0;
    /* An empty A set means no template pair survives an extra beat: the
       series is as irregular as the data allows. Report a finite ceiling
       instead of Infinity so metrics tables stay numeric. */
    if (a === 0) return -Math.log(1 / (b + 1));
    return -Math.log(a / b);
  }

  /* Indices of premature R-R intervals that form a compensatory pause
     pair: a short cycle immediately followed by a long one whose sum is
     roughly two normal cycles. This is the textbook signature of a
     premature ventricular contraction with full compensation. */
  function ectopyIndices(rrMs, options) {
    var opts = options || {};
    var med = median(rrMs);
    if (!med) return [];
    var shortFactor = opts.shortFactor === undefined ? 0.85 : opts.shortFactor;
    var longFactor = opts.longFactor === undefined ? 1.15 : opts.longFactor;
    var sumLo = opts.sumLo === undefined ? 1.7 : opts.sumLo;
    var sumHi = opts.sumHi === undefined ? 2.3 : opts.sumHi;
    var out = [];
    for (var i = 0; i + 1 < rrMs.length; i++) {
      if (rrMs[i] < shortFactor * med && rrMs[i + 1] > longFactor * med) {
        var pair = rrMs[i] + rrMs[i + 1];
        if (pair > sumLo * med && pair < sumHi * med) out.push(i);
      }
    }
    return out;
  }

  /* The full feature set the classifier reasons over. Everything is
     derived from the R-R interval list alone so the classifier works on
     detected peaks, ground truth peaks, or hand-authored strips. */
  function rrFeatures(rrMs) {
    var n = rrMs.length;
    if (!n) {
      return {
        n: 0, meanNN: 0, bpm: 0, sdnn: 0, rmssd: 0, cv: 0, pnn50: 0,
        sd1: 0, sd2: 0, sd1sd2: 0, sampEn: 0, irregularIndex: 0,
        ectopyCount: 0, ectopy: []
      };
    }
    var meanNN = mean(rrMs);
    var diffs = [];
    for (var i = 1; i < n; i++) diffs.push(rrMs[i] - rrMs[i - 1]);
    var sdnn = stddev(rrMs);
    var rmssd = 0;
    var over50 = 0;
    for (var d = 0; d < diffs.length; d++) {
      rmssd += diffs[d] * diffs[d];
      if (Math.abs(diffs[d]) > 50) over50++;
    }
    rmssd = diffs.length ? Math.sqrt(rmssd / diffs.length) : 0;

    var x1 = [], x2 = [];
    for (var p = 0; p + 1 < n; p++) {
      x1.push((rrMs[p] - rrMs[p + 1]) * INV_SQRT2);
      x2.push((rrMs[p] + rrMs[p + 1]) * INV_SQRT2);
    }
    var sd1 = stddev(x1);
    var sd2 = stddev(x2);

    var jumps = 0;
    for (var j = 0; j < diffs.length; j++) {
      if (Math.abs(diffs[j]) > 0.11 * meanNN) jumps++;
    }
    var ect = ectopyIndices(rrMs);

    return {
      n: n,
      meanNN: meanNN,
      bpm: meanNN > 0 ? 60000 / meanNN : 0,
      sdnn: sdnn,
      rmssd: rmssd,
      cv: meanNN > 0 ? sdnn / meanNN : 0,
      pnn50: diffs.length ? over50 / diffs.length * 100 : 0,
      sd1: sd1,
      sd2: sd2,
      sd1sd2: sd2 > 0 ? sd1 / sd2 : 0,
      sampEn: sampleEntropy(rrMs),
      irregularIndex: diffs.length ? jumps / diffs.length : 0,
      ectopyCount: ect.length,
      ectopy: ect
    };
  }

  /* ------------------------------------------------------------------ */
  /* Poincare geometry                                                   */
  /* ------------------------------------------------------------------ */

  /* Parameters of the SD1/SD2 ellipse for the Poincare plot. The centre
     sits at (mean RR_n, mean RR_n+1); SD2 is the semi-axis along the
     identity line, SD1 the semi-axis perpendicular to it. */
  function poincareEllipse(rrMs) {
    var n = rrMs.length;
    if (n < 3) {
      return { cx: 0, cy: 0, sd1: 0, sd2: 0, sd1sd2: 0, u2x: INV_SQRT2, u2y: INV_SQRT2, u1x: -INV_SQRT2, u1y: INV_SQRT2 };
    }
    var xs = rrMs.slice(0, n - 1);
    var ys = rrMs.slice(1, n);
    var f = rrFeatures(rrMs);
    return {
      cx: mean(xs),
      cy: mean(ys),
      sd1: f.sd1,
      sd2: f.sd2,
      sd1sd2: f.sd1sd2,
      u2x: INV_SQRT2, u2y: INV_SQRT2,
      u1x: -INV_SQRT2, u1y: INV_SQRT2
    };
  }

  /* ------------------------------------------------------------------ */
  /* Rule-based rhythm classification                                    */
  /* ------------------------------------------------------------------ */

  /* Classifies an R-R interval series into one deterministic rhythm
     label. Rules are ordered from the most specific pattern
     (compensatory-pause ectopy) to the rate bands, and every decision
     reports the measured quantities that produced it. */
  function classifyRhythm(rrMs, options) {
    var opts = options || {};
    var f = rrFeatures(rrMs);
    var reasons = [];
    var key;

    if (f.n < 3) {
      return {
        key: 'insufficient', label: CLASS_LABELS.insufficient, bpm: f.bpm,
        features: f, reasons: ['only ' + f.n + ' R-R intervals detected']
      };
    }

    var ectopyLimit = opts.minEctopy === undefined ? 2 : opts.minEctopy;
    if (f.ectopyCount >= ectopyLimit && f.cv < 0.45) {
      key = 'ectopic';
      reasons.push(f.ectopyCount + ' compensatory-pause cycles (short RR below ' +
        '0.85x median then pause above 1.15x, pair summing near 2x)');
      reasons.push('baseline rhythm between ectopy events is organised: CV ' + f.cv.toFixed(3));
    } else if (f.cv >= 0.14 && (f.sampEn >= 0.9 || f.irregularIndex >= 0.4)) {
      key = 'irregular';
      reasons.push('RR dispersion CV ' + f.cv.toFixed(3) + ' with SampEn ' +
        f.sampEn.toFixed(2) + ' and jump index ' + f.irregularIndex.toFixed(2));
      reasons.push('variability lacks the organised pattern of respiratory sinus arrhythmia');
    } else if (f.bpm < 60) {
      key = 'bradycardia';
      reasons.push('mean rate ' + f.bpm.toFixed(1) + ' bpm is below the 60 bpm threshold');
    } else if (f.bpm > 100) {
      key = 'tachycardia';
      reasons.push('mean rate ' + f.bpm.toFixed(1) + ' bpm is above the 100 bpm threshold');
    } else {
      key = 'normal';
      reasons.push('mean rate ' + f.bpm.toFixed(1) + ' bpm inside the 60 to 100 band');
      reasons.push('regularity metrics within sinus limits: CV ' + f.cv.toFixed(3) +
        ', SampEn ' + f.sampEn.toFixed(2));
    }
    if (f.ectopyCount > 0 && key !== 'ectopic') {
      reasons.push(f.ectopyCount + ' isolated premature cycle(s) below the ectopy call threshold');
    }
    return { key: key, label: CLASS_LABELS[key], bpm: f.bpm, features: f, reasons: reasons };
  }

  /* ------------------------------------------------------------------ */
  /* Artefact meters                                                     */
  /* ------------------------------------------------------------------ */

  /* Single-frequency amplitude via the matched-filter form of the
     Goertzel result: the least-squares sine/cosine projection of the
     whole record at exactly f hertz. */
  function toneAmplitude(x, freq, fs) {
    var w = 2 * Math.PI * freq / fs;
    var re = 0, im = 0;
    for (var i = 0; i < x.length; i++) {
      re += x[i] * Math.cos(w * i);
      im += x[i] * Math.sin(w * i);
    }
    return 2 / x.length * Math.sqrt(re * re + im * im);
  }

  /* Measures 60 Hz mains hum (plus its 120 Hz harmonic) and baseline
     wander, and flags them against conservative millivolt thresholds.
     The flags drive the artefact class in the benchmark and the warning
     chips in the UI; the raw amplitudes are always reported so the
     thresholds stay transparent. */
  function analyzeArtifacts(signal, fs, options) {
    var opts = options || {};
    var humThreshold = opts.humThreshold === undefined ? 0.10 : opts.humThreshold;
    var wanderThreshold = opts.wanderThreshold === undefined ? 0.15 : opts.wanderThreshold;

    var hum60 = toneAmplitude(signal, 60, fs);
    var hum120 = toneAmplitude(signal, 120, fs);
    var wanderMv = 0;
    if (signal.length > 64) {
      var sos = Filters.butter(2, [0.8], 'lowpass', fs);
      var baseline = Filters.sosfiltfilt(sos, signal);
      var dc = mean(baseline);
      var acc = 0;
      for (var i = 0; i < baseline.length; i++) {
        var centred = baseline[i] - dc;
        acc += centred * centred;
      }
      wanderMv = Math.sqrt(acc / baseline.length);
    }
    var humMv = Math.max(hum60, hum120);
    var flags = [];
    if (humMv > humThreshold) flags.push('powerline');
    if (wanderMv > wanderThreshold) flags.push('wander');
    return {
      humMv: hum60,
      hum120Mv: hum120,
      wanderMv: wanderMv,
      humFlag: humMv > humThreshold,
      wanderFlag: wanderMv > wanderThreshold,
      flags: flags
    };
  }

  /* ------------------------------------------------------------------ */
  /* Annotated synthetic strip generator                                 */
  /* ------------------------------------------------------------------ */

  /* Gaussian-bump PQRST template for one beat, lead II morphology.
     Returns the sample array and the index of the R extremum inside it. */
  function beatTemplate(fs) {
    var comps = [
      [-0.190, 0.12, 0.030],
      [-0.032, -0.06, 0.009],
      [0, 1.05, 0.011],
      [0.038, -0.18, 0.011],
      [0.300, 0.28, 0.055]
    ];
    var pre = 0.42, post = 0.62;
    var len = Math.round((pre + post) * fs) + 1;
    var rIndex = Math.round(pre * fs);
    var out = new Float64Array(len);
    for (var c = 0; c < comps.length; c++) {
      var t0 = comps[c][0], amp = comps[c][1], w = comps[c][2];
      for (var i = 0; i < len; i++) {
        var x = (i / fs - pre) - t0;
        out[i] += amp * Math.exp(-0.5 * (x / w) * (x / w));
      }
    }
    return { data: out, rIndex: rIndex };
  }

  /* Mean RR per strip type in milliseconds. hum and wander strips carry
     a normal underlying rhythm; their artefact lives in the signal. */
  var STRIP_MEAN_MS = {
    normal: 833.3,
    bradycardia: 1250,
    tachycardia: 468.75,
    irregular: 800,
    ectopic: 833.3,
    hum: 833.3,
    wander: 833.3
  };

  var STRIP_CLASS = {
    normal: 'normal',
    bradycardia: 'bradycardia',
    tachycardia: 'tachycardia',
    irregular: 'irregular',
    ectopic: 'ectopic',
    hum: 'artifact',
    wander: 'artifact'
  };

  /* Builds an annotated single-lead strip with a ground-truth rhythm
     label, true R-peak sample indices and the true R-R series. Every
     strip is seeded so the benchmark reproduces identically on every run.

     Types: 'normal', 'bradycardia', 'tachycardia', 'irregular',
     'ectopic', 'hum' (normal rhythm plus 60 Hz mains hum) and 'wander'
     (normal rhythm plus baseline drift). */
  function synthesizeStrip(options) {
    var opts = options || {};
    var type = opts.type || 'normal';
    var fs = opts.samplingRate || 250;
    var duration = opts.duration || 16;
    var seed = (opts.seed === undefined ? 1 : opts.seed) >>> 0;
    var noise = opts.noise === undefined ? 0.006 : opts.noise;
    var humMv = opts.humMv === undefined ? (type === 'hum' ? 0.30 : 0) : opts.humMv;
    var wanderMv = opts.wanderMv === undefined ? (type === 'wander' ? 0.45 : 0) : opts.wanderMv;
    var meanMs = STRIP_MEAN_MS[type] || STRIP_MEAN_MS.normal;

    var random = makeRandom(seed + 101);
    var gauss = makeGaussian(random);

    /* Build the beat R positions from the interval model for the class.
       Irregular strips use independent uniform jitter around the mean,
       which is the irregularly irregular pattern the entropy test keys
       on. Ectopic strips inject a premature interval every fifth beat
       followed by a fully compensatory pause. */
    var rrMs = [];
    var positions = [];
    var posMs = 400;
    var respPeriodBeats = 4000 / meanMs;
    var beatIndex = 0;
    var pauseNext = false;
    positions.push(Math.round(posMs * fs / 1000));
    while (posMs < duration * 1000 - 700) {
      var r;
      if (type === 'irregular') {
        r = meanMs * (1 + (random() * 2 - 1) * 0.30) + gauss() * meanMs * 0.03;
        if (r < 380) r = 380;
      } else {
        r = meanMs * (1 + gauss() * 0.012) + 16 * Math.sin(2 * Math.PI * beatIndex / respPeriodBeats);
        if (type === 'ectopic') {
          if (pauseNext) {
            r = 2 * meanMs - rrMs[rrMs.length - 1];
            pauseNext = false;
          } else if (beatIndex % 5 === 3) {
            r = 0.55 * meanMs;
            pauseNext = true;
          }
        }
      }
      rrMs.push(r);
      posMs += r;
      if (posMs < duration * 1000 - 650) positions.push(Math.round(posMs * fs / 1000));
      beatIndex++;
    }

    var n = Math.round(duration * fs);
    var signal = new Float64Array(n);
    var tpl = beatTemplate(fs);
    for (var p = 0; p < positions.length; p++) {
      var start = positions[p] - tpl.rIndex;
      for (var i = 0; i < tpl.data.length; i++) {
        var idx = start + i;
        if (idx >= 0 && idx < n) signal[idx] += tpl.data[i];
      }
    }

    var humPhase = random() * 2 * Math.PI;
    var humHarm = random() * 2 * Math.PI;
    var wanderPhase = random() * 2 * Math.PI;
    for (var s = 0; s < n; s++) {
      var t = s / fs;
      var v = signal[s] + gauss() * noise;
      if (humMv > 0) {
        v += humMv * Math.sin(2 * Math.PI * 60 * t + humPhase) +
          0.3 * humMv * Math.sin(2 * Math.PI * 120 * t + humHarm);
      }
      if (wanderMv > 0) {
        v += wanderMv * Math.sin(2 * Math.PI * 0.33 * t + wanderPhase) +
          0.4 * wanderMv * Math.sin(2 * Math.PI * 0.11 * t + wanderPhase / 3);
      }
      signal[s] = v;
    }

    /* The true interval series comes back from the placed sample
       positions, which is the ground truth a detector is scored on. */
    var rrTrue = Analysis.rrIntervals(positions, fs);
    return {
      signal: signal,
      fs: fs,
      duration: duration,
      type: type,
      seed: seed,
      peaks: positions,
      rrMs: rrTrue,
      trueBpm: rrTrue.length ? 60000 / mean(rrTrue) : 0,
      trueClass: STRIP_CLASS[type] || 'normal',
      noise: noise,
      humMv: humMv,
      wanderMv: wanderMv
    };
  }

  /* ------------------------------------------------------------------ */
  /* End-to-end strip scoring                                            */
  /* ------------------------------------------------------------------ */

  /* The deterministic annotated strip set the benchmark panel runs.
     Two independent seeds per rhythm class keep one unlucky noise
     realisation from deciding the verdict. */
  function rhythmStripSet() {
    return [
      { id: 'NSR-A', type: 'normal', seed: 11, note: '72 bpm sinus' },
      { id: 'NSR-B', type: 'normal', seed: 23, note: '72 bpm sinus' },
      { id: 'BRADY-A', type: 'bradycardia', seed: 5, note: '48 bpm sinus' },
      { id: 'TACHY-A', type: 'tachycardia', seed: 9, note: '128 bpm sinus' },
      { id: 'IRREG-A', type: 'irregular', seed: 3, note: 'irregularly irregular' },
      { id: 'IRREG-B', type: 'irregular', seed: 31, note: 'irregularly irregular' },
      { id: 'PVC-A', type: 'ectopic', seed: 7, note: 'premature beats, pauses' },
      { id: 'PVC-B', type: 'ectopic', seed: 41, note: 'premature beats, pauses' },
      { id: 'HUM-A', type: 'hum', seed: 13, note: '0.30 mV 60 Hz hum' },
      { id: 'WANDER-A', type: 'wander', seed: 17, note: '0.45 mV baseline drift' }
    ];
  }

  /* Runs the real Pan-Tompkins detector on a strip, classifies the
     detected R-R series, measures artefacts, and reports whether the
     combined prediction matches the strip label. Artefact flags take
     precedence in the combined label so a noisy strip is called
     'artifact' even though its underlying rhythm is sinus. */
  function classifyStrip(strip, options) {
    var det = Analysis.detectQRS(strip.signal, strip.fs);
    var rrDet = Analysis.rrIntervals(det.peaks, strip.fs);
    var rhythm = classifyRhythm(rrDet, options);
    var artifacts = analyzeArtifacts(strip.signal, strip.fs, options);
    var predicted = (artifacts.humFlag || artifacts.wanderFlag) ? 'artifact' : rhythm.key;
    var score = Analysis.scoreDetection(det.peaks, strip.peaks, strip.fs, 120);
    var mNN = rrDet.length ? mean(rrDet) : 0;
    var bpm = mNN > 0 ? 60000 / mNN : 0;
    return {
      strip: strip,
      detected: det,
      rhythm: rhythm,
      artifacts: artifacts,
      predicted: predicted,
      predictedLabel: CLASS_LABELS[predicted] || predicted,
      expectedLabel: CLASS_LABELS[strip.trueClass] || strip.trueClass,
      trueBpm: strip.trueBpm,
      bpm: bpm,
      bpmError: Math.abs(bpm - strip.trueBpm),
      score: score,
      detF1: score.f1,
      ok: predicted === strip.trueClass
    };
  }

  /* One-versus-rest metrics for every class, plus accuracy, the mean
     absolute bpm error against the strip's true rate, and the mean
     detection F1 of the real detector against placed R peaks. */
  function runRhythmBenchmark(strips, options) {
    var list = strips || rhythmStripSet();
    var rows = [];
    for (var i = 0; i < list.length; i++) {
      var strip = synthesizeStrip(list[i]);
      var res = classifyStrip(strip, options);
      res.id = list[i].id;
      res.note = list[i].note;
      res.expected = strip.trueClass;
      rows.push(res);
    }

    var metrics = [];
    var macroSens = 0, macroSpec = 0, macroF1 = 0;
    for (var c = 0; c < CLASS_KEYS.length; c++) {
      var k = CLASS_KEYS[c];
      var tp = 0, fp = 0, fn = 0, tn = 0;
      for (var r = 0; r < rows.length; r++) {
        var actual = rows[r].expected;
        var pred = rows[r].predicted;
        if (actual === k && pred === k) tp++;
        else if (actual !== k && pred === k) fp++;
        else if (actual === k && pred !== k) fn++;
        else tn++;
      }
      var sens = (tp + fn) ? tp / (tp + fn) : 0;
      var spec = (tn + fp) ? tn / (tn + fp) : 0;
      var prec = (tp + fp) ? tp / (tp + fp) : 0;
      var f1 = (sens + prec) > 0 ? 2 * sens * prec / (sens + prec) : 0;
      metrics.push({
        key: k, label: CLASS_LABELS[k],
        tp: tp, fp: fp, fn: fn, tn: tn,
        sensitivity: sens, specificity: spec, precision: prec, f1: f1
      });
      macroSens += sens;
      macroSpec += spec;
      macroF1 += f1;
    }
    var classes = CLASS_KEYS.length;
    var correct = 0, mae = 0, detSum = 0;
    for (var m = 0; m < rows.length; m++) {
      if (rows[m].ok) correct++;
      mae += rows[m].bpmError;
      detSum += rows[m].detF1;
    }
    return {
      rows: rows,
      metrics: metrics,
      classes: CLASS_KEYS.slice(),
      accuracy: rows.length ? correct / rows.length : 0,
      correct: correct,
      total: rows.length,
      macroSens: macroSens / classes,
      macroSpec: macroSpec / classes,
      macroF1: macroF1 / classes,
      maeBpm: rows.length ? mae / rows.length : 0,
      meanDetF1: rows.length ? detSum / rows.length : 0
    };
  }

  return {
    CLASS_KEYS: CLASS_KEYS,
    CLASS_LABELS: CLASS_LABELS,
    STRIP_MEAN_MS: STRIP_MEAN_MS,
    STRIP_CLASS: STRIP_CLASS,
    makeRandom: makeRandom,
    makeGaussian: makeGaussian,
    sampleEntropy: sampleEntropy,
    ectopyIndices: ectopyIndices,
    rrFeatures: rrFeatures,
    poincareEllipse: poincareEllipse,
    classifyRhythm: classifyRhythm,
    toneAmplitude: toneAmplitude,
    analyzeArtifacts: analyzeArtifacts,
    beatTemplate: beatTemplate,
    synthesizeStrip: synthesizeStrip,
    rhythmStripSet: rhythmStripSet,
    classifyStrip: classifyStrip,
    runRhythmBenchmark: runRhythmBenchmark
  };
});
