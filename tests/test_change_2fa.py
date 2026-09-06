"""Exercise rotation with fake sessions; never contact real accounts."""
import logging
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core"))
import change_2fa as rotate

LOGGER = logging.getLogger("test_rotation")
SECRET = "JBSWY3DPEHPK3PXP"


def response(payload, status=200):
    return SimpleNamespace(status_code=status, json=lambda: payload)


class RotationTests(unittest.IsolatedAsyncioTestCase):
    async def run_rotation(self, client, workspace=False):
        with (
            patch.object(rotate, "_make_session", AsyncMock(return_value=client)),
            patch.object(rotate, "login_pure_request", AsyncMock(return_value=SimpleNamespace(access_token="fake-token"))),
            patch.object(rotate, "_has_session_token", return_value=True),
            patch.object(rotate, "_get_session", AsyncMock(return_value={"account": {"id": "personal", "planType": "free"}})),
        ):
            return await rotate.change_2fa_pure("test@example.test", "fake-password", SECRET, logger=LOGGER, workspace=workspace)

    def client(self, activation=None):
        return SimpleNamespace(
            post=AsyncMock(side_effect=[response({"secret": SECRET, "session_id": "enrollment"}), activation or response({"success": True})]),
            get=AsyncMock(return_value=response({"accounts": {
                "personal": {"account": {"plan_type": "free"}},
                "school": {"account": {"plan_type": "k12"}},
                "default": "personal",
            }})),
            close=AsyncMock(),
        )

    async def test_personal_rotation_keeps_existing_request_context(self):
        client = self.client()
        result = await self.run_rotation(client)
        self.assertTrue(result["ok"])
        self.assertEqual(result["totp_secret"], SECRET)
        client.get.assert_not_awaited()
        self.assertEqual(client.post.await_count, 2)
        for call in client.post.await_args_list:
            self.assertNotIn("ChatGPT-Account-ID", call.kwargs["headers"])

    async def test_workspace_rotation_scopes_both_posts_to_school(self):
        client = self.client()
        result = await self.run_rotation(client, workspace=True)
        self.assertTrue(result["ok"])
        self.assertEqual(client.post.await_count, 2)
        for call in client.post.await_args_list:
            self.assertEqual(call.kwargs["headers"]["ChatGPT-Account-ID"], "school")

    async def test_no_managed_workspace_fails_before_enrollment(self):
        client = self.client()
        client.get.return_value = response({"accounts": {"personal": {"account": {"plan_type": "free"}}}})
        result = await self.run_rotation(client, workspace=True)
        self.assertFalse(result["ok"])
        self.assertEqual(result["stage"], "workspace_lookup")
        client.post.assert_not_awaited()

    async def test_workspace_lookup_failure_is_not_reported_as_rotation(self):
        client = self.client()
        client.get.return_value = response({}, 403)
        result = await self.run_rotation(client, workspace=True)
        self.assertIn("HTTP 403", result["error"])
        client.post.assert_not_awaited()

    async def test_enroll_failure_never_activates_or_leaks_candidate(self):
        client = self.client()
        client.post.side_effect = [response({}, 500)]
        result = await self.run_rotation(client)
        self.assertFalse(result["ok"])
        self.assertEqual(result["stage"], "mfa_enroll")
        self.assertNotIn("recovery_totp", result)
        self.assertEqual(client.post.await_count, 1)

    async def test_ambiguous_activation_preserves_secret_without_retry(self):
        for activation in (TimeoutError("request timed out"), response({}, 500), response({"success": False}), response({"success": "false"})):
            with self.subTest(activation=str(activation)):
                client = self.client(activation)
                result = await self.run_rotation(client)
                self.assertFalse(result["ok"])
                self.assertTrue(result["activation_uncertain"])
                self.assertEqual(result["recovery_totp"], SECRET)
                self.assertEqual(result["stage"], "mfa_activate")
                self.assertEqual(client.post.await_count, 2)
                client.close.assert_awaited_once()

    async def test_cleanup_failure_does_not_lose_successful_secret(self):
        client = self.client()
        client.close.side_effect = RuntimeError("close failed")
        result = await self.run_rotation(client)
        self.assertTrue(result["ok"])
        self.assertEqual(result["totp_secret"], SECRET)


if __name__ == "__main__":
    unittest.main()
