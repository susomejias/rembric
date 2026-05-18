"""is_available sends a bearer header to /healthz and degrades to False on any error."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from _loader import fresh_plugin


class _FakeResponse:
    def __init__(self, status: int = 200) -> None:
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False

    def read(self):
        return b""


class IsAvailableTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        (self.tmp / "home").mkdir()

    def _module(self, *, with_token: bool = True, with_url: bool = True):
        env: dict[str, str] = {}
        if with_url:
            env["REMBRIC_SERVER_URL"] = "http://server.example.com:8787"
        if with_token:
            env["REMBRIC_API_TOKEN"] = "tok-XYZ"
        return fresh_plugin(env=env, home=str(self.tmp / "home"))

    def test_returns_false_when_token_unset_and_no_http_call_is_made(self) -> None:
        mod = self._module(with_token=False)
        with patch.object(mod, "urlopen") as mock_urlopen:
            result = mod.RembricMemoryProvider().is_available()
            self.assertFalse(result)
            self.assertEqual(mock_urlopen.call_count, 0)

    def test_returns_false_when_server_url_unset(self) -> None:
        mod = self._module(with_url=False)
        with patch.object(mod, "urlopen") as mock_urlopen:
            result = mod.RembricMemoryProvider().is_available()
            self.assertFalse(result)
            self.assertEqual(mock_urlopen.call_count, 0)

    def test_returns_true_on_200_and_sends_bearer_header(self) -> None:
        mod = self._module()
        with patch.object(mod, "urlopen") as mock_urlopen:
            mock_urlopen.return_value = _FakeResponse(status=200)
            provider = mod.RembricMemoryProvider()
            self.assertTrue(provider.is_available())
            self.assertEqual(mock_urlopen.call_count, 1)
            request = mock_urlopen.call_args_list[0].args[0]
            self.assertEqual(request.full_url, "http://server.example.com:8787/healthz")
            headers = dict(request.header_items())
            self.assertEqual(headers.get("Authorization"), "Bearer tok-XYZ")
            self.assertEqual(request.get_method(), "GET")

    def test_returns_false_on_401(self) -> None:
        import urllib.error

        mod = self._module()
        with patch.object(mod, "urlopen") as mock_urlopen:
            mock_urlopen.side_effect = urllib.error.HTTPError(
                "http://x/healthz", 401, "Unauthorized", {}, None
            )
            self.assertFalse(mod.RembricMemoryProvider().is_available())

    def test_returns_false_on_503(self) -> None:
        import urllib.error

        mod = self._module()
        with patch.object(mod, "urlopen") as mock_urlopen:
            mock_urlopen.side_effect = urllib.error.HTTPError(
                "http://x/healthz", 503, "Service Unavailable", {}, None
            )
            self.assertFalse(mod.RembricMemoryProvider().is_available())

    def test_returns_false_on_network_error(self) -> None:
        import urllib.error

        mod = self._module()
        with patch.object(mod, "urlopen") as mock_urlopen:
            mock_urlopen.side_effect = urllib.error.URLError("connection refused")
            self.assertFalse(mod.RembricMemoryProvider().is_available())


if __name__ == "__main__":
    unittest.main()
