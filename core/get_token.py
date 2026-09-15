"""Retrieve ChatGPT access_token and session payload for an account."""
from __future__ import annotations

import asyncio
import json
import logging
import sys
from typing import Any

from login_service import LoginError, _has_session_token, _make_session, login_pure_request

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass


async def get_token_pure(email: str, password: str, totp_secret: str, *, logger: logging.Logger) -> dict[str, Any]:
    client = await _make_session()
    stage = "login"
    try:
        logger.info("[get_token] logging in - %s", email)
        entry = await login_pure_request(
            email=email,
            password=password,
            totp_secret=totp_secret,
            http_client=client,
            logger=logger,
        )
        if not _has_session_token(client):
            raise LoginError(reason="network_error", message="no session after login", stage=stage)
        token = str(getattr(entry, "access_token", "") or "")
        if not token:
            raise LoginError(reason="network_error", message="no access_token after login", stage=stage)
        logger.info("[get_token] OK (token_len=%d)", len(token))
        raw_session = getattr(entry, "raw_session", None)
        if raw_session is None:
            raw_session = {}
        return {
            "ok": True,
            "email": email,
            "access_token": token,
            "session": raw_session,
        }
    except Exception as exc:
        logger.info("[get_token] failed: %s", exc)
        return {
            "ok": False,
            "email": email,
            "stage": getattr(exc, "stage", stage),
            "error": str(exc),
        }
    finally:
        try:
            await client.close()
        except Exception:
            logger.warning("[get_token] session cleanup failed")


def _emit(obj: dict) -> None:
    # Same __RESULT__{json} stdout contract as change_2fa.py / check_plan.py.
    sys.stdout.write("__RESULT__" + json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def _cli() -> None:
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(asctime)s %(levelname)s %(message)s")
    log = logging.getLogger("get_token")
    if len(sys.argv) != 2:
        _emit({"ok": False, "stage": "input", "error": "usage: get_token.py <email|pass|2fa>"})
        raise SystemExit(2)
    parts = sys.argv[1].split("|")
    if len(parts) != 3 or not all(parts):
        _emit({"ok": False, "stage": "input", "error": "combo must be email|pass|2fa"})
        raise SystemExit(2)
    email, password, totp_secret = parts
    result = asyncio.run(get_token_pure(email, password, totp_secret, logger=log))
    _emit(result)


def _selfcheck() -> int:
    assert callable(get_token_pure)
    print("selfcheck ok", file=sys.stderr)
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--selfcheck":
        raise SystemExit(_selfcheck())
    _cli()
