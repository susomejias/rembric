"""Lifecycle methods POST to the right HTTP endpoints with the right bodies."""

from __future__ import annotations

import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import MagicMock, patch

from _loader import fresh_plugin


class _FakeResponse:
    status = 200

    def __init__(self, body: bytes = b"") -> None:
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False

    def read(self):
        return self._body


def _captured_post(mock_urlopen, idx: int = 0):
    """Return (url, body_dict, headers_dict) for the idx-th urlopen call."""
    request = mock_urlopen.call_args_list[idx].args[0]
    body = json.loads(request.data.decode("utf-8")) if request.data else None
    headers = dict(request.header_items())
    return request.full_url, body, headers


def _posted_urls(mock_urlopen) -> list[str]:
    return [call.args[0].full_url for call in mock_urlopen.call_args_list]


class LifecycleTest(unittest.TestCase):
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
    def test_initialize_posts_session_then_resume(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeResponse()
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        self.assertEqual(mock_urlopen.call_count, 2)
        url, body, headers = _captured_post(mock_urlopen)
        self.assertEqual(
            url, "http://server.example.com:8787/api/myproj/sessions"
        )
        self.assertEqual(
            body,
            {"id": "01XYZ", "cwd": str(self.tmp / "cwd"), "agent": "hermes"},
        )
        self.assertEqual(headers["Authorization"], "Bearer tok-XXXX")
        self.assertEqual(headers["Content-type"], "application/json")
        # The resume follows the ensure, never precedes it: on a row purged
        # while terminal the ensure recreates it and the resume is the no-op.
        url_resume, body_resume, _ = _captured_post(mock_urlopen, idx=1)
        self.assertEqual(
            url_resume,
            "http://server.example.com:8787/api/myproj/sessions/01XYZ/resume",
        )
        self.assertEqual(body_resume, {})

    @patch("rembric_hermes_plugin.urlopen")
    def test_pre_compress_posts_transcript(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeResponse()
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        provider.on_pre_compress(
            [
                {"role": "user", "content": "first message"},
                {"role": "assistant", "content": "ack"},
            ]
        )
        self.assertEqual(mock_urlopen.call_count, 3)
        url, body, _ = _captured_post(mock_urlopen, idx=2)
        self.assertEqual(
            url,
            "http://server.example.com:8787/api/myproj/sessions/01XYZ/summary",
        )
        self.assertEqual(
            body,
            {"summary": "user: first message\nassistant: ack", "final": False},
        )

    @patch("rembric_hermes_plugin.urlopen")
    def test_pre_compress_truncates_at_20k(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeResponse()
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        big = "x" * 30_000
        provider.on_pre_compress([{"role": "user", "content": big}])
        _, body, _ = _captured_post(mock_urlopen, idx=2)
        self.assertEqual(len(body["summary"]), 20_000)
        # Truncation is from the head — the tail of the input survives.
        self.assertTrue(body["summary"].endswith("x" * 20_000))

    @patch("rembric_hermes_plugin.urlopen")
    def test_session_end_with_empty_messages_posts_empty_body(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeResponse()
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        provider.on_session_end([])
        url, body, _ = _captured_post(mock_urlopen, idx=2)
        self.assertEqual(
            url, "http://server.example.com:8787/api/myproj/sessions/01XYZ/end"
        )
        # No transcript → no summary/title to write; degraded end.
        self.assertEqual(body, {})

    @patch("rembric_hermes_plugin.urlopen")
    def test_session_end_with_messages_posts_summary_and_title(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeResponse()
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        provider.on_session_end(
            [
                {"role": "user", "content": "hola"},
                {"role": "assistant", "content": "Fixed the bug"},
                {"role": "user", "content": "thx"},
            ]
        )
        url, body, _ = _captured_post(mock_urlopen, idx=2)
        self.assertEqual(
            url, "http://server.example.com:8787/api/myproj/sessions/01XYZ/end"
        )
        self.assertEqual(body["title"], "Fixed the bug")
        self.assertIn("Fixed the bug", body["summary"])
        self.assertEqual(body["final"], False)

    @patch("rembric_hermes_plugin.urlopen")
    def test_on_session_switch_closes_old_and_opens_new(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeResponse()
        provider = self._provider()
        provider.initialize("01OLD", cwd=str(self.tmp / "cwd"))
        mock_urlopen.reset_mock()
        provider.on_session_switch(
            "01NEW", parent_session_id="01OLD", reset=False
        )
        # Expect three POSTs: /end old, /sessions new, resume new.
        self.assertEqual(mock_urlopen.call_count, 3)
        url_end, body_end, _ = _captured_post(mock_urlopen, idx=0)
        self.assertTrue(url_end.endswith("/sessions/01OLD/end"))
        self.assertEqual(body_end, {})
        url_new, body_new, _ = _captured_post(mock_urlopen, idx=1)
        self.assertTrue(url_new.endswith("/sessions"))
        self.assertEqual(body_new["id"], "01NEW")
        self.assertEqual(body_new["agent"], "hermes")
        url_resume, body_resume, _ = _captured_post(mock_urlopen, idx=2)
        self.assertTrue(url_resume.endswith("/sessions/01NEW/resume"))
        self.assertEqual(body_resume, {})
        self.assertEqual(provider._session_id, "01NEW")

    @patch("rembric_hermes_plugin.urlopen")
    def test_on_session_switch_reset_closes_cached_session(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeResponse()
        provider = self._provider()
        provider.initialize("01OLD", cwd=str(self.tmp / "cwd"))
        mock_urlopen.reset_mock()
        # /reset and /new arrive with a POPULATED parent_session_id (the host
        # passes `old_session_id or ""`), so it discriminates nothing. The
        # cached id does: it is what tells us there is an old row to close.
        provider.on_session_switch("01NEW", parent_session_id="01OLD", reset=True)
        self.assertEqual(mock_urlopen.call_count, 3)
        url_end, body_end, _ = _captured_post(mock_urlopen, idx=0)
        self.assertTrue(url_end.endswith("/sessions/01OLD/end"))
        self.assertEqual(body_end, {})
        url_new, body_new, _ = _captured_post(mock_urlopen, idx=1)
        self.assertTrue(url_new.endswith("/sessions"))
        self.assertEqual(body_new["id"], "01NEW")
        url_resume, _, _ = _captured_post(mock_urlopen, idx=2)
        self.assertTrue(url_resume.endswith("/sessions/01NEW/resume"))
        self.assertEqual(provider._session_id, "01NEW")

    @patch("rembric_hermes_plugin.urlopen")
    def test_in_place_switch_keeps_id_and_resumes_only_once(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeResponse()
        provider = self._provider()
        provider.initialize("01SAME", cwd=str(self.tmp / "cwd"))
        mock_urlopen.reset_mock()
        # In-place compression, then /undo and the gateway rewind: all three
        # hand back the id the provider already holds.
        provider.on_session_switch(
            "01SAME", parent_session_id="01SAME", reset=False
        )
        provider.on_session_switch(
            "01SAME", parent_session_id="", reset=False, rewound=True
        )
        urls = _posted_urls(mock_urlopen)
        self.assertEqual([u for u in urls if u.endswith("/end")], [])
        self.assertEqual([u for u in urls if u.endswith("/resume")], [])
        self.assertEqual(len(urls), 2)
        self.assertTrue(all(u.endswith("/sessions") for u in urls))
        self.assertEqual(provider._session_id, "01SAME")
        # Control in the same run: a genuinely new id DOES close the old row
        # and DOES resume, so the assertions above are not vacuous.
        mock_urlopen.reset_mock()
        provider.on_session_switch(
            "01NEW", parent_session_id="01SAME", reset=False
        )
        urls = _posted_urls(mock_urlopen)
        self.assertEqual(len([u for u in urls if u.endswith("/01SAME/end")]), 1)
        self.assertEqual(len([u for u in urls if u.endswith("/01NEW/resume")]), 1)

    @patch("rembric_hermes_plugin.urlopen")
    def test_switching_back_to_an_ensured_id_does_not_resume_again(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeResponse()
        provider = self._provider()
        provider.initialize("01OLD", cwd=str(self.tmp / "cwd"))
        provider.on_session_switch("01NEW", parent_session_id="01OLD")
        mock_urlopen.reset_mock()
        provider.on_session_switch("01OLD", parent_session_id="01NEW")
        urls = _posted_urls(mock_urlopen)
        # The ensure repeats (it is idempotent); the resume does not.
        self.assertEqual(len([u for u in urls if u.endswith("/sessions")]), 1)
        self.assertEqual([u for u in urls if u.endswith("/resume")], [])

    @patch("rembric_hermes_plugin.urlopen")
    def test_reason_and_rewound_do_not_change_behaviour(
        self, mock_urlopen: MagicMock
    ) -> None:
        # The host sends these from some call sites and not others; consuming
        # either would couple us to a keyword that says nothing about the only
        # case the resume exists for (a cold start, which fires neither).
        runs = []
        for extra in ({}, {"reason": "resume"}, {"rewound": True}, {"reason": "branch"}):
            provider = self._provider()
            provider.initialize("01OLD", cwd=str(self.tmp / "cwd"))
            mock_urlopen.reset_mock()
            provider.on_session_switch("01NEW", parent_session_id="01OLD", **extra)
            runs.append(_posted_urls(mock_urlopen))
        self.assertEqual(len(runs[0]), 3)
        for observed in runs[1:]:
            self.assertEqual(observed, runs[0])

    @patch("rembric_hermes_plugin.urlopen")
    def test_failed_ensure_suppresses_the_resume(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.side_effect = urllib.error.HTTPError(
            "http://server.example.com:8787/api/myproj/sessions",
            503,
            "Service Unavailable",
            {},  # type: ignore[arg-type]
            None,
        )
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        urls = _posted_urls(mock_urlopen)
        self.assertEqual(len(urls), 1)
        self.assertTrue(urls[0].endswith("/sessions"))
        # The id is remembered anyway, so a later ensure retries neither call.
        mock_urlopen.reset_mock()
        mock_urlopen.side_effect = None
        mock_urlopen.return_value = _FakeResponse()
        provider.on_session_switch("01XYZ", parent_session_id="01XYZ")
        self.assertEqual(
            [u for u in _posted_urls(mock_urlopen) if u.endswith("/resume")], []
        )

    @patch("rembric_hermes_plugin.urlopen")
    def test_successful_ensure_does_emit_the_resume(
        self, mock_urlopen: MagicMock
    ) -> None:
        # Control for the failure test above: same path, ensure answering 200.
        mock_urlopen.return_value = _FakeResponse()
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        self.assertEqual(
            [u for u in _posted_urls(mock_urlopen) if u.endswith("/resume")],
            ["http://server.example.com:8787/api/myproj/sessions/01XYZ/resume"],
        )

    @patch("rembric_hermes_plugin.urlopen")
    def test_suppressed_context_makes_no_http_calls_from_sync_or_end(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeResponse()
        provider = self._provider()
        provider.initialize(
            "01SUB", cwd=str(self.tmp / "cwd"), agent_context="subagent"
        )
        mock_urlopen.reset_mock()
        provider.sync_turn("hi", "hello")
        self.assertTrue(provider._sync_lock.acquire(timeout=5.0))
        provider._sync_lock.release()
        provider.on_pre_compress([{"role": "user", "content": "x"}])
        provider.on_session_end([{"role": "assistant", "content": "bye"}])
        self.assertEqual(mock_urlopen.call_count, 0)

    @patch("rembric_hermes_plugin.urlopen")
    def test_suppressed_context_switch_makes_no_http_calls_for_either_session(
        self, mock_urlopen: MagicMock
    ) -> None:
        mock_urlopen.return_value = _FakeResponse()
        provider = self._provider()
        provider.initialize(
            "01OLD", cwd=str(self.tmp / "cwd"), agent_context="cron"
        )
        mock_urlopen.reset_mock()
        provider.on_session_switch(
            "01NEW", parent_session_id="01OLD", reset=False
        )
        self.assertEqual(mock_urlopen.call_count, 0)
        self.assertEqual(provider._session_id, "01NEW")

    @patch("rembric_hermes_plugin.urlopen")
    def test_no_slug_skips_all_posts(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeResponse()
        provider = self._provider()
        # cwd without .rembric and no other slug source
        empty_cwd = self.tmp / "empty"
        empty_cwd.mkdir()
        # Drop the URL parse fallback by overriding the env.
        import os

        os.environ["REMBRIC_SERVER_URL"] = "http://server.example.com:8787"
        provider.initialize("01XYZ", cwd=str(empty_cwd))
        provider.on_pre_compress([{"role": "user", "content": "x"}])
        provider.on_session_end([])
        self.assertEqual(mock_urlopen.call_count, 0)

    @patch("rembric_hermes_plugin.urlopen")
    def test_fully_inert_methods_issue_zero_http(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeResponse()
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        mock_urlopen.reset_mock()
        block = provider.system_prompt_block()
        self.assertIn("memory.session_summary", block)
        self.assertIn("title", block)
        self.assertEqual(provider.prefetch("anything"), "")
        self.assertIsNone(provider.on_memory_write("add", "MEMORY.md", "x"))
        self.assertIsNone(provider.shutdown())
        self.assertEqual(mock_urlopen.call_count, 0)

    @patch("rembric_hermes_plugin.urlopen")
    def test_2xx_with_non_json_body_is_treated_as_success(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeResponse(b"OK")
        self.assertTrue(
            self.mod._api_post("http://server.example.com:8787", "myproj", "/sessions", {"id": "x"})
        )


if __name__ == "__main__":
    unittest.main()
