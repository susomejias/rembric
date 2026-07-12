"""_format_transcript excludes non-conversational roles (system, tool)."""

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


class FormatTranscriptRoleFilterTest(unittest.TestCase):
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

    def test_excludes_system_and_tool_roles_keeps_user_and_assistant(self) -> None:
        messages = [
            {"role": "system", "content": "You are Hermes. Toolset docs: web, browser, terminal..."},
            {"role": "user", "content": "please fix the bug"},
            {"role": "tool", "content": "{\"result\": \"ok\"}"},
            {"role": "assistant", "content": "Fixed it."},
        ]
        transcript = self.mod._format_transcript(messages)
        self.assertNotIn("Toolset docs", transcript)
        self.assertNotIn("result", transcript)
        self.assertIn("user: please fix the bug", transcript)
        self.assertIn("assistant: Fixed it.", transcript)

    def test_giant_system_message_does_not_displace_conversation_from_truncation_window(
        self,
    ) -> None:
        giant_system = "x" * (self.mod._SUMMARY_MAX_CHARS * 2)
        messages = [
            {"role": "system", "content": giant_system},
            {"role": "user", "content": "please fix the bug"},
            {"role": "assistant", "content": "Fixed it."},
        ]
        transcript = self.mod._format_transcript(messages)
        self.assertNotIn("x" * 100, transcript)
        self.assertIn("please fix the bug", transcript)
        self.assertIn("Fixed it.", transcript)

    @patch("rembric_hermes_plugin.urlopen")
    def test_on_pre_compress_inherits_the_filter(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        mock_urlopen.reset_mock()

        provider.on_pre_compress(
            [
                {"role": "system", "content": "Toolset docs: web, browser..."},
                {"role": "user", "content": "please fix the bug"},
                {"role": "assistant", "content": "Fixed it."},
            ]
        )
        request = mock_urlopen.call_args_list[0].args[0]
        body = json.loads(request.data.decode("utf-8"))
        self.assertNotIn("Toolset docs", body["summary"])
        self.assertIn("please fix the bug", body["summary"])

    @patch("rembric_hermes_plugin.urlopen")
    def test_on_session_end_inherits_the_filter(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        mock_urlopen.reset_mock()

        provider.on_session_end(
            [
                {"role": "system", "content": "Toolset docs: web, browser..."},
                {"role": "user", "content": "please fix the bug"},
                {"role": "assistant", "content": "Fixed it."},
            ]
        )
        request = mock_urlopen.call_args_list[0].args[0]
        body = json.loads(request.data.decode("utf-8"))
        self.assertNotIn("Toolset docs", body["summary"])
        self.assertIn("please fix the bug", body["summary"])

    @patch("rembric_hermes_plugin.urlopen")
    def test_sync_turn_inherits_the_filter(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        mock_urlopen.reset_mock()

        provider.sync_turn(
            "please fix the bug",
            "Fixed it.",
            messages=[
                {"role": "system", "content": "Toolset docs: web, browser..."},
                {"role": "user", "content": "please fix the bug"},
                {"role": "assistant", "content": "Fixed it."},
            ],
        )
        self.assertTrue(provider._sync_lock.acquire(timeout=5.0))
        provider._sync_lock.release()
        request = mock_urlopen.call_args_list[0].args[0]
        body = json.loads(request.data.decode("utf-8"))
        self.assertNotIn("Toolset docs", body["summary"])
        self.assertIn("please fix the bug", body["summary"])


if __name__ == "__main__":
    unittest.main()
