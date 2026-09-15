"""Log out all active ChatGPT sessions across all devices for an account."""
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

_LOGOUT_ALL_URL = "https://chatgpt.com/backend-api/accounts/logout_all"


async def logout_all_pure(email: str, password: str, totp_secret: str, *, logger: logging.Logger) -> dict[str, Any]:
    client = await _make_session()
    stage = "login"
    try:
        logger.info("[logout_all] logging in - %s", email)
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

        stage = "logout_all"
        logger.info("[logout_all] executing backend logout_all")
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "*/*",
            "Origin": "https://chatgpt.com",
            "Referer": "https://chatgpt.com/",
            "oai-client-type": "web",
        }
        res = await client.post(_LOGOUT_ALL_URL, json={}, headers=headers)
        if res.status_code == 200:
            logger.info("[logout_all] OK - all sessions terminated for %s", email)
            return {
                "ok": True,
                "email": email,
                "message": "all sessions logged out successfully",
            }
        logger.warning("[logout_all] failed HTTP %s: %s", res.status_code, res.text[:200])
        return {
            "ok": False,
            "email": email,
            "stage": stage,
            "error": f"logout_all HTTP {res.status_code}",
        }
    except Exception as exc:
        logger.info("[logout_all] failed: %s", exc)
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
            logger.warning("[logout_all] session cleanup failed")


def _emit(obj: dict) -> None:
    sys.stdout.write("__RESULT__" + json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def _cli() -> None:
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(asctime)s %(levelname)s %(message)s")
    log = logging.getLogger("logout_all")
    if len(sys.argv) != 2:
        _emit({"ok": False, "stage": "input", "error": "usage: logout_all.py <email|pass|2fa>"})
        raise SystemExit(2)
    parts = sys.argv[1].split("|")
    if len(parts) != 3 or not all(parts):
        _emit({"ok": False, "stage": "input", "error": "combo must be email|pass|2fa"})
        raise SystemExit(2)
    email, password, totp_secret = parts
    result = asyncio.run(logout_all_pure(email, password, totp_secret, logger=log))
    _emit(result)


def _selfcheck() -> int:
    assert callable(logout_all_pure)
    print("selfcheck ok", file=sys.stderr)
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--selfcheck":
        raise SystemExit(_selfcheck())
    _cli()
