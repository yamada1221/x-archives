"""Small read-only live check; never writes account data or uses secrets."""

import datetime as dt
import json
import os
import time

from fxtwitter import probe_profile


def main():
    cases = [
        ("X", "", "active", ""),
        ("X", "783214", "active", ""),
        ("tawakenai_marou", "", "active", ""),
        ("aryuha_0_0", "", "unavailable", "suspended"),
        ("zzxarch9q7k2v5", "", "unavailable", "not_found"),
    ]
    rows = []
    failed = False
    for username, user_id, expected, reason in cases:
        result = probe_profile(username, user_id)
        ok = result["status"] == expected and result["reason"] == reason
        failed |= not ok
        rows.append(f"| {username} {'(ID)' if user_id else ''} | {result['status']} | {result['reason'] or '-'} | {'PASS' if ok else 'FAIL'} |")
        print(json.dumps({"username": username, "by_id": bool(user_id), "expected": expected, "passed": ok, **result}, ensure_ascii=False), flush=True)
        time.sleep(1)
    summary = "\n".join([
        "## FxTwitter live diagnostics", "",
        dt.datetime.now(dt.timezone.utc).isoformat(), "",
        "| Account | Result | Reason | Check |", "|---|---|---|---|", *rows, "",
        "Read-only check. Expected states are fixtures observed on 2026-09-23; a real account change can require updating the fixture.", "",
    ])
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as output:
            output.write(summary)
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
