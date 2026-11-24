'use strict';
/* CardioWave DSP repository hygiene: security metadata, offline guarantees,
   punctuation and wording rules, and shipped-file requirements. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = f => fs.existsSync(path.join(ROOT, f));

const SHIPPED = ['index.html', 'style.css', 'app.js',
  'src/cardio.js', 'src/filters.js', 'src/analysis.js',
  'test/helpers.js', 'test/engine.test.js', 'test/engine2.test.js',
  'test/ui.test.js', 'test/hygiene.test.js',
  'package.json', 'README.md', 'LICENSE', '.gitignore'];

test('index.html carries a restrictive Content-Security-Policy', () => {
  const m = read('index.html').match(/<meta[^>]+http-equiv="Content-Security-Policy"[^>]*>/i);
  assert.ok(m, 'CSP meta tag missing');
  const tag = m[0].toLowerCase();
  /* frame-ancestors is deliberately absent: browsers ignore it inside a
     meta element and log an error, so it only belongs in a real header. */
  assert.ok(!tag.includes('frame-ancestors'), 'frame-ancestors must not sit in a meta CSP');
  for (const d of ['default-src', 'script-src', 'connect-src', 'object-src', 'base-uri', 'form-action']) {
    assert.ok(tag.includes(d), 'CSP missing ' + d);
  }
  assert.ok(tag.includes("connect-src 'none'"));
  assert.ok(tag.includes("script-src 'self'"));
  assert.ok(!tag.includes('unsafe-eval'));
});

test('index.html carries a Permissions-Policy', () => {
  const m = read('index.html').match(/<meta[^>]+http-equiv="Permissions-Policy"[^>]*>/i);
  assert.ok(m, 'Permissions-Policy missing');
  for (const f of ['geolocation', 'camera', 'microphone', 'payment', 'usb']) {
    assert.ok(m[0].toLowerCase().includes(f + '=()'), 'missing ' + f);
  }
});

test('no external URLs, scripts, stylesheets, fonts or iframes', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /src=["']\/\//);
  assert.doesNotMatch(html, /<iframe/i);
  assert.doesNotMatch(read('style.css'), /@import|url\(/i);
});

test('no network calls, dynamic code execution or HTML sinks in scripts', () => {
  for (const f of ['app.js', 'src/cardio.js', 'src/filters.js', 'src/analysis.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/, f);
    assert.doesNotMatch(src, /\beval\s*\(|new Function/, f);
    assert.doesNotMatch(src, /\.innerHTML\s*=[^=]|outerHTML|insertAdjacentHTML|document\.write/, f);
  }
});

test('no secret-shaped strings in shipped files', () => {
  for (const f of SHIPPED) {
    assert.doesNotMatch(read(f), /api[_-]?key\s*[:=]|token\s*[:=]|password\s*[:=]|secret\s*[:=]/i, f);
  }
});

test('every shipped file has no em or en dashes', () => {
  const EM = String.fromCharCode(0x2014), EN = String.fromCharCode(0x2013);
  for (const f of SHIPPED) {
    const text = read(f);
    assert.ok(!text.includes(EM), 'em dash in ' + f);
    assert.ok(!text.includes(EN), 'en dash in ' + f);
  }
});

test('no model or vendor attribution strings in shipped files', () => {
  const pat = new RegExp(['clau' + 'de', 'chat' + 'gpt', 'open' + 'ai', 'l' + 'lm', 'gp' + 't-[0-9]', 'anthro' + 'pic', 'de' + 'vin'].join('|'), 'i');
  for (const f of SHIPPED) {
    if (f === 'test/hygiene.test.js') continue;
    assert.doesNotMatch(read(f), pat, f);
  }
});

test('no smooth scrolling anywhere', () => {
  for (const f of SHIPPED) assert.doesNotMatch(read(f), /scroll-behavior:\s*smooth/i, f);
});

test('the title stands alone: no tagline or kicker copy', () => {
  const html = read('index.html');
  assert.ok(/<h1[^>]*>/.test(html));
  assert.doesNotMatch(html, /class=["'][^"']*(tagline|subtitle|kicker|eyebrow|lede|panel-tag|panel-intro)/i);
});

test('synthetic-only and not-a-medical-device disclaimers are present', () => {
  const html = read('index.html');
  assert.match(html, /not a medical device/i);
  assert.match(html, /synthetic/i);
  assert.match(html, /not.*(diagnosis|clinical)/i);
});

test('LICENSE is MIT and matches package.json', () => {
  assert.match(read('LICENSE'), /MIT License/);
  assert.equal(JSON.parse(read('package.json')).license, 'MIT');
});

test('README documents offline use, the synthetic-only rule and tests', () => {
  const md = read('README.md');
  assert.match(md, /synthetic/i);
  assert.match(md, /not a medical device/i);
  assert.match(md, /npm test|node --test/);
  assert.match(md, /offline|no .*network|zero.dependenc/i);
});

test('.nojekyll and .gitignore exist for Pages serving and hygiene', () => {
  assert.ok(exists('.nojekyll'));
  assert.match(read('.gitignore'), /node_modules|DS_Store/);
});

test('every id is unique, every label resolves, every tab wires its panel', () => {
  const html = read('index.html');
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'duplicate ids');
  for (const m of html.matchAll(/for="([^"]+)"/g)) {
    assert.ok(ids.includes(m[1]), 'for=' + m[1]);
  }
  for (const m of html.matchAll(/aria-controls="([^"]+)"/g)) {
    assert.ok(ids.includes(m[1]), 'aria-controls=' + m[1]);
  }
});

test('skip link target exists and is focusable', () => {
  const html = read('index.html');
  const skip = html.match(/<a\b(?=[^>]*class="[^"]*skip[^"]*")(?=[^>]*href="#([^"]+)")[^>]*>/i);
  assert.ok(skip, 'skip link missing');
  const target = html.match(new RegExp('id="' + skip[1] + '"[^>]*>'));
  assert.ok(target, 'skip target missing');
  assert.match(target[0], /tabindex="-1"/);
});

test('tabs are ARIA-complete and canvases carry text alternatives', () => {
  const html = read('index.html');
  for (const m of html.matchAll(/role="tab"[^>]*>/g)) {
    assert.match(m[0], /aria-selected/, 'tab missing aria-selected');
    assert.match(m[0], /aria-controls/, 'tab missing aria-controls');
  }
  const canvases = [...html.matchAll(/<canvas[^>]*>/g)].map(m => m[0]);
  assert.ok(canvases.length >= 4, 'expected several canvases');
  for (const c of canvases) {
    assert.match(c, /aria-label|role="img"/, 'canvas missing text alternative');
  }
});

test('live regions and the alert role announce status changes', () => {
  const html = read('index.html');
  assert.ok((html.match(/aria-live/g) || []).length >= 2);
});
