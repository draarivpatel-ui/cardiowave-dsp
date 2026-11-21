/*
 * CardioWave DSP
 * 12-lead synthetic ECG (McSharry ODE), Pan-Tompkins QRS detection,
 * heart-rate variability analysis, and PhysioNet/WFDB export.
 *
 * Zero dependencies. Pure computation and file generation.
 * For education and research only. Not a medical device and not for diagnosis.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    root.CardioWave = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '1.0.0';

  /* ------------------------------------------------------------------ */
  /* Lead layout                                                         */
  /* ------------------------------------------------------------------ */

  /* Standard 12-lead order: limb leads I, II, III, aVR, aVL, aVF then
     precordial leads V1 through V6. */
  var LEAD_NAMES = ['I', 'II', 'III', 'aVR', 'aVL', 'aVF', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'];

  /* Per-lead multipliers applied to the P, Q, R, S, T extremum amplitudes.
     Rows follow LEAD_NAMES. This is the lead-projection matrix used by the
     McSharry ECGSYN generator. */
  var LEAD_GAMMA = [
    [1, 0.1, 1, 1.2, 1],
    [2, 0.2, 0.2, 0.2, 3],
    [1, -0.1, -0.8, -1.1, 2.5],
    [-1, -0.05, -0.8, -0.5, -1.2],
    [0.05, 0.05, 1, 1, 1],
    [1, -0.05, -0.1, -0.1, 3],
    [-0.5, 0.05, 0.2, 0.5, 1],
    [0.05, 0.05, 1.3, 2.5, 2],
    [1, 0.05, 1, 2, 1],
    [1.2, 0.05, 1, 2, 2],
    [1.5, 0.1, 0.8, 1, 2],
    [1.8, 0.05, 0.5, 0.1, 2]
  ];

  /* Extrema angles in degrees (P, Q, R, S, T) and their amplitudes (mV) and
     Gaussian widths (rad). */
  var BASE_EXTREMUM_ANGLES = [-70, -15, 0, 15, 100];
  var BASE_EXTREMUM_AMPLITUDES = [1.2, -5, 30, -7.5, 0.75];
  var BASE_EXTREMUM_WIDTHS = [0.25, 0.1, 0.1, 0.1, 0.4];

  var DEFAULT_OPTIONS = {
    duration: 20,
    samplingRate: 500,
    heartRate: 72,
    hrStd: 1,
    rsaAmplitude: 40,
    respRate: 15,
    mayerAmplitude: 15,
    humAmplitude: 0.05,
    wanderAmplitude: 0.1,
    emgAmplitude: 0.02,
    emgBandwidth: 40,
    seed: 42
  };

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                       */
  /* ------------------------------------------------------------------ */

  function assert(cond, message) {
    if (!cond) throw new Error(message || 'Assertion failed');
  }

  function clamp(value, lo, hi) {
    return value < lo ? lo : (value > hi ? hi : value);
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function mean(values) {
    if (!values.length) return NaN;
    var sum = 0;
    for (var i = 0; i < values.length; i++) sum += values[i];
    return sum / values.length;
  }

  function variance(values) {
    if (values.length < 2) return 0;
    var m = mean(values);
    var acc = 0;
    for (var i = 0; i < values.length; i++) {
      var d = values[i] - m;
      acc += d * d;
    }
    return acc / (values.length - 1);
  }

  function stddev(values) {
    return Math.sqrt(variance(values));
  }

  /* Deterministic 32-bit PRNG (mulberry32). Same seed gives same signal. */
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

  /* Box-Muller transform: standard normal deviates from uniform input. */
  function makeGaussian(random) {
    var spare = null;
    return function () {
      if (spare !== null) {
        var s = spare;
        spare = null;
        return s;
      }
      var u = 0;
      var v = 0;
      var s = 0;
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
  /* Fourier-series band noise                                            */
  /* ------------------------------------------------------------------ */

  /* Builds a zero-mean, roughly unit-variance signal from a band of
     frequencies using random-phase sinusoids. Used for the Mayer wave
     (LF, 0.04 to 0.15 Hz) and respiratory (HF, 0.15 to 0.40 Hz) components
     of the RR interval series, and for the EMG noise band. */
  function bandNoise(freqs, length, random) {
    var out = new Float64Array(length);
    var phases = new Float64Array(freqs.length);
    var amp = 1 / Math.sqrt(freqs.length);
    var i;
    for (i = 0; i < freqs.length; i++) phases[i] = random() * 2 * Math.PI;
    for (i = 0; i < length; i++) {
      var acc = 0;
      for (var k = 0; k < freqs.length; k++) {
        acc += amp * Math.sin(2 * Math.PI * freqs[k] * i + phases[k]);
      }
      out[i] = acc;
    }
    return out;
  }

  /* Rescales a series so its peak-to-peak span equals the given amount.
     Used to give the Mayer and respiratory components a directly meaningful
     millisecond amplitude. */
  function scaleToPeakToPeak(values, amplitude) {
    var min = Infinity;
    var max = -Infinity;
    var i;
    for (i = 0; i < values.length; i++) {
      if (values[i] < min) min = values[i];
      if (values[i] > max) max = values[i];
    }
    var range = max - min;
    if (range < 1e-12) return values;
    var offset = amplitude / 2;
    for (i = 0; i < values.length; i++) {
      values[i] = ((values[i] - min) / range) * amplitude - offset;
    }
    return values;
  }

  function linspace(start, stop, count) {
    var out = new Float64Array(count);
    if (count === 1) {
      out[0] = start;
      return out;
    }
    var step = (stop - start) / (count - 1);
    for (var i = 0; i < count; i++) out[i] = start + step * i;
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* RR interval series                                                  */
  /* ------------------------------------------------------------------ */

  /* Builds the per-beat RR interval series (seconds) that drives the
     oscillator. The Mayer wave (LF) and respiratory sinus arrhythmia (HF)
     components are scaled to the requested peak-to-peak millisecond
     amplitudes and then added to the mean RR interval. */
  function buildRRSeries(options) {
    var hr = options.heartRate;
    var rrMean = 60 / hr;
    var beats = Math.ceil(options.duration / rrMean) + 8;
    var random = makeRandom(options.seed);
    var gauss = makeGaussian(random);

    var loFreqs = [];
    for (var f = 0.04; f <= 0.1501; f += 0.0025) loFreqs.push(f);
    var hiFreqs = [];
    for (var g = 0.15; g <= 0.4001; g += 0.0025) hiFreqs.push(g);

    /* Small Gaussian jitter gives a realistic beat-to-beat spread on top of
       the structured Mayer and respiratory components. */
    var jitter = options.hrStd * 60 / (hr * hr) * 0.25;

    /* The two structured components are generated once for the whole series
       and then scaled to their requested peak-to-peak amplitude. */
    var mayer = null;
    var resp = null;
    if (options.mayerAmplitude > 0) {
      mayer = scaleToPeakToPeak(bandNoise(loFreqs, beats, random), options.mayerAmplitude / 1000);
    }
    if (options.rsaAmplitude > 0) {
      resp = scaleToPeakToPeak(bandNoise(hiFreqs, beats, random), options.rsaAmplitude / 1000);
    }

    var rr = new Float64Array(beats);
    for (var i = 0; i < beats; i++) {
      var value = rrMean;
      if (mayer) value += mayer[i];
      if (resp) value += resp[i];
      value += gauss() * jitter;
      if (value < 0.2) value = 0.2;
      rr[i] = value;
    }
    return rr;
  }

  /* ------------------------------------------------------------------ */
  /* McSharry dynamical ECG model                                        */
  /* ------------------------------------------------------------------ */

  /* Right-hand side of the McSharry three-state oscillator.

     x1, x2 carry the unit-norm phasor whose angle is the cardiac phase, and
     x3 is the membrane potential that the ECG signal is proportional to.

       ta      = atan2(x2, x1)
       a0      = 1 - |x1 + i x2|
       dx1/dt  = a0 x1 - w0 x2
       dx2/dt  = a0 x2 + w0 x1
       dx3/dt  = -sum_j ai_j dti_j exp(-0.5 (dti_j / bi_j)^2) - (x3 - zbase)

     dti_j is the wrapped angular distance from the current phase to the
     angle of extremum j. */
  function mcsharryDerivative(x1, x2, x3, w0, ti, amp, bi, zbase) {
    var ta = Math.atan2(x2, x1);
    var a0 = 1 - Math.sqrt(x1 * x1 + x2 * x2);
    var dx1 = a0 * x1 - w0 * x2;
    var dx2 = a0 * x2 + w0 * x1;
    var drive = 0;
    for (var j = 0; j < ti.length; j++) {
      var dti = ta - ti[j];
      dti = dti - Math.round(dti / (2 * Math.PI)) * 2 * Math.PI;
      var scaled = dti / bi[j];
      drive += amp[j] * dti * Math.exp(-0.5 * scaled * scaled);
    }
    var dx3 = -drive - (x3 - zbase);
    return [dx1, dx2, dx3];
  }

  /* One classical fourth-order Runge-Kutta step on the three-state system. */
  function rk4Step(state, dt, w0, ti, amp, bi, zbase) {
    var k1 = mcsharryDerivative(state[0], state[1], state[2], w0, ti, amp, bi, zbase);
    var s2 = [state[0] + 0.5 * dt * k1[0], state[1] + 0.5 * dt * k1[1], state[2] + 0.5 * dt * k1[2]];
    var k2 = mcsharryDerivative(s2[0], s2[1], s2[2], w0, ti, amp, bi, zbase);
    var s3 = [state[0] + 0.5 * dt * k2[0], state[1] + 0.5 * dt * k2[1], state[2] + 0.5 * dt * k2[2]];
    var k3 = mcsharryDerivative(s3[0], s3[1], s3[2], w0, ti, amp, bi, zbase);
    var s4 = [state[0] + dt * k3[0], state[1] + dt * k3[1], state[2] + dt * k3[2]];
    var k4 = mcsharryDerivative(s4[0], s4[1], s4[2], w0, ti, amp, bi, zbase);
    var out = new Array(3);
    for (var i = 0; i < 3; i++) {
      out[i] = state[i] + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
    }
    return out;
  }

  /* Integrates all 12 leads together over the requested duration.

     Returns the raw lead signals plus the true R-peak sample indices, which
     the SNR benchmark scores the detector against. */
  function simulateMcSharry(options) {
    options = resolveOptions(options);
    var fs = options.samplingRate;
    var internalFs = fs * 4;
    var dt = 1 / internalFs;
    var totalOut = Math.round(options.duration * fs);
    var totalInternal = totalOut * 4;

    var rr = buildRRSeries(options);

    /* Heart-rate-dependent scaling of the extremum angles and widths,
       following the ECGSYN parameter adjustment. */
    var hrfact = Math.sqrt(options.heartRate / 60);
    var hrfact2 = Math.sqrt(hrfact);
    var scaleFactors = [hrfact2, hrfact, 1, hrfact, hrfact2];
    var ti = [];
    var bi = [];
    for (var j = 0; j < 5; j++) {
      ti.push(BASE_EXTREMUM_ANGLES[j] * Math.PI / 180 * scaleFactors[j]);
      bi.push(BASE_EXTREMUM_WIDTHS[j] * hrfact);
    }

    var leads = [];
    for (var L = 0; L < 12; L++) {
      var amp = [];
      for (var k = 0; k < 5; k++) amp.push(LEAD_GAMMA[L][k] * BASE_EXTREMUM_AMPLITUDES[k]);
      leads.push(amp);
    }

    /* Fresh oscillators, one per lead, all sharing the same phase. */
    var states = [];
    for (var m = 0; m < 12; m++) states.push([1, 0, 0.04]);

    var respHz = options.respRate / 60;
    var out = [];
    for (var L2 = 0; L2 < 12; L2++) out.push(new Float64Array(totalOut));

    /* All twelve leads share one oscillator phase, so the phase of the
       first lead is recorded as the model-wide cardiac phase. */
    var phases = new Float64Array(totalOut);

    /* The oscillator starts away from its limit cycle and needs a few
       beats to settle. Those warm-up beats are integrated but discarded,
       so that the recorded trace and the per-lead normalisation both
       describe the steady-state waveform instead of the start-up
       transient. */
    var warmupBeats = 5;

    var beatIndex = 0;
    var time = 0;
    var internalIndex = 0;
    var recorded = 0;

    while (recorded < totalOut && beatIndex < rr.length - 1) {
      var rrInterval = rr[beatIndex];
      var steps = Math.max(1, Math.round(rrInterval / dt));
      var w0 = 2 * Math.PI / (steps * dt);

      for (var s = 0; s < steps && recorded < totalOut; s++) {
        var t = time + s * dt;
        var zbase = 0.005 * Math.sin(2 * Math.PI * respHz * t);
        for (var L3 = 0; L3 < 12; L3++) {
          states[L3] = rk4Step(states[L3], dt, w0, ti, leads[L3], bi, zbase);
        }
        if (internalIndex % 4 === 0 && beatIndex >= warmupBeats) {
          var outIndex = recorded;
          for (var L4 = 0; L4 < 12; L4++) out[L4][outIndex] = states[L4][2];
          phases[outIndex] = Math.atan2(states[0][1], states[0][0]);
          recorded++;
        }
        internalIndex++;
      }

      time += steps * dt;
      beatIndex++;
    }

    /* Scale each lead into a physiological millivolt range. */
    var signals = [];
    for (var L5 = 0; L5 < 12; L5++) {
      signals.push(scaleToPhysiological(out[L5]));
    }

    /* The membrane potential carries a one-second time constant, so the
       recorded waveform trails the cardiac phase by a small constant delay.
       The phase crossings therefore give the beat grid, and each lead is
       refined onto its own recorded R-wave extremum. */
    var crossings = findPhaseCrossings(phases);
    var refinement = Math.max(1, Math.round(0.12 * fs));
    var rPeaksByLead = [];
    for (var L6 = 0; L6 < 12; L6++) {
      var polarity = LEAD_GAMMA[L6][2] >= 0 ? 1 : -1;
      rPeaksByLead.push(refineRPeaks(signals[L6], crossings, polarity, refinement));
    }

    return {
      signals: signals,
      rPeaks: rPeaksByLead[1],
      rPeaksByLead: rPeaksByLead,
      beatCrossings: crossings,
      samplingRate: fs,
      duration: options.duration,
      leadNames: LEAD_NAMES.slice()
    };
  }

  /* Sample indices at which the cardiac phase crosses zero on its way up.

     The R extremum of the McSharry model sits at phase zero, so every
     upward crossing marks the start of one ventricular depolarisation and
     is common to all twelve leads. */
  function findPhaseCrossings(phases) {
    var crossings = [];
    for (var i = 1; i < phases.length; i++) {
      if (phases[i - 1] < 0 && phases[i] >= 0) crossings.push(i);
    }
    return crossings;
  }

  /* Refines model beat crossings onto the recorded R-wave extremum of one
     lead.

     The polarity of the R wave follows the sign of that lead's R-wave
     projection, so inverted leads such as III and aVR are matched on
     their negative deflection rather than their positive one. */
  function refineRPeaks(signalValues, crossings, polarity, windowSamples) {
    var peaks = [];
    var n = signalValues.length;
    for (var c = 0; c < crossings.length; c++) {
      var lo = Math.max(1, crossings[c] - windowSamples);
      /* At very high heart rates the refinement windows of neighbouring
         beats overlap, and two crossings could otherwise select the same
         extremum sample. The ground-truth list must be strictly
         increasing, so each beat may only claim samples after the
         previous peak. */
      if (peaks.length) lo = Math.max(lo, peaks[peaks.length - 1] + 1);
      var hi = Math.min(n - 2, crossings[c] + windowSamples);
      if (hi <= lo) continue;
      var best = -1;
      var i;
      for (i = lo; i <= hi; i++) {
        if (polarity > 0) {
          if (signalValues[i] > signalValues[i - 1] && signalValues[i] >= signalValues[i + 1]) {
            if (best < 0 || signalValues[i] > signalValues[best]) best = i;
          }
        } else {
          if (signalValues[i] < signalValues[i - 1] && signalValues[i] <= signalValues[i + 1]) {
            if (best < 0 || signalValues[i] < signalValues[best]) best = i;
          }
        }
      }
      if (best < 0) best = crossings[c];
      peaks.push(best);
    }
    return peaks;
  }

  /* Locates the R peaks of a clean single-lead trace.

     Peaks are found with a prominence threshold relative to the signal
     range, and are then thinned to one peak per expected beat interval so
     that the large T wave is not mistaken for a second R wave. */
  function findGroundTruthRPeaks(signalValues, fs, heartRate) {
    var n = signalValues.length;
    if (n < 3) return [];

    var min = Infinity;
    var max = -Infinity;
    var i;
    for (i = 0; i < n; i++) {
      if (signalValues[i] < min) min = signalValues[i];
      if (signalValues[i] > max) max = signalValues[i];
    }
    var range = max - min;
    if (range < 1e-9) return [];

    /* Candidate peaks: strict local maxima standing clear of the baseline. */
    var candidates = [];
    for (i = 1; i < n - 1; i++) {
      if (signalValues[i] > signalValues[i - 1] && signalValues[i] >= signalValues[i + 1] &&
        signalValues[i] > min + 0.5 * range) {
        candidates.push(i);
      }
    }

    /* Thin to the strongest peak within each expected beat window. */
    var rr = 60 / heartRate;
    var minDistance = Math.max(1, Math.floor(0.5 * rr * fs));
    var chosen = [];
    var lastIndex = -Infinity;
    for (var c = 0; c < candidates.length; c++) {
      var idx = candidates[c];
      if (idx - lastIndex < minDistance) {
        /* Keep whichever of the two candidates is taller. */
        if (chosen.length && signalValues[idx] > signalValues[chosen[chosen.length - 1]]) {
          chosen[chosen.length - 1] = idx;
          lastIndex = idx;
        }
        continue;
      }
      chosen.push(idx);
      lastIndex = idx;
    }
    return chosen;
  }

  /* Rescales a raw oscillator trace so it spans a fixed millivolt window. */
  function scaleToPhysiological(values) {
    var min = Infinity;
    var max = -Infinity;
    for (var i = 0; i < values.length; i++) {
      if (values[i] < min) min = values[i];
      if (values[i] > max) max = values[i];
    }
    var range = max - min;
    if (range < 1e-12) return values.slice();
    var out = new Float64Array(values.length);
    for (var j = 0; j < values.length; j++) {
      out[j] = (values[j] - min) * 1.6 / range - 0.4;
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Additive artefacts: mains hum, baseline wander, EMG noise          */
  /* ------------------------------------------------------------------ */

  /* Adds 60 Hz mains hum, low-frequency baseline wander, and band-limited
     EMG noise to a signal in place-free fashion (returns a new array).

     Each lead receives its own noise realisation. Real electrodes pick up
     independent disturbance, and sharing one realisation across all twelve
     leads would make the noise look like a genuine, spatially coherent
     deflection instead of something that a multi-lead detector can vote
     away. */
  function addArtifacts(signalValues, options, leadIndex) {
    var fs = options.samplingRate;
    var n = signalValues.length;
    var lead = leadIndex || 0;
    var random = makeRandom(options.seed + 7919 + lead * 104729);
    var i;

    /* bandNoise expects frequencies in cycles per sample, so the nominal
       hertz values are divided by the sampling rate. Feeding raw hertz
       aliases every whole-number frequency to DC (EMG became a no-op) and
       folds the 0.05-0.5 Hz wander band into 12.5-125 Hz garbage. */
    var emgFreqs = [];
    var upper = Math.min(options.emgBandwidth, fs / 2 * 0.9);
    for (var f = 20; f <= upper; f += 2) emgFreqs.push(f / fs);
    var emg = bandNoise(emgFreqs, n, random);

    var wanderFreqs = [];
    for (var w = 0.05; w <= 0.5; w += 0.01) wanderFreqs.push(w / fs);
    var wander = bandNoise(wanderFreqs, n, random);

    var humPhase = random() * 2 * Math.PI;
    var humOffset = random() * 2 * Math.PI;

    var out = new Float64Array(n);
    for (i = 0; i < n; i++) {
      var t = i / fs;
      var hum = options.humAmplitude *
        (Math.sin(2 * Math.PI * 60 * t + humPhase) +
          0.35 * Math.sin(2 * Math.PI * 120 * t + humOffset));
      out[i] = signalValues[i] +
        options.wanderAmplitude * wander[i] +
        options.emgAmplitude * emg[i] +
        hum;
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Public generator                                                    */
  /* ------------------------------------------------------------------ */

  function resolveOptions(input) {
    var opts = {};
    var key;
    for (key in DEFAULT_OPTIONS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_OPTIONS, key)) opts[key] = DEFAULT_OPTIONS[key];
    }
    if (input) {
      for (var k in input) {
        if (Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined &&
          input[k] !== null) {
          opts[k] = input[k];
        }
      }
    }
    assert(isFiniteNumber(opts.duration) && opts.duration > 0 && opts.duration <= 3600,
      'duration must be a positive number no larger than 3600 seconds');
    assert(isFiniteNumber(opts.samplingRate) && opts.samplingRate >= 32 && opts.samplingRate <= 2000,
      'samplingRate must be between 32 and 2000 Hz');
    /* The record is materialised as twelve Float64Arrays plus copies, so
       cap the sample count where a direct API caller cannot request an
       allocation the runtime cannot satisfy. */
    assert(opts.duration * opts.samplingRate <= 1e6,
      'duration times samplingRate must not exceed 1000000 samples');
    assert(isFiniteNumber(opts.heartRate) && opts.heartRate > 20 && opts.heartRate < 300,
      'heartRate must be between 20 and 300 beats per minute');
    /* Variability inputs are physiological quantities: hrStd is a heart
       rate standard deviation in beats per minute, and the structured
       amplitudes are peak-to-peak millisecond swings of the RR interval.
       Unbounded values stretch a single beat past any computable length
       and the warm-up loop, which predates the recording guard, never
       terminates. */
    assert(isFiniteNumber(opts.hrStd) && opts.hrStd >= 0 && opts.hrStd <= 100,
      'hrStd must be between 0 and 100 beats per minute');
    assert(isFiniteNumber(opts.rsaAmplitude) && opts.rsaAmplitude >= 0 && opts.rsaAmplitude <= 2000,
      'rsaAmplitude must be between 0 and 2000 milliseconds');
    assert(isFiniteNumber(opts.mayerAmplitude) && opts.mayerAmplitude >= 0 && opts.mayerAmplitude <= 2000,
      'mayerAmplitude must be between 0 and 2000 milliseconds');
    assert(isFiniteNumber(opts.respRate) && opts.respRate > 0 && opts.respRate < 60,
      'respRate must be between 0 and 60 breaths per minute');
    assert(isFiniteNumber(opts.humAmplitude) && opts.humAmplitude >= 0,
      'humAmplitude must be non-negative');
    assert(isFiniteNumber(opts.wanderAmplitude) && opts.wanderAmplitude >= 0,
      'wanderAmplitude must be non-negative');
    assert(isFiniteNumber(opts.emgAmplitude) && opts.emgAmplitude >= 0,
      'emgAmplitude must be non-negative');
    assert(isFiniteNumber(opts.emgBandwidth) && opts.emgBandwidth > 0,
      'emgBandwidth must be positive');
    assert(Number.isInteger(opts.seed), 'seed must be an integer');
    return opts;
  }

  /* Generates a full 12-lead record with artefacts applied to every lead.

     The returned object holds the lead signals, the true R-peak indices, and
     the resolved options, so downstream analysis can be scored against
     ground truth. */
  function generateECG(input) {
    var options = resolveOptions(input);
    var base = simulateMcSharry(options);
    var signals = [];
    for (var i = 0; i < base.signals.length; i++) {
      signals.push(addArtifacts(base.signals[i], options, i));
    }
    return {
      signals: signals,
      leadNames: base.leadNames,
      rPeaks: base.rPeaks,
      samplingRate: options.samplingRate,
      duration: options.duration,
      options: options
    };
  }

  return {
    VERSION: VERSION,
    LEAD_NAMES: LEAD_NAMES,
    LEAD_GAMMA: LEAD_GAMMA,
    DEFAULT_OPTIONS: DEFAULT_OPTIONS,
    generateECG: generateECG,
    simulateMcSharry: simulateMcSharry,
    addArtifacts: addArtifacts,
    buildRRSeries: buildRRSeries
  };
});
