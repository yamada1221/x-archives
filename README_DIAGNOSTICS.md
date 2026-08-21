# External diagnostics

When X returns an unexpected response, `scripts/monitor_accounts.py` records only a short diagnostic summary.

Recorded details may include:

- HTTP status
- Content-Type
- a short, single-line preview of the response body
- final profile URL when validation falls back to the public profile page

The diagnostic code does not record request cookies, Authorization headers, or other request headers.

These diagnostics are intended to distinguish blocking/challenge pages, rate limits, and endpoint format changes while preserving the conservative `unknown` behavior.
