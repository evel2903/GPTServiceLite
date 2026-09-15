"""Generate 6-digit TOTP code from a full combo or standalone 2FA secret key."""
from __future__ import annotations

import json
import re
import sys
import time
from typing import Any

import pyotp

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass


def extract_secret_and_tag(raw: str) -> tuple[str, str, str]:
    """Extract (clean_secret, email, tag) from combo or standalone secret."""
    raw = raw.strip()
    if not raw:
        return "", "", ""
    parts = [p.strip() for p in raw.split("|")]
    email = ""
    candidate = ""

    if len(parts) >= 3:
        email = parts[0]
        candidate = parts[2]
    elif len(parts) == 2:
        email = parts[0]
        candidate = parts[1]
    else:
        candidate = parts[0]

    clean = re.sub(r"[\s-]+", "", candidate).upper()
    return clean, email, raw


def get_2fa_code(raw: str) -> dict[str, Any]:
    clean_secret, email, raw_line = extract_secret_and_tag(raw)
    if not clean_secret:
        return {"ok": False, "error": "empty 2fa secret", "input": raw}

    try:
        totp = pyotp.TOTP(clean_secret)
        code = totp.now()
        remaining = 30 - (int(time.time()) % 30)
        return {
            "ok": True,
            "code": code,
            "remaining": remaining,
            "secret": clean_secret,
            "email": email,
            "input": raw_line,
        }
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"invalid 2fa secret ({exc})", "input": raw_line}


def _emit(obj: dict) -> None:
    sys.stdout.write("__RESULT__" + json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def _cli() -> None:
    if len(sys.argv) != 2:
        _emit({"ok": False, "error": "usage: get_2fa.py <combo_or_secret>"})
        raise SystemExit(2)
    result = get_2fa_code(sys.argv[1])
    _emit(result)


def _selfcheck() -> int:
    assert get_2fa_code("JBSWY3DPEHPK3PXP")["ok"] is True
    assert get_2fa_code("a@b.com|pass|JBSWY3DPEHPK3PXP")["ok"] is True
    assert get_2fa_code("invalid!!!")["ok"] is False
    print("selfcheck ok", file=sys.stderr)
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--selfcheck":
        raise SystemExit(_selfcheck())
    _cli()
