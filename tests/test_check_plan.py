"""Offline plan fixtures and mocked HTTP tests; never authenticate real accounts."""
from __future__ import annotations

import logging
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core"))

from account_plans import extract_plan_details, extract_workspaces, normalize_plan, select_workspace
from login_service import LoginError
import check_plan


def account(account_id, plan, expires_at=None, **extra):
    result = {"account": {"account_id": account_id, "name": account_id, "plan_type": plan}, **extra}
    if expires_at:
        result["entitlement"] = {"has_active_subscription": True, "expires_at": expires_at}
    return result


class PlanMetadataTests(unittest.TestCase):
    def test_all_plan_types_and_unrecognized_values(self):
        for raw, expected in [
            ("chatgptfreeplan", "free"), ("chatgptplusplan", "plus"),
            ("chatgptproplan", "pro"), ("chatgptteamplan", "team"),
            ("chatgptbusinessplan", "business"), ("chatgptenterpriseplan", "enterprise"),
            ("chatgpteduplan", "edu"), ("chatgptk12plan", "k12"), ("chatgptgoplan", "go"),
            (" Future_Plan ", "future_plan"), (None, "unknown"), (True, "unknown"),
        ]:
            with self.subTest(raw=raw):
                self.assertEqual(normalize_plan(raw), expected)
        self.assertEqual(extract_plan_details({"subscription_plan": "Future_Plan"}), ("future_plan", "Future_Plan"))
        for malformed in [None, {}, [], {"account": "broken"}, {"subscription_plan": {"name": "plus"}}]:
            self.assertEqual(check_plan._extract_plan(malformed), "unknown")

    def test_active_entitlement_and_school_specific_metadata(self):
        self.assertEqual(check_plan._extract_plan({
            "account": {"plan_type": "free"},
            "entitlement": {"subscription_plan": "chatgptplusplan", "has_active_subscription": True},
        }), "plus")
        self.assertEqual(check_plan._extract_plan({
            "account": {"plan_type": "free"},
            "entitlement": {"subscription_plan": "chatgptplusplan", "has_active_subscription": False},
        }), "free")
        self.assertEqual(check_plan._extract_plan({
            "account": {"plan_type": "k12"},
            "entitlement": {"subscription_plan": "chatgptenterpriseplan"},
        }), "k12")
        self.assertEqual(check_plan._extract_plan({"account": {"name": "K12 Enterprise Team"}}), "unknown")
        self.assertEqual(check_plan._extract_plan({"account": {"plan_type": "enterprise", "name": "K12"}}), "enterprise")
        self.assertEqual(extract_plan_details({"account": {"plan_type": "Future_K12_Education"}}), ("future_k12_education", "Future_K12_Education"))
        self.assertEqual(check_plan._extract_plan({
            "account": {"plan_type": "free"},
            "entitlement": {"subscription_plan": "chatgptk12plan", "has_active_subscription": False},
        }), "free")

    def test_multiple_workspaces_default_alias_and_scoped_expiry(self):
        personal = account("personal", "plus", "2090-01-01T00:00:00Z")
        team = account("team-id", "team", "2090-06-01T00:00:00Z")
        payload = {"accounts": {"default": personal, "personal": personal, "team-id": team}}
        session = {"account": {"id": "team-id", "planType": "team"}}
        workspaces = extract_workspaces(session, payload)
        self.assertEqual(len(workspaces), 2)
        self.assertEqual([workspace["plan"] for workspace in workspaces], ["plus", "team"])
        selected = select_workspace(workspaces, session)
        self.assertEqual(selected["id"], "team-id")
        self.assertTrue(selected["is_selected"])
        self.assertTrue(workspaces[0]["is_default"])
        self.assertEqual(check_plan._extract_expiry(payload, "team-id")[1], "2090-06-01T00:00:00Z")
        self.assertEqual(check_plan._extract_expiry(payload)[1], "2090-01-01T00:00:00Z")
        self.assertEqual(check_plan._extract_expiry(payload, "missing"), (None, None))

    def test_free_workspace_does_not_inherit_another_accounts_expiry(self):
        personal = account("personal", "free")
        paid = account("paid", "business", "2090-06-01T00:00:00Z")
        payload = {"accounts": {"paid": paid, "default": personal, "personal": personal}}
        self.assertEqual(check_plan._extract_expiry(payload), (None, None))

    def test_default_pointer_and_alias_without_an_id_are_deduplicated(self):
        for default in ["personal", {"account": {"plan_type": "free"}}]:
            with self.subTest(default=default):
                payload = {"accounts": {"default": default, "personal": {"account": {"plan_type": "free"}}}}
                workspaces = extract_workspaces({}, payload)
                self.assertEqual(len(workspaces), 1)
                self.assertEqual(workspaces[0]["id"], "personal")
                self.assertTrue(workspaces[0]["is_default"])

    def test_session_plan_is_only_applied_to_its_workspace(self):
        session = {"account": {"id": "school", "planType": "k12"}}
        workspaces = extract_workspaces(session, {"accounts": {"personal": account("personal", "free")}})
        self.assertEqual([(item["id"], item["plan"]) for item in workspaces], [("personal", "free"), ("school", "k12")])
        self.assertEqual(select_workspace(workspaces, session)["plan"], "k12")

    def test_malformed_expiry_and_usage_are_not_fabricated(self):
        payload = {"accounts": {"one": account("one", "plus", "not-a-date")}}
        self.assertEqual(check_plan._extract_expiry(payload), (None, "not-a-date"))
        for window in [[], None, {"used_percent": True}, {"used_percent": float("nan")}, {"used_percent": "25"}]:
            self.assertEqual(check_plan._extract_remaining({"rate_limit": {"primary_window": window}}), (None, None, False))
        self.assertEqual(check_plan._extract_remaining({"rate_limit": {"primary_window": {"used_percent": 25.4, "reset_at": 5}, "limit_reached": True}}), (75, 5, True))


class CheckPlanRequestTests(unittest.IsolatedAsyncioTestCase):
    async def run_check(self, session, accounts, usage=None, accounts_status=200, accounts_error=None, close_error=None, entry_token="offline-token"):
        calls = []

        async def get(url, **kwargs):
            calls.append((url, kwargs))
            if url == check_plan._URL_SESSION:
                return SimpleNamespace(status_code=200, json=lambda: session)
            if url == check_plan._URL_ACCOUNTS_CHECK:
                if accounts_error:
                    raise accounts_error
                return SimpleNamespace(status_code=accounts_status, json=lambda: accounts)
            if url == check_plan._URL_USAGE:
                return SimpleNamespace(status_code=200, json=lambda: usage or {})
            raise AssertionError(f"Unexpected URL: {url}")

        client = SimpleNamespace(get=get, close=AsyncMock(side_effect=close_error))
        with patch.object(check_plan, "_make_session", AsyncMock(return_value=client)), patch.object(
            check_plan, "login_pure_request", AsyncMock(return_value=SimpleNamespace(access_token=entry_token))
        ):
            result = await check_plan.check_plan_pure("fixture@example.invalid", "fixture-password", "fixture-secret", logger=logging.getLogger("test"))
        client.close.assert_awaited_once()
        return result, calls

    async def test_session_free_still_fetches_team_and_school_workspaces(self):
        personal = account("personal", "free")
        result, calls = await self.run_check(
            {"account": {"id": "personal", "planType": "free"}, "access_token": "offline-token"},
            {"accounts": {"default": personal, "personal": personal, "team": account("team", "team"), "school": account("school", "k12")}},
            {"account_id": "personal", "rate_limit": {"primary_window": {"used_percent": 20}}},
        )
        self.assertEqual(result["plan"], "free")
        self.assertTrue(result["plans_complete"])
        self.assertEqual(result["warnings"], [])
        self.assertEqual(result["plans"], ["free", "team", "k12"])
        self.assertEqual(len(result["workspaces"]), 3)
        self.assertEqual(result["remaining_percent"], 80)
        self.assertEqual(result["usage_account_id"], "personal")
        self.assertEqual(calls[-1][1]["headers"]["ChatGPT-Account-ID"], "personal")

    async def test_selected_team_usage_and_expiry_are_scoped_to_team(self):
        personal = account("personal", "plus", "2090-01-01T00:00:00Z")
        result, calls = await self.run_check(
            {"account": {"id": "team", "planType": "team"}},
            {"accounts": {"default": personal, "personal": personal, "team": account("team", "team", "2090-06-01T00:00:00Z")}},
            {"account_id": "team", "rate_limit": {"primary_window": {"used_percent": 45}}},
        )
        self.assertEqual(result["plan"], "team")
        self.assertEqual(result["expires_at"], "2090-06-01T00:00:00Z")
        self.assertEqual(result["remaining_percent"], 55)
        self.assertEqual(calls[-1][1]["headers"]["ChatGPT-Account-ID"], "team")

    async def test_usage_from_another_workspace_is_not_returned(self):
        result, _ = await self.run_check(
            {"account": {"id": "team", "planType": "team"}},
            {"accounts": {"team": account("team", "team")}},
            {"account_id": "personal", "rate_limit": {"primary_window": {"used_percent": 45}}},
        )
        self.assertNotIn("remaining_percent", result)
        self.assertEqual(result["plan"], "team")

    async def test_unavailable_accounts_preserves_session_plan_and_unknown(self):
        for session, expected in [({"subscription_plan": "Future_Plan"}, "future_plan"), ({}, "unknown")]:
            with self.subTest(expected=expected):
                result, _ = await self.run_check(session, None, accounts_status=403)
                self.assertTrue(result["ok"])
                self.assertEqual(result["plan"], expected)
                self.assertEqual(result["plans"], [expected])
                self.assertIsNone(result["expires_at"])
                self.assertFalse(result["plans_complete"])
                self.assertEqual(result["warnings"], ["workspace_lookup_failed: HTTP 403"])

    async def test_invalid_accounts_shape_is_marked_incomplete(self):
        for accounts in [None, [], "not-an-object", {}, {"accounts": "malformed"}]:
            with self.subTest(accounts=accounts):
                result, _ = await self.run_check({"subscription_plan": "plus"}, accounts)
                self.assertEqual(result["plan"], "plus")
                self.assertFalse(result["plans_complete"])
                self.assertEqual(result["warnings"], ["workspace_lookup_failed: invalid accounts response"])

    async def test_accounts_map_and_list_are_complete(self):
        for accounts in [{}, [], [account("team", "team")]]:
            with self.subTest(accounts=accounts):
                result, _ = await self.run_check({}, {"accounts": accounts})
                self.assertTrue(result["plans_complete"])
                self.assertEqual(result["warnings"], [])

    async def test_lookup_exception_does_not_expose_remote_body(self):
        result, _ = await self.run_check({"subscription_plan": "plus"}, None, accounts_error=ValueError("private response body"))
        self.assertFalse(result["plans_complete"])
        self.assertEqual(result["warnings"], ["workspace_lookup_failed: ValueError"])
        self.assertEqual(result["plan"], "plus")

    async def test_missing_token_is_marked_incomplete(self):
        result, calls = await self.run_check({"subscription_plan": "plus"}, None, entry_token=None)
        self.assertEqual(len(calls), 1)
        self.assertFalse(result["plans_complete"])
        self.assertEqual(result["warnings"], ["workspace_lookup_failed: missing access token"])

    async def test_cleanup_failure_preserves_successful_result(self):
        result, _ = await self.run_check({"subscription_plan": "plus"}, {"accounts": {}}, close_error=OSError("cleanup failed"))
        self.assertTrue(result["ok"])
        self.assertEqual(result["plan"], "plus")

    async def test_usage_can_supply_missing_plan_without_guessing(self):
        result, _ = await self.run_check({}, {}, {"plan_type": "pro"})
        self.assertEqual(result["plan"], "pro")
        self.assertEqual(result["plans"], ["pro"])


class CheckPlanCliTests(unittest.TestCase):
    def test_login_error_stage_is_preserved(self):
        error = LoginError(reason="workspace_selection_required", message="Select a workspace", stage="workspace_selection")
        with patch.object(sys, "argv", ["check_plan.py", "fixture@example.invalid|password|secret"]), patch.object(
            check_plan, "check_plan_pure", AsyncMock(side_effect=error)
        ), patch.object(check_plan, "_emit") as emit, patch.object(check_plan.logging, "basicConfig"):
            with self.assertRaises(SystemExit) as raised:
                check_plan._cli()
        self.assertEqual(raised.exception.code, 1)
        emit.assert_called_once_with({"ok": False, "stage": "workspace_selection", "error": "Select a workspace"})


if __name__ == "__main__":
    unittest.main()
