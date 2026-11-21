/*
 * CardioWave DSP / Digital filter design and zero-phase filtering.
 *
 * A faithful, dependency-free port of the SciPy signal processing chain:
 * analogue Butterworth prototype -> frequency transformation -> bilinear
 * transform -> second-order section (SOS) cascade -> zero-phase filtering.
 *
 * For education and research only. Not a medical device and not for diagnosis.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    root.CardioWaveFilters = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var EPS = 2.220446049250313e-16;

  /* Complex helpers are kept as plain pairs [re, im] so that no typed
     array class is needed. */
  function c(re, im) {
    return [re, im || 0];
  }

  function cAdd(a, b) {
    return [a[0] + b[0], a[1] + b[1]];
  }

  function cSub(a, b) {
    return [a[0] - b[0], a[1] - b[1]];
  }

  function cMul(a, b) {
    return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
  }

  function cDiv(a, b) {
    var den = b[0] * b[0] + b[1] * b[1];
    if (den === 0) return [0, 0];
    return [(a[0] * b[0] + a[1] * b[1]) / den, (a[1] * b[0] - a[0] * b[1]) / den];
  }

  function cScale(a, s) {
    return [a[0] * s, a[1] * s];
  }

  function cSqrt(a) {
    /* Principal square root of a complex number. */
    var re = a[0];
    var im = a[1];
    if (re === 0 && im === 0) return [0, 0];
    var r = Math.sqrt(re * re + im * im);
    var t = Math.sqrt((r + re) / 2);
    var u = Math.sqrt((r - re) / 2);
    if (im < 0) u = -u;
    return [t, u];
  }

  function cConj(a) {
    return [a[0], -a[1]];
  }

  function cAbs(a) {
    return Math.sqrt(a[0] * a[0] + a[1] * a[1]);
  }

  function cIsReal(a) {
    return a[1] === 0;
  }

  function cProd(list) {
    var out = c(1, 0);
    for (var i = 0; i < list.length; i++) out = cMul(out, list[i]);
    return out;
  }

  function cRealPart(a) {
    return a[0];
  }

  /* ------------------------------------------------------------------ */
  /* Polynomial helpers                                                  */
  /* ------------------------------------------------------------------ */

  /* Builds the monic polynomial coefficients for a list of roots.

     Returns coefficients in descending power order, matching numpy.poly:
     [1, -sum(r), sum(r_i r_j), ...]. */
  function polyFromRoots(roots) {
    if (roots.length === 0) return [1];
    var coeffs = [c(1, 0)];
    for (var i = 0; i < roots.length; i++) {
      var neg = c(-roots[i][0], -roots[i][1]);
      var next = [];
      for (var j = 0; j <= coeffs.length; j++) next.push(c(0, 0));
      for (var j2 = 0; j2 < coeffs.length; j2++) {
        /* Multiply by (1 - root * z). */
        next[j2] = cAdd(next[j2], coeffs[j2]);
        next[j2 + 1] = cAdd(next[j2 + 1], cMul(coeffs[j2], neg));
      }
      coeffs = next;
    }
    /* SciPy returns a real result when every root has a matching conjugate. */
    var imags = roots.map(function (r) { return r[1]; });
    var sorted = imags.slice().sort(function (a, b) { return a - b; });
    var conjSorted = roots.map(function (r) { return -r[1]; }).sort(function (a, b) { return a - b; });
    var allConjugate = true;
    for (var m = 0; m < sorted.length; m++) {
      if (Math.abs(sorted[m] - conjSorted[m]) > 1e-9) {
        allConjugate = false;
        break;
      }
    }
    if (allConjugate) {
      return coeffs.map(function (v) { return v[0]; });
    }
    return coeffs.map(function (v) { return v[0]; });
  }

  /* ------------------------------------------------------------------ */
  /* Analogue Butterworth prototype                                       */
  /* ------------------------------------------------------------------ */

  /* buttap(N): analog lowpass Butterworth prototype with unit cutoff. */
  function buttap(order) {
    var z = [];
    var p = [];
    for (var m = -order + 1; m < order; m += 2) {
      p.push(c(-Math.cos(Math.PI * m / (2 * order)), -Math.sin(Math.PI * m / (2 * order))));
    }
    return { z: z, p: p, k: 1.0 };
  }

  function relativeDegree(z, p) {
    return p.length - z.length;
  }

  /* Lowpass prototype -> highpass with cutoff wo. */
  function lp2hpZpk(z, p, k, wo) {
    var degree = relativeDegree(z, p);
    var zHp = z.map(function (v) { return cDiv(c(wo, 0), v); });
    var pHp = p.map(function (v) { return cDiv(c(wo, 0), v); });
    for (var i = 0; i < degree; i++) zHp.push(c(0, 0));
    var kHp = k * cRealPart(cDiv(cProd(z.map(function (v) { return cScale(v, -1); })),
      cProd(p.map(function (v) { return cScale(v, -1); }))));
    return { z: zHp, p: pHp, k: kHp };
  }

  /* Lowpass prototype -> bandstop with centre wo and bandwidth bw. */
  function lp2bsZpk(z, p, k, wo, bw) {
    var degree = relativeDegree(z, p);
    var zHp = z.map(function (v) { return cDiv(c(bw / 2, 0), v); });
    var pHp = p.map(function (v) { return cDiv(c(bw / 2, 0), v); });

    var zBs = [];
    var pBs = [];
    var i;
    for (i = 0; i < zHp.length; i++) {
      var zs = cSqrt(cSub(cMul(zHp[i], zHp[i]), c(wo * wo, 0)));
      zBs.push(cAdd(zHp[i], zs));
      zBs.push(cSub(zHp[i], zs));
    }
    for (i = 0; i < pHp.length; i++) {
      var ps = cSqrt(cSub(cMul(pHp[i], pHp[i]), c(wo * wo, 0)));
      pBs.push(cAdd(pHp[i], ps));
      pBs.push(cSub(pHp[i], ps));
    }
    for (i = 0; i < degree; i++) zBs.push(c(0, wo));
    for (i = 0; i < degree; i++) zBs.push(c(0, -wo));

    var kBs = k * cRealPart(cDiv(cProd(z.map(function (v) { return cScale(v, -1); })),
      cProd(p.map(function (v) { return cScale(v, -1); }))));
    return { z: zBs, p: pBs, k: kBs };
  }

  /* Lowpass prototype -> bandpass with centre wo and bandwidth bw. */
  function lp2bpZpk(z, p, k, wo, bw) {
    var degree = relativeDegree(z, p);
    var zLp = z.map(function (v) { return cScale(v, bw / 2); });
    var pLp = p.map(function (v) { return cScale(v, bw / 2); });
    var zBp = [];
    var pBp = [];
    var i;
    for (i = 0; i < zLp.length; i++) {
      var zs = cSqrt(cSub(cMul(zLp[i], zLp[i]), c(wo * wo, 0)));
      zBp.push(cAdd(zLp[i], zs));
      zBp.push(cSub(zLp[i], zs));
    }
    for (i = 0; i < pLp.length; i++) {
      var ps = cSqrt(cSub(cMul(pLp[i], pLp[i]), c(wo * wo, 0)));
      pBp.push(cAdd(pLp[i], ps));
      pBp.push(cSub(pLp[i], ps));
    }
    for (i = 0; i < degree; i++) zBp.push(c(0, 0));
    return { z: zBp, p: pBp, k: k * Math.pow(bw, degree) };
  }

  /* Analog -> digital via the bilinear transform. */
  function bilinearZpk(z, p, k, fs) {
    var degree = relativeDegree(z, p);
    var fs2 = 2 * fs;
    var zZ = z.map(function (v) { return cDiv(cAdd(c(fs2, 0), v), cSub(c(fs2, 0), v)); });
    var pZ = p.map(function (v) { return cDiv(cAdd(c(fs2, 0), v), cSub(c(fs2, 0), v)); });
    for (var i = 0; i < degree; i++) zZ.push(c(-1, 0));
    var kZ = k * cRealPart(cDiv(
      cProd(z.map(function (v) { return cSub(c(fs2, 0), v); })),
      cProd(p.map(function (v) { return cSub(c(fs2, 0), v); }))));
    return { z: zZ, p: pZ, k: kZ };
  }

  /* ------------------------------------------------------------------ */
  /* Zero/pole to second-order sections                                  */
  /* ------------------------------------------------------------------ */

  /* Splits roots into conjugate pairs and real roots.

     Mirrors SciPy's _cplxreal: complex roots are averaged with their
     conjugates and returned once, real roots are returned separately. */
  function cplxreal(roots) {
    if (roots.length === 0) return { complex: [], real: [] };

    var tol = 100 * EPS;
    /* numpy.lexsort((abs(imag), real)) sorts primarily by real part and
       secondarily by the magnitude of the imaginary part. */
    var sorted = roots.slice().sort(function (a, b) {
      if (a[0] !== b[0]) return a[0] - b[0];
      return Math.abs(a[1]) - Math.abs(b[1]);
    });

    var realRoots = [];
    var complexRoots = [];
    for (var i = 0; i < sorted.length; i++) {
      if (Math.abs(sorted[i][1]) <= tol * cAbs(sorted[i])) {
        realRoots.push(sorted[i][0]);
      } else {
        complexRoots.push(sorted[i]);
      }
    }
    if (realRoots.length === roots.length) {
      return { complex: [], real: realRoots };
    }

    var zp = complexRoots.filter(function (r) { return r[1] > 0; });
    var zn = complexRoots.filter(function (r) { return r[1] < 0; });
    if (zp.length !== zn.length) {
      throw new Error('Array contains complex value with no matching conjugate.');
    }

    /* Pair each positive-imaginary root with the nearest negative one. */
    var averaged = new Array(zp.length);
    for (var p = 0; p < zp.length; p++) {
      var best = -1;
      var bestDist = Infinity;
      for (var q = 0; q < zn.length; q++) {
        var d = Math.abs(zp[p][0] - zn[q][0]) + Math.abs(zp[p][1] + zn[q][1]);
        if (d < bestDist) {
          bestDist = d;
          best = q;
        }
      }
      averaged[p] = [(zp[p][0] + zn[best][0]) / 2, (zp[p][1] - zn[best][1]) / 2];
    }
    return { complex: averaged, real: realRoots };
  }

  /* Index of the root closest to `to`, optionally restricted to real or
     complex roots. Mirrors SciPy's _nearest_real_complex_idx. */
  function nearestRealComplexIdx(roots, to, which) {
    var order = roots.map(function (r, i) { return { i: i, d: cAbs(cSub(r, to)) }; })
      .sort(function (a, b) { return a.d - b.d; });
    if (which === 'any') return order[0].i;
    for (var k = 0; k < order.length; k++) {
      var isReal = cIsReal(roots[order[k].i]);
      if (which === 'real' && isReal) return order[k].i;
      if (which === 'complex' && !isReal) return order[k].i;
    }
    return order[0].i;
  }

  /* Builds one second-order section from up to two zeros and two poles. */
  function singleZpksos(z, p, k) {
    var sos = [0, 0, 0, 0, 0, 0];
    var b = polyFromRoots(z).map(function (v) { return v * k; });
    var a = polyFromRoots(p);
    for (var i = 0; i < b.length; i++) sos[3 - b.length + i] = b[i];
    for (var j = 0; j < a.length; j++) sos[6 - a.length + j] = a[j];
    return sos;
  }

  /* Converts a zero-pole-gain system into second-order sections using
     SciPy's 'nearest' pairing strategy. */
  function zpk2sos(z, p, k) {
    if (z.length === 0 && p.length === 0) {
      return [[k, 0, 0, 1, 0, 0]];
    }

    var zeros = z.slice();
    var poles = p.slice();
    while (poles.length < zeros.length) poles.push(c(0, 0));
    while (zeros.length < poles.length) zeros.push(c(0, 0));
    var nSections = Math.floor((Math.max(poles.length, zeros.length) + 1) / 2);
    if (poles.length % 2 === 1) {
      poles.push(c(0, 0));
      zeros.push(c(0, 0));
    }

    var zSplit = cplxreal(zeros);
    var pSplit = cplxreal(poles);
    zeros = zSplit.complex.concat(zSplit.real.map(function (v) { return c(v, 0); }));
    poles = pSplit.complex.concat(pSplit.real.map(function (v) { return c(v, 0); }));

    /* Index of the pole closest to the unit circle, i.e. the "worst". */
    function idxWorst(list) {
      var worst = 0;
      var best = Infinity;
      for (var i = 0; i < list.length; i++) {
        var d = Math.abs(1 - cAbs(list[i]));
        if (d < best) {
          best = d;
          worst = i;
        }
      }
      return worst;
    }

    var sos = [];
    for (var i2 = 0; i2 < nSections; i2++) sos.push([0, 0, 0, 0, 0, 0]);

    for (var si = nSections - 1; si >= 0; si--) {
      var p1Idx = idxWorst(poles);
      var p1 = poles[p1Idx];
      poles.splice(p1Idx, 1);

      var realPoleCount = poles.filter(cIsReal).length;

      if (cIsReal(p1) && realPoleCount === 0) {
        /* Special case: the last remaining real pole. */
        var z1Idx = nearestRealComplexIdx(zeros, p1, 'real');
        var z1 = zeros[z1Idx];
        zeros.splice(z1Idx, 1);
        sos[si] = singleZpksos([z1, c(0, 0)], [p1, c(0, 0)], 1);
      } else if (poles.length + 1 === zeros.length && !cIsReal(p1) &&
        poles.filter(cIsReal).length === 1 && zeros.filter(cIsReal).length === 1) {
        /* Special case: one real pole and one real zero left over. */
        var z2Idx = nearestRealComplexIdx(zeros, p1, 'complex');
        var z2 = zeros[z2Idx];
        zeros.splice(z2Idx, 1);
        sos[si] = singleZpksos([z2, cConj(z2)], [p1, cConj(p1)], 1);
      } else {
        var p2;
        if (cIsReal(p1)) {
          var reals = [];
          for (var ri = 0; ri < poles.length; ri++) {
            if (cIsReal(poles[ri])) reals.push(ri);
          }
          var p2Idx = reals[idxWorst(reals.map(function (v) { return poles[v]; }))];
          p2 = poles[p2Idx];
          poles.splice(p2Idx, 1);
        } else {
          p2 = cConj(p1);
        }

        if (zeros.length > 0) {
          var zi1 = nearestRealComplexIdx(zeros, p1, 'any');
          var zz1 = zeros[zi1];
          zeros.splice(zi1, 1);

          if (!cIsReal(zz1)) {
            sos[si] = singleZpksos([zz1, cConj(zz1)], [p1, p2], 1);
          } else if (zeros.length > 0) {
            var zi2 = nearestRealComplexIdx(zeros, p1, 'real');
            var zz2 = zeros[zi2];
            zeros.splice(zi2, 1);
            sos[si] = singleZpksos([zz1, zz2], [p1, p2], 1);
          } else {
            sos[si] = singleZpksos([zz1], [p1, p2], 1);
          }
        } else {
          sos[si] = singleZpksos([], [p1, p2], 1);
        }
      }
    }

    sos[0][0] *= k;
    sos[0][1] *= k;
    sos[0][2] *= k;
    return sos;
  }

  /* ------------------------------------------------------------------ */
  /* Butterworth design                                                  */
  /* ------------------------------------------------------------------ */

  /* Designs a digital Butterworth filter and returns second-order sections.

     type is one of 'lowpass', 'highpass', 'bandpass' or 'bandstop'.
     Wn holds the critical frequencies in hertz. */
  function butter(order, Wn, type, fs) {
    if (!Number.isInteger(order) || order < 1) {
      throw new Error('Filter order must be a positive integer.');
    }
    if (!Array.isArray(Wn)) Wn = [Wn];
    var warped = Wn.map(function (w) {
      var wn = w / (fs / 2);
      if (!(wn > 0 && wn < 1)) {
        throw new Error('Digital filter critical frequencies must be 0 < Wn < fs/2.');
      }
      return 4 * Math.tan(Math.PI * wn / 2);
    });

    var proto = buttap(order);
    var z = proto.z;
    var p = proto.p;
    var k = proto.k;

    if (type === 'lowpass' || type === 'highpass') {
      if (warped.length !== 1) {
        throw new Error('Must specify a single critical frequency for lowpass or highpass filters.');
      }
      if (type === 'highpass') {
        var hp = lp2hpZpk(z, p, k, warped[0]);
        z = hp.z; p = hp.p; k = hp.k;
      } else {
        /* lp2lp_zpk with the prototype already at unit cutoff. */
        z = z.map(function (v) { return cScale(v, warped[0]); });
        p = p.map(function (v) { return cScale(v, warped[0]); });
        k = k * Math.pow(warped[0], relativeDegree(z, p));
      }
    } else if (type === 'bandpass' || type === 'bandstop') {
      if (warped.length !== 2) {
        throw new Error('Wn must specify start and stop frequencies for bandpass or bandstop filters.');
      }
      var bw = warped[1] - warped[0];
      if (!(bw > 0)) {
        throw new Error('Band edges must be in strictly ascending order.');
      }
      var wo = Math.sqrt(warped[0] * warped[1]);
      if (type === 'bandstop') {
        var bs = lp2bsZpk(z, p, k, wo, bw);
        z = bs.z; p = bs.p; k = bs.k;
      } else {
        var bp = lp2bpZpk(z, p, k, wo, bw);
        z = bp.z; p = bp.p; k = bp.k;
      }
    } else {
      throw new Error('Unknown filter type: ' + type);
    }

    var digital = bilinearZpk(z, p, k, 2.0);
    return zpk2sos(digital.z, digital.p, digital.k);
  }

  /* ------------------------------------------------------------------ */
  /* Filtering                                                           */
  /* ------------------------------------------------------------------ */

  /* Steady-state initial conditions for a single second-order section. */
  function lfilterZi(b, a) {
    if (a[0] === 0) throw new Error('First coefficient of parameter a must be non-zero.');
    var nb = b.slice();
    var na = a.slice();
    if (a[0] !== 1) {
      var scale = 1 / a[0];
      nb = nb.map(function (v) { return v * scale; });
      na = na.map(function (v) { return v * scale; });
    }
    var sumA = na.reduce(function (s, v) { return s + v; }, 0);
    if (sumA === 0) throw new Error('Filter not stable due to sum(a) == 0.');
    var sumB = nb.reduce(function (s, v) { return s + v; }, 0);
    var yInf = sumB / sumA;

    var n = Math.max(na.length, nb.length);
    while (nb.length < n) nb.push(0);
    while (na.length < n) na.push(0);

    /* zi[k] = zi[k+1] + b - y_inf * a, accumulated from the back. The
       steady-state vector has order = n - 1 entries, not n: allocating n
       leaves a stray hole at the end. */
    var zi = new Array(n - 1);
    var acc = 0;
    for (var i = n - 1; i >= 1; i--) {
      acc += (nb[i] - yInf * na[i]);
      zi[i - 1] = acc;
    }
    return zi;
  }

  /* Initial conditions for the whole SOS cascade. */
  function sosfiltZi(sos) {
    var zi = [];
    var scale = 1.0;
    for (var s = 0; s < sos.length; s++) {
      var b = sos[s].slice(0, 3);
      var a = sos[s].slice(3, 6);
      var sectionZi = lfilterZi(b, a).map(function (v) { return v * scale; });
      zi.push(sectionZi);
      var sumB = b.reduce(function (acc, v) { return acc + v; }, 0);
      var sumA = a.reduce(function (acc, v) { return acc + v; }, 0);
      scale *= sumB / sumA;
    }
    return zi;
  }

  /* Direct-form II transposed cascade, matching SciPy's sosfilt. */
  function sosfilt(sos, x, zi) {
    var n = x.length;
    var out = new Float64Array(n);
    if (!zi) {
      zi = [];
      for (var z = 0; z < sos.length; z++) zi.push([0, 0]);
    }
    var state = zi.map(function (section) { return [section[0], section[1]]; });
    var sample;
    for (var i = 0; i < n; i++) {
      sample = x[i];
      for (var s = 0; s < sos.length; s++) {
        var row = sos[s];
        var xNew = row[0] * sample + state[s][0];
        state[s][0] = row[1] * sample - row[4] * xNew + state[s][1];
        state[s][1] = row[2] * sample - row[5] * xNew;
        sample = xNew;
      }
      out[i] = sample;
    }
    return out;
  }

  /* Odd extension of a signal, mirroring SciPy's odd_ext.

     The left side reflects x[n] down to x[1] and the right side reflects
     x[len-2] down to x[len-n-1]. */
  function oddExt(x, n) {
    if (n < 1) return x.slice();
    var len = x.length;
    var left = new Float64Array(n);
    var right = new Float64Array(n);
    var i;
    for (i = 0; i < n; i++) left[i] = 2 * x[0] - x[n - i];
    for (i = 0; i < n; i++) right[i] = 2 * x[len - 1] - x[len - 2 - i];
    var out = new Float64Array(n + len + n);
    out.set(left, 0);
    out.set(x, n);
    out.set(right, n + len);
    return out;
  }

  /* Zero-phase forward-backward filtering, mirroring SciPy's sosfiltfilt.

     The signal is extended by odd reflection at both ends, filtered forward
     and then backward, and the extension is trimmed away. */
  function sosfiltfilt(sos, x) {
    var nSections = sos.length;
    var ntaps = 2 * nSections + 1;
    var zeroB2 = sos.filter(function (row) { return row[2] === 0; }).length;
    var zeroA2 = sos.filter(function (row) { return row[5] === 0; }).length;
    ntaps -= Math.min(zeroB2, zeroA2);

    var edge = ntaps * 3;
    if (x.length <= edge) {
      throw new Error('The length of the input vector x must be greater than padlen.');
    }

    var ext = oddExt(x, edge);
    var zi = sosfiltZi(sos);

    var ziScaled = zi.map(function (section) {
      return [section[0] * ext[0], section[1] * ext[0]];
    });
    var forward = sosfilt(sos, ext, ziScaled);

    var reversed = new Float64Array(forward.length);
    for (var i = 0; i < forward.length; i++) reversed[i] = forward[forward.length - 1 - i];

    var last = forward[forward.length - 1];
    var ziBack = zi.map(function (section) {
      return [section[0] * last, section[1] * last];
    });
    var backward = sosfilt(sos, reversed, ziBack);

    var out = new Float64Array(x.length);
    for (var j = 0; j < x.length; j++) {
      out[j] = backward[backward.length - 1 - (edge + j)];
    }
    return out;
  }

  /* Causal Butterworth filter with step-response initial conditions.

     This is the band-pass stage used by the QRS detector. */
  function butterFilterCausal(sos, x) {
    var mean = 0;
    for (var i = 0; i < x.length; i++) mean += x[i];
    mean = x.length ? mean / x.length : 0;
    var zi = sosfiltZi(sos).map(function (section) {
      return [section[0] * mean, section[1] * mean];
    });
    return sosfilt(sos, x, zi);
  }

  /* ------------------------------------------------------------------ */
  /* Frequency response                                                  */
  /* ------------------------------------------------------------------ */

  /* Magnitude response in dB of an SOS cascade at a given frequency. */
  function sosMagnitudeDb(sos, freq, fs) {
    var omega = 2 * Math.PI * freq / fs;
    var z = c(Math.cos(omega), Math.sin(omega));
    var zInv = cDiv(c(1, 0), z);
    var gain = 0;
    for (var s = 0; s < sos.length; s++) {
      var row = sos[s];
      var num = cAdd(cAdd(c(row[0], 0), cMul(c(row[1], 0), zInv)), cMul(c(row[2], 0), cMul(zInv, zInv)));
      var den = cAdd(cAdd(c(row[3], 0), cMul(c(row[4], 0), zInv)), cMul(c(row[5], 0), cMul(zInv, zInv)));
      gain += 20 * Math.log10(Math.max(cAbs(num) / Math.max(cAbs(den), 1e-300), 1e-300));
    }
    return gain;
  }

  return {
    butter: butter,
    zpk2sos: zpk2sos,
    sosfilt: sosfilt,
    sosfiltfilt: sosfiltfilt,
    sosfiltZi: sosfiltZi,
    butterFilterCausal: butterFilterCausal,
    sosMagnitudeDb: sosMagnitudeDb,
    polyFromRoots: polyFromRoots,
    buttap: buttap
  };
});
