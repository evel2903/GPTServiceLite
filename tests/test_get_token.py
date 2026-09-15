"""Exercise get_token with fake sessions; never contact real accounts."""
import logging
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core"))
import get_token
from login_service import LoginError

LOGGER = logging.getLogger("test_get_token")
SECRET = "JBSWY3DPEHPK3PXP"


class GetTokenTests(unittest.IsolatedAsyncioTestCase):
    async def test_get_token_success(self):
        fake_client = SimpleNamespace(close=AsyncMock())
        fake_entry = SimpleNamespace(
            access_token="test-access-token-123",
            raw_session={"user": {"email": "user@example.com"}, "accessToken": "test-access-token-123"}
        )
        with (
            patch.object(get_token, "_make_session", AsyncMock(return_value=fake_client)),
            patch.object(get_token, "login_pure_request", AsyncMock(return_value=fake_entry)),
            patch.object(get_token, "_has_session_token", return_value=True),
        ):
            result = await get_token.get_token_pure("user@example.com", "password", SECRET, logger=LOGGER)
            self.assertTrue(result["ok"])
            self.assertEqual(result["email"], "user@example.com")
            self.assertEqual(result["access_token"], "test-access-token-123")
            self.assertEqual(result["session"]["accessToken"], "test-access-token-123")
            fake_client.close.assert_awaited_once()

    async def test_get_token_missing_token(self):
        fake_client = SimpleNamespace(close=AsyncMock())
        fake_entry = SimpleNamespace(access_token="", raw_session={})
        with (
            patch.object(get_token, "_make_session", AsyncMock(return_value=fake_client)),
            patch.object(get_token, "login_pure_request", AsyncMock(return_value=fake_entry)),
            patch.object(get_token, "_has_session_token", return_value=True),
        ):
            result = await get_token.get_token_pure("user@example.com", "password", SECRET, logger=LOGGER)
            self.assertFalse(result["ok"])
            self.assertIn("no access_token", result["error"])
            fake_client.close.assert_awaited_once()

    async def test_get_token_login_error(self):
        fake_client = SimpleNamespace(close=AsyncMock())
        with (
            patch.object(get_token, "_make_session", AsyncMock(return_value=fake_client)),
            patch.object(get_token, "login_pure_request", AsyncMock(side_effect=LoginError(code="login_credentials_invalid"))),
        ):
            result = await get_token.get_token_pure("user@example.com", "password", SECRET, logger=LOGGER)
            self.assertFalse(result["ok"])
            self.assertEqual(result["error"], "login_credentials_invalid")
            fake_client.close.assert_awaited_once()

    def test_selfcheck(self):
        self.assertEqual(get_token._selfcheck(), 0)


if __name__ == "__main__":
    unittest.main()
