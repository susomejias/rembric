"""Lifecycle methods POST to the right HTTP endpoints with the right bodies."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from _loader import fresh_plugin


class _FakeResponse:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False

    def read(self):
        return b""


def _captured_post(mock_urlopen, idx: int = 0):
    """Return (url, body_dict, headers_dict) for the idx-th urlopen call."""
    request = mock_urlopen.call_args_list[idx].args[0]
    body = json.loads(request.data.decode("utf-8")) if request.data else None
    headers = dict(request.header_items())
    return request.full_url, body, headers


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
    def test_initialize_posts_session(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeResponse()
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        self.assertEqual(mock_urlopen.call_count, 1)
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
        self.assertEqual(mock_urlopen.call_count, 2)
        url, body, _ = _captured_post(mock_urlopen, idx=1)
        self.assertEqual(
            url,
            "http://server.example.com:8787/api/myproj/sessions/01XYZ/summary",
        )
        self.assertEqual(body, {"summary": "user: first message\nassistant: ack"})

    @patch("rembric_hermes_plugin.urlopen")
    def test_pre_compress_truncates_at_20k(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeResponse()
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        big = "x" * 30_000
        provider.on_pre_compress([{"role": "user", "content": big}])
        _, body, _ = _captured_post(mock_urlopen, idx=1)
        self.assertEqual(len(body["summary"]), 20_000)
        # Truncation is from the head — the tail of the input survives.
        self.assertTrue(body["summary"].endswith("x" * 20_000))

    @patch("rembric_hermes_plugin.urlopen")
    def test_session_end_posts_empty_body(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeResponse()
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        provider.on_session_end([])
        url, body, _ = _captured_post(mock_urlopen, idx=1)
        self.assertEqual(
            url, "http://server.example.com:8787/api/myproj/sessions/01XYZ/end"
        )
        self.assertEqual(body, {})

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
    def test_memory_touching_methods_issue_zero_http(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.return_value = _FakeResponse()
        provider = self._provider()
        provider.initialize("01XYZ", cwd=str(self.tmp / "cwd"))
        mock_urlopen.reset_mock()
        self.assertEqual(provider.system_prompt_block(), "")
        self.assertEqual(provider.prefetch("anything"), "")
        self.assertIsNone(provider.queue_prefetch("anything"))
        self.assertIsNone(provider.sync_turn("u", "a"))
        self.assertIsNone(provider.on_memory_write("add", "MEMORY.md", "x"))
        self.assertIsNone(provider.shutdown())
        self.assertEqual(mock_urlopen.call_count, 0)


if __name__ == "__main__":
    unittest.main()
