# CardioWave DSP

A self-contained, zero-dependency engineering workbench for synthetic 12-lead ECG signals, Pan-Tompkins QRS detection, heart-rate variability analysis, deterministic rhythm classification, artefact metering, clinical-style exports and PhysioNet WFDB text export.

> **Education and research only.** This project generates synthetic signals and is not a medical device. It must not be used for diagnosis, treatment, monitoring, triage, or any clinical decision. No real patient data is used or stored.

**Live demo:** [https://aariv.me/cardiowave-dsp/](https://aariv.me/cardiowave-dsp/)

## Quick start

Open `index.html` in any modern browser. There is no build step, no package install, no server, and no network request. Every script is a plain browser file and every source module is a UMD wrapper that also loads under Node.

```sh
npm test
# or
node --test test/*.test.js
```

Node 18 or newer is required for `node --test`. The browser needs no specific Node version. The suite is verified at 336 passing tests, 0 failures, and a headless Chromium audit at 1440x900 and 390x844 reports zero console errors, zero uncaught page errors, zero external network requests and zero horizontal overflow.

## What is inside

| Path | Purpose |
| --- | --- |
| `index.html` | Responsive workbench with six tabs, WAI-ARIA tab pattern, live outputs, Canvas plots and tables |
| `style.css` | Dark and light themes, mobile rules down to 375px, focus rings, reduced-motion support |
| `app.js` | Browser wiring, plot renderers, presets, benchmark harness, WFDB text builders, keyboard handlers |
| `src/cardio.js` | McSharry dynamical ECG model, 12-lead projection, seeded RR series, additive artefacts |
| `src/filters.js` | Butterworth prototype design, SOS pairing, causal and zero-phase filtering, magnitude response |
| `src/analysis.js` | QRS detection, multi-lead voting, detection scoring, HRV metrics, spline interpolation, Welch PSD |
| `src/rhythm.js` | Deterministic six-class rhythm classifier, SampEn, Poincare ellipse, Goertzel hum and wander meters, annotated strip synthesis, benchmark scorer |
| `src/report.js` | Pure SHA-256, canonical JSON, filtered-trace CSV, fingerprinted report, printable 25 mm/s and 10 mm/mV pink-grid SVG strip |
| `test/engine.test.js` | Unit, edge-case and invariant tests for the engine modules and app helpers |
| `test/rhythm.test.js` | Closed-form HRV identities, classifier rule table, artefact flags, strip synthesis and end-to-end benchmark tests |
| `test/report.test.js` | SHA-256 vectors, canonical JSON, filter attenuation in decibels, CSV determinism and SVG strip checks |
| `test/ui.test.js` | DOM and accessibility smoke tests driven by a tiny dependency-free DOM stub |
| `test/app2.test.js` | Rhythm card, live Poincare, benchmark tables, clinical exports and URL-hash recovery in the stub DOM |
| `test/helpers.js` | Minimal DOM and Canvas double used only by the tests |

## Engine pipeline

1. A seeded mulberry32 generator and Box-Muller transform build a per-beat RR interval series with a Mayer wave (0.04 to 0.15 Hz), respiratory sinus arrhythmia (0.15 to 0.40 Hz) and Gaussian jitter.
2. A classical fourth-order Runge-Kutta integrator advances twelve coupled McSharry oscillators at four times the output sampling rate. Five warm-up beats are discarded.
3. Each lead is projected through a 12 by 5 P, Q, R, S, T amplitude matrix, rescaled to a millivolt range, and given an independent realisation of 60 Hz mains hum, low-frequency baseline wander and band-limited EMG noise.
4. The detector applies a 5 to 15 Hz Butterworth band-pass, differentiates, squares, integrates over a 120 ms window, then thresholds with adaptive signal and noise peak estimators.
5. The ensemble clusters detections across all twelve leads, requires a configurable number of lead votes, gates weak clusters, and refines each survivor onto the largest deflection of the spatial magnitude signal.
6. HRV metrics combine time-domain statistics, Poincare geometry and a 100 Hz interpolated Welch power spectral density estimate with LF and HF band powers.
7. The rhythm classifier reads the detected R-R series and applies an ordered, transparent rule set: compensatory-pause ectopy pairs first, then irregularly irregular dispersion plus sample entropy, then the sinus rate bands below 60 and above 100 bpm. Every verdict lists the measured quantities behind it.
8. Artefact meters measure 60 Hz mains hum and its 120 Hz harmonic with a Goertzel-style least-squares projection, and baseline wander as the RMS of a low-passed baseline estimate; millivolt thresholds drive both the flag chips and the artefact class.
9. Clinical exports pass every lead through the mains notch and baseline high-pass before writing the CSV, JSON report and printable strip, all deterministic and fingerprinted.

## Workbench tabs

- **Workbench.** Record, physiology, artefact and detector controls with six presets. Live Lead II plot with detected and ground-truth markers, a numeric run summary, an interactive Poincare scatter with SD1/SD2 ellipse and ectopy markers, and the deterministic rhythm classification card with artefact flags.
- **Signal & leads.** Twelve-lead small multiples, Butterworth magnitude response curves, and the three Pan-Tompkins stages.
- **HRV analysis.** Metric table, R-R tachogram, Poincare scatter and shaded Welch spectrum.
- **Evaluation.** Side-by-side baseline and ensemble scores, a nine-case deterministic benchmark suite, the ten-strip rhythm classifier benchmark with per-class sensitivity, specificity and F1, measured filter verification, a vote-count sweep, and a written list of known failure modes and limitations.
- **WFDB export.** Locally generated `.hea`, `.csv` and `.qrs` text with a preview and download buttons, plus the clinical bundle: filtered-trace CSV, fingerprinted JSON report and printable pink-grid SVG strip.
- **Docs.** Module map, pipeline, test commands, keyboard reference, disclaimer and licence.

## Quantitative evaluation

The Evaluation tab scores every detection against the generator's own phase-crossing ground truth with a 150 ms match tolerance. It reports true positives, false positives, false negatives, sensitivity, positive predictivity, F1 and timing RMSE for both a single lead II baseline and the twelve-lead voting ensemble.

The benchmark suite runs nine deterministic cases across seeds, heart rates from 48 to 128 bpm, sampling rates from 125 to 500 Hz, and artefact levels from silent to heavy. It reports the mean F1 of each detector and the number of cases where the ensemble wins. Expected behaviour: the ensemble markedly improves precision by rejecting T-wave candidates, while very high artefact levels and overly strict vote counts reduce sensitivity. Those failure modes are listed in the tab and demonstrated by the vote sweep plot.

The filter verification table measures the actual SOS magnitude response in decibels at six probe frequencies and marks each probe PASS or FAIL against an expected bound.

The rhythm classifier benchmark synthesizes ten annotated strips, two seeds for each of the six classes (normal sinus rhythm, bradycardia, tachycardia, irregularly irregular, premature ectopic beats and artefact-heavy), runs the real Pan-Tompkins detector on each, and scores the combined prediction one-versus-rest. Verified results on the shipped set: 10 of 10 strips correct for 100.0 percent accuracy, per-class sensitivity, specificity and F1 of 1.000, a mean absolute beat-rate error of 7.7 bpm, and a mean detection F1 of 0.93 against placed R peaks (the mains-hum and bradycardia strips are the hardest for the detector, which the table shows honestly).

## Clinical exports, print and URL state

One button builds three deterministic files: a filtered 12-lead CSV (mains notch plus baseline high-pass), a structured JSON report carrying detection scores, HRV metrics, the rhythm verdict and artefact meters with a SHA-256 fingerprint over its canonical form, and a printable single-lead SVG strip at the standard 25 mm/s, 10 mm/mV on a pink grid with a 1 mV calibration pulse and a non-diagnostic educational disclaimer. A print button isolates the strip for clean output.

Every run writes the full generator configuration into the URL hash, so a shared link restores identical records; the restore is verified in tests and by the browser audit.

## Accessibility and responsive layout

- Tabs implement the WAI-ARIA tab pattern: arrow keys, Home, End, Enter and Space. Number keys 1 through 6 jump to a tab, and R regenerates.
- All controls have visible labels and live output values. Canvases have `role="img"` and text alternatives; quantitative results are always also published as HTML tables.
- The colour palette is colour-blind safe, and markers differ by shape and line style as well as colour.
- `:focus-visible` outlines, a skip link, `aria-live` status messages, `prefers-reduced-motion`, and dark and light `prefers-color-scheme` support are included.
- At 375px the layout collapses to a single column, the header meta chips hide, tabs scroll horizontally, and `overflow-x: hidden` plus `max-width: 100%` keep every element inside the viewport.

## WFDB export format

The `.hea` first line is `record numberOfLeads samplingRate numberOfSamples`, followed by a CSV signal line with gain, ADC resolution and lead names. The CSV holds a time column plus one integer column per lead. The `.qrs` annotation list holds sample index, time in seconds and type `N`. These are WFDB compatible text files for education and research, not clinical records.

## Determinism and limits

Every parameter is seeded, so a given configuration always produces identical samples, peaks, scores and benchmark rows, and report fingerprints make the exports tamper evident. The McSharry model is a smooth ODE, not real electrophysiology: arrhythmias, ectopic beats, electrode detachment and pacemaker spikes are not modelled by the dynamical core (the benchmark's ectopic and irregular strips are authored interval patterns, not ODE output). Short synthetic records give coarse LF/HF spectral estimates. Scores measure agreement with the generator and the authored strip labels, which is synthetic ground truth, not clinical validation.

## Licence

MIT. See `LICENSE`. No third-party runtime dependencies and no external assets.
