// Headless Chromium audit for the CardioWave DSP workbench.
// Run: node scripts/browser-audit.mjs
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  const candidates = [];
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try { candidates.push(execFileSync(npmCmd, ['root', '-g'], { encoding: 'utf8' }).trim() + '/package.json'); } catch {}
  candidates.push(path.join(homedir(), '.npm-global/lib/node_modules/omniroute/package.json'));
  let loaded = false;
  for (const anchor of candidates) {
    try {
      const req = createRequire(anchor);
      ({ chromium } = req('playwright'));
      loaded = true;
      break;
    } catch {}
  }
  if (!loaded) throw new Error('Playwright not found');
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pageUrl = pathToFileURL(path.join(root, 'index.html')).href;
const shotDir = path.join(tmpdir(), 'cardiowave-visual-audit');
fs.rmSync(shotDir, { recursive: true, force: true });
fs.mkdirSync(shotDir, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`);
};
const assert = (name, cond, detail = '') => {
  if (!cond) throw new Error(`${name}${detail ? ': ' + detail : ''}`);
};

const canvasPainted = id => {
  const c = document.getElementById(id);
  if (!c) return -1;
  const g = c.getContext('2d');
  if (!g || !c.width || !c.height) return 0;
  const data = g.getImageData(0, 0, c.width, c.height).data;
  const base = data[0] + ',' + data[1] + ',' + data[2] + ',' + data[3];
  let diff = 0;
  for (let i = 0; i < data.length; i += 4 * 17) {
    const px = data[i] + ',' + data[i + 1] + ',' + data[i + 2] + ',' + data[i + 3];
    if (px !== base) diff++;
  }
  return diff;
};

function a11yScan() {
  const visible = el => {
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  const labelFor = el => {
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return true;
    if (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) return true;
    return !!el.closest('label');
  };
  const controls = [...document.querySelectorAll('input,select,textarea')];
  const unlabeled = controls.filter(el => el.type !== 'hidden' && !labelFor(el)).map(el => el.id || el.name || el.type);
  const buttons = [...document.querySelectorAll('button,[role="button"]')];
  const nameless = buttons.filter(el => {
    const txt = (el.textContent || '').trim();
    return !txt && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby');
  }).map(el => el.id || el.className || el.tagName);
  const ids = [...document.querySelectorAll('[id]')].map(el => el.id);
  const dup = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  const skip = document.querySelector('.skip-link');
  const skipTarget = skip && skip.getAttribute('href') ? document.querySelector(skip.getAttribute('href')) : null;
  const interactives = [...document.querySelectorAll('button,select,input,textarea,a[href],[role="button"],[role="tab"],canvas[tabindex],pre[tabindex]')].filter(visible);
  const smallTargets = interactives.filter(el => {
    const r = el.getBoundingClientRect();
    return (r.width < 24 || r.height < 24) && !['INPUT'].includes(el.tagName);
  }).map(el => (el.id || el.textContent || el.tagName).trim().slice(0, 40));
  const badAriaTabs = [...document.querySelectorAll('[role="tab"]')].filter(tab => {
    const panel = document.getElementById(tab.getAttribute('aria-controls') || '');
    return !panel || panel.getAttribute('role') !== 'tabpanel';
  }).map(el => el.id);
  return { controls: controls.length, unlabeled, buttons: buttons.length, nameless, dup, skipTarget: !!skipTarget, smallTargets, badAriaTabs };
}

async function overflowState(page) {
  return page.evaluate(() => {
    const width = window.innerWidth;
    const scroll = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    const insideScroller = el => {
      for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
        const cs = getComputedStyle(node);
        if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && node.scrollWidth > node.clientWidth) return true;
      }
      return false;
    };
    const offenders = [...document.querySelectorAll('body *')]
      .filter(el => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && !insideScroller(el) && (r.right > width + 0.5 || r.left < -0.5);
      })
      .slice(0, 6)
      .map(el => {
        const r = el.getBoundingClientRect();
        return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String(el.className || '').split(' ')[0]}@${Math.round(r.left)}..${Math.round(r.right)}`;
      });
    return { overflow: scroll - width, offenders };
  });
}

async function checkNoOverflow(page, tag, label) {
  const s = await overflowState(page);
  check(`${tag} ${label} zero horizontal overflow`, s.overflow <= 0 && s.offenders.length === 0, `${s.overflow}px${s.offenders.length ? '; ' + s.offenders.join(', ') : ''}`);
}

async function auditViewport(browser, width, height) {
  const tag = `${width}x${height}`;
  const context = await browser.newContext({
    viewport: { width, height },
    acceptDownloads: true,
    colorScheme: 'dark',
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const requests = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.on('request', r => requests.push(r.url()));
  page.on('requestfailed', r => consoleErrors.push('requestfailed ' + r.url()));

  await page.goto(pageUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => window.CardioWaveApp && window.CardioWaveApp._state);
  const favicon = await page.getAttribute('link[rel="icon"]', 'href');
  check(`${tag} favicon is a data URI`, favicon && favicon.startsWith('data:'), favicon ? favicon.slice(0, 30) : 'missing');
  await checkNoOverflow(page, tag, 'initial');
  await page.screenshot({ path: path.join(shotDir, `cardiowave-${tag}-initial.png`) });

  await page.click('#run');
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('Generated'), null, { timeout: 15000 });
  const statCount = await page.locator('#stat-grid .stat').count();
  check(`${tag} run publishes 8 summary stats`, statCount === 8, String(statCount));
  const ecgPaint = await page.evaluate(canvasPainted, 'ecg-canvas');
  check(`${tag} lead II canvas painted`, ecgPaint > 80, `diff px=${ecgPaint}`);
  const poincarePaint = await page.evaluate(canvasPainted, 'poincare-live-canvas');
  check(`${tag} live Poincare canvas painted`, poincarePaint > 40, `diff px=${poincarePaint}`);
  await checkNoOverflow(page, tag, 'after run');
  await page.screenshot({ path: path.join(shotDir, `cardiowave-${tag}-run.png`) });

  await page.locator('#tab-workbench').focus();
  await page.keyboard.press('ArrowRight');
  let selected = await page.getAttribute('#tab-signal', 'aria-selected');
  check(`${tag} tab ArrowRight selects Signal`, selected === 'true', `selected=${selected}`);
  for (const id of ['leads-canvas', 'bode-canvas', 'stages-canvas']) {
    const painted = await page.evaluate(canvasPainted, id);
    check(`${tag} ${id} painted`, painted > 60, `diff px=${painted}`);
  }
  await checkNoOverflow(page, tag, 'signal tab');
  await page.screenshot({ path: path.join(shotDir, `cardiowave-${tag}-signal.png`) });

  await page.keyboard.press('3');
  selected = await page.getAttribute('#tab-hrv', 'aria-selected');
  const hrvRows = await page.locator('#hrv-body tr').count();
  check(`${tag} number key 3 opens populated HRV tab`, selected === 'true' && hrvRows >= 8, `selected=${selected} rows=${hrvRows}`);
  const tachoPaint = await page.evaluate(canvasPainted, 'tacho-canvas');
  const psdPaint = await page.evaluate(canvasPainted, 'psd-canvas');
  check(`${tag} HRV canvases painted`, tachoPaint > 40 && psdPaint > 40, `tacho=${tachoPaint} psd=${psdPaint}`);
  await checkNoOverflow(page, tag, 'HRV tab');

  await page.click('#tab-eval');
  await page.click('#run-suite');
  await page.waitForFunction(() => document.querySelectorAll('#suite-body tr').length >= 9, null, { timeout: 20000 });
  const suiteRows = await page.locator('#suite-body tr').count();
  check(`${tag} benchmark suite fills 9 cases`, suiteRows === 9, String(suiteRows));
  await page.click('#run-rhythm-bench');
  await page.waitForFunction(() => document.querySelectorAll('#rhythm-bench-body tr').length >= 10, null, { timeout: 20000 });
  const rhythmRows = await page.locator('#rhythm-bench-body tr').count();
  const accText = await page.textContent('#rhythm-bench-summary');
  check(`${tag} rhythm benchmark fills 10 strips`, rhythmRows === 10, `${rhythmRows}; ${String(accText).slice(0, 60)}`);
  await checkNoOverflow(page, tag, 'evaluation tab');
  await page.screenshot({ path: path.join(shotDir, `cardiowave-${tag}-evaluation.png`) });

  await page.click('#tab-export');
  await page.click('#build-export');
  await page.waitForFunction(() => document.getElementById('export-preview').textContent.includes('cardiowave-synthetic'));
  const exportDisabled = await page.evaluate(() => ['download-header', 'download-signals', 'download-ann'].map(id => document.getElementById(id).disabled));
  check(`${tag} WFDB build enables 3 downloads`, exportDisabled.every(v => v === false), exportDisabled.join(','));
  for (const [id, suffix] of [['download-header', '.hea'], ['download-signals', '.csv'], ['download-ann', '.qrs']]) {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#' + id)]);
    check(`${tag} ${suffix} download fires`, dl.suggestedFilename().endsWith(suffix), dl.suggestedFilename());
  }
  await page.click('#build-clinical');
  await page.waitForFunction(() => document.getElementById('report-preview').textContent.includes('SHA-256 fingerprint'));
  const clinicalState = await page.evaluate(() => ({
    disabled: ['download-csv', 'download-json', 'download-svg', 'print-strip'].map(id => document.getElementById(id).disabled),
    imgVisible: !document.getElementById('strip-preview').hidden,
    fingerprint: /[0-9a-f]{64}/.test(document.getElementById('report-preview').textContent),
  }));
  check(`${tag} clinical build enables outputs`, clinicalState.disabled.every(v => v === false) && clinicalState.imgVisible && clinicalState.fingerprint, JSON.stringify(clinicalState.disabled));
  for (const [id, suffix] of [['download-csv', '.csv'], ['download-json', '.json'], ['download-svg', '.svg']]) {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#' + id)]);
    check(`${tag} clinical ${suffix} download fires`, dl.suggestedFilename().endsWith(suffix), dl.suggestedFilename());
  }
  await checkNoOverflow(page, tag, 'export tab');
  await page.screenshot({ path: path.join(shotDir, `cardiowave-${tag}-export.png`) });

  const hash = await page.evaluate(() => location.hash);
  check(`${tag} run writes settings hash`, hash.length > 20, hash.slice(0, 30));
  const page2 = await context.newPage();
  const errors2 = [];
  page2.on('pageerror', e => errors2.push(String(e)));
  await page2.goto(pageUrl + hash, { waitUntil: 'load' });
  await page2.waitForFunction(() => window.CardioWaveApp && window.CardioWaveApp._state);
  const restoreStatus = await page2.textContent('#status');
  check(`${tag} hash restores controls`, /Restored [1-9][0-9]* settings/.test(restoreStatus), restoreStatus.slice(0, 80));
  check(`${tag} hash restore has no page errors`, errors2.length === 0, errors2[0] || 'clean');
  await page2.close();

  await page.click('#tab-docs');
  const a11y = await page.evaluate(a11yScan);
  check(`${tag} all form controls labelled`, a11y.unlabeled.length === 0, a11y.unlabeled.join(',') || `${a11y.controls} controls`);
  check(`${tag} all buttons have accessible names`, a11y.nameless.length === 0, a11y.nameless.join(',') || `${a11y.buttons} buttons`);
  check(`${tag} no duplicate ids`, a11y.dup.length === 0, a11y.dup.join(',') || 'clean');
  check(`${tag} skip link target exists`, a11y.skipTarget);
  check(`${tag} interactive targets at least 24px`, a11y.smallTargets.length === 0, a11y.smallTargets.join(',') || 'clean');
  check(`${tag} tab aria-controls resolve to tabpanels`, a11y.badAriaTabs.length === 0, a11y.badAriaTabs.join(',') || 'clean');
  await checkNoOverflow(page, tag, 'docs tab');
  await page.screenshot({ path: path.join(shotDir, `cardiowave-${tag}-docs.png`) });

  const external = requests.filter(u =>
    !u.startsWith('file:') && !u.startsWith('data:') && !u.startsWith('blob:') &&
    !u.startsWith('about:') && !u.startsWith('chrome:'));
  check(`${tag} zero external network requests`, external.length === 0, external.slice(0, 3).join(', ') || 'clean');
  check(`${tag} zero console errors`, consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || 'clean');
  check(`${tag} zero uncaught page errors`, pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || 'clean');
  await context.close();
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
for (const [w, h] of [[1440, 900], [390, 844]]) {
  try {
    await auditViewport(browser, w, h);
  } catch (e) {
    check(`${w}x${h} fatal`, false, String(e).slice(0, 300));
  }
}
await browser.close();
const failed = results.filter(r => !r.ok).length;
console.log(`\nBrowser audit: ${results.length} checks, ${results.length - failed} passed, ${failed} failed.`);
console.log(`Screenshots: ${shotDir}`);
process.exit(failed ? 1 : 0);
