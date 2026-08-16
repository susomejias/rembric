"""prefetch's remaining per-turn hints — first-turn relevance, the cached
server notice (session-nudges), and the pre-compaction urgent reminder.
The periodic save/summary hint and its cadence are gone: the firing
decision now belongs to the server.
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

    def _session_id_hint(self, session_id: str) -> str:
        return self.mod._SESSION_ID_HINT_TEMPLATE.replace("{{SESSION_ID}}", session_id)

    @patch("rembric_hermes_plugin.urlopen")
    def test_relevance_hint_fires_only_on_turn_1_not_on_later_turns(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))

        provider.on_turn_start(1, None)
        self.assertIn(self.mod._RELEVANCE_HINT, provider.prefetch("q", session_id="01XYZ"))

        provider.on_turn_start(2, None)
        self.assertNotIn(self.mod._RELEVANCE_HINT, provider.prefetch("q", session_id="01XYZ"))

    def test_prefetch_omits_session_id_hint_when_session_id_is_unknown(self) -> None:
        # No initialize() call: self._session_id stays None (its __init__
        # default), and no session_id kwarg is passed either.
        provider = self._provider()
        provider.on_turn_start(5, None)
        out = provider.prefetch("q")
        self.assertEqual(out, "")
        self.assertNotIn("sessionId=", out)

    @patch("rembric_hermes_plugin.urlopen")
    def test_prefetch_emits_nothing_absent_a_cached_notice_or_any_other_hint(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True, "created": False})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))

        provider.on_turn_start(2, None)
        self.assertEqual(provider.prefetch("q", session_id="01XYZ"), "")

    @patch("rembric_hermes_plugin.urlopen")
    def test_the_cached_server_notice_is_injected_wrapped_and_taken_once(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True, "created": False})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        provider._pending_lines["01XYZ"] = ["rembric: a server-composed notice"]

        out = provider.prefetch("q", session_id="01XYZ")
        self.assertIn("<memory-hint>rembric: a server-composed notice</memory-hint>", out)

        second = provider.prefetch("q", session_id="01XYZ")
        self.assertNotIn("a server-composed notice", second)

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
        provider._pending_lines["01XYZ"] = ["rembric: a notice"]

        out = provider.prefetch("q", session_id="01XYZ")
        self.assertIn("<memory-context>", out)
        self.assertTrue(out.endswith("</memory-hint>"))

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

        # The sessionId line no longer accompanies this hint: it now
        # accompanies only a write-directing line (the server notice or the
        # session opening), per plugin-session-protocol's restated trigger.
        provider.on_turn_start(2, None, remaining_tokens=self.mod._COMPACTION_TOKEN_FLOOR - 1)
        self.assertEqual(
            provider.prefetch("q", session_id="01XYZ"), self.mod._SAVE_HINT_URGENT
        )

        provider.on_turn_start(4, None, remaining_tokens=self.mod._COMPACTION_TOKEN_FLOOR - 1)
        self.assertNotIn(self.mod._SAVE_HINT_URGENT, provider.prefetch("q", session_id="01XYZ"))

    @patch("rembric_hermes_plugin.urlopen")
    def test_urgent_reminder_does_not_suppress_a_pending_notice(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True, "created": False})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        provider._pending_lines["01XYZ"] = ["rembric: a server-composed notice"]

        provider.on_turn_start(2, None, remaining_tokens=self.mod._COMPACTION_TOKEN_FLOOR - 1)
        out = provider.prefetch("q", session_id="01XYZ")
        self.assertIn(self.mod._SAVE_HINT_URGENT, out)
        self.assertIn("a server-composed notice", out)

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

    def test_no_save_summary_cadence_constant_or_hint_remains(self) -> None:
        for name in ("_SAVE_HINT_EVERY", "_SUMMARY_HINT_EVERY", "_SAVE_HINT", "_SUMMARY_HINT"):
            self.assertFalse(hasattr(self.mod, name), f"{name} should not exist")


if __name__ == "__main__":
    unittest.main()
