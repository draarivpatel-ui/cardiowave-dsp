'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Analysis = require('../src/analysis.js');
const Rhythm = require('../src/rhythm.js');

test('L507: a constant DC offset is not reported as baseline wander', () => {
  const fs = 250;
  const flatOffset = new Float64Array(1000).fill(0.5);
  const a = Rhythm.analyzeArtifacts(flatOffset, fs);
  assert.equal(a.wanderFlag, false, `flat offset flagged with ${a.wanderMv} mV`);
  assert.ok(a.wanderMv < 0.01, `wander RMS ${a.wanderMv}`);
});

test('L507: HRV total power includes VLF power below the LF band', () => {
  const fs = 250;
  const peaks = [];
  let t = 0;
  for (let i = 0; i < 400; i++) {
    t += 0.8 + 0.15 * Math.sin(2 * Math.PI * 0.02 * t) + 0.03 * Math.sin(2 * Math.PI * 0.25 * t);
    peaks.push(Math.round(t * fs));
  }
  const h = Analysis.hrvFrequency(peaks, fs);
  assert.ok(h.totalPower > h.lf + h.hf, `total ${h.totalPower} should exceed LF+HF ${h.lf + h.hf}`);
  assert.ok(h.lfNormalized + h.hfNormalized < 1, 'normalised LF and HF must leave room for VLF');
});
