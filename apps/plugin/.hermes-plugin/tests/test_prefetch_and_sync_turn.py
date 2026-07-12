"""prefetch/queue_prefetch (per-turn recall), sync_turn (throttled heartbeat),
and initialize's agent_context gating.
"""

from __future__ import annotations

import json
import tempfile
import threading
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
    def test_sync_turn_posts_on_every_call_via_a_background_thread(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        mock_urlopen.reset_mock()

        self.assertIsNone(provider.sync_turn("hi", "hello"))
        self.assertTrue(provider._sync_lock.acquire(timeout=5.0))
        provider._sync_lock.release()
        self.assertEqual(mock_urlopen.call_count, 1)
        url, body = _captured_post(mock_urlopen)
        self.assertEqual(
            url, "http://server.example.com:8787/api/myproj/sessions/01XYZ/summary"
        )
        self.assertEqual(body["final"], False)
        self.assertIn("hi", body["summary"])
        self.assertIn("hello", body["summary"])

        for _ in range(3):
            provider.sync_turn("hi again", "hello again")
            self.assertTrue(provider._sync_lock.acquire(timeout=5.0))
            provider._sync_lock.release()
        self.assertEqual(mock_urlopen.call_count, 4)

    @patch("rembric_hermes_plugin.urlopen")
    def test_sync_turn_does_not_block_the_calling_thread(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        mock_urlopen.reset_mock()

        release = threading.Event()

        def slow_urlopen(*_a, **_kw):
            release.wait(timeout=5.0)
            return _FakeJsonResponse({"ok": True})

        mock_urlopen.side_effect = slow_urlopen

        provider.sync_turn("hi", "hello")
        # The background thread holds the lock for the duration of the slow POST.
        self.assertFalse(provider._sync_lock.acquire(timeout=0))
        release.set()
        self.assertTrue(provider._sync_lock.acquire(timeout=5.0))
        provider._sync_lock.release()

    @patch("rembric_hermes_plugin.urlopen")
    def test_sync_turn_serializes_concurrent_calls_via_the_lock(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        mock_urlopen.reset_mock()

        first_started = threading.Event()
        first_release = threading.Event()
        second_started = threading.Event()

        def slow_urlopen(*_a, **_kw):
            if not first_started.is_set():
                first_started.set()
                first_release.wait(timeout=5.0)
            else:
                second_started.set()
            return _FakeJsonResponse({"ok": True})

        mock_urlopen.side_effect = slow_urlopen

        provider.sync_turn("first", "reply")
        self.assertTrue(first_started.wait(timeout=5.0))

        provider.sync_turn("second", "reply2")
        # Second call's background thread is blocked acquiring the lock,
        # not yet POSTing — bounded wait shorter than first_release.
        self.assertFalse(second_started.wait(timeout=0.2))

        first_release.set()
        self.assertTrue(second_started.wait(timeout=5.0))
        self.assertTrue(provider._sync_lock.acquire(timeout=5.0))
        provider._sync_lock.release()
        self.assertEqual(mock_urlopen.call_count, 2)

    @patch("rembric_hermes_plugin.urlopen")
    def test_sync_turn_heartbeat_prefers_the_full_messages_list_when_given(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        mock_urlopen.reset_mock()

        provider.sync_turn(
            "latest user msg",
            "latest assistant msg",
            messages=[
                {"role": "user", "content": "turn one"},
                {"role": "assistant", "content": "turn one reply"},
            ],
        )
        self.assertTrue(provider._sync_lock.acquire(timeout=5.0))
        provider._sync_lock.release()
        _, body = _captured_post(mock_urlopen)
        self.assertIn("turn one", body["summary"])
        self.assertIn("turn one reply", body["summary"])

    @patch("rembric_hermes_plugin.urlopen")
    def test_on_session_end_drains_a_pending_sync_turn_before_posting_end(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeJsonResponse({"ok": True})
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        mock_urlopen.reset_mock()

        started = threading.Event()
        release = threading.Event()
        order: list[str] = []

        def slow_urlopen(req, *_a, **_kw):
            if req.full_url.endswith("/summary"):
                started.set()
                release.wait(timeout=5.0)
                order.append("summary")
            else:
                order.append("end")
            return _FakeJsonResponse({"ok": True})

        mock_urlopen.side_effect = slow_urlopen

        provider.sync_turn("hi", "hello")
        self.assertTrue(started.wait(timeout=5.0))
        release.set()

        provider.on_session_end([{"role": "user", "content": "bye"}])

        self.assertEqual(order, ["summary", "end"])

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
