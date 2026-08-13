"""The post-compaction directive: armed by on_pre_compress (the compaction
event itself, never by on_turn_start's remaining_tokens estimate), emitted
exactly once from the next prefetch(), superseding the resumed-read line on
a shared turn, and cleared on session end and session switch
(plugin-session-protocol, opencode-plugin design D24/D25).
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


class PostCompactDirectiveTest(unittest.TestCase):
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

    @patch("rembric_hermes_plugin.urlopen")
    def test_not_armed_by_a_low_remaining_tokens_estimate_alone(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True, "created": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))

        provider.on_turn_start(1, None, remaining_tokens=100)
        out = provider.prefetch("q", session_id="01XYZ")
        self.assertNotIn(self.mod._POST_COMPACT_HINT, out)

    @patch("rembric_hermes_plugin.urlopen")
    def test_armed_by_on_pre_compress_and_emitted_exactly_once(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True, "created": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))

        provider.on_turn_start(1, None)
        out1 = provider.prefetch("q", session_id="01XYZ")
        self.assertNotIn(self.mod._POST_COMPACT_HINT, out1)

        ret = provider.on_pre_compress([{"role": "user", "content": "hello"}])
        self.assertEqual(ret, "")

        provider.on_turn_start(2, None)
        out2 = provider.prefetch("q", session_id="01XYZ")
        self.assertIn(self.mod._POST_COMPACT_HINT, out2)

        provider.on_turn_start(3, None)
        out3 = provider.prefetch("q", session_id="01XYZ")
        self.assertNotIn(self.mod._POST_COMPACT_HINT, out3)

    @patch("rembric_hermes_plugin.urlopen")
    def test_on_pre_compress_still_returns_the_empty_string(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True, "created": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        ret = provider.on_pre_compress([{"role": "user", "content": "hello"}])
        self.assertEqual(ret, "")

    @patch("rembric_hermes_plugin.urlopen")
    def test_supersedes_the_resumed_read_line_on_a_shared_turn(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True, "created": False})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))

        provider.on_pre_compress([{"role": "user", "content": "hello"}])
        provider.on_turn_start(1, None)
        out = provider.prefetch("q", session_id="01XYZ")
        self.assertIn(self.mod._POST_COMPACT_HINT, out)
        self.assertNotIn(self.mod._RESUMED_READ_HINT, out)

    @patch("rembric_hermes_plugin.urlopen")
    def test_cleared_by_session_end(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True, "created": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        provider.on_pre_compress([{"role": "user", "content": "hello"}])
        provider.on_session_end([{"role": "user", "content": "bye"}])

        provider.on_turn_start(1, None)
        out = provider.prefetch("q", session_id="01XYZ")
        self.assertNotIn(self.mod._POST_COMPACT_HINT, out)

    @patch("rembric_hermes_plugin.urlopen")
    def test_cleared_by_session_switch(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True, "created": True})
        provider = self._provider()
        provider.initialize("01FIRST", cwd=str(self.tmp / "cwd"))
        provider.on_pre_compress([{"role": "user", "content": "hello"}])
        provider.on_session_switch("01SECOND", parent_session_id="01FIRST")

        provider.on_turn_start(1, None)
        out = provider.prefetch("q", session_id="01SECOND")
        self.assertNotIn(self.mod._POST_COMPACT_HINT, out)


if __name__ == "__main__":
    unittest.main()
