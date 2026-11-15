"""subagent_stop: forwarding a delegated child's report to the parent session."""

from __future__ import annotations

import io
import json
import tempfile
import threading
import types
import unittest
from contextlib import redirect_stderr
from email.message import Message
from pathlib import Path
from typing import Any
from unittest.mock import patch
from urllib.error import HTTPError, URLError

from _loader import fresh_plugin

_REPORT = (
    "Done. Mapped the flow.\n<private>k</private>\n\n## Key Learnings\n"
    "1. The router resolves scope before any repository call.\n"
    "2. The sweep never archives a pinned memory row.\n"
)
_REDACTED = (
    "Done. Mapped the flow.\n[REDACTED]\n\n## Key Learnings\n"
    "1. The router resolves scope before any repository call.\n"
    "2. The sweep never archives a pinned memory row.\n"
)
_HOST_KWARGS: dict[str, Any] = {
    "parent_turn_id": "T1",
    "child_status": "completed",
    "tool_call_history": [],
    "duration_ms": 1200,
    "telemetry_schema_version": 1,
}


class _Response:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False

    def read(self):
        return b'{"ok":true}'


class SubagentReportTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        (self.tmp / "home").mkdir()
        (self.tmp / "cwd").mkdir()
        (self.tmp / "bare").mkdir()
        (self.tmp / "cwd" / ".rembric").write_text("PROJECT_SLUG=myproj\n")
        self.mod = fresh_plugin(
            env={
                "REMBRIC_SERVER_URL": "http://server.example.com:8787",
                "REMBRIC_API_TOKEN": "tok-XXXX",
            },
            home=str(self.tmp / "home"),
        )
        self.workers: list[threading.Thread] = []
        self.addCleanup(self._join_workers)

    def _join_workers(self) -> None:
        for worker in self.workers:
            if worker.ident is not None:
                worker.join(timeout=5.0)

    def _provider(self, cwd: str = "cwd", **kwargs: Any):
        provider = self.mod.RembricMemoryProvider()
        with patch.object(self.mod, "urlopen", return_value=_Response()):
            provider.initialize("01PRIMARY", cwd=str(self.tmp / cwd), **kwargs)
        spawn = provider._spawn_context_thread

        def tracked(*args: Any, **kw: Any):
            worker = spawn(*args, **kw)
            self.workers.append(worker)
            return worker

        if spawn is not None:
            provider._spawn_context_thread = tracked
        return provider

    def _fire(self, provider, **overrides: Any):
        kwargs: dict[str, Any] = {
            "parent_session_id": "P",
            "child_session_id": "C",
            "child_role": "researcher",
            "child_summary": _REPORT,
            **_HOST_KWARGS,
        }
        kwargs.update(overrides)
        return provider.subagent_stop(**kwargs)

    def test_a_delegated_childs_learnings_reach_the_parent_session(self) -> None:
        provider = self._provider()
        entered = threading.Event()
        release = threading.Event()
        completed = threading.Event()
        seen: list[tuple[str, str | None, Any, threading.Thread]] = []

        def slow(request, **_kw):
            seen.append((request.full_url, request.get_header("Authorization"),
                         json.loads(request.data), threading.current_thread()))
            entered.set()
            release.wait(timeout=5.0)
            completed.set()
            return _Response()

        try:
            with patch.object(self.mod, "urlopen", side_effect=slow):
                self.assertIsNone(self._fire(provider))
                self.assertFalse(completed.is_set())
                self.assertTrue(entered.wait(timeout=5.0))
                self.assertFalse(completed.is_set())
                release.set()
                self.assertEqual(len(self.workers), 1)
                self.workers[0].join(timeout=5.0)
                self.assertFalse(self.workers[0].is_alive())
        finally:
            release.set()
        self.assertTrue(completed.is_set())
        self.assertTrue(self.workers[0].daemon)
        self.assertEqual(len(seen), 1)
        url, auth, body, thread = seen[0]
        self.assertEqual(url, "http://server.example.com:8787/api/myproj/sessions/P/learnings")
        self.assertEqual(auth, "Bearer tok-XXXX")
        self.assertEqual(body, {"report": _REDACTED, "agentType": "researcher"})
        self.assertIs(thread, self.workers[0])
        self.assertIsNot(thread, threading.current_thread())

    def test_agent_type_is_omitted_when_the_host_names_no_role(self) -> None:
        for role in ("", None):
            with self.subTest(role=role):
                provider = self._provider()
                with patch.object(self.mod, "urlopen", return_value=_Response()) as mock_urlopen:
                    self._fire(provider, child_role=role)
                    self._join_workers()
                self.assertEqual(mock_urlopen.call_count, 1)
                body = json.loads(mock_urlopen.call_args.args[0].data)
                self.assertEqual(body, {"report": _REDACTED})

    def test_the_binding_is_captured_at_dispatch(self) -> None:
        provider = self._provider()
        deferred: list[threading.Thread] = []
        spawn = provider._spawn_context_thread

        def defer(*args: Any, **kw: Any):
            deferred.append(spawn(*args, **kw))
            return types.SimpleNamespace(start=lambda: None)

        provider._spawn_context_thread = defer
        self._fire(provider)
        provider._base, provider._token, provider._slug = "http://other.example", "other-tok", "other"
        with patch.object(self.mod, "urlopen", return_value=_Response()) as mock_urlopen:
            deferred[0].start()
            deferred[0].join(timeout=5.0)
        request = mock_urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "http://server.example.com:8787/api/myproj/sessions/P/learnings")
        self.assertEqual(request.get_header("Authorization"), "Bearer tok-XXXX")

    def test_an_empty_summary_is_ignored(self) -> None:
        provider = self._provider()
        for summary in ("", None):
            with self.subTest(summary=summary), patch.object(self.mod, "urlopen") as mock_urlopen:
                self.assertIsNone(self._fire(provider, child_summary=summary))
                mock_urlopen.assert_not_called()
        self.assertEqual(self.workers, [])

    def test_nothing_is_sent_in_the_other_ignore_cases(self) -> None:
        cases = {
            "no key learnings phrase": (lambda: self._provider(), {"child_summary": "Done. Nothing learned."}),
            "phrase only inside a private span": (
                lambda: self._provider(), {"child_summary": "Done. <private>key learnings</private>"}),
            "structured summary": (lambda: self._provider(), {"child_summary": {"key learnings": "x"}}),
            "empty parent session id": (lambda: self._provider(), {"parent_session_id": ""}),
            "suppressed provider": (lambda: self._provider(agent_context="subagent"), {}),
            "no slug": (lambda: self._provider(cwd="bare"), {}),
            "uninitialized provider": (lambda: self.mod.RembricMemoryProvider(), {}),
        }
        for label, (build, overrides) in cases.items():
            with self.subTest(case=label):
                provider = build()
                stderr = io.StringIO()
                with redirect_stderr(stderr), patch.object(self.mod, "urlopen") as mock_urlopen:
                    self.assertIsNone(self._fire(provider, **overrides))
                    self._join_workers()
                mock_urlopen.assert_not_called()
                self.assertEqual(stderr.getvalue(), "")
        self.assertEqual(self.workers, [])

    def test_the_phrase_matches_in_any_letter_case(self) -> None:
        provider = self._provider()
        with patch.object(self.mod, "urlopen", return_value=_Response()) as mock_urlopen:
            self._fire(provider, child_summary="## KEY LEARNINGS\n1. Upper case still counts here.")
            self._join_workers()
        self.assertEqual(mock_urlopen.call_count, 1)

    def test_a_failing_server_never_raises_into_hermes(self) -> None:
        errors = (
            URLError(ConnectionRefusedError("refused tok-XXXX")),
            HTTPError("http://server.example.com:8787", 500, "SECRET-BODY tok-XXXX", Message(),
                      io.BytesIO(b"SECRET-BODY tok-XXXX")),
        )
        for error in errors:
            with self.subTest(error=type(error).__name__):
                provider = self._provider()
                stderr = io.StringIO()
                with redirect_stderr(stderr), patch.object(self.mod, "urlopen", side_effect=error):
                    self.assertIsNone(self._fire(provider))
                    self._join_workers()
                lines = stderr.getvalue().splitlines()
                self.assertEqual(len(lines), 1, lines)
                self.assertTrue(lines[0].startswith("[rembric]"))
                self.assertNotIn("tok-XXXX", lines[0])
                self.assertNotIn("SECRET-BODY", lines[0])
        errors[1].close()

    def test_a_missing_or_failing_thread_api_is_one_safe_diagnostic(self) -> None:
        def raising(*_a: Any, **_k: Any):
            raise RuntimeError("SECRET-ERROR tok-XXXX")

        for factory in (None, raising,
                        lambda *a, **k: types.SimpleNamespace(start=lambda: raising())):
            with self.subTest(factory=factory):
                provider = self._provider()
                provider._spawn_context_thread = factory
                stderr = io.StringIO()
                with redirect_stderr(stderr), patch.object(self.mod, "urlopen") as mock_urlopen:
                    self.assertIsNone(self._fire(provider))
                mock_urlopen.assert_not_called()
                lines = stderr.getvalue().splitlines()
                self.assertEqual(len(lines), 1, lines)
                self.assertTrue(lines[0].startswith("[rembric]"))
                self.assertNotIn("SECRET-ERROR", lines[0])
                self.assertNotIn("tok-XXXX", lines[0])


if __name__ == "__main__":
    unittest.main()
