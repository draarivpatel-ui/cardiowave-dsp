'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers.js');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
const ids = H.parseHtmlIds(html);
const tabIds = H.parseTabIds(html);

function freshApp() {
  // app.js is cached, so clear it to get a fresh module for each DOM.
  delete require.cache[require.resolve('../app.js')];
  const App = require('../app.js');
  const doc = H.createDom(ids, tabIds);
  const win = { devicePixelRatio: 1, addEventListener: function () {}, setTimeout: function (fn) { fn(); } };
  const state = App.boot(doc, win);
  return { App, doc, win, state };
}

test('index.html has complete tab, panel, control and accessibility wiring', () => {
  assert.equal(tabIds.length, 6);
  for (const id of tabIds) {
    assert.ok(html.includes('id="tab-' + id + '"'), 'tab ' + id);
    assert.ok(html.includes('id="panel-' + id + '"'), 'panel ' + id);
    assert.ok(html.includes('aria-labelledby="tab-' + id + '"'), 'labelled panel ' + id);
  }
  assert.ok(html.includes('role="tablist"'));
  assert.ok(html.includes('role="tabpanel"'));
  assert.ok(html.includes('class="skip-link"'));
  assert.ok(html.includes('aria-live="polite"'));
  assert.ok(html.includes('<main id="main"'));
  assert.ok(html.includes('viewport" content="width=device-width'));
  assert.ok(html.includes('Education and research only'));
  assert.ok(html.includes('not a medical device'));
  assert.ok(html.includes('failure modes'));
  assert.ok(html.includes('explicit baseline comparison'));
  for (const src of ['style.css', 'src/filters.js', 'src/cardio.js', 'src/analysis.js', 'app.js']) {
    assert.ok(html.includes(src), 'script or stylesheet ' + src);
  }
  // Every canvas has a text alternative.
  const canvasTags = html.match(/<canvas[^>]*>/g) || [];
  assert.ok(canvasTags.length >= 8);
  for (const tag of canvasTags) assert.ok(/aria-label="[^"]+"/.test(tag) || /role="img"/.test(tag), 'canvas alternative: ' + tag);
  // Every range input has a matching label and output.
  const ranges = html.match(/<input type="range"[^>]*>/g) || [];
  assert.ok(ranges.length >= 12);
  for (const tag of ranges) {
    const id = /id="([^"]+)"/.exec(tag)[1];
    assert.ok(html.includes('for="' + id + '"'), 'label for ' + id);
    assert.ok(html.includes('id="' + id + '-out"'), 'output for ' + id);
  }
});

test('CSS guards a 375px viewport with no horizontal overflow', () => {
  assert.ok(css.includes('@media (max-width: 375px)'));
  assert.ok(css.includes('overflow-x: hidden'));
  assert.ok(css.includes('max-width: 100%'));
  assert.ok(css.includes('@media (prefers-color-scheme: light)'));
  assert.ok(css.includes(':focus-visible'));
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'));
  assert.ok(css.includes('grid-template-columns'));
});

test('boot builds a working UI without a real browser', () => {
  const { doc, state } = freshApp();
  assert.equal(state.initialized, true);
  assert.equal(doc.getElementById('tab-workbench').getAttribute('aria-selected'), 'true');
  assert.equal(doc.getElementById('panel-workbench').getAttribute('hidden'), null);
  assert.equal(doc.getElementById('panel-hrv').getAttribute('hidden'), 'hidden');
  assert.ok(doc.getElementById('status').textContent.includes('Ready'));
  assert.ok(doc.getElementById('filter-body').children.length > 0, 'filter table rendered on boot');
  assert.ok(doc.getElementById('duration-out').textContent.includes('s'));
  assert.ok(doc.getElementById('ecg-canvas').getContext('2d').calls.stroke > 0, 'canvas drew something');
});

test('tab keyboard navigation follows the ARIA pattern', () => {
  const { doc } = freshApp();
  const first = doc.getElementById('tab-workbench');
  assert.equal(first.dispatch('keydown', { key: 'ArrowRight', preventDefault() {} }), 1);
  assert.equal(doc.getElementById('tab-signal').getAttribute('aria-selected'), 'true');
  assert.equal(first.getAttribute('tabindex'), '-1');
  assert.equal(doc.getElementById('tab-signal').getAttribute('tabindex'), '0');
  doc.getElementById('tab-signal').dispatch('keydown', { key: 'End', preventDefault() {} });
  assert.equal(doc.getElementById('tab-docs').getAttribute('aria-selected'), 'true');
  doc.getElementById('tab-docs').dispatch('keydown', { key: 'Home', preventDefault() {} });
  assert.equal(doc.getElementById('tab-workbench').getAttribute('aria-selected'), 'true');
  doc.getElementById('tab-workbench').dispatch('keydown', { key: 'ArrowLeft', preventDefault() {} });
  assert.equal(doc.getElementById('tab-docs').getAttribute('aria-selected'), 'true');
  doc.getElementById('tab-eval').dispatch('click');
  assert.equal(doc.getElementById('tab-eval').getAttribute('aria-selected'), 'true');
  assert.equal(doc.getElementById('panel-eval').getAttribute('hidden'), null);
});

test('number keys switch tabs and R regenerates the record', () => {
  const { doc, state } = freshApp();
  doc.dispatch('keydown', { key: '4', target: doc.body, preventDefault() {} });
  assert.equal(doc.getElementById('tab-eval').getAttribute('aria-selected'), 'true');
  assert.equal(state.getRecord(), null);
  doc.dispatch('keydown', { key: 'R', target: doc.body, preventDefault() {} });
  assert.ok(state.getRecord(), 'R generated a record');
  assert.ok(state.getEvaluation(), 'R produced an evaluation');
});

test('run button generates a record, plots and publishes a numerical summary', () => {
  const { doc, state } = freshApp();
  doc.getElementById('run').click();
  const record = state.getRecord();
  assert.equal(record.signals.length, 12);
  assert.equal(record.signals[0].length, 20 * 250);
  assert.ok(doc.getElementById('status').textContent.includes('Generated 12 leads'));
  assert.ok(doc.getElementById('stat-grid').children.length >= 8);
  assert.ok(doc.getElementById('hrv-body').children.length >= 10);
  assert.ok(doc.getElementById('score-body').children.length === 2);
  assert.ok(doc.getElementById('ecg-caption').textContent.includes('Lead II'));
  assert.ok(doc.getElementById('ecg-canvas').getContext('2d').calls.lineTo > 100);
  assert.ok(doc.getElementById('leads-canvas').getContext('2d').calls.stroke >= 12);
  assert.ok(doc.getElementById('bode-canvas').getContext('2d').calls.stroke >= 3);
  assert.ok(doc.getElementById('sweep-canvas').getContext('2d').calls.stroke >= 3);
});

test('preset selection updates controls and outputs', () => {
  const { doc, state } = freshApp();
  const preset = doc.getElementById('preset');
  preset.value = 'noisy';
  preset.dispatch('change');
  assert.equal(doc.getElementById('heartRate').value, '90');
  assert.equal(doc.getElementById('humAmplitude').value, '0.35');
  assert.ok(doc.getElementById('humAmplitude-out').textContent.includes('0.35'));
  doc.getElementById('run').click();
  assert.equal(state.getRecord().options.heartRate, 90);
  doc.getElementById('reset').click();
  assert.equal(doc.getElementById('heartRate').value, '72');
  assert.equal(doc.getElementById('preset').value, 'clinical');
});

test('slider input events update their live output text', () => {
  const { doc } = freshApp();
  const el = doc.getElementById('gate');
  el.value = '0.45';
  el.dispatch('input');
  assert.equal(doc.getElementById('gate-out').textContent, '0.45');
  const gain = doc.getElementById('export-gain');
  gain.value = '600';
  gain.dispatch('input');
  assert.equal(doc.getElementById('export-gain-out').textContent, '600');
});

test('detector overlay and lead window changes redraw without errors', () => {
  const { doc, state } = freshApp();
  doc.getElementById('run').click();
  const mode = doc.getElementById('detectorMode');
  mode.value = 'single';
  mode.dispatch('change');
  assert.ok(doc.getElementById('status').textContent.includes('overlay'));
  const windowEl = doc.getElementById('lead-window');
  windowEl.value = '10';
  windowEl.dispatch('change');
  assert.ok(state.getRecord());
});

test('benchmark suite button fills all nine rows and a summary', () => {
  const { doc } = freshApp();
  doc.getElementById('run-suite').click();
  assert.equal(doc.getElementById('suite-body').children.length, 9);
  assert.ok(doc.getElementById('suite-body').children[0].children.length === 10);
  assert.ok(doc.getElementById('suite-summary').children.length >= 4);
  assert.ok(doc.getElementById('suite-time').textContent.includes('Executed in'));
});

test('export builds header, CSV and annotation text and enables downloads', () => {
  const { doc, state } = freshApp();
  assert.equal(doc.getElementById('download-header').disabled, true);
  doc.getElementById('run').click();
  doc.getElementById('export-name').value = 'my record';
  doc.getElementById('export-leads').value = '3';
  doc.getElementById('build-export').click();
  const files = state.getExportFiles();
  assert.equal(files.name, 'my-record');
  assert.ok(files.header.startsWith('my-record 3 250 5000\n'));
  assert.ok(files.signals.startsWith('time_s,I,II,III\n'));
  assert.ok(files.signals.trim().split('\n').length === 5001);
  assert.ok(files.annotations.startsWith('# sample,time_s,type\n'));
  assert.equal(doc.getElementById('download-header').disabled, false);
  assert.ok(doc.getElementById('export-preview').textContent.includes('annotations:'));
  // The download helper tolerates an environment without Blob or URL.
  state.download('header', 'hea');
  assert.equal(doc.getElementById('status').attributes['data-kind'], 'warn');
});

test('all presets produce finite records and evaluation scores', () => {
  const { doc } = freshApp();
  for (const key of Object.keys(require('../app.js').PRESETS)) {
    const preset = doc.getElementById('preset');
    preset.value = key;
    preset.dispatch('change');
    doc.getElementById('run').click();
    assert.ok(doc.getElementById('status').textContent.startsWith('Generated'), 'preset ' + key);
    assert.ok(!doc.getElementById('status').textContent.includes('Engine error'), 'engine error on ' + key);
  }
});

test('rendered tables never show object, NaN or undefined strings', () => {
  const { doc } = freshApp();
  doc.getElementById('run').click();
  doc.getElementById('run-suite').click();
  const bodies = ['score-body', 'suite-body', 'filter-body', 'hrv-body'];
  for (const id of bodies) {
    const body = doc.getElementById(id);
    assert.ok(body.children.length > 0, id + ' has rows');
    for (const tr of body.children) {
      for (const td of tr.children) {
        const s = td.textContent;
        assert.ok(!s.includes('[object Object]'), id + ': ' + s);
        assert.ok(!s.includes('NaN'), id + ': ' + s);
        assert.ok(!s.includes('undefined'), id + ': ' + s);
      }
    }
  }
  // The Delta F1 column is the last cell of each suite row and carries
  // a signed three-decimal delta with a good/bad class.
  for (const tr of doc.getElementById('suite-body').children) {
    const cell = tr.children[tr.children.length - 1];
    assert.match(cell.textContent, /^[+-]\d+\.\d{3}$/, 'delta cell: ' + cell.textContent);
    assert.ok(cell.className === 'good' || cell.className === 'bad', 'delta class: ' + cell.className);
  }
  // The filter table verdict cells resolve to PASS or FAIL, not an object.
  for (const tr of doc.getElementById('filter-body').children) {
    const cell = tr.children[tr.children.length - 1];
    assert.ok(cell.textContent === 'PASS' || cell.textContent === 'FAIL', 'verdict: ' + cell.textContent);
  }
});
