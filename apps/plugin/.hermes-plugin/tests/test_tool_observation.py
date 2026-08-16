"""The two-condition tool-observation rule sync_turn's usedTools flag reads
from the `messages` kwarg (session-nudges D4): a message whose role sits
outside {user, assistant, system} (a tool RESULT), OR an assistant message
carrying a non-empty `tool_calls` field (a tool CALL). Each half is tested
with its own control, since a role-only reading passes a naive test while
missing exactly the call-without-result case this rule exists for.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from _loader import fresh_plugin


class _FakeJsonResponse:
    def __init__(self, body: dict, status: int = 200) -> None:
        self.status = status
        self._body = json.dumps(body).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False

    def read(self):
        return self._body


def _captured_post(mock_urlopen, idx: int = 0):
    request = mock_urlopen.call_args_list[idx].args[0]
    body = json.loads(request.data.decode("utf-8")) if request.data else None
    return request.full_url, body


class ToolObservationTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        (self.tmp / "home").mkdir()
        (self.tmp / "cwd").mkdir()
        (self.tmp / "cwd" / ".rembric").write_text("PROJECT_SLUG=myproj\n")
        self.mod = fresh_plugin(
            env={
                "REMBRIC_SERVER_URL": "http://server.example.com:8787",
                "REMBRIC_API_TOKEN": "tok-XXXX",
            },
            home=str(self.tmp / "home"),
        )

    def _provider(self):
        return self.mod.RembricMemoryProvider()

    def _sync_and_wait(self, provider, *args, **kwargs) -> None:
        provider.sync_turn(*args, **kwargs)
        self.assertTrue(provider._sync_lock.acquire(timeout=5.0))
        provider._sync_lock.release()

    def _turn_body(self, mock_urlopen: MagicMock) -> dict:
        for i in range(len(mock_urlopen.call_args_list)):
            url, body = _captured_post(mock_urlopen, idx=i)
            if url.endswith("/turn"):
                return body
        raise AssertionError("no /turn request was captured")

    @patch("rembric_hermes_plugin.urlopen")
    def test_a_tool_result_message_is_reported_as_work(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        mock_urlopen.reset_mock()

        self._sync_and_wait(
            provider,
            "run the tests",
            "done",
            messages=[
                {"role": "user", "content": "run the tests"},
                {"role": "assistant", "content": "done"},
                {"role": "tool", "content": "1 passed"},
            ],
        )
        self.assertTrue(self._turn_body(mock_urlopen)["usedTools"])

    @patch("rembric_hermes_plugin.urlopen")
    def test_control_a_role_only_list_with_no_tool_calls_reports_false(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        mock_urlopen.reset_mock()

        self._sync_and_wait(
            provider,
            "just chatting",
            "sure",
            messages=[
                {"role": "user", "content": "just chatting"},
                {"role": "assistant", "content": "sure"},
                {"role": "system", "content": "background"},
            ],
        )
        self.assertFalse(self._turn_body(mock_urlopen)["usedTools"])

    @patch("rembric_hermes_plugin.urlopen")
    def test_a_tool_call_with_no_result_message_is_still_reported_as_work(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        mock_urlopen.reset_mock()

        self._sync_and_wait(
            provider,
            "run the tests",
            "",
            messages=[
                {"role": "user", "content": "run the tests"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{"id": "t1", "type": "function", "function": {"name": "run"}}],
                },
                # Deliberately NO role:"tool" message — the call aborted or
                # errored before returning anything.
            ],
        )
        self.assertTrue(self._turn_body(mock_urlopen)["usedTools"])

    def test_control_a_role_only_test_misses_the_call_without_result_case(self) -> None:
        # The same input as the previous test, but read through role
        # membership ALONE — the failure mode the two-condition rule
        # exists to prevent: a role-only reading returns False here, while
        # the real function (tested above) returns True on the same input.
        messages = [
            {"role": "user", "content": "run the tests"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": "t1", "type": "function", "function": {"name": "run"}}],
            },
        ]
        role_only_result = any(
            m.get("role") not in ("user", "assistant", "system") for m in messages
        )
        self.assertFalse(role_only_result)
        self.assertTrue(self.mod._messages_used_tools(messages))

    @patch("rembric_hermes_plugin.urlopen")
    def test_an_empty_tool_calls_field_is_not_a_tool_call(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        mock_urlopen.reset_mock()

        self._sync_and_wait(
            provider,
            "hi",
            "hello",
            messages=[
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "hello", "tool_calls": []},
            ],
        )
        self.assertFalse(self._turn_body(mock_urlopen)["usedTools"])

    @patch("rembric_hermes_plugin.urlopen")
    def test_absent_messages_kwarg_fails_open_reporting_true(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        mock_urlopen.reset_mock()

        # No `messages` kwarg at all — the provider's own two-string
        # fallback synthesises a list admitting neither condition by
        # construction, so `usedTools` reports True rather than False.
        self._sync_and_wait(provider, "hi", "hello")
        self.assertTrue(self._turn_body(mock_urlopen)["usedTools"])

    @patch("rembric_hermes_plugin.urlopen")
    def test_a_tool_in_an_earlier_turn_is_not_reported_for_a_chat_turn(
        self, mock_urlopen: MagicMock
    ) -> None:
        # `messages` is the agent loop's whole working list, so turn one's tool
        # would otherwise mark every later turn as work for the rest of the run.
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        mock_urlopen.reset_mock()

        self._sync_and_wait(
            provider,
            "thanks",
            "you're welcome",
            messages=[
                {"role": "user", "content": "run the tests"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{"id": "t1", "type": "function", "function": {"name": "run"}}],
                },
                {"role": "tool", "content": "1 passed"},
                {"role": "assistant", "content": "all green"},
                {"role": "user", "content": "thanks"},
                {"role": "assistant", "content": "you're welcome"},
            ],
        )
        self.assertFalse(self._turn_body(mock_urlopen)["usedTools"])

    def test_control_the_same_history_with_the_tool_in_the_last_turn_reports_true(self) -> None:
        history = [
            {"role": "user", "content": "just chatting"},
            {"role": "assistant", "content": "sure"},
        ]
        current_turn = [
            {"role": "user", "content": "run the tests"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": "t1", "type": "function", "function": {"name": "run"}}],
            },
            {"role": "tool", "content": "1 passed"},
        ]
        self.assertTrue(self.mod._messages_used_tools(history + current_turn))
        # …and with the two halves swapped the tool is history, not this turn.
        self.assertFalse(
            self.mod._messages_used_tools(
                current_turn + [{"role": "user", "content": "thanks"}]
            )
        )

    def test_messages_used_tools_matches_the_synthesised_fallback_shape(self) -> None:
        synthesised = [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hello"},
        ]
        self.assertTrue(
            all(m.get("role") in ("user", "assistant", "system") for m in synthesised)
        )
        self.assertTrue(all(not m.get("tool_calls") for m in synthesised))
        self.assertTrue(self.mod._messages_used_tools(None))
        self.assertFalse(self.mod._messages_used_tools(synthesised))


if __name__ == "__main__":
    unittest.main()
