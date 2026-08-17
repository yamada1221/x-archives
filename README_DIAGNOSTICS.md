# External diagnostics

When X or archive.md returns an unexpected response, `scripts/monitor_accounts.py` records only a short diagnostic summary.

Recorded details may include:

- HTTP status
- Content-Type
- a short, single-line preview of the response body
- archive final URL when validation fails

The diagnostic code does not record request cookies, Authorization headers, or other request headers.

These diagnostics are intended to distinguish blocking/challenge pages, rate limits, and endpoint format changes while preserving the conservative `unknown` / `retry_pending` behavior.
