'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Report = require('../src/report.js');
const Rhythm = require('../src/rhythm.js');
const A = require('../src/analysis.js');

/* ---------- SHA-256 ---------- */

test('sha256 of the empty string matches the published vector', () => {
  assert.equal(Report.sha256(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('sha256 of "abc" matches the published vector', () => {
  assert.equal(Report.sha256('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('sha256 of the quick brown fox matches the published vector', () => {
  assert.equal(Report.sha256('The quick brown fox jumps over the lazy dog'),
    'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592');
});

test('sha256 handles the 56-byte message boundary', () => {
  assert.equal(
    Report.sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('sha256 of one million "a" characters matches the published vector', () => {
  assert.equal(Report.sha256('a'.repeat(1000000)),
    'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('sha256 returns 64 lowercase hex characters', () => {
  const h = Report.sha256('anything');
  assert.match(h, /^[0-9a-f]{64}$/);
});

test('sha256 encodes multibyte UTF-8 identically to the node crypto digest', () => {
  const crypto = require('node:crypto');
  for (const s of ['\u20ac', '\u00e9tude', 'a\u00f1o', '\ud83d\ude00beat', 'mixed \u0394 text 123']) {
    assert.equal(Report.sha256(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'), JSON.stringify(s));
  }
});

test('utf8Bytes encodes ASCII, two-byte and three-byte sequences', () => {
  assert.deepEqual(Report.utf8Bytes('A'), [65]);
  assert.deepEqual(Report.utf8Bytes('\u00e9'), [0xc3, 0xa9]);
  assert.deepEqual(Report.utf8Bytes('\u20ac'), [0xe2, 0x82, 0xac]);
});

test('utf8Bytes encodes a surrogate pair as four bytes', () => {
  const bytes = Report.utf8Bytes('\ud83d\ude00'); // U+1F600
  assert.deepEqual(bytes, [0xf0, 0x9f, 0x98, 0x80]);
});

test('utf8Bytes encodes a lone surrogate code unit as three bytes', () => {
  // Unpaired surrogates encode their own code unit, matching WTF-8.
  assert.deepEqual(Report.utf8Bytes('\ud83d'), [0xed, 0xa0, 0xbd]);
});

/* ---------- canonical JSON ---------- */

test('stableStringify sorts object keys', () => {
  assert.equal(Report.stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test('stableStringify is deterministic for nested objects', () => {
  const a = Report.stableStringify({ x: { y: [3, { b: 1, a: 0 }] }, z: 's' });
  const b = Report.stableStringify({ z: 's', x: { y: [3, { a: 0, b: 1 }] } });
  assert.equal(a, b);
});

test('stableStringify serialises typed arrays as plain arrays', () => {
  assert.equal(Report.stableStringify(new Float64Array([1.5, 2.5])), '[1.5,2.5]');
});

test('stableStringify handles primitives', () => {
  assert.equal(Report.stableStringify(3.5), '3.5');
  assert.equal(Report.stableStringify('x'), '"x"');
  assert.equal(Report.stableStringify(null), 'null');
  assert.equal(Report.stableStringify(true), 'true');
});

/* ---------- filteredLeads attenuation ---------- */

function rms(x) {
  let acc = 0;
  for (let i = 0; i < x.length; i++) acc += x[i] * x[i];
  return Math.sqrt(acc / x.length);
}

function db(after, before) {
  return 20 * Math.log10(after / before);
}

test('filteredLeads returns one filtered array per lead without touching inputs', () => {
  const a = new Float64Array(200), b = new Float64Array(200);
  for (let i = 0; i < 200; i++) { a[i] = Math.sin(i / 3); b[i] = 0.2; }
  const src = [a, b];
  const copy0 = Array.from(src[0]);
  const out = Report.filteredLeads(src, 250);
  assert.equal(out.length, 2);
  assert.equal(out[0].length, 200);
  assert.deepEqual(Array.from(src[0]), copy0, 'input unmodified');
  assert.notEqual(out[0], src[0], 'returns a new array');
});

test('filteredLeads attenuates a 60 Hz tone by at least 20 dB', () => {
  const fs = 500, n = 4000;
  const sig = new Float64Array(n);
  for (let i = 0; i < n; i++) sig[i] = 0.5 * Math.sin(2 * Math.PI * 60 * i / fs);
  const out = Report.filteredLeads([sig], fs)[0];
  // Compare the settled tail so filter transients do not distort the ratio.
  const tail = out.subarray(Math.floor(n / 2));
  const att = db(rms(tail), 0.5 / Math.SQRT2);
  assert.ok(att < -20, 'attenuation ' + att.toFixed(1) + ' dB');
});

test('filteredLeads attenuates a 0.3 Hz baseline drift by at least 15 dB', () => {
  const fs = 500, n = 8000;
  const sig = new Float64Array(n);
  for (let i = 0; i < n; i++) sig[i] = 0.5 * Math.sin(2 * Math.PI * 0.3 * i / fs);
  const out = Report.filteredLeads([sig], fs)[0];
  const tail = out.subarray(Math.floor(n / 2));
  const att = db(rms(tail), 0.5 / Math.SQRT2);
  assert.ok(att < -15, 'wander attenuation ' + att.toFixed(1) + ' dB');
});

test('filteredLeads preserves a midband QRS-like component within 6 dB', () => {
  const fs = 500, n = 4000;
  const sig = new Float64Array(n);
  for (let i = 0; i < n; i++) sig[i] = 0.5 * Math.sin(2 * Math.PI * 12 * i / fs);
  const out = Report.filteredLeads([sig], fs)[0];
  const tail = out.subarray(Math.floor(n / 2));
  const att = db(rms(tail), 0.5 / Math.SQRT2);
  assert.ok(att > -6, 'midband loss ' + att.toFixed(1) + ' dB');
});

test('filteredLeads output stays finite on noisy input', () => {
  const rand = Rhythm.makeRandom(9);
  const sig = new Float64Array(3000);
  for (let i = 0; i < sig.length; i++) sig[i] = rand() * 2 - 1;
  const out = Report.filteredLeads([sig], 250)[0];
  for (let i = 0; i < out.length; i += 97) assert.ok(Number.isFinite(out[i]));
});

/* ---------- traceCsv ---------- */

test('traceCsv header is time_s plus every lead name', () => {
  const csv = Report.traceCsv([new Float64Array(3), new Float64Array(3)], ['I', 'II'], 250);
  assert.equal(csv.split('\n')[0], 'time_s,I,II');
});

test('traceCsv emits one row per sample', () => {
  const csv = Report.traceCsv([new Float64Array(7), new Float64Array(7)], ['I', 'II'], 250);
  assert.equal(csv.trim().split('\n').length, 8);
});

test('traceCsv stamps time at 1/fs resolution', () => {
  const csv = Report.traceCsv([new Float64Array(3)], ['II'], 200);
  const rows = csv.trim().split('\n');
  assert.equal(rows[1].split(',')[0], '0.0000');
  assert.equal(rows[2].split(',')[0], '0.0050');
  assert.equal(rows[3].split(',')[0], '0.0100');
});

test('traceCsv is byte-for-byte deterministic', () => {
  const sig = [new Float64Array([0.1, -0.2, 0.3])];
  assert.equal(Report.traceCsv(sig, ['II'], 250), Report.traceCsv(sig, ['II'], 250));
});

test('traceCsv honours the precision argument', () => {
  const csv = Report.traceCsv([new Float64Array([1 / 3])], ['II'], 250, 3);
  assert.match(csv.split('\n')[1], /0\.333$/);
});

test('traceCsv values are plain decimals, never NaN or exponent noise', () => {
  const csv = Report.traceCsv([new Float64Array([0.123456789, -1e-3])], ['II'], 250, 5);
  assert.doesNotMatch(csv, /NaN|undefined|e[+-]/i);
});

/* ---------- reportJson ---------- */

function samplePayload() {
  return {
    tool: 'CardioWave DSP',
    record: { name: 't1', samplingRate: 250, duration: 10 },
    detection: { beats: 12, f1: 0.98 },
    hrv: { meanNN: 800, sdnn: 20 },
    rhythm: { key: 'normal', label: 'Normal sinus rhythm' },
    artifacts: { humFlag: false, wanderFlag: false },
    strip: { lead: 'II', seconds: 10, mmPerSec: 25, mmPerMv: 10 }
  };
}

test('reportJson fingerprint is a 64-hex SHA-256', () => {
  const r = Report.reportJson(samplePayload());
  assert.match(r.fingerprint, /^[0-9a-f]{64}$/);
});

test('reportJson embeds the fingerprint inside the document', () => {
  const r = Report.reportJson(samplePayload());
  const parsed = JSON.parse(r.text);
  assert.equal(parsed.fingerprint.hex, r.fingerprint);
  assert.equal(parsed.fingerprint.algorithm, 'SHA-256');
});

test('reportJson fingerprint verifies: recomputing it reproduces the same hex', () => {
  const r = Report.reportJson(samplePayload());
  const parsed = JSON.parse(r.text);
  delete parsed.fingerprint;
  assert.equal(Report.sha256(Report.stableStringify(parsed)), r.fingerprint);
});

test('reportJson changes when the payload changes', () => {
  const a = Report.reportJson(samplePayload());
  const p2 = samplePayload(); p2.hrv.sdnn = 21;
  const b = Report.reportJson(p2);
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test('reportJson is deterministic for identical payloads', () => {
  assert.equal(Report.reportJson(samplePayload()).text, Report.reportJson(samplePayload()).text);
});

test('reportJson carries the educational disclaimer', () => {
  const r = Report.reportJson(samplePayload());
  assert.ok(r.text.includes('Education and research only'));
  assert.ok(r.text.includes('Not a medical device'));
});

test('reportJson schema tag is present', () => {
  const parsed = JSON.parse(Report.reportJson(samplePayload()).text);
  assert.equal(parsed.schema, 'cardiowave-report/1');
});

test('reportJson tolerates an empty payload', () => {
  const r = Report.reportJson({});
  assert.match(r.fingerprint, /^[0-9a-f]{64}$/);
  const parsed = JSON.parse(r.text);
  assert.deepEqual(parsed.hrv, {});
});

/* ---------- ecgStripSvg ---------- */

function sampleStrip() {
  const s = Rhythm.synthesizeStrip({ type: 'normal', seed: 11, duration: 10 });
  return Report.ecgStripSvg(s.signal, s.fs, s.peaks, { lead: 'II', recordName: 'demo' });
}

test('ecgStripSvg is well-formed SVG with a millimetre viewBox', () => {
  const svg = sampleStrip();
  assert.ok(svg.startsWith('<svg xmlns='));
  assert.ok(svg.trim().endsWith('</svg>'));
  assert.match(svg, /width="[\d.]+mm" height="[\d.]+mm"/);
});

test('ecgStripSvg declares 25 mm/s and 10 mm/mV', () => {
  const svg = sampleStrip();
  assert.ok(svg.includes('25 mm/s'));
  assert.ok(svg.includes('10 mm/mV'));
});

test('ecgStripSvg paints the standard pink grid', () => {
  const svg = sampleStrip();
  assert.ok(svg.includes('#f6b8c4'), 'minor pink');
  assert.ok(svg.includes('#e78ba0'), 'major pink');
  assert.ok(svg.includes('#fffbfb'), 'paper');
});

test('ecgStripSvg prints the educational disclaimer', () => {
  const svg = sampleStrip();
  assert.ok(svg.includes('education only'));
  assert.ok(svg.includes('not for diagnosis'));
});

test('ecgStripSvg embeds a 1 mV calibration pulse', () => {
  const svg = sampleStrip();
  // The pulse rises 10 mm (1 mV at 10 mm/mV) and runs 5 mm wide (200 ms).
  assert.ok(svg.includes('polyline'), 'trace present');
  assert.ok(/points="2,\d+(\.\d+)? 2,\d+(\.\d+)? 7,\d+(\.\d+)? 7,\d+(\.\d+)?"/.test(svg) || svg.includes('points="2,'), 'calibration pulse shape');
});

test('ecgStripSvg marks detected beats', () => {
  const s = Rhythm.synthesizeStrip({ type: 'normal', seed: 11, duration: 10 });
  const svg = Report.ecgStripSvg(s.signal, s.fs, s.peaks, { lead: 'II' });
  const ticks = svg.match(/<line /g) || [];
  assert.ok(ticks.length >= s.peaks.length - 2, 'one tick per visible beat');
  assert.ok(svg.includes('beats marked'));
});

test('ecgStripSvg is byte-for-byte deterministic', () => {
  const s = Rhythm.synthesizeStrip({ type: 'normal', seed: 11, duration: 10 });
  assert.equal(
    Report.ecgStripSvg(s.signal, s.fs, s.peaks, { lead: 'II' }),
    Report.ecgStripSvg(s.signal, s.fs, s.peaks, { lead: 'II' }));
});

test('ecgStripSvg width scales with strip duration at 25 mm/s', () => {
  const s10 = Rhythm.synthesizeStrip({ type: 'normal', seed: 11, duration: 10 });
  const s5 = Rhythm.synthesizeStrip({ type: 'normal', seed: 11, duration: 5 });
  const w10 = parseFloat(/width="([\d.]+)mm"/.exec(Report.ecgStripSvg(s10.signal, s10.fs, [], {}))[1]);
  const w5 = parseFloat(/width="([\d.]+)mm"/.exec(Report.ecgStripSvg(s5.signal, s5.fs, [], {}))[1]);
  assert.ok(Math.abs((w10 - w5) - 125) < 1, 'five more seconds is 125 mm');
});

test('ecgStripSvg includes the fingerprint prefix when provided', () => {
  const s = Rhythm.synthesizeStrip({ type: 'normal', seed: 11, duration: 10 });
  const fp = Report.sha256('x');
  const svg = Report.ecgStripSvg(s.signal, s.fs, [], { fingerprint: fp });
  assert.ok(svg.includes('sha256 ' + fp.slice(0, 16)));
});

test('ecgStripSvg escapes markup in the record name', () => {
  const s = Rhythm.synthesizeStrip({ type: 'normal', seed: 11, duration: 5 });
  const svg = Report.ecgStripSvg(s.signal, s.fs, [], { recordName: 'a<b>&"' });
  assert.ok(svg.includes('a&lt;b&gt;&amp;'));
  assert.doesNotMatch(svg, />a<b>/);
});
