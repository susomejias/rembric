"""prefetch/queue_prefetch (per-turn recall), sync_turn (throttled heartbeat),
and initialize's agent_context gating.
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


class PrefetchAndSyncTurnTest(unittest.TestCase):
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
    def test_prefetch_returns_empty_before_any_queue_prefetch(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        mock_urlopen.reset_mock()
        self.assertEqual(provider.prefetch("how did we handle auth"), "")
        mock_urlopen.assert_not_called()

    @patch("rembric_hermes_plugin.urlopen")
    def test_queue_prefetch_warms_the_cache_and_prefetch_reads_it(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse(
            {
                "ok": True,
                "memories": [{"id": "01A", "title": "auth notes", "snippet": "..."}],
                "formatted": "<memory-context>\n- auth notes: ...\n</memory-context>",
            }
        )
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        mock_urlopen.reset_mock()

        result = provider.queue_prefetch("how did we handle auth", session_id="01XYZ")
        self.assertIsNone(result)
        self.assertEqual(mock_urlopen.call_count, 1)
        url, body = _captured_post(mock_urlopen)
        self.assertEqual(url, "http://server.example.com:8787/api/myproj/memory/recall")
        self.assertEqual(body, {"query": "how did we handle auth", "limit": 5})

        cached = provider.prefetch("how did we handle auth", session_id="01XYZ")
        self.assertIn("<memory-context>", cached)
        self.assertIn("auth notes", cached)
        # prefetch itself still makes no network call.
        self.assertEqual(mock_urlopen.call_count, 1)

    @patch("rembric_hermes_plugin.urlopen")
    def test_queue_prefetch_is_a_no_op_for_an_empty_query(
        self, mock_urlopen: MagicMock
    ) -> None:
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        mock_urlopen.reset_mock()
        self.assertIsNone(provider.queue_prefetch(""))
        mock_urlopen.assert_not_called()

    @patch("rembric_hermes_plugin.urlopen")
    def test_queue_prefetch_failure_leaves_prior_cache_entry_intact(
        self, mock_urlopen: MagicMock
    ) -> None:
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        mock_urlopen.reset_mock()
        mock_urlopen.return_value = _FakeJsonResponse(
            {"ok": True, "memories": [], "formatted": "<memory-context>\n- x: y\n</memory-context>"}
        )
        provider.queue_prefetch("first query", session_id="01XYZ")
        self.assertEqual(provider.prefetch("first query", session_id="01XYZ"), (
            "<memory-context>\n- x: y\n</memory-context>"
        ))

        mock_urlopen.side_effect = OSError("network down")
        result = provider.queue_prefetch("second query", session_id="01XYZ")
        self.assertIsNone(result)
        # Cache still holds the first successful result.
        self.assertEqual(
            provider.prefetch("second query", session_id="01XYZ"),
            "<memory-context>\n- x: y\n</memory-context>",
        )

    @patch("rembric_hermes_plugin.urlopen")
    def test_sync_turn_only_posts_every_fifth_call(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        mock_urlopen.reset_mock()

        for _ in range(4):
            self.assertIsNone(provider.sync_turn("hi", "hello"))
        mock_urlopen.assert_not_called()

        self.assertIsNone(provider.sync_turn("hi", "hello"))
        self.assertEqual(mock_urlopen.call_count, 1)
        url, body = _captured_post(mock_urlopen)
        self.assertEqual(
            url, "http://server.example.com:8787/api/myproj/sessions/01XYZ/summary"
        )
        self.assertEqual(body["final"], False)
        self.assertIn("hi", body["summary"])
        self.assertIn("hello", body["summary"])

    @patch("rembric_hermes_plugin.urlopen")
    def test_sync_turn_heartbeat_prefers_the_full_messages_list_when_given(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        mock_urlopen.reset_mock()

        for _ in range(4):
            provider.sync_turn("latest user msg", "latest assistant msg")
        provider.sync_turn(
            "latest user msg",
            "latest assistant msg",
            messages=[
                {"role": "user", "content": "turn one"},
                {"role": "assistant", "content": "turn one reply"},
            ],
        )
        _, body = _captured_post(mock_urlopen)
        self.assertIn("turn one", body["summary"])
        self.assertIn("turn one reply", body["summary"])

    @patch("rembric_hermes_plugin.urlopen")
    def test_initialize_skips_session_creation_for_a_subagent_context(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01SUB", cwd=str(self.tmp / "cwd"), agent_context="subagent")
        mock_urlopen.assert_not_called()
        # Still registers normally for subsequent lifecycle calls.
        self.assertEqual(provider._slug, "myproj")
        self.assertEqual(provider._session_id, "01SUB")

    @patch("rembric_hermes_plugin.urlopen")
    def test_initialize_creates_a_session_when_agent_context_is_absent_or_primary(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01PRIMARY", cwd=str(self.tmp / "cwd"), agent_context="primary")
        self.assertEqual(mock_urlopen.call_count, 1)
        url, _ = _captured_post(mock_urlopen)
        self.assertTrue(url.endswith("/sessions"))


if __name__ == "__main__":
    unittest.main()
