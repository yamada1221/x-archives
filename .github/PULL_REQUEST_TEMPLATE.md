## Summary

- Safely capture diagnostic details for X/archive.md failures
- Keep conservative status handling (`unknown` / `retry_pending`)
- Add tests and PR-triggered diagnostic checks

## Validation

- `python -m unittest discover -v`
- `python -m py_compile scripts/*.py`
- PR workflow probes X without archive writes
