# CardioWave DSP: workbench upgrade notes

This document records what changed when the repository grew from three bare `src/` engine modules and an empty `test/` folder into a complete, self-contained engineering workbench. It is written for a submission write-up, a demo script, and a reviewer who wants to know exactly what is new.

## Before and after

| Area | Before | After |
| --- | --- | --- |
| Browser entry point | none | responsive `index.html` with six tabs |
| Styling | none | `style.css` with dark and light themes and 375px mobile rules |
| Browser logic | none | `app.js` with Canvas plots, presets, live outputs, keyboard and ARIA wiring |
| Tests | empty `test/` folder | deterministic `node --test` suite covering engine, invariants, DOM and UI |
| Metadata | none | `package.json`, MIT `LICENSE`, `.nojekyll`, `.gitignore` |
| Documentation | none | `README.md` and this file |
| Verification | none | quantitative Evaluation tab with baseline comparison, nine-case benchmark suite, filter verification and documented failure modes |
| Export | none in the browser | browser-local WFDB `.hea`, `.csv` and `.qrs` text generation |

## New user-facing capabilities

### Interactive generator
Sixteen live controls cover record duration, sampling rate, mean heart rate, seed, beat jitter, RSA and Mayer amplitudes, respiration rate, mains hum, baseline wander, EMG amplitude and bandwidth, lead vote count, amplitude gate, cluster tolerance and detector mode. Six presets cover a clinical baseline, tachycardia, bradycardia, a heavy artefact stress case, a clean research reference and a high HRV case.

### Visualisation
- Lead II trace with solid markers for detections and dashed ground-truth markers.
- Twelve-lead small multiples with per-row auto-scaling and a selectable time window.
- Butterworth magnitude response curves for the QRS band-pass, mains notch and baseline high-pass.
- Three Pan-Tompkins stages: filtered signal, squared derivative and integration envelope.
- R-R tachogram, Poincare scatter and a Welch power spectrum with shaded LF and HF bands.
- Bar chart of F1, sensitivity and precision for both detectors.
- Vote-count sweep showing the sensitivity and precision trade-off.

### Quantitative evaluation
Every run scores both a single lead II Pan-Tompkins baseline and the twelve-lead voting ensemble against the generator's ground truth. The table reports detections, true positives, false positives, false negatives, sensitivity, precision, F1 and timing RMSE. A nine-case deterministic suite varies seeds, heart rates, sampling rates and artefact levels, then reports mean F1 for each detector, win counts and elapsed runtime. A filter verification table measures the real SOS response at six probe frequencies and marks each bound PASS or FAIL.

### Explicit failure modes
The Evaluation tab names and explains seven limitations: T-wave confusion, noise saturation, vote sensitivity, short-record spectral instability, synthetic ground truth, model mismatch, and medical-device status. The artefact stress preset and vote sweep make two of these visible as numbers rather than claims.

### Accessibility
WAI-ARIA tab semantics with full keyboard navigation, number-key tab shortcuts, R to regenerate, skip link, `aria-live` status announcements, labelled controls with live outputs, `role="img"` canvases with text alternatives, table duplicates of every plot, focus-visible outlines, reduced-motion support, and dark and light automatic colour schemes.

### Education and research disclaimer
The disclaimer appears in the page banner, the Evaluation failure list, the Docs tab, the generated WFDB header and the README. The workbench never claims clinical validity and never handles real patient data.

## Verification approach

`npm test` runs `node --test test/*.test.js`. The suite checks:

- Filter design validity, pole stability, coefficient finiteness and transfer function polynomial construction.
- Invalid order, frequency and type rejection.
- Zero-phase forward-backward symmetry on a symmetric impulse and padding length errors.
- Measured passband and stopband attenuation in decibels.
- Full 12-lead generator determinism across every sample and every lead, plus shape, beat count and option validation.
- Additive artefact behaviour, lead-independent noise realisations and zero-amplitude identity.
- QRS detector input validation, stage array shapes, monotonic peaks and extreme-noise robustness.
- Ensemble precision and F1 gain over the single lead baseline, vote trade-offs and one-to-one detection scoring invariants.
- HRV time and frequency invariants, spline knot interpolation, Welch spectral peak location and band integration.
- WFDB header, CSV and annotation formatting.
- HTML structure, ARIA wiring, labelled controls, canvas alternatives, CSS 375px rules, and absence of prohibited punctuation or mentions.
- Live DOM boot, tab keyboard navigation, number shortcuts, run and preset behaviour, live output updates, benchmark table population and export file construction.

The DOM and Canvas doubles live in `test/helpers.js` and are not used by the browser. They let the Node test suite exercise the real `app.js` boot path, event handlers and renderers without a browser or any external package.

## Zero-dependency guarantees

No npm dependencies, no dev dependencies, no CDN links, no fonts, no images, no network calls, no build step, no bundler and no server requirement. The four engine modules and the three browser scripts are plain JavaScript. The `.nojekyll` file keeps static hosting from filtering any asset, and `.gitignore` excludes only `node_modules`, logs and local system files.

## Demo walkthrough

1. Open `index.html`. The Clinical 12-lead, 72 bpm preset is loaded.
2. Press **Generate and analyse**. The status line reports 12 leads, 5000 samples, compute time and unmatched peak events.
3. Inspect the Lead II plot, then use keys `1` through `6` or click through Signal, HRV, Evaluation, Export and Docs.
4. On Evaluation, press **Run suite** to fill the nine-case benchmark table and the mean F1 summary. Note where the ensemble beats the baseline and where the noisy stress case degrades.
5. Choose the **Heavy artefact stress test** preset, regenerate, and compare the F1 and false-positive counts.
6. On WFDB export, build and download the `.hea`, `.csv` and `.qrs` files.
7. Run `npm test` in a terminal to show the deterministic verification suite.

## Files added or modified

Added: `index.html`, `style.css`, `app.js`, `package.json`, `LICENSE`, `.nojekyll`, `.gitignore`, `README.md`, `DEVPOST_UPGRADE.md`, `test/helpers.js`, `test/engine.test.js`, `test/ui.test.js`.

Unmodified: `src/cardio.js`, `src/filters.js`, `src/analysis.js`. The upgrade wraps the existing engines without changing their numerical behaviour, so previously computed results remain reproducible.
