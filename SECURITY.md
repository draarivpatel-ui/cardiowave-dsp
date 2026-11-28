# Security policy

## Reporting a vulnerability

Use the private GitHub Security Advisory form at [Report a vulnerability](https://github.com/draarivpatel-ui/cardiowave-dsp/security/advisories/new). Do not open a public issue, pull request or discussion with exploit details.

Never include a live secret, token, cookie, private key, victim hostname or proprietary payload in a report. Use synthetic values and redacted transcripts.

## Supported versions

| Version | Status |
| --- | --- |
| latest `main` | Supported |

Security fixes are applied to the latest state of the default branch.

## Scope

This policy covers the static CardioWave DSP browser application, including synthetic ECG generation, rhythm classification, filtering, local browser state, URL state, report exports and browser rendering.

In scope:

- A cross-site scripting or HTML injection path through signal parameters, rhythm output, annotations, URL state, imported text or report output.
- A share-link decoder or serialization flaw that bypasses validation, corrupts another analysis state, or executes attacker-controlled code.
- A report, CSV, WFDB or SVG export flaw that makes generated output execute a formula or script when opened.
- A browser storage or offline-serving flaw that leaks sensitive user input or serves attacker-controlled application code across an update.
- A medical-safety boundary flaw that causes synthetic output to be presented as a diagnosis or as real patient data.

Out of scope:

- Browser vulnerabilities, operating system compromise or physical access to the machine.
- Damage caused by modified copies of the static application that do not come from this repository.
- Accuracy limits documented for synthetic signals and deterministic classifiers, unless a report shows a specific validation or output integrity failure.

## Coordinated disclosure

- Acknowledgment: within 3 business days.
- Initial triage: within 14 calendar days.
- Fix or mitigation target: within 90 calendar days for confirmed reports.
- Coordinated public disclosure: up to 90 days by default, adjusted by mutual agreement when exploitation or user risk requires a different date.
