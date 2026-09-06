"""Rotate account TOTP using the existing enroll/activate flow.

Workspace mode resolves an authenticated Team/Business/Edu/K12 account context
before enrollment. These ChatGPT web endpoints are not a public API; workspace
behavior needs validation with a real account. MFA still belongs to the user.
Activation is never retried automatically: a timeout may already have applied
the new factor, so an uncertain result carries the candidate secret for recovery.
"""
from __future__ import annotations

import asyncio
import json
import logging
import sys
from typing import Any

import pyotp

from login_service import LoginError, login_pure_request, _has_session_token, _make_session, _get_session
from account_plans import extract_workspaces, select_workspace

_ENROLL_URL = "https://chatgpt.com/backend-api/accounts/mfa/enroll"
_ACTIVATE_URL = "https://chatgpt.com/backend-api/accounts/mfa/user/activate_enrollment"
_ACCOUNTS_URL = "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27"
_WORKSPACE_PLANS = {"team", "business", "enterprise", "edu", "k12"}


async def _mfa_headers(token: str, account_id: str | None = None) -> dict[str, str]:
    headers = {
        "content-type": "application/json",
        "authorization": f"Bearer {token}",
        "origin": "https://chatgpt.com",
        "referer": "https://chatgpt.com/",
    }
    if account_id:
        headers["ChatGPT-Account-ID"] = account_id
    return headers


async def _workspace_context(client: Any, token: str, logger: logging.Logger) -> dict[str, Any]:
    session = await _get_session(client, logger)
    response = await client.get(_ACCOUNTS_URL, headers=await _mfa_headers(token))
    if response.status_code != 200:
        raise LoginError(reason="workspace_lookup_failed", message=f"workspace lookup HTTP {response.status_code}", stage="workspace_lookup")
    workspaces = extract_workspaces(session, response.json())
    candidates = [w for w in workspaces if w.get("id") and w.get("plan") in _WORKSPACE_PLANS]
    if not candidates:
        raise LoginError(reason="workspace_not_found", message="workspace_not_found: no Team/Business/K12/Edu/Enterprise workspace identified; use Check Plan to inspect this account", stage="workspace_lookup")
    selected = select_workspace(candidates, session)
    # MFA is user-level; choosing a context does not change workspace membership.
    return selected or candidates[0]


async def change_2fa_pure(email: str, password: str, totp_secret: str, *, logger: logging.Logger, workspace: bool = False) -> dict[str, Any]:
    client = await _make_session()
    stage = "login"
    new_secret = None
    activation_started = False
    try:
        logger.info("[change_2fa] logging in - %s", email)
        entry = await login_pure_request(email=email, password=password, totp_secret=totp_secret, http_client=client, logger=logger)
        if not _has_session_token(client):
            raise LoginError(reason="network_error", message="no session after login")
        access_token = str(getattr(entry, "access_token", "") or "")
        if not access_token:
            raise LoginError(reason="network_error", message="no access_token after login")

        account = None
        if workspace:
            stage = "workspace_lookup"
            account = await _workspace_context(client, access_token, logger)
            logger.info("[change_2fa] workspace context plan=%s", account["plan"])
        logger.info("[change_2fa] [1/2] enroll new TOTP factor")
        stage = "mfa_enroll"
        headers = await _mfa_headers(access_token, account["id"] if account else None)
        r1 = await client.post(_ENROLL_URL, json={"factor_type": "totp"}, headers=headers)
        if r1.status_code != 200:
            raise LoginError(reason="network_error", message=f"mfa/enroll HTTP {r1.status_code}", stage=stage)
        enroll = r1.json()
        new_secret = enroll.get("secret") if isinstance(enroll, dict) else None
        session_id = enroll.get("session_id") if isinstance(enroll, dict) else None
        if not new_secret or not session_id:
            raise LoginError(reason="network_error", message="mfa/enroll missing secret/session_id", stage=stage)

        logger.info("[change_2fa] [2/2] activate new TOTP factor")
        stage = "mfa_activate"
        code = pyotp.TOTP(new_secret).now()
        activation_started = True
        r2 = await client.post(
            _ACTIVATE_URL, json={"code": code, "factor_type": "totp", "session_id": session_id}, headers=headers
        )
        if r2.status_code != 200:
            raise LoginError(reason="network_error", message=f"activate_enrollment HTTP {r2.status_code}", stage=stage)
        activate = r2.json()
        if not isinstance(activate, dict) or activate.get("success") is not True:
            raise LoginError(reason="network_error", message="activate_enrollment did not report success", stage=stage)

        logger.info("[change_2fa] done for %s", email)
        return {"ok": True, "email": email, "totp_secret": new_secret}
    except Exception as exc:
        result = {"ok": False, "email": email, "stage": getattr(exc, "stage", stage), "error": str(exc)}
        if activation_started and new_secret:
            result.update(recovery_totp=new_secret, activation_uncertain=True)
        return result
    finally:
        try:
            await client.close()
        except Exception:
            logger.warning("[change_2fa] session cleanup failed")


def _emit(obj: dict) -> None:
    # Same __RESULT__{json} stdout contract as change_password.py / worker.py.
    sys.stdout.write("__RESULT__" + json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def _cli() -> None:
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(asctime)s %(levelname)s %(message)s")
    log = logging.getLogger("change_2fa")
    if len(sys.argv) not in (2, 3) or (len(sys.argv) == 3 and sys.argv[2] != "--workspace"):
        _emit({"ok": False, "stage": "input", "error": "usage: change_2fa.py <email|pass|2fa> [--workspace]"})
        raise SystemExit(2)
    parts = sys.argv[1].split("|")
    if len(parts) != 3:
        _emit({"ok": False, "stage": "input", "error": "combo must be email|pass|2fa"})
        raise SystemExit(2)
    email, password, totp_secret = parts
    try:
        result = asyncio.run(change_2fa_pure(email, password, totp_secret, logger=log, workspace="--workspace" in sys.argv[2:]))
    except Exception as e:  # noqa: BLE001
        _emit({"ok": False, "stage": "change_2fa", "error": str(e)})
        raise SystemExit(1)
    _emit(result)


if __name__ == "__main__":
    _cli()
