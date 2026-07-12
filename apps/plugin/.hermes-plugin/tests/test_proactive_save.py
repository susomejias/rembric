"""prefetch save/summary-hint cadence + on_turn_start pre-compaction reminder."""

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


class ProactiveSaveTest(unittest.TestCase):
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
    def test_prefetch_appends_save_hint_on_cadence_even_with_empty_cache(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))

        provider.on_turn_start(5, None)
        self.assertEqual(provider.prefetch("q", session_id="01XYZ"), self.mod._SAVE_HINT)

    @patch("rembric_hermes_plugin.urlopen")
    def test_prefetch_appends_summary_hint_on_turn_1_even_with_empty_cache(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))

        provider.on_turn_start(1, None)
        self.assertEqual(provider.prefetch("q", session_id="01XYZ"), self.mod._SUMMARY_HINT)

    @patch("rembric_hermes_plugin.urlopen")
    def test_prefetch_appends_summary_hint_every_10th_turn(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))

        provider.on_turn_start(10, None)
        self.assertIn(self.mod._SUMMARY_HINT, provider.prefetch("q", session_id="01XYZ"))

    @patch("rembric_hermes_plugin.urlopen")
    def test_prefetch_emits_nothing_off_cadence(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))

        provider.on_turn_start(2, None)
        self.assertEqual(provider.prefetch("q", session_id="01XYZ"), "")

    @patch("rembric_hermes_plugin.urlopen")
    def test_prefetch_appends_both_hints_as_separate_lines_on_turn_10(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))

        provider.on_turn_start(10, None)
        out = provider.prefetch("q", session_id="01XYZ")
        self.assertIn(self.mod._SAVE_HINT, out)
        self.assertIn(self.mod._SUMMARY_HINT, out)
        # Neither replaces the other — both appear as distinct lines.
        self.assertEqual(out, f"{self.mod._SAVE_HINT}\n{self.mod._SUMMARY_HINT}")

    @patch("rembric_hermes_plugin.urlopen")
    def test_prefetch_appends_hint_after_the_recalled_context(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse(
            {"ok": True, "memories": [], "formatted": "<memory-context>\n- x: y\n</memory-context>"}
        )
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        provider.queue_prefetch("warm", session_id="01XYZ")

        provider.on_turn_start(5, None)
        out = provider.prefetch("q", session_id="01XYZ")
        self.assertIn("<memory-context>", out)
        self.assertTrue(out.endswith(self.mod._SAVE_HINT))

    @patch("rembric_hermes_plugin.urlopen")
    def test_on_turn_start_arms_urgent_only_below_the_floor(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))

        provider.on_turn_start(1, None, remaining_tokens=self.mod._COMPACTION_TOKEN_FLOOR + 1)
        self.assertFalse(provider._compaction_imminent)

        provider.on_turn_start(2, None, remaining_tokens=self.mod._COMPACTION_TOKEN_FLOOR - 1)
        self.assertTrue(provider._compaction_imminent)

    @patch("rembric_hermes_plugin.urlopen")
    def test_pre_compaction_reminder_fires_once(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))

        provider.on_turn_start(2, None, remaining_tokens=self.mod._COMPACTION_TOKEN_FLOOR - 1)
        self.assertEqual(provider.prefetch("q", session_id="01XYZ"), self.mod._SAVE_HINT_URGENT)

        provider.on_turn_start(4, None, remaining_tokens=self.mod._COMPACTION_TOKEN_FLOOR - 1)
        self.assertNotIn(self.mod._SAVE_HINT_URGENT, provider.prefetch("q", session_id="01XYZ"))

    @patch("rembric_hermes_plugin.urlopen")
    def test_urgent_reminder_does_not_suppress_the_summary_hint(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))

        # Turn 10 is a summary-firing turn; force the urgent flag armed too.
        provider.on_turn_start(10, None, remaining_tokens=self.mod._COMPACTION_TOKEN_FLOOR - 1)
        out = provider.prefetch("q", session_id="01XYZ")
        self.assertIn(self.mod._SAVE_HINT_URGENT, out)
        self.assertIn(self.mod._SUMMARY_HINT, out)
        # The urgent reminder replaces the NORMAL save hint, not the summary one.
        self.assertNotIn(self.mod._SAVE_HINT, out.replace(self.mod._SAVE_HINT_URGENT, ""))

    @patch("rembric_hermes_plugin.urlopen")
    def test_session_switch_resets_turn_state(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))

        provider.on_turn_start(2, None, remaining_tokens=self.mod._COMPACTION_TOKEN_FLOOR - 1)
        provider.on_session_switch("01NEW")
        self.assertEqual(provider._turn_number, 0)
        self.assertFalse(provider._compaction_imminent)
        self.assertFalse(provider._compaction_warned)


if __name__ == "__main__":
    unittest.main()
