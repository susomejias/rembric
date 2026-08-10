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
    def test_fires_once_on_the_first_summary_firing_when_created_is_false(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True, "created": False})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))

        provider.on_turn_start(1, None)
        out = provider.prefetch("q", session_id="01XYZ")
        self.assertIn(self.mod._RESUMED_READ_HINT, out)
        self.assertIn(self.mod._SUMMARY_HINT, out)

        provider.on_turn_start(10, None)
        out10 = provider.prefetch("q", session_id="01XYZ")
        self.assertIn(self.mod._SUMMARY_HINT, out10)
        self.assertNotIn(self.mod._RESUMED_READ_HINT, out10)

    @patch("rembric_hermes_plugin.urlopen")
    def test_never_fires_when_created_is_true(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True, "created": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))

        provider.on_turn_start(1, None)
        out = provider.prefetch("q", session_id="01XYZ")
        self.assertIn(self.mod._SUMMARY_HINT, out)
        self.assertNotIn(self.mod._RESUMED_READ_HINT, out)

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

        # A LATER ensure in the same provider instance reports created:True;
        # the latch from the first ensure still governs every session's line.
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True, "created": True})
        provider.on_session_switch("01SECOND", parent_session_id="01FIRST")

        provider.on_turn_start(1, None)
        out = provider.prefetch("q", session_id="01SECOND")
        self.assertIn(self.mod._RESUMED_READ_HINT, out)

    @patch("rembric_hermes_plugin.urlopen")
    def test_never_merges_into_or_changes_the_summary_hint(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True, "created": False})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))

        provider.on_turn_start(1, None)
        out = provider.prefetch("q", session_id="01XYZ")
        # Line-level, not substring: a line that merely CONTAINS or ENDS
        # WITH the summary hint's text would also satisfy a weaker check
        # even after the two lines were glued into one.
        lines = out.split("\n")
        self.assertIn(self.mod._SUMMARY_HINT, lines)

    @patch("rembric_hermes_plugin.urlopen")
    def test_is_its_own_line_ordered_before_the_summary_hint(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True, "created": False})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))

        provider.on_turn_start(1, None)
        lines = provider.prefetch("q", session_id="01XYZ").split("\n")
        self.assertIn(self.mod._RESUMED_READ_HINT, lines)
        self.assertIn(self.mod._SUMMARY_HINT, lines)
        self.assertLess(
            lines.index(self.mod._RESUMED_READ_HINT), lines.index(self.mod._SUMMARY_HINT)
        )

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
