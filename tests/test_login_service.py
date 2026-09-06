"""Offline regression tests for login continuation and callback handling."""
from __future__ import annotations

import logging
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core"))

import login_service as login


CALLBACK = "https://chatgpt.com/api/auth/callback/openai?code=fake-code"
CONTINUE = "https://auth.openai.com/log-in/success"
AUTHORIZE = "https://auth.openai.com/authorize?state=fake-state"
LOGGER = logging.getLogger("test_login_service")


class Response:
    def __init__(self, status=200, *, payload=None, headers=None, text=""):
        self.status_code = status
        self.headers = headers or {}
        self.text = text
        self._payload = payload

    def json(self):
        if self._payload is None:
            raise ValueError("not JSON")
        return self._payload


class LoginContinuationTests(unittest.IsolatedAsyncioTestCase):
    async def test_json_continuation_reaches_callback(self):
        client = SimpleNamespace(get=AsyncMock(return_value=Response(
            payload={"continue_url": CALLBACK},
            headers={"content-type": "application/json"},
        )))

        result = await login._follow_redirects_to_callback(client, CONTINUE, LOGGER)

        self.assertEqual(result, CALLBACK)
        self.assertEqual(client.get.await_count, 1)

    async def test_relative_json_continuation_uses_current_origin(self):
        client = SimpleNamespace(get=AsyncMock(side_effect=[
            Response(payload={"continue_url": "/log-in/success"},
                     headers={"content-type": "application/json"}),
            Response(302, headers={"location": CALLBACK}),
        ]))

        result = await login._follow_redirects_to_callback(
            client, "https://auth.openai.com/continue", LOGGER,
        )

        self.assertEqual(result, CALLBACK)
        self.assertEqual(client.get.await_args_list[1].args[0], CONTINUE)

    async def test_unsafe_initial_urls_are_rejected_before_request(self):
        for url in (
            "http://auth.openai.com/log-in/success",
            "https://auth.openai.com.evil.test/log-in/success",
            "https://example.com/api/auth/callback/openai?code=fake-code",
            "javascript:alert(1)",
            "https://auth.openai.com:invalid/log-in/success",
            "https://auth.openai.com:99999/log-in/success",
        ):
            with self.subTest(url=url):
                client = SimpleNamespace(get=AsyncMock())
                with self.assertRaises(login.LoginError) as caught:
                    await login._follow_redirects_to_callback(client, url, LOGGER)
                self.assertEqual(caught.exception.reason, "unsupported_login_redirect")
                self.assertEqual(caught.exception.stage, "login_redirect")
                client.get.assert_not_awaited()

    async def test_unsafe_redirect_is_rejected_before_following(self):
        client = SimpleNamespace(get=AsyncMock(return_value=Response(
            302, headers={"location": "https://example.com/redirect"},
        )))

        with self.assertRaises(login.LoginError):
            await login._follow_redirects_to_callback(client, CONTINUE, LOGGER)

        self.assertEqual(client.get.await_count, 1)

    async def test_unsafe_json_continuation_is_rejected_before_following(self):
        client = SimpleNamespace(get=AsyncMock(return_value=Response(
            payload={"continue_url": "https://example.com/redirect"},
            headers={"content-type": "application/json"},
        )))

        with self.assertRaises(login.LoginError):
            await login._follow_redirects_to_callback(client, CONTINUE, LOGGER)

        self.assertEqual(client.get.await_count, 1)

    async def test_workspace_selection_remains_actionable(self):
        client = SimpleNamespace(get=AsyncMock(return_value=Response(
            payload={"page": {"type": "workspace_selection"}},
            headers={"content-type": "application/json"},
        )))

        with self.assertRaises(login.LoginError) as caught:
            await login._follow_redirects_to_callback(client, CONTINUE, LOGGER)

        self.assertEqual(caught.exception.reason, "workspace_selection_required")
        self.assertTrue(caught.exception.stage)

    async def test_html_workspace_selector_remains_actionable(self):
        client = SimpleNamespace(get=AsyncMock(return_value=Response(
            text="<html><body>Select a workspace</body></html>",
        )))

        with self.assertRaises(login.LoginError) as caught:
            await login._follow_redirects_to_callback(
                client, "https://auth.openai.com/select-workspace", LOGGER,
            )

        self.assertEqual(caught.exception.reason, "workspace_selection_required")
        self.assertTrue(caught.exception.stage)

    async def test_sso_and_email_steps_keep_specific_errors(self):
        for page_type, reason in (
            ("sso", "sso_required"),
            ("email_otp_verification", "email_verification_required"),
        ):
            with self.subTest(page_type=page_type):
                client = SimpleNamespace(get=AsyncMock(return_value=Response(
                    payload={"page": {"type": page_type}},
                    headers={"content-type": "application/json"},
                )))

                with self.assertRaises(login.LoginError) as caught:
                    await login._follow_redirects_to_callback(client, CONTINUE, LOGGER)

                self.assertEqual(caught.exception.reason, reason)
                self.assertTrue(caught.exception.stage)

    async def test_mfa_response_page_type_is_preserved_without_continuation(self):
        for challenge_id in ("deadbeef0123456789", "5f850cae-5554-4f14-bb51-e3439082f116"):
            with self.subTest(challenge_id=challenge_id):
                client = object()
                with (
                    patch.object(login, "_bootstrap", new=AsyncMock(return_value=("fake-device", "https://auth.openai.com/log-in/password"))),
                    patch.object(login, "get_sentinel_token", new=AsyncMock(return_value="fake-sentinel")),
                    patch.object(login, "_password_verify", new=AsyncMock(return_value={
                        "page": {"type": "mfa_challenge"}, "continue_url": f"/mfa-challenge/{challenge_id}?source=test",
                    })),
                    patch.object(login, "_mfa_issue", new=AsyncMock()) as issue,
                    patch.object(login, "_mfa_verify", new=AsyncMock(return_value={
                        "page": {"type": "workspace_selection"},
                    })) as verify,
                    patch.object(login.pyotp, "TOTP") as totp,
                    patch.object(login, "_complete_login_callback", new=AsyncMock()) as complete,
                ):
                    totp.return_value.now.return_value = "123456"
                    with self.assertRaises(login.LoginError) as caught:
                        await login.login_pure_request(
                            email="test@example.com", password="fake-password",
                            totp_secret="fake-secret", http_client=client, logger=LOGGER,
                        )

                self.assertEqual(caught.exception.reason, "workspace_selection_required")
                issue.assert_awaited_once_with(client, challenge_id, "fake-device", LOGGER)
                verify.assert_awaited_once_with(client, challenge_id, "123456", "fake-device", LOGGER)
                complete.assert_not_awaited()


class CompleteLoginCallbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_supplied_continuation_is_consumed_without_reauthorization(self):
        client = object()
        session_ready = [False]

        async def consume(*args):
            session_ready[0] = True
            return True

        with (
            patch.object(login, "_follow_redirects_to_callback", new=AsyncMock(return_value=CALLBACK)) as follow,
            patch.object(login, "_consume_callback_verified", new=AsyncMock(side_effect=consume)) as consume_callback,
            patch.object(login, "_has_session_token", side_effect=lambda _: session_ready[0]),
            patch.object(login, "_step_csrf", new=AsyncMock()) as csrf,
            patch.object(login, "_step_auth_url", new=AsyncMock()) as authorize,
        ):
            await login._complete_login_callback(client, CONTINUE, LOGGER)

        follow.assert_awaited_once_with(client, CONTINUE, LOGGER)
        consume_callback.assert_awaited_once_with(client, CALLBACK, LOGGER)
        csrf.assert_not_awaited()
        authorize.assert_not_awaited()

    async def test_unproductive_continuation_uses_one_reauthorization_fallback(self):
        client = object()
        session_ready = [False]

        async def consume(*args):
            session_ready[0] = True
            return True

        with (
            patch.object(login, "_follow_redirects_to_callback", new=AsyncMock(side_effect=[None, CALLBACK])) as follow,
            patch.object(login, "_consume_callback_verified", new=AsyncMock(side_effect=consume)) as consume_callback,
            patch.object(login, "_has_session_token", side_effect=lambda _: session_ready[0]),
            patch.object(login, "_step_csrf", new=AsyncMock(return_value="fake-csrf")) as csrf,
            patch.object(login, "_step_auth_url", new=AsyncMock(return_value=AUTHORIZE)) as authorize,
        ):
            await login._complete_login_callback(client, CONTINUE, LOGGER)

        self.assertEqual([call.args[1] for call in follow.await_args_list], [CONTINUE, AUTHORIZE])
        self.assertEqual(csrf.await_count, 1)
        self.assertEqual(authorize.await_count, 1)
        consume_callback.assert_awaited_once_with(client, CALLBACK, LOGGER)

    async def test_existing_session_does_not_reauthorize(self):
        client = object()
        with (
            patch.object(login, "_has_session_token", return_value=True),
            patch.object(login, "_step_csrf", new=AsyncMock()) as csrf,
            patch.object(login, "_step_auth_url", new=AsyncMock()) as authorize,
        ):
            await login._complete_login_callback(client, "", LOGGER)

        csrf.assert_not_awaited()
        authorize.assert_not_awaited()

    async def test_expired_continuation_can_reauthorize(self):
        client = SimpleNamespace(get=AsyncMock(side_effect=[
            Response(404, text="Continuation expired"),
            Response(302, headers={"location": CALLBACK}),
        ]))
        session_ready = [False]

        async def consume(*args):
            session_ready[0] = True
            return True

        with (
            patch.object(login, "_consume_callback_verified", new=AsyncMock(side_effect=consume)) as consume_callback,
            patch.object(login, "_has_session_token", side_effect=lambda _: session_ready[0]),
            patch.object(login, "_step_csrf", new=AsyncMock(return_value="fake-csrf")) as csrf,
            patch.object(login, "_step_auth_url", new=AsyncMock(return_value=AUTHORIZE)) as authorize,
        ):
            await login._complete_login_callback(client, CONTINUE, LOGGER)

        self.assertEqual([call.args[0] for call in client.get.await_args_list], [CONTINUE, AUTHORIZE])
        self.assertEqual(csrf.await_count, 1)
        self.assertEqual(authorize.await_count, 1)
        consume_callback.assert_awaited_once_with(client, CALLBACK, LOGGER)

    async def test_failed_callback_and_fallback_report_callback_stage(self):
        client = object()
        with (
            patch.object(login, "_follow_redirects_to_callback", new=AsyncMock(return_value=CALLBACK)) as follow,
            patch.object(login, "_consume_callback_verified", new=AsyncMock(return_value=False)) as consume_callback,
            patch.object(login, "_has_session_token", return_value=False),
            patch.object(login, "_step_csrf", new=AsyncMock(return_value="fake-csrf")) as csrf,
            patch.object(login, "_step_auth_url", new=AsyncMock(return_value=AUTHORIZE)) as authorize,
        ):
            with self.assertRaises(login.LoginError) as caught:
                await login._complete_login_callback(client, CONTINUE, LOGGER)

        self.assertEqual(caught.exception.reason, "network_error")
        self.assertEqual(caught.exception.stage, "login_callback")
        self.assertIn("login_callback_failed", str(caught.exception))
        self.assertEqual(follow.await_count, 2)
        self.assertEqual(consume_callback.await_count, 2)
        self.assertEqual(csrf.await_count, 1)
        self.assertEqual(authorize.await_count, 1)

    async def test_structured_required_step_errors_are_not_hidden_by_fallback(self):
        for reason in (
            "workspace_selection_required", "sso_required",
            "email_verification_required", "unsupported_login_redirect",
        ):
            with self.subTest(reason=reason):
                client = object()
                error = login.LoginError(reason=reason, stage="login")
                with (
                    patch.object(login, "_follow_redirects_to_callback", new=AsyncMock(side_effect=error)),
                    patch.object(login, "_has_session_token", return_value=False),
                    patch.object(login, "_step_csrf", new=AsyncMock()) as csrf,
                    patch.object(login, "_step_auth_url", new=AsyncMock()) as authorize,
                ):
                    with self.assertRaises(login.LoginError) as caught:
                        await login._complete_login_callback(client, CONTINUE, LOGGER)

                self.assertIs(caught.exception, error)
                csrf.assert_not_awaited()
                authorize.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()

class WorkspaceSelectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_workspace_selection_auto_selects_organization(self):
        client = SimpleNamespace(
            cookies=SimpleNamespace(jar=[]),
            post=AsyncMock(return_value=Response(
                payload={"continue_url": CALLBACK},
                headers={"content-type": "application/json"},
            ))
        )
        with (
            patch.object(login, "_bootstrap", new=AsyncMock(return_value=("fake-device", "https://auth.openai.com/log-in/password"))),
            patch.object(login, "get_sentinel_token", new=AsyncMock(return_value="fake-sentinel")),
            patch.object(login, "_password_verify", new=AsyncMock(return_value={
                "page": {"type": "mfa_challenge"}, "continue_url": "/mfa-challenge/fake-challenge",
            })),
            patch.object(login, "_mfa_issue", new=AsyncMock()),
            patch.object(login, "_mfa_verify", new=AsyncMock(return_value={
                "continue_url": "https://auth.openai.com/workspace",
                "page": {"type": "workspace"},
                "oai-client-auth-session": {
                    "workspaces": [
                        {"id": "ws-org-123", "name": "Team Org", "kind": "organization"},
                        {"id": "ws-personal-456", "name": None, "kind": "personal"},
                    ]
                },
            })),
            patch.object(login.pyotp, "TOTP") as totp,
            patch.object(login, "_complete_login_callback", new=AsyncMock()) as complete,
            patch.object(login, "_has_session_token", return_value=True),
            patch.object(login, "_get_session", new=AsyncMock(return_value={"accessToken": "test-token"})),
        ):
            totp.return_value.now.return_value = "123456"
            entry = await login.login_pure_request(
                email="test@example.com",
                password="fake-password",
                totp_secret="fake-secret",
                http_client=client,
                logger=LOGGER,
            )

        self.assertEqual(entry.access_token, "test-token")
        client.post.assert_awaited_once_with(
            login._URL_WORKSPACE_SELECT,
            json={"workspace_id": "ws-org-123"},
            headers={
                "Accept": "application/json",
                "Accept-Language": "en-US,en;q=0.9,nl;q=0.8",
                "Referer": f"{login._AUTH_BASE}/workspace",
                "Origin": login._AUTH_BASE,
                "oai-device-id": "fake-device",
            },
            allow_redirects=False,
        )
        complete.assert_awaited_once()

    async def test_workspace_selection_preferred_workspace_id(self):
        client = SimpleNamespace(
            cookies=SimpleNamespace(jar=[]),
            post=AsyncMock(return_value=Response(
                payload={"continue_url": CALLBACK},
                headers={"content-type": "application/json"},
            ))
        )
        with (
            patch.object(login, "_bootstrap", new=AsyncMock(return_value=("fake-device", "https://auth.openai.com/log-in/password"))),
            patch.object(login, "get_sentinel_token", new=AsyncMock(return_value="fake-sentinel")),
            patch.object(login, "_password_verify", new=AsyncMock(return_value={
                "page": {"type": "mfa_challenge"}, "continue_url": "/mfa-challenge/fake-challenge",
            })),
            patch.object(login, "_mfa_issue", new=AsyncMock()),
            patch.object(login, "_mfa_verify", new=AsyncMock(return_value={
                "continue_url": "https://auth.openai.com/workspace",
                "page": {"type": "workspace"},
                "oai-client-auth-session": {
                    "workspaces": [
                        {"id": "ws-org-123", "name": "Team Org", "kind": "organization"},
                        {"id": "ws-personal-456", "name": None, "kind": "personal"},
                    ]
                },
            })),
            patch.object(login.pyotp, "TOTP") as totp,
            patch.object(login, "_complete_login_callback", new=AsyncMock()),
            patch.object(login, "_has_session_token", return_value=True),
            patch.object(login, "_get_session", new=AsyncMock(return_value={"accessToken": "test-token"})),
        ):
            totp.return_value.now.return_value = "123456"
            await login.login_pure_request(
                email="test@example.com",
                password="fake-password",
                totp_secret="fake-secret",
                http_client=client,
                logger=LOGGER,
                workspace_id="ws-personal-456",
            )

        client.post.assert_awaited_once()
        self.assertEqual(client.post.await_args.kwargs["json"]["workspace_id"], "ws-personal-456")
