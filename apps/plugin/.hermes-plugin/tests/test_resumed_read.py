"""The resumed-process read line: gated on `created` from the FIRST
session-ensure of the provider instance's lifetime, emitted at most once
per session, never merged into the summary hint (plugin-session-protocol).
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


class ResumedReadTest(unittest.TestCase):
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
    def test_fires_once_on_turn_1_when_created_is_false(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True, "created": False})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))

        provider.on_turn_start(1, None)
        out = provider.prefetch("q", session_id="01XYZ")
        self.assertIn(self.mod._RESUMED_READ_HINT, out)

        provider.on_turn_start(10, None)
        out10 = provider.prefetch("q", session_id="01XYZ")
        self.assertNotIn(self.mod._RESUMED_READ_HINT, out10)

    @patch("rembric_hermes_plugin.urlopen")
    def test_never_fires_when_created_is_true(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True, "created": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))

        provider.on_turn_start(1, None)
        out = provider.prefetch("q", session_id="01XYZ")
        self.assertNotIn(self.mod._RESUMED_READ_HINT, out)
        # The session-opening line fires instead, since this session's own
        # ensure genuinely reported created:true.
        self.assertIn(self.mod._SESSION_OPENING_HINT, out)

    @patch("rembric_hermes_plugin.urlopen")
    def test_never_fires_when_the_ensure_response_carries_no_created_field(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))

        provider.on_turn_start(1, None)
        out = provider.prefetch("q", session_id="01XYZ")
        self.assertNotIn(self.mod._RESUMED_READ_HINT, out)

    @patch("rembric_hermes_plugin.urlopen")
    def test_never_fires_when_the_first_ensure_failed(self, mock_urlopen: MagicMock) -> None:
        import urllib.error

        mock_urlopen.side_effect = urllib.error.HTTPError(
            "http://server.example.com:8787/api/myproj/sessions",
            503,
            "Service Unavailable",
            {},  # type: ignore[arg-type]
            None,
        )
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))

        provider.on_turn_start(1, None)
        out = provider.prefetch("q", session_id="01XYZ")
        self.assertNotIn(self.mod._RESUMED_READ_HINT, out)

    @patch("rembric_hermes_plugin.urlopen")
    def test_the_process_wide_latch_is_read_once_not_per_session(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True, "created": False})
        provider = self._provider()
        provider.initialize("01FIRST", cwd=str(self.tmp / "cwd"))

        # A LATER ensure in the same provider instance reports an UNCLEAR
        # outcome (no `created` field) — so its own per-session opening
        # gate stays false and cannot mask the process-wide latch under
        # test. The latch from the FIRST ensure still governs this line.
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider.on_session_switch("01SECOND", parent_session_id="01FIRST")

        provider.on_turn_start(1, None)
        out = provider.prefetch("q", session_id="01SECOND")
        self.assertIn(self.mod._RESUMED_READ_HINT, out)

    @patch("rembric_hermes_plugin.urlopen")
    def test_is_emitted_as_a_standalone_memory_hint_block(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True, "created": False})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))

        provider.on_turn_start(1, None)
        out = provider.prefetch("q", session_id="01XYZ")
        self.assertIn(self.mod._RESUMED_READ_HINT, out)
        # Its own closed <memory-hint>...</memory-hint> block, never a
        # fragment concatenated into a different hint's text.
        self.assertEqual(out.count(self.mod._RESUMED_READ_HINT), 1)

    @patch("rembric_hermes_plugin.urlopen")
    def test_a_summary_responses_body_never_influences_the_resumed_state(
        self, mock_urlopen: MagicMock
    ) -> None:
        # First ensure reports created:True (fresh session) — the read line
        # must never fire in this process.
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True, "created": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))

        # A /summary response that ALSO happens to carry `created: False`
        # must not be consulted: the contract forbids reading a *summary*
        # response to learn summary (or resume) state at all.
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True, "created": False})
        provider.on_pre_compress([{"role": "user", "content": "hello"}])

        provider.on_turn_start(1, None)
        out = provider.prefetch("q", session_id="01XYZ")
        self.assertNotIn(self.mod._RESUMED_READ_HINT, out)


if __name__ == "__main__":
    unittest.main()
