/*
 * CardioWave DSP / QRS detection, heart-rate variability and benchmarking.
 *
 * Pan-Tompkins QRS detection and the HRV metric set follow the conventions
 * used by the NeuroKit2 reference implementation so that results can be
 * compared directly with published tooling.
 *
 * For education and research only. Not a medical device and not for diagnosis.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory(require('./filters.js'));
  } else if (typeof define === 'function' && define.amd) {
    define(['./filters.js'], factory);
  } else {
    root.CardioWaveAnalysis = factory(root.CardioWaveFilters);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Filters) {
  'use strict';

  var SQRT2 = Math.sqrt(2);

  function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed');
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function mean(values) {
    if (!values.length) return 0;
    var total = 0;
    for (var i = 0; i < values.length; i++) total += values[i];
    return total / values.length;
  }

  /* Sample standard deviation (denominator n - 1). */
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

  /* Median of a list of numbers. */
  function median(values) {
    if (!values.length) return 0;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /* ------------------------------------------------------------------ */
  /* Pre-processing filters                                               */
  /* ------------------------------------------------------------------ */

  /* Removes 60 Hz mains hum with a zero-phase band-stop Butterworth. */
  function notch60(signal, fs, options) {
    var opts = options || {};
    var order = opts.order || 2;
    var center = opts.center || 60;
    var width = opts.width || 2;
    var sos = Filters.butter(order, [center - width / 2, center + width / 2], 'bandstop', fs);
    return Filters.sosfiltfilt(sos, signal);
  }

  /* Removes baseline wander with a zero-phase high-pass Butterworth. */
  function highpass(signal, fs, options) {
    var opts = options || {};
    var order = opts.order || 2;
    var cutoff = opts.cutoff || 0.5;
    var sos = Filters.butter(order, [cutoff], 'highpass', fs);
    return Filters.sosfiltfilt(sos, signal);
  }

  /* Band-pass filter used as the first stage of QRS detection. */
  function bandpass(signal, fs, lowcut, highcut, order) {
    var sos = Filters.butter(order || 1, [lowcut, highcut], 'bandpass', fs);
    return Filters.butterFilterCausal(sos, signal);
  }

  /* ------------------------------------------------------------------ */
  /* Pan-Tompkins QRS detection                                          */
  /* ------------------------------------------------------------------ */

  /* Causal moving average over a sliding window.

     Each output element averages the window_size inputs that end at that
     position, except for the head of the signal, where only the inputs seen
     so far are used. */
  function movingWindowAverage(values, windowSize) {
    if (!Number.isInteger(windowSize) || windowSize < 1) {
      throw new RangeError('windowSize must be a positive integer, got ' + windowSize);
    }
    var n = values.length;
    var out = new Float64Array(n);
    var head = Math.min(windowSize - 1, n);
    var running = 0;
    var i;
    for (i = 0; i < head; i++) {
      running += values[i];
      out[i] = running / (i + 1);
    }
    for (i = head; i < n; i++) {
      running += values[i];
      if (i >= windowSize) running -= values[i - windowSize];
      out[i] = running / windowSize;
    }
    return out;
  }

  /* Strict local maxima, matching scipy.signal.find_peaks with
     plateau_size=(1, 1): flat tops are not reported as peaks. */
  function findLocalMaxima(values) {
    var peaks = [];
    for (var i = 1; i < values.length - 1; i++) {
      if (values[i] > values[i - 1] && values[i] > values[i + 1]) peaks.push(i);
    }
    return peaks;
  }

  /* Detects R peaks with the Pan-Tompkins algorithm.

     The signal is band-pass filtered, differentiated, squared, integrated
     over a 120 ms window, and then thresholded with an adaptive signal and
     noise peak estimator. */
  function detectQRS(signal, fs, options) {
    var opts = options || {};
    assert(Array.isArray(signal) || signal instanceof Float64Array,
      'signal must be an array of samples');
    assert(isFiniteNumber(fs) && fs > 0, 'sampling rate must be a positive number');
    assert(signal.length > 2, 'signal must contain more than two samples');

    var lowcut = opts.lowcut || 5;
    var highcut = opts.highcut || 15;
    var order = opts.order || 1;

    var filtered = bandpass(signal, fs, lowcut, highcut, order);

    var squared = new Float64Array(filtered.length);
    for (var i = 1; i < filtered.length; i++) {
      var d = filtered[i] - filtered[i - 1];
      squared[i - 1] = d * d;
    }

    var window = Math.max(1, Math.round(0.12 * fs));
    var integrated = movingWindowAverage(squared, window);

    /* Ignore the first 200 ms, where the filter is still settling. */
    var ignore = Math.round(0.2 * fs);
    for (var j = 0; j < Math.min(ignore, integrated.length); j++) integrated[j] = 0;

    var peaks = findLocalMaxima(integrated);
    var minPeakDistance = Math.round(0.3 * fs);
    var minMissedDistance = Math.round(0.25 * fs);

    var signalPeaks = [];
    var spki = 0;
    var npki = 0;
    var lastPeak = 0;
    var lastIndex = -1;

    for (var p = 0; p < peaks.length; p++) {
      var peak = peaks[p];
      var peakValue = integrated[peak];
      var threshold1 = npki + 0.25 * (spki - npki);

      if (peakValue > threshold1 && peak > lastPeak + minPeakDistance) {
        signalPeaks.push(peak);

        if (signalPeaks.length > 9) {
          var rrAverage = Math.floor((signalPeaks[signalPeaks.length - 2] -
            signalPeaks[signalPeaks.length - 10]) / 8);
          var rrMissed = Math.floor(1.66 * rrAverage);
          if (peak - lastPeak > rrMissed) {
            var missed = [];
            for (var m = lastIndex + 1; m < p; m++) {
              if (peaks[m] > lastPeak + minMissedDistance &&
                peaks[m] < peak - minMissedDistance) missed.push(peaks[m]);
            }
            var threshold2 = 0.5 * threshold1;
            var strong = missed.filter(function (idx) { return integrated[idx] > threshold2; });
            if (strong.length) {
              var best = strong[0];
              for (var s = 1; s < strong.length; s++) {
                if (integrated[strong[s]] > integrated[best]) best = strong[s];
              }
              signalPeaks[signalPeaks.length - 1] = best;
              signalPeaks.push(peak);
            }
          }
        }

        lastPeak = peak;
        lastIndex = p;
        spki = 0.125 * peakValue + 0.875 * spki;
      } else {
        npki = 0.125 * peakValue + 0.875 * npki;
      }
    }

    return { peaks: signalPeaks, integrated: integrated, filtered: filtered };
  }

  /* ------------------------------------------------------------------ */
  /* Multi-lead ensemble detection                                         */
  /* ------------------------------------------------------------------ */

  /* Builds the spatial magnitude of a set of leads.

     The instantaneous magnitude sqrt(sum of squares) is invariant to the
     polarity of the R wave, so a lead whose R wave points downwards still
     contributes a positive deflection. It also averages away the part of
     the signal that is specific to a single lead. */
  function vectorMagnitude(leadSignals) {
    assert(leadSignals.length > 0, 'at least one lead is required');
    var n = leadSignals[0].length;
    var out = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      var sum = 0;
      for (var L = 0; L < leadSignals.length; L++) {
        var v = leadSignals[L][i];
        sum += v * v;
      }
      out[i] = Math.sqrt(sum);
    }
    return out;
  }

  /* Runs the single-lead detector on every lead and keeps only the
     candidate positions that at least minVotes leads agree on.

     The McSharry generator produces a large T wave in some leads, and a
     T wave can be tall enough to pass the Pan-Tompkins band. Requiring
     agreement across leads rejects those isolated T-wave candidates while
     keeping the QRS complexes, which are large in at least one lead of
     every standard configuration.

     Two further stages tighten the result:

       - A relative amplitude gate discards clusters whose integrated
         energy is far below the median cluster. The main source of such
         clusters is the settling transient of the causal band-pass filter
         at the start of the record.
       - A composite refinement moves each surviving consensus position onto
         the largest deflection of the spatial magnitude signal within a
         short window, which removes the small timing spread that comes from
         averaging detections taken from leads with different waveform
         shapes. */
  function detectQRSEnsemble(leadSignals, fs, options) {
    var opts = options || {};
    assert(leadSignals.length > 0, 'at least one lead is required');
    assert(isFiniteNumber(fs) && fs > 0, 'sampling rate must be a positive number');

    var minVotes = opts.minVotes === undefined
      ? Math.max(2, Math.ceil(leadSignals.length / 2))
      : opts.minVotes;
    var tolerance = Math.round((opts.toleranceMs === undefined ? 50 : opts.toleranceMs) * fs / 1000);
    var gate = opts.gate === undefined ? 0.05 : opts.gate;
    var refineMs = opts.refineMs === undefined ? 60 : opts.refineMs;
    var highpassCutoff = opts.highpassCutoff === undefined ? 0.5 : opts.highpassCutoff;

    var detections = [];
    var candidates = [];
    for (var L = 0; L < leadSignals.length; L++) {
      var det = detectQRS(leadSignals[L], fs, opts);
      detections.push(det);
      for (var p = 0; p < det.peaks.length; p++) {
        candidates.push({ index: det.peaks[p], lead: L, weight: det.integrated[det.peaks[p]] });
      }
    }

    candidates.sort(function (a, b) { return a.index - b.index; });

    var clusters = [];
    var current = [];
    for (var c = 0; c < candidates.length; c++) {
      if (current.length === 0) {
        current.push(candidates[c]);
      } else if (candidates[c].index - current[current.length - 1].index <= tolerance) {
        current.push(candidates[c]);
      } else {
        clusters.push(current);
        current = [candidates[c]];
      }
    }
    if (current.length) clusters.push(current);

    /* First pass: keep the clusters that enough leads agree on. */
    var positions = [];
    var votes = [];
    var amplitudes = [];
    for (var k = 0; k < clusters.length; k++) {
      var group = clusters[k];
      var leads = {};
      var count = 0;
      var amplitude = 0;
      for (var m = 0; m < group.length; m++) {
        if (!leads[group[m].lead]) {
          leads[group[m].lead] = true;
          count++;
        }
        if (group[m].weight > amplitude) amplitude = group[m].weight;
      }
      if (count < minVotes) continue;

      /* The position of the consensus peak is the weighted mean of the
         cluster, which keeps it anchored on the QRS rather than drifting
         onto a neighbouring deflection. */
      var totalWeight = 0;
      var weighted = 0;
      for (var q = 0; q < group.length; q++) {
        var w = Math.max(group[q].weight, 0);
        totalWeight += w;
        weighted += w * group[q].index;
      }
      var position = totalWeight > 0 ? weighted / totalWeight : group[0].index;
      positions.push(Math.round(position));
      votes.push(count);
      amplitudes.push(amplitude);
    }

    /* Second pass: discard clusters that are far weaker than the typical
       beat, which removes filter start-up transients. */
    if (gate > 0 && positions.length > 2) {
      var reference = median(amplitudes);
      var kept = [];
      for (var g = 0; g < positions.length; g++) {
        if (amplitudes[g] >= gate * reference) {
          kept.push({
            index: positions[g], vote: votes[g], amplitude: amplitudes[g]
          });
        }
      }
      positions = kept.map(function (item) { return item.index; });
      votes = kept.map(function (item) { return item.vote; });
      amplitudes = kept.map(function (item) { return item.amplitude; });
    }

    /* Third pass: snap each consensus position onto the largest deflection
       of the spatial magnitude signal. */
    if (refineMs > 0 && positions.length) {
      var filteredLeads = [];
      for (var L2 = 0; L2 < leadSignals.length; L2++) {
        filteredLeads.push(highpass(leadSignals[L2], fs, { cutoff: highpassCutoff, order: 2 }));
      }
      var magnitude = vectorMagnitude(filteredLeads);
      var window = Math.max(1, Math.round(refineMs * fs / 1000));
      for (var r = 0; r < positions.length; r++) {
        var lo = Math.max(1, positions[r] - window);
        var hi = Math.min(magnitude.length - 2, positions[r] + window);
        if (hi <= lo) continue;
        var best = lo;
        for (var s = lo; s <= hi; s++) {
          if (magnitude[s] > magnitude[best]) best = s;
        }
        positions[r] = best;
      }
    }

    /* Fourth pass: refractory merge. Two consensus positions closer than
       the physiological refractory period cannot both be QRS complexes:
       one of them is a P or T wave that happened to collect enough votes.
       The single-lead detector enforces the same minimum spacing, but the
       cluster voting above does not, so enforce it here on the final list.
       Keep the position with the larger integrated amplitude. */
    var refractory = Math.round(0.25 * fs);
    if (positions.length > 1) {
      var order = [];
      for (var o = 0; o < positions.length; o++) order.push(o);
      order.sort(function (a, b) { return positions[a] - positions[b]; });
      var merged = [];
      for (var oi = 0; oi < order.length; oi++) {
        var idx = order[oi];
        var item = { index: positions[idx], vote: votes[idx], amplitude: amplitudes[idx] };
        var last = merged[merged.length - 1];
        if (last && item.index - last.index < refractory) {
          if (item.amplitude > last.amplitude) merged[merged.length - 1] = item;
        } else {
          merged.push(item);
        }
      }
      positions = merged.map(function (m) { return m.index; });
      votes = merged.map(function (m) { return m.vote; });
      amplitudes = merged.map(function (m) { return m.amplitude; });
    }

    return {
      peaks: positions,
      votes: votes,
      amplitudes: amplitudes,
      detections: detections
    };
  }

  /* ------------------------------------------------------------------ */
  /* Benchmarking against a known reference                                */
  /* ------------------------------------------------------------------ */

  /* Scores detected peaks against a reference list.

     A detection counts as a true positive when it falls within tolerance of
     a reference peak. Each reference peak can be matched only once, so a
     single reference cannot absorb several detections. */
  function scoreDetection(detected, reference, fs, toleranceMs) {
    var tolerance = (toleranceMs === undefined ? 150 : toleranceMs) * fs / 1000;
    var matchedDetected = new Array(detected.length).fill(false);
    var errors = [];
    var truePositives = 0;

    /* Score the detection set, not the detection order. A per-detection
       greedy pass lets an early detection claim a shared reference and
       strand a later one even when a free in-tolerance reference
       remains, and the same peak set then scores differently when
       listed in another order. Maximum bipartite matching (augmenting
       paths, each detection trying its nearest candidates first) counts
       the most true positives the geometry allows. */
    var candidates = [];
    for (var d0 = 0; d0 < detected.length; d0++) {
      var list = [];
      for (var r0 = 0; r0 < reference.length; r0++) {
        var dist0 = Math.abs(detected[d0] - reference[r0]);
        if (dist0 <= tolerance) list.push({ r: r0, dist: dist0 });
      }
      list.sort(function (a, b) { return a.dist - b.dist || a.r - b.r; });
      candidates.push(list);
    }
    var match = new Array(reference.length).fill(-1);
    function augment(d, seen) {
      var list = candidates[d];
      for (var i = 0; i < list.length; i++) {
        var r = list[i].r;
        if (seen[r]) continue;
        seen[r] = true;
        if (match[r] < 0 || augment(match[r], seen)) {
          match[r] = d;
          return true;
        }
      }
      return false;
    }
    for (var d = 0; d < detected.length; d++) {
      augment(d, new Array(reference.length).fill(false));
    }
    for (var r = 0; r < reference.length; r++) {
      if (match[r] >= 0) {
        matchedDetected[match[r]] = true;
        truePositives++;
        errors.push((detected[match[r]] - reference[r]) / fs * 1000);
      }
    }

    var falsePositives = detected.length - truePositives;
    var falseNegatives = reference.length - truePositives;

    var sensitivity = reference.length ? truePositives / reference.length : 0;
    var positivePredictivity = detected.length ? truePositives / detected.length : 0;
    var f1 = (sensitivity + positivePredictivity) > 0
      ? 2 * sensitivity * positivePredictivity / (sensitivity + positivePredictivity)
      : 0;

    var rmse = 0;
    if (errors.length) {
      var acc = 0;
      for (var e = 0; e < errors.length; e++) acc += errors[e] * errors[e];
      rmse = Math.sqrt(acc / errors.length);
    }

    return {
      truePositives: truePositives,
      falsePositives: falsePositives,
      falseNegatives: falseNegatives,
      sensitivity: sensitivity,
      positivePredictivity: positivePredictivity,
      f1: f1,
      rmseMs: rmse,
      matchedDetected: matchedDetected,
      errorsMs: errors
    };
  }

  /* ------------------------------------------------------------------ */
  /* Heart-rate variability                                               */
  /* ------------------------------------------------------------------ */

  /* R-R intervals in milliseconds derived from peak indices. */
  function rrIntervals(peaks, fs) {
    var intervals = [];
    for (var i = 1; i < peaks.length; i++) {
      intervals.push((peaks[i] - peaks[i - 1]) / fs * 1000);
    }
    return intervals;
  }

  /* Timestamps, in seconds, of each R-R interval. */
  function rrTimes(peaks, fs) {
    var times = [];
    for (var i = 1; i < peaks.length; i++) times.push(peaks[i] / fs);
    return times;
  }

  /* Time-domain HRV metrics. */
  function hrvTime(peaks, fs) {
    var rri = rrIntervals(peaks, fs);
    if (rri.length < 2) {
      return {
        rri: rri, meanNN: rri.length ? rri[0] : 0, sdnn: 0, rmssd: 0,
        pnn50: 0, sd1: 0, sd2: 0, sd1sd2: 0, cvnn: 0, cvsd: 0, sdnni: 0
      };
    }

    var differences = [];
    for (var i = 1; i < rri.length; i++) {
      differences.push(rri[i] - rri[i - 1]);
    }

    var meanNN = mean(rri);
    var sdnn = stddev(rri);
    var squared = 0;
    for (var d = 0; d < differences.length; d++) squared += differences[d] * differences[d];
    var rmssd = Math.sqrt(squared / differences.length);

    var over50 = 0;
    for (var c = 0; c < differences.length; c++) {
      if (Math.abs(differences[c]) > 50) over50++;
    }
    var pnn50 = over50 / differences.length * 100;

    /* Poincare axes and their standard deviations. */
    var x1 = [];
    var x2 = [];
    for (var p = 0; p + 1 < rri.length; p++) {
      x1.push((rri[p] - rri[p + 1]) / SQRT2);
      x2.push((rri[p] + rri[p + 1]) / SQRT2);
    }
    var sd1 = stddev(x1);
    var sd2 = stddev(x2);

    /* Mean of the standard deviations over 5-minute windows. Windows are
       bounded by elapsed cardiac time (the R-R series is irregularly
       sampled), not by a fixed count of intervals. */
    var sdnni = 0;
    var windowMs = 300000;
    var windowStds = [];
    var wStart = 0, elapsed = 0;
    for (var w = 0; w < rri.length; w++) {
      elapsed += rri[w];
      if (elapsed >= windowMs || w === rri.length - 1) {
        var slice = rri.slice(wStart, w + 1);
        if (slice.length > 1) windowStds.push(stddev(slice));
        wStart = w + 1;
        elapsed = 0;
      }
    }
    if (windowStds.length) sdnni = mean(windowStds);

    return {
      rri: rri,
      meanNN: meanNN,
      sdnn: sdnn,
      rmssd: rmssd,
      pnn50: pnn50,
      sd1: sd1,
      sd2: sd2,
      sd1sd2: sd2 > 0 ? sd1 / sd2 : 0,
      cvnn: meanNN > 0 ? sdnn / meanNN : 0,
      cvsd: meanNN > 0 ? rmssd / meanNN : 0,
      sdnni: sdnni
    };
  }

  /* ------------------------------------------------------------------ */
  /* Quadratic spline interpolation                                       */
  /* ------------------------------------------------------------------ */

  /* Not-a-knot knot vector, mirroring SciPy's _not_a_knot for even degree. */
  function notAKnotKnots(x, k) {
    var interior = [];
    for (var i = 0; i + 1 < x.length; i++) interior.push((x[i] + x[i + 1]) / 2);
    var k2 = Math.floor(k / 2);
    interior = interior.slice(k2, interior.length - k2);
    var knots = [];
    var j;
    for (j = 0; j <= k; j++) knots.push(x[0]);
    for (j = 0; j < interior.length; j++) knots.push(interior[j]);
    for (j = 0; j <= k; j++) knots.push(x[x.length - 1]);
    return knots;
  }

  /* Index of the knot span that contains x. */
  function findSpan(t, k, n, x) {
    if (x >= t[n]) return n - 1;
    if (x <= t[k]) return k;
    var lo = k;
    var hi = n;
    var mid = Math.floor((lo + hi) / 2);
    while (x < t[mid] || x >= t[mid + 1]) {
      if (x < t[mid]) hi = mid;
      else lo = mid;
      mid = Math.floor((lo + hi) / 2);
    }
    return mid;
  }

  /* Non-zero basis functions for a knot span, using the standard
     recurrence that avoids a factorial blow-up. */
  function basisFunctions(t, k, span, x) {
    var left = new Float64Array(k + 1);
    var right = new Float64Array(k + 1);
    var values = new Float64Array(k + 1);
    values[0] = 1;
    for (var j = 1; j <= k; j++) {
      left[j] = x - t[span + 1 - j];
      right[j] = t[span + j] - x;
      var saved = 0;
      for (var r = 0; r < j; r++) {
        var temp = values[r] / (right[r + 1] + left[j - r]);
        values[r] = saved + right[r + 1] * temp;
        saved = left[j - r] * temp;
      }
      values[j] = saved;
    }
    return values;
  }

  /* Solves a dense linear system with partial pivoting. */
  function solveLinearSystem(matrix, rhs) {
    var n = rhs.length;
    var a = matrix.map(function (row) { return row.slice(); });
    var b = rhs.slice();
    for (var col = 0; col < n; col++) {
      var pivot = col;
      for (var r = col + 1; r < n; r++) {
        if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
      }
      if (Math.abs(a[pivot][col]) < 1e-14) {
        throw new Error('Singular matrix in spline interpolation.');
      }
      if (pivot !== col) {
        var tmp = a[pivot];
        a[pivot] = a[col];
        a[col] = tmp;
        var tmpB = b[pivot];
        b[pivot] = b[col];
        b[col] = tmpB;
      }
      for (var row = col + 1; row < n; row++) {
        var factor = a[row][col] / a[col][col];
        if (factor === 0) continue;
        for (var c = col; c < n; c++) a[row][c] -= factor * a[col][c];
        b[row] -= factor * b[col];
      }
    }
    var solution = new Float64Array(n);
    for (var i = n - 1; i >= 0; i--) {
      var acc = b[i];
      for (var j = i + 1; j < n; j++) acc -= a[i][j] * solution[j];
      solution[i] = acc / a[i][i];
    }
    return solution;
  }

  /* Interpolates a series onto a regular grid with a quadratic
     not-a-knot spline, matching SciPy's make_interp_spline with k=2. */
  function quadraticSpline(x, y, xNew) {
    var k = 2;
    var n = x.length;
    if (n === 0) throw new RangeError('quadraticSpline requires at least one knot');
    for (var v = 0; v < n; v++) {
      if (!isFiniteNumber(x[v]) || !isFiniteNumber(y[v])) {
        throw new RangeError('quadraticSpline knots must be finite numbers');
      }
    }
    if (n < 3) {
      var flat = new Float64Array(xNew.length);
      for (var q = 0; q < xNew.length; q++) flat[q] = y[0];
      return flat;
    }

    var t = notAKnotKnots(x, k);
    var nt = t.length - k - 1;

    var matrix = [];
    for (var i = 0; i < n; i++) matrix.push(new Float64Array(nt));
    for (var i2 = 0; i2 < n; i2++) {
      var span = findSpan(t, k, nt, x[i2]);
      var basis = basisFunctions(t, k, span, x[i2]);
      for (var m = 0; m <= k; m++) matrix[i2][span - k + m] = basis[m];
    }

    var coefficients = solveLinearSystem(matrix, y);
    var out = new Float64Array(xNew.length);
    for (var p = 0; p < xNew.length; p++) {
      var s = findSpan(t, k, nt, xNew[p]);
      var b2 = basisFunctions(t, k, s, xNew[p]);
      var value = 0;
      for (var m2 = 0; m2 <= k; m2++) value += coefficients[s - k + m2] * b2[m2];
      out[p] = value;
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Welch power spectral density                                         */
  /* ------------------------------------------------------------------ */

  /* Estimates the one-sided power spectral density with Welch's method.

     Uses a periodic Hann window, 50 percent overlap, and density scaling. */
  function welchPsd(signal, fs, nperseg, nfft) {
    if (!isFiniteNumber(fs) || fs <= 0) {
      throw new RangeError('welchPsd requires a positive sampling rate, got ' + fs);
    }
    if (nperseg !== undefined && (!Number.isInteger(nperseg) || nperseg < 2)) {
      throw new RangeError('welchPsd segment length must be an integer of at least 2, got ' + nperseg);
    }
    if (nfft !== undefined && (!Number.isInteger(nfft) || nfft < 2)) {
      throw new RangeError('welchPsd nfft must be an integer of at least 2, got ' + nfft);
    }
    var n = signal.length;
    var segment = nperseg || Math.min(n, 256);
    if (segment > n) segment = n;
    /* A segment shorter than two samples has no computable spectrum: the
       Hann window is identically zero there, so report empty rather than
       emit NaN bins. */
    if (segment < 2) return { frequency: new Float64Array(0), power: new Float64Array(0) };
    /* The radix-2 FFT needs a power-of-two length; round nfft up to the
       next power of two and never let it drop below the segment length,
       which would silently discard samples. */
    var transform = 1;
    var requested = Math.max(nfft || segment, segment);
    while (transform < requested) transform <<= 1;
    var overlap = Math.floor(segment / 2);
    var step = segment - overlap;

    var window = new Float64Array(segment);
    var windowPower = 0;
    for (var i = 0; i < segment; i++) {
      window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / segment);
      windowPower += window[i] * window[i];
    }
    var scale = 1 / (fs * windowPower);

    var bins = Math.floor(transform / 2) + 1;
    var total = new Float64Array(bins);
    var count = 0;
    var start = 0;

    while (start + segment <= n) {
      var real = new Float64Array(transform);
      var imag = new Float64Array(transform);
      /* Remove each segment's mean before windowing (SciPy's default
         'constant' detrend). Without it the DC component leaks through the
         window sidelobes and inflates the low-frequency bins. */
      var segMean = 0;
      for (var sm = 0; sm < segment; sm++) segMean += signal[start + sm];
      segMean /= segment;
      for (var j = 0; j < segment; j++) {
        real[j] = (signal[start + j] - segMean) * window[j];
      }
      fft(real, imag);

      for (var b = 0; b < bins; b++) {
        var power = (real[b] * real[b] + imag[b] * imag[b]) * scale;
        /* One-sided spectrum: every interior bin doubles. DC never does,
           and the final bin doubles only when it is not the Nyquist
           (even-length transforms always end on the Nyquist). */
        if (b === 0 || (transform % 2 === 0 && b === bins - 1)) total[b] += power;
        else total[b] += power * 2;
      }
      count++;
      start += step;
    }

    if (count === 0) return { frequency: new Float64Array(0), power: new Float64Array(0) };

    var frequency = new Float64Array(bins);
    for (var f = 0; f < bins; f++) frequency[f] = f * fs / transform;

    for (var t2 = 0; t2 < bins; t2++) total[t2] /= count;
    return { frequency: frequency, power: total };
  }

  /* In-place radix-2 Cooley-Tukey FFT with zero padding. */
  function fft(real, imag) {
    var n = real.length;
    var j = 0;
    var i;
    for (i = 1; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        var tr = real[i]; real[i] = real[j]; real[j] = tr;
        var ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
      }
    }
    for (var len = 2; len <= n; len <<= 1) {
      var angle = -2 * Math.PI / len;
      var wReal = Math.cos(angle);
      var wImag = Math.sin(angle);
      for (var start = 0; start < n; start += len) {
        var curReal = 1;
        var curImag = 0;
        var half = len >> 1;
        for (var k = 0; k < half; k++) {
          var uReal = real[start + k];
          var uImag = imag[start + k];
          var vReal = real[start + k + half] * curReal - imag[start + k + half] * curImag;
          var vImag = real[start + k + half] * curImag + imag[start + k + half] * curReal;
          real[start + k] = uReal + vReal;
          imag[start + k] = uImag + vImag;
          real[start + k + half] = uReal - vReal;
          imag[start + k + half] = uImag - vImag;
          var nextReal = curReal * wReal - curImag * wImag;
          curImag = curReal * wImag + curImag * wReal;
          curReal = nextReal;
        }
      }
    }
  }

  /* Integrates a power spectrum over a frequency band. */
  function bandPower(psd, low, high) {
    var total = 0;
    for (var i = 1; i < psd.frequency.length; i++) {
      var f = psd.frequency[i];
      if (f >= low && f < high) {
        var df = psd.frequency[i] - psd.frequency[i - 1];
        total += 0.5 * (psd.power[i] + psd.power[i - 1]) * df;
      }
    }
    return total;
  }

  /* Frequency-domain HRV metrics.

     The R-R series is interpolated at 100 Hz and analysed with a Welch
     power spectral density estimate. */
  function hrvFrequency(peaks, fs, options) {
    var opts = options || {};
    var interpolationRate = opts.interpolationRate || 100;
    var lfBand = opts.lfBand || [0.04, 0.15];
    var hfBand = opts.hfBand || [0.15, 0.4];

    var rri = rrIntervals(peaks, fs);
    var times = rrTimes(peaks, fs);
    if (rri.length < 3) {
      return { lf: 0, hf: 0, lfHf: 0, totalPower: 0, lfNormalized: 0, hfNormalized: 0 };
    }

    var last = times[times.length - 1];
    var step = 1 / interpolationRate;
    var count = Math.floor((last - times[0]) / step) + 1;
    var grid = new Float64Array(count);
    for (var i = 0; i < count; i++) grid[i] = times[0] + i * step;

    var interpolated = quadraticSpline(times, rri, grid);

    var minFrequency = lfBand[0];
    var nperseg = Math.round((2 / minFrequency) * interpolationRate);
    var length = interpolated.length;
    if (nperseg > length / 2) nperseg = Math.floor(length / 2);
    if (nperseg < 2) {
      return { lf: 0, hf: 0, lfHf: 0, totalPower: 0, lfNormalized: 0, hfNormalized: 0 };
    }

    var psd = welchPsd(interpolated, interpolationRate, nperseg, nperseg * 2);
    var lf = bandPower(psd, lfBand[0], lfBand[1]);
    var hf = bandPower(psd, hfBand[0], hfBand[1]);
    var totalPower = lf + hf;

    return {
      lf: lf,
      hf: hf,
      lfHf: hf > 0 ? lf / hf : 0,
      totalPower: totalPower,
      lfNormalized: totalPower > 0 ? lf / totalPower : 0,
      hfNormalized: totalPower > 0 ? hf / totalPower : 0,
      psd: psd
    };
  }

  /* Full HRV report combining the time and frequency domains. */
  function computeHRV(peaks, fs, options) {
    var time = hrvTime(peaks, fs);
    var frequency = hrvFrequency(peaks, fs, options);
    return {
      meanNN: time.meanNN,
      sdnn: time.sdnn,
      rmssd: time.rmssd,
      pnn50: time.pnn50,
      sd1: time.sd1,
      sd2: time.sd2,
      sd1sd2: time.sd1sd2,
      cvnn: time.cvnn,
      cvsd: time.cvsd,
      sdnni: time.sdnni,
      lf: frequency.lf,
      hf: frequency.hf,
      lfHf: frequency.lfHf,
      lfNormalized: frequency.lfNormalized,
      hfNormalized: frequency.hfNormalized,
      totalPower: frequency.totalPower,
      rri: time.rri,
      rrTimes: rrTimes(peaks, fs)
    };
  }

  return {
    notch60: notch60,
    highpass: highpass,
    bandpass: bandpass,
    detectQRS: detectQRS,
    detectQRSEnsemble: detectQRSEnsemble,
    vectorMagnitude: vectorMagnitude,
    scoreDetection: scoreDetection,
    hrvTime: hrvTime,
    hrvFrequency: hrvFrequency,
    computeHRV: computeHRV,
    rrIntervals: rrIntervals,
    rrTimes: rrTimes,
    quadraticSpline: quadraticSpline,
    welchPsd: welchPsd,
    bandPower: bandPower,
    movingWindowAverage: movingWindowAverage,
    findLocalMaxima: findLocalMaxima
  };
});
