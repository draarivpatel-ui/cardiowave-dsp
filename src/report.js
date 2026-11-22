/*
 * CardioWave DSP / deterministic export and reporting.
 *
 * Pure-JavaScript SHA-256, a canonical JSON writer, a filtered-trace CSV
 * builder, a structured analysis report, and a printable 25 mm/s,
 * 10 mm/mV pink-grid ECG strip rendered as an SVG string. No Date, no
 * randomness and no I/O: identical inputs produce identical bytes.
 *
 * For education and research only. Not a medical device and not for diagnosis.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory(require('./filters.js'), require('./analysis.js'));
  } else if (typeof define === 'function' && define.amd) {
    define(['./filters.js', './analysis.js'], factory);
  } else {
    root.CardioWaveReport = factory(root.CardioWaveFilters, root.CardioWaveAnalysis);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Filters, Analysis) {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* SHA-256                                                             */
  /* ------------------------------------------------------------------ */

  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function rotr(x, n) {
    return ((x >>> n) | (x << (32 - n))) >>> 0;
  }

  /* UTF-8 encoding without TextEncoder so the file works everywhere. */
  function utf8Bytes(str) {
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var code = str.charCodeAt(i);
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
        var lo = str.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          i++;
          var cp = 0x10000 + ((code - 0xd800) << 10) + (lo - 0xdc00);
          bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
            0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        } else {
          bytes.push(0xef, 0xbf, 0xbd);
        }
      } else {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      }
    }
    return bytes;
  }

  /* Full SHA-256 over a string, returned as lowercase hex. Verified
     against the published test vectors in the suite. */
  function sha256(str) {
    var bytes = utf8Bytes(str);
    var bitLenHi = Math.floor(bytes.length / 0x20000000);
    var bitLenLo = (bytes.length * 8) >>> 0;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    bytes.push((bitLenHi >>> 24) & 255, (bitLenHi >>> 16) & 255, (bitLenHi >>> 8) & 255, bitLenHi & 255,
      (bitLenLo >>> 24) & 255, (bitLenLo >>> 16) & 255, (bitLenLo >>> 8) & 255, bitLenLo & 255);

    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Array(64);
    var a, b, c, d, e, f, g, hh, t, i;

    for (var off = 0; off < bytes.length; off += 64) {
      for (t = 0; t < 16; t++) {
        w[t] = (bytes[off + t * 4] << 24) | (bytes[off + t * 4 + 1] << 16) |
          (bytes[off + t * 4 + 2] << 8) | bytes[off + t * 4 + 3];
      }
      for (t = 16; t < 64; t++) {
        var s0 = (rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3)) >>> 0;
        var s1 = (rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10)) >>> 0;
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }
      a = h[0]; b = h[1]; c = h[2]; d = h[3];
      e = h[4]; f = h[5]; g = h[6]; hh = h[7];
      for (t = 0; t < 64; t++) {
        var s1e = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
        var ch = ((e & f) ^ (~e & g)) >>> 0;
        var t1 = (hh + s1e + ch + K[t] + w[t]) >>> 0;
        var s0a = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
        var maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        var t2 = (s0a + maj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
      h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
      h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    var hex = '';
    for (i = 0; i < 8; i++) {
      hex += ('00000000' + h[i].toString(16)).slice(-8);
    }
    return hex;
  }

  /* ------------------------------------------------------------------ */
  /* Canonical JSON                                                      */
  /* ------------------------------------------------------------------ */

  /* Recursively converts a value into JSON with object keys in sorted
     order, so the same logical object always serialises to the same
     string. Typed arrays become plain arrays. */
  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (ArrayBuffer.isView(value)) {
      var arr = [];
      for (var i = 0; i < value.length; i++) arr.push(value[i]);
      return stableStringify(arr);
    }
    if (Array.isArray(value)) {
      var parts = [];
      for (var j = 0; j < value.length; j++) parts.push(stableStringify(value[j]));
      return '[' + parts.join(',') + ']';
    }
    var keys = Object.keys(value).sort();
    var pairs = [];
    for (var k = 0; k < keys.length; k++) {
      pairs.push(JSON.stringify(keys[k]) + ':' + stableStringify(value[keys[k]]));
    }
    return '{' + pairs.join(',') + '}';
  }

  /* ------------------------------------------------------------------ */
  /* Filtered signal exports                                             */
  /* ------------------------------------------------------------------ */

  /* Applies the mains notch and baseline-wander high-pass to every lead.
     Returns new arrays; the inputs are never touched. */
  function filteredLeads(signals, fs) {
    var out = [];
    for (var L = 0; L < signals.length; L++) {
      out.push(Analysis.highpass(Analysis.notch60(signals[L], fs), fs));
    }
    return out;
  }

  /* CSV of time plus one column per lead, values in millivolts at a
     fixed precision so the file is byte-for-byte reproducible. */
  function traceCsv(signals, leadNames, fs, precision) {
    var digits = precision === undefined ? 5 : precision;
    var n = signals[0].length;
    var lines = ['time_s,' + leadNames.join(',')];
    for (var i = 0; i < n; i++) {
      var row = [(i / fs).toFixed(4)];
      for (var L = 0; L < signals.length; L++) row.push(signals[L][i].toFixed(digits));
      lines.push(row.join(','));
    }
    return lines.join('\n') + '\n';
  }

  /* ------------------------------------------------------------------ */
  /* Structured JSON report                                              */
  /* ------------------------------------------------------------------ */

  /* Builds the analysis report object, fingerprints the canonical form
     with SHA-256, and returns the fingerprint alongside pretty-printed
     JSON text. The fingerprint covers every field except itself, so a
     reviewer can recompute it to prove the file was not edited. */
  function reportJson(payload) {
    var body = {
      schema: 'cardiowave-report/1',
      tool: payload.tool || 'CardioWave DSP',
      record: payload.record || {},
      detection: payload.detection || {},
      hrv: payload.hrv || {},
      rhythm: payload.rhythm || {},
      artifacts: payload.artifacts || {},
      strip: payload.strip || {},
      disclaimer: 'Synthetic signal. Education and research only. Not a medical device. Not for diagnosis.'
    };
    var fingerprint = sha256(stableStringify(body));
    body.fingerprint = {
      algorithm: 'SHA-256',
      canonical: 'stable-json-v1',
      hex: fingerprint
    };
    return {
      object: body,
      text: JSON.stringify(body, null, 2) + '\n',
      fingerprint: fingerprint
    };
  }

  /* ------------------------------------------------------------------ */
  /* Printable ECG strip (standard 25 mm/s, 10 mm/mV pink grid)         */
  /* ------------------------------------------------------------------ */

  function r2(v) {
    return Math.round(v * 100) / 100;
  }

  /* Renders a single-lead strip as an SVG whose user units are true
     millimetres. The grid uses two stacked patterns: 1 mm fine pink
     squares and darker 5 mm major squares, matching standard ECG paper.
     A 1 mV x 200 ms calibration pulse precedes the trace. */
  function ecgStripSvg(signal, fs, peaks, options) {
    var o = options || {};
    var mmPerSec = o.mmPerSec || 25;
    var mmPerMv = o.mmPerMv || 10;
    var dur = signal.length / fs;
    var headMm = 14;
    var footMm = 10;
    var plotMm = o.plotMm || 30;
    var marginX = 9;
    var wMm = r2(dur * mmPerSec + marginX);
    var hMm = headMm + plotMm + footMm;
    var yBase = headMm + plotMm / 2;

    var parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" role="img" ' +
      'aria-label="Printable ECG strip" width="' + r2(wMm) + 'mm" height="' + r2(hMm) +
      'mm" viewBox="0 0 ' + r2(wMm) + ' ' + r2(hMm) + '">');
    parts.push('<defs>' +
      '<pattern id="grid-minor" width="1" height="1" patternUnits="userSpaceOnUse">' +
      '<path d="M 1 0 L 0 0 0 1" fill="none" stroke="#f6b8c4" stroke-width="0.09"/></pattern>' +
      '<pattern id="grid-major" width="5" height="5" patternUnits="userSpaceOnUse">' +
      '<path d="M 5 0 L 0 0 0 5" fill="none" stroke="#e78ba0" stroke-width="0.16"/></pattern>' +
      '</defs>');
    parts.push('<rect width="' + r2(wMm) + '" height="' + r2(hMm) + '" fill="#fffbfb"/>');
    parts.push('<rect width="' + r2(wMm) + '" height="' + r2(hMm) + '" fill="url(#grid-minor)"/>');
    parts.push('<rect width="' + r2(wMm) + '" height="' + r2(hMm) + '" fill="url(#grid-major)"/>');

    /* Calibration pulse: 1 mV for 200 ms is a 10 mm tall, 5 mm wide step
       at 10 mm/mV and 25 mm/s. */
    var calX = 2;
    parts.push('<polyline fill="none" stroke="#1f2430" stroke-width="0.3" points="' +
      r2(calX) + ',' + r2(yBase) + ' ' + r2(calX) + ',' + r2(yBase - 10) + ' ' +
      r2(calX + 5) + ',' + r2(yBase - 10) + ' ' + r2(calX + 5) + ',' + r2(yBase) + '"/>');

    /* Trace, clipped to the plot band via the same polyline the canvas
       version draws. Values outside the band saturate at the edge. */
    var n = signal.length;
    var x0 = marginX;
    var min = Infinity, max = -Infinity;
    for (var i = 0; i < n; i++) {
      if (signal[i] < min) min = signal[i];
      if (signal[i] > max) max = signal[i];
    }
    var pts = [];
    for (i = 0; i < n; i++) {
      var x = x0 + (i / fs) * mmPerSec;
      var y = yBase - signal[i] * mmPerMv;
      var yMin = headMm + 0.4, yMax = headMm + plotMm - 0.4;
      if (y < yMin) y = yMin;
      if (y > yMax) y = yMax;
      pts.push(r2(x) + ',' + r2(y));
    }
    parts.push('<polyline fill="none" stroke="#1f2430" stroke-width="0.28" points="' +
      pts.join(' ') + '"/>');

    /* Detected beat ticks sit just above the plot band. */
    if (peaks && peaks.length) {
      var marks = [];
      for (var p = 0; p < peaks.length; p++) {
        var px = x0 + (peaks[p] / fs) * mmPerSec;
        if (px > x0 && px < wMm - 0.5) {
          marks.push('<line x1="' + r2(px) + '" y1="' + r2(headMm - 3.4) +
            '" x2="' + r2(px) + '" y2="' + r2(headMm - 0.6) + '" stroke="#b03a52" stroke-width="0.35"/>');
        }
      }
      if (marks.length) parts.push(marks.join(''));
    }

    var lead = o.lead || 'II';
    var name = o.recordName || 'cardiowave-strip';
    var fpx = 'font-family="ui-monospace, monospace" fill="#7a2c3e"';
    parts.push('<text x="1.5" y="4.2" font-size="3" ' + fpx + '>' + esc(name) + ' | Lead ' + esc(lead) +
      ' | ' + (peaks ? peaks.length : 0) + ' beats marked</text>');
    parts.push('<text x="1.5" y="8.6" font-size="3" ' + fpx + '>' + mmPerSec + ' mm/s  |  ' +
      mmPerMv + ' mm/mV  |  ' + fs + ' Hz  |  ' + r2(dur) + ' s</text>');
    var right = 'synthetic ECG - education only - not for diagnosis';
    if (o.fingerprint) right += ' | sha256 ' + o.fingerprint.slice(0, 16);
    parts.push('<text x="' + r2(wMm - 1.5) + '" y="' + r2(hMm - 3) + '" font-size="2.6" ' +
      'text-anchor="end" ' + fpx + '>' + esc(right) + '</text>');
    parts.push('</svg>');
    return parts.join('\n') + '\n';
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  return {
    sha256: sha256,
    utf8Bytes: utf8Bytes,
    stableStringify: stableStringify,
    filteredLeads: filteredLeads,
    traceCsv: traceCsv,
    reportJson: reportJson,
    ecgStripSvg: ecgStripSvg
  };
});
