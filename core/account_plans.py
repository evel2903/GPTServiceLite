"""Read plan and workspace metadata without guessing missing subscription details."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


_PLAN_ALIASES = {
    "chatgptfreeplan": "free",
    "chatgptplusplan": "plus",
    "chatgptproplan": "pro",
    "chatgptteamplan": "team",
    "chatgptbusinessplan": "business",
    "chatgptenterpriseplan": "enterprise",
    "chatgpteduplan": "edu",
    "chatgpteducationplan": "edu",
    "education": "edu",
    "chatgptk12plan": "k12",
    "k-12": "k12",
    "k_12": "k12",
    "chatgptgoplan": "go",
}


def normalize_plan(raw: Any) -> str:
    """Keep unfamiliar plan identifiers visible instead of reporting them as Free."""
    if not isinstance(raw, str) or not raw.strip():
        return "unknown"
    value = raw.strip().lower()
    return _PLAN_ALIASES.get(value, value)


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _text(*values: Any) -> str | None:
    return next((value.strip() for value in values if isinstance(value, str) and value.strip()), None)


def session_account_id(payload: Any) -> str | None:
    session = _mapping(payload)
    account = _mapping(session.get("account"))
    return _text(account.get("account_id"), account.get("id"), session.get("account_id"), session.get("accountId"))


def extract_plan_details(payload: Any) -> tuple[str, str | None]:
    """Return the API's plan, preferring entitlement detail over generic account type."""
    record = _mapping(payload)
    account = _mapping(record.get("account"))
    entitlement = _mapping(record.get("entitlement"))
    entitlement_plans = [entitlement.get("subscription_plan"), entitlement.get("plan_type"), entitlement.get("planType")]
    account_plans = [
        record.get("subscription_plan"), account.get("plan_type"), account.get("planType"),
        record.get("plan_type"), record.get("planType"),
    ]
    candidates = account_plans + entitlement_plans if entitlement.get("has_active_subscription") is False else entitlement_plans + account_plans
    # Some school workspaces carry a generic Enterprise entitlement. Use an
    # explicit school plan field when supplied; workspace names are never evidence.
    raw = _text(*candidates)
    if normalize_plan(raw) == "enterprise":
        raw = next((value for value in candidates if normalize_plan(value) in {"k12", "edu"}), raw)
    return normalize_plan(raw), raw


def subscription_expiry(entitlement: Any) -> tuple[int | None, str | None]:
    entitlement = _mapping(entitlement)
    expires_at = _text(entitlement.get("expires_at"))
    if entitlement.get("has_active_subscription") is False or not expires_at:
        return None, None
    try:
        expires = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        if expires.tzinfo is None:
            return None, expires_at
        return max((expires - datetime.now(timezone.utc)).days, 0), expires_at
    except (ValueError, OverflowError):
        return None, expires_at


def _workspace(record: dict[str, Any], key: str | None, *, is_default: bool = False) -> dict[str, Any]:
    account = _mapping(record.get("account"))
    entitlement = _mapping(record.get("entitlement"))
    plan, raw = extract_plan_details(record)
    days_left, expires_at = subscription_expiry(entitlement)
    return {
        "id": _text(account.get("account_id"), account.get("id"), record.get("account_id"), record.get("id"), key),
        "name": _text(account.get("name"), account.get("account_name"), record.get("name"), record.get("account_name")),
        "plan": plan,
        "plan_raw": raw,
        "is_default": is_default,
        "is_selected": False,
        "has_active_subscription": entitlement.get("has_active_subscription") if isinstance(entitlement.get("has_active_subscription"), bool) else None,
        "days_left": days_left,
        "expires_at": expires_at,
    }


def select_workspace(workspaces: list[dict[str, Any]], session_payload: Any = None) -> dict[str, Any] | None:
    active_id = session_account_id(session_payload)
    if active_id:
        active = next((workspace for workspace in workspaces if workspace.get("id") == active_id), None)
        if active:
            return active
    return next((workspace for workspace in workspaces if workspace.get("is_default")), None) or next(iter(workspaces), None)


def extract_workspaces(session_payload: Any, accounts_payload: Any) -> list[dict[str, Any]]:
    """Deduplicate the accounts/check default alias and keep each entitlement scoped."""
    session = _mapping(session_payload)
    accounts = _mapping(accounts_payload).get("accounts")
    workspaces: list[dict[str, Any]] = []
    by_id: dict[str, dict[str, Any]] = {}
    records = list(accounts.items()) if isinstance(accounts, dict) else [(None, value) for value in accounts] if isinstance(accounts, list) else []
    # Real entries contain more metadata than a default alias in some responses.
    records.sort(key=lambda item: item[0] == "default")
    for key, value in records:
        if key == "default" and isinstance(value, str):
            if value in by_id:
                by_id[value]["is_default"] = True
            continue
        if not isinstance(value, dict):
            continue
        workspace = _workspace(value, key if isinstance(key, str) and key != "default" else None, is_default=key == "default")
        existing = by_id.get(workspace["id"]) if workspace["id"] else None
        if existing:
            existing["is_default"] = existing["is_default"] or workspace["is_default"]
            for field, field_value in workspace.items():
                if existing.get(field) in (None, "unknown") and field_value is not None:
                    existing[field] = field_value
            continue
        # A literal duplicate alias may omit an id, while its map key supplies it.
        if key == "default" and not workspace["id"]:
            duplicate_key = next((other_key for other_key, other_value in records if other_key != "default" and other_value == value), None)
            if duplicate_key in by_id:
                by_id[duplicate_key]["is_default"] = True
                continue
        workspaces.append(workspace)
        if workspace["id"]:
            by_id[workspace["id"]] = workspace

    active_id = session_account_id(session)
    session_plan, session_raw = extract_plan_details(session)
    active = by_id.get(active_id) if active_id else select_workspace(workspaces, session)
    if active is None and (active_id or not workspaces):
        active = _workspace(session, active_id)
        workspaces.append(active)
    if active and session_plan != "unknown" and (active["plan"] == "unknown" or (active["plan"] == "enterprise" and session_plan in {"edu", "k12"})):
        active["plan"], active["plan_raw"] = session_plan, session_raw
    selected = select_workspace(workspaces, session)
    if selected:
        selected["is_selected"] = True
    return workspaces
