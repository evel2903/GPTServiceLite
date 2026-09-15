import logging
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core"))
import logout_all
from login_service import LoginError

LOGGER = logging.getLogger("test_logout_all")


class TestLogoutAll(unittest.IsolatedAsyncioTestCase):
    async def test_logout_all_pure_success(self):
        fake_client = SimpleNamespace(
            post=AsyncMock(return_value=SimpleNamespace(status_code=200, text="null")),
            close=AsyncMock()
        )
        fake_entry = SimpleNamespace(access_token="fake_access_token")

        with (
            patch.object(logout_all, "_make_session", new=AsyncMock(return_value=fake_client)),
            patch.object(logout_all, "login_pure_request", new=AsyncMock(return_value=fake_entry)),
            patch.object(logout_all, "_has_session_token", return_value=True),
        ):
            res = await logout_all.logout_all_pure("test@example.com", "pass", "TOTP", logger=LOGGER)

        self.assertTrue(res["ok"])
        self.assertEqual(res["email"], "test@example.com")
        self.assertIn("message", res)

    async def test_logout_all_pure_http_error(self):
        fake_client = SimpleNamespace(
            post=AsyncMock(return_value=SimpleNamespace(status_code=403, text='{"error":"forbidden"}')),
            close=AsyncMock()
        )
        fake_entry = SimpleNamespace(access_token="fake_access_token")

        with (
            patch.object(logout_all, "_make_session", new=AsyncMock(return_value=fake_client)),
            patch.object(logout_all, "login_pure_request", new=AsyncMock(return_value=fake_entry)),
            patch.object(logout_all, "_has_session_token", return_value=True),
        ):
            res = await logout_all.logout_all_pure("test@example.com", "pass", "TOTP", logger=LOGGER)

        self.assertFalse(res["ok"])
        self.assertEqual(res["email"], "test@example.com")
        self.assertEqual(res["stage"], "logout_all")
        self.assertIn("403", res["error"])

    def test_selfcheck(self):
        self.assertEqual(logout_all._selfcheck(), 0)


if __name__ == "__main__":
    unittest.main()
