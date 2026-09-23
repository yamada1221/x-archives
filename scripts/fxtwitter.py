"""Read public account evidence from FxTwitter without X credentials."""

from __future__ import annotations

import http.client
import json
import re
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = "https://api.fxtwitter.com/2/profile/"
USER_AGENT = "x-archives/1.0 (+https://github.com/yamada1221/x-archives)"
BODY_LIMIT = 512 * 1024


def unknown(detail: str) -> dict:
    return {"status": "unknown", "reason": "", "source": "fxtwitter", "detail": detail}


def classify(payload: object, http_status: int, username: str, user_id: str = "") -> dict:
    """Never interpret transport failures or an unrelated profile as account loss."""
    if not isinstance(payload, dict):
        return unknown(f"FxTwitter HTTP {http_status}; invalid response object")
    code = payload.get("code")
    message = str(payload.get("message", ""))[:160].replace("\n", " ")
    detail = f"FxTwitter HTTP {http_status}; code={code}; message={message}"
    if http_status not in (200, 404):
        return unknown(detail)
    if code == 404:
        reason = payload.get("reason")
        if reason == "suspended":
            return {"status": "unavailable", "reason": "suspended", "source": "fxtwitter", "detail": detail}
        if not reason and message == "User not found":
            return {"status": "unavailable", "reason": "not_found", "source": "fxtwitter", "detail": detail}
        return unknown(detail)
    if http_status != 200 or code != 200 or payload.get("reason"):
        return unknown(detail)
    user = payload.get("user")
    if not isinstance(user, dict):
        return unknown(detail + "; missing profile")
    resolved_id = user.get("id")
    handle = user.get("screen_name")
    if not isinstance(resolved_id, str) or not resolved_id.isascii() or not resolved_id.isdigit():
        return unknown(detail + "; missing or invalid numeric user ID")
    if not isinstance(handle, str) or not re.fullmatch(r"[A-Za-z0-9_]{1,15}", handle):
        return unknown(detail + "; missing or invalid username")
    if (user_id and resolved_id != user_id) or (not user_id and handle.lower() != username.lower()):
        return unknown(detail + "; profile identity mismatch")
    return {
        "status": "active", "reason": "", "source": "fxtwitter",
        "detail": detail + f"; user_id={resolved_id}; screen_name={handle}",
        "user_id": resolved_id, "username": handle,
        "protected": user.get("protected") is True,
    }


def probe_profile(username: str, user_id: str = "") -> dict:
    if user_id:
        if not isinstance(user_id, str) or not re.fullmatch(r"[0-9]+", user_id):
            return unknown("FxTwitter: invalid stored user ID")
        target = "id:" + user_id
    else:
        if not re.fullmatch(r"[A-Za-z0-9_]{1,15}", username):
            return unknown("FxTwitter: invalid username")
        target = username
    req = urllib.request.Request(
        BASE_URL + urllib.parse.quote(target, safe=":"),
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
    )
    try:
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                status, raw = response.status, response.read(BODY_LIMIT + 1)
        except urllib.error.HTTPError as exc:
            status, raw = exc.code, exc.read(BODY_LIMIT + 1)
        if len(raw) > BODY_LIMIT:
            return unknown(f"FxTwitter HTTP {status}; oversized response")
        try:
            payload = json.loads(raw)
        except (ValueError, UnicodeError):
            return unknown(f"FxTwitter HTTP {status}; non-JSON response")
        return classify(payload, status, username, user_id)
    except (OSError, ValueError, http.client.HTTPException) as exc:
        return unknown(f"FxTwitter temporary failure: {type(exc).__name__}")
