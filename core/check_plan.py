"""Read ChatGPT plans across personal and organization workspaces after login."""
from __future__ import annotations

import asyncio
import json
import logging
import math
import sys
from datetime import datetime, timezone
from typing import Any

from account_plans import extract_plan_details, extract_workspaces, select_workspace, session_account_id
from login_service import _extract_access_token, _make_session, login_pure_request

_URL_SESSION = "https://chatgpt.com/api/auth/session"
# The bearer token is required to enumerate workspaces and their entitlements.
_URL_ACCOUNTS_CHECK = "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27"
# rate-limit usage: rate_limit.primary_window.used_percent -> we report REMAINING (100 - used).
_URL_USAGE = "https://chatgpt.com/backend-api/wham/usage"


def _extract_plan(payload: Any) -> str:
    return extract_plan_details(payload)[0]


def _extract_remaining(usage_payload: Any) -> tuple[int | None, int | None, bool]:
    """(remaining_percent, reset_at_epoch, limit_reached) from wham/usage. The API gives
    used_percent for the current rate-limit window; we report REMAINING = 100 - used."""
    rl = usage_payload.get("rate_limit") if isinstance(usage_payload, dict) else None
    if not isinstance(rl, dict):
        return None, None, False
    pw = rl.get("primary_window")
    if not isinstance(pw, dict):
        pw = {}
    used = pw.get("used_percent")
    remaining = int(round(100 - used)) if isinstance(used, (int, float)) and not isinstance(used, bool) and math.isfinite(used) else None
    if remaining is not None:
        remaining = max(0, min(100, remaining))
    reset = pw.get("reset_at")
    reset_at = int(reset) if isinstance(reset, (int, float)) and not isinstance(reset, bool) and math.isfinite(reset) else None
    return remaining, reset_at, bool(rl.get("limit_reached"))


def _extract_expiry(accounts_payload: Any, account_id: str | None = None) -> tuple[int | None, str | None]:
    """Return only the selected account's expiry, never another workspace's renewal."""
    session = {"account_id": account_id} if account_id else {}
    workspace = select_workspace(extract_workspaces(session, accounts_payload), session)
    return (workspace["days_left"], workspace["expires_at"]) if workspace else (None, None)


async def check_plan_pure(email: str, password: str, totp_secret: str, *, logger: logging.Logger) -> dict[str, Any]:
    client = await _make_session()
    try:
        logger.info("[check_plan] logging in - %s", email)
        entry = await login_pure_request(email=email, password=password, totp_secret=totp_secret, http_client=client, logger=logger)
        logger.info("[check_plan] GET /api/auth/session")
        response = await client.get(
            _URL_SESSION, headers={"Accept": "application/json", "Referer": "https://chatgpt.com/"}
        )
        if response.status_code != 200:
            return {"ok": False, "stage": "check_plan", "error": f"session HTTP {response.status_code}"}
        payload = response.json()
        if not isinstance(payload, dict):
            return {"ok": False, "stage": "check_plan", "error": "session response is not an object"}
        access_token = _extract_access_token(payload) or getattr(entry, "access_token", None)
        accounts_payload: Any = None
        warnings: list[str] = []
        plans_complete = False
        if access_token:
            try:
                response = await client.get(
                    _URL_ACCOUNTS_CHECK,
                    headers={"Accept": "application/json", "Referer": "https://chatgpt.com/", "Authorization": f"Bearer {access_token}"},
                )
                if response.status_code == 200:
                    candidate = response.json()
                    if isinstance(candidate, dict) and isinstance(candidate.get("accounts"), (dict, list)):
                        accounts_payload = candidate
                        plans_complete = True
                    else:
                        warnings.append("workspace_lookup_failed: invalid accounts response")
                else:
                    warnings.append(f"workspace_lookup_failed: HTTP {response.status_code}")
                    logger.info("[check_plan] accounts fetch HTTP %s", response.status_code)
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"workspace_lookup_failed: {type(exc).__name__}")
                logger.info("[check_plan] accounts fetch failed: %s", type(exc).__name__)
        else:
            warnings.append("workspace_lookup_failed: missing access token")

        workspaces = extract_workspaces(payload, accounts_payload)
        primary = select_workspace(workspaces, payload)
        result: dict[str, Any] = {
            "ok": True, "email": email, "workspaces": workspaces,
            "plans_complete": plans_complete, "warnings": warnings,
        }
        if access_token:
            # Usage is scoped to the selected workspace, so a Team subscription
            # cannot accidentally be paired with the personal workspace's quota.
            try:
                headers = {
                    "Accept": "application/json",
                    "Referer": "https://chatgpt.com/",
                    "Authorization": f"Bearer {access_token}",
                    "x-openai-target-path": "/backend-api/wham/usage",
                    "x-openai-target-route": "/backend-api/wham/usage",
                }
                if primary and primary["id"]:
                    headers["ChatGPT-Account-ID"] = primary["id"]
                if len(workspaces) > 1 and not (primary and primary["id"]):
                    raise ValueError("cannot scope usage to an unidentified workspace")
                uz = await client.get(
                    _URL_USAGE,
                    headers=headers,
                )
                if uz.status_code == 200:
                    usage = uz.json()
                    reported_id = session_account_id(usage)
                    if reported_id and primary and primary["id"] and reported_id != primary["id"]:
                        raise ValueError("usage response belongs to a different workspace")
                    remaining, reset_at, limit_reached = _extract_remaining(usage)
                    result["remaining_percent"] = remaining
                    result["limit_reached"] = limit_reached
                    result["usage_account_id"] = primary["id"] if primary else None
                    if reset_at is not None:
                        try:
                            result["usage_reset_at"] = datetime.fromtimestamp(reset_at, timezone.utc).isoformat()
                        except (ValueError, OverflowError, OSError):
                            pass
                    if primary and primary["plan"] == "unknown":
                        primary["plan"], primary["plan_raw"] = extract_plan_details(usage)
                    logger.info("[check_plan] remaining_percent=%s limit_reached=%s", remaining, limit_reached)
            except Exception as e:  # noqa: BLE001
                logger.info("[check_plan] usage fetch failed: %s", type(e).__name__)
        result.update({
            "plan": primary["plan"] if primary else "unknown",
            "plans": list(dict.fromkeys(workspace["plan"] for workspace in workspaces)),
            "account_id": primary["id"] if primary else None,
            "days_left": primary["days_left"] if primary else None,
            "expires_at": primary["expires_at"] if primary else None,
        })
        logger.info("[check_plan] plan=%s workspaces=%s", result["plan"], len(workspaces))
        return result
    finally:
        try:
            await client.close()
        except Exception as exc:  # noqa: BLE001
            logger.info("[check_plan] session cleanup failed: %s", type(exc).__name__)


def _emit(obj: dict) -> None:
    # Same __RESULT__{json} stdout contract as Core/worker.py.
    sys.stdout.write("__RESULT__" + json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def _cli() -> None:
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(asctime)s %(levelname)s %(message)s")
    log = logging.getLogger("check_plan")
    if len(sys.argv) != 2:
        _emit({"ok": False, "stage": "input", "error": "usage: check_plan.py <email|pass|2fa>"})
        raise SystemExit(2)
    parts = sys.argv[1].split("|")
    if len(parts) != 3:
        _emit({"ok": False, "stage": "input", "error": "combo must be email|pass|2fa"})
        raise SystemExit(2)
    email, password, totp_secret = parts
    try:
        result = asyncio.run(check_plan_pure(email, password, totp_secret, logger=log))
    except Exception as e:  # noqa: BLE001
        _emit({"ok": False, "stage": getattr(e, "stage", None) or "check_plan", "error": str(e)})
        raise SystemExit(1)
    _emit(result)


def _selfcheck() -> int:
    assert _extract_plan({"subscription_plan": "chatgptplusplan"}) == "plus"
    assert _extract_plan({"account": {"planType": "plus"}}) == "plus"
    assert _extract_plan({"subscription_plan": "free"}) == "free"
    assert _extract_plan({}) == "unknown"
    assert _extract_plan(None) == "unknown"
    assert _extract_plan({"account": {"planType": "team"}}) == "team"
    assert _extract_plan({"subscription_plan": "future_plan"}) == "future_plan"
    # remaining = 100 - used_percent
    assert _extract_remaining({"rate_limit": {"primary_window": {"used_percent": 0}}})[0] == 100
    assert _extract_remaining({"rate_limit": {"primary_window": {"used_percent": 25.4}, "limit_reached": True}}) == (75, None, True)
    assert _extract_remaining({"rate_limit": {"primary_window": {"used_percent": 100, "reset_at": 5}}}) == (0, 5, False)
    assert _extract_remaining({})[0] is None
    print("selfcheck ok", file=sys.stderr)
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--selfcheck":
        raise SystemExit(_selfcheck())
    _cli()
