# External diagnostics

`python scripts/diagnose_fxtwitter.py` performs a small read-only live check of active, suspended and missing accounts, including numeric-ID lookup. It never writes `data/artists.json` or uses credentials. `Test FxTwitter monitoring` runs this check in GitHub Actions. The expected live account states are fixtures observed on 2026-09-23; actual account changes may require updating the fixtures.

`python scripts/monitor_accounts.py --dry-run` probes all registered accounts without saving. Normal monitoring stores `monitoring_summary` and emits an Actions step summary. `--check-health` checks the saved summary and exits unsuccessfully if every checked account was unknown; the production workflow does this after committing the results.

When X returns an unexpected response, `scripts/monitor_accounts.py` records only a short diagnostic summary.

Recorded details may include:

- HTTP status
- Content-Type
- a short, single-line preview of the response body
- final profile URL when validation falls back to the public profile page

The diagnostic code does not record request cookies, Authorization headers, or other request headers.

These diagnostics are intended to distinguish blocking/challenge pages, rate limits, and endpoint format changes while preserving the conservative `unknown` behavior.
