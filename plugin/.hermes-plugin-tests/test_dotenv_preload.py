"""``_preload_rembric_dotenv`` should fill missing env, never override shell-set values."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from _loader import fresh_plugin


class DotenvPreloadTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.home = Path(self._tmp.name) / "home"
        self.home.mkdir()
        (self.home / ".rembric").mkdir()

    def test_preload_fills_missing_env(self) -> None:
        (self.home / ".rembric" / ".env").write_text(
            "REMBRIC_SERVER_URL=http://localhost:8787\n"
            "REMBRIC_API_TOKEN=tok-from-file\n"
        )
        fresh_plugin(home=str(self.home))
        self.assertEqual(os.environ.get("REMBRIC_SERVER_URL"), "http://localhost:8787")
        self.assertEqual(os.environ.get("REMBRIC_API_TOKEN"), "tok-from-file")

    def test_shell_env_wins_over_file(self) -> None:
        (self.home / ".rembric" / ".env").write_text(
            "REMBRIC_SERVER_URL=http://from-file:8787\n"
        )
        fresh_plugin(
            home=str(self.home),
            env={"REMBRIC_SERVER_URL": "http://from-shell:9000"},
        )
        self.assertEqual(os.environ.get("REMBRIC_SERVER_URL"), "http://from-shell:9000")

    def test_missing_file_is_silent(self) -> None:
        # Module import should complete with no exception and no env written.
        fresh_plugin(home=str(self.home))
        self.assertNotIn("REMBRIC_SERVER_URL", os.environ)

    def test_quoted_values_stripped(self) -> None:
        (self.home / ".rembric" / ".env").write_text(
            'REMBRIC_SERVER_URL="http://quoted:8787"\n'
            "REMBRIC_API_TOKEN='single-quoted'\n"
        )
        fresh_plugin(home=str(self.home))
        self.assertEqual(os.environ.get("REMBRIC_SERVER_URL"), "http://quoted:8787")
        self.assertEqual(os.environ.get("REMBRIC_API_TOKEN"), "single-quoted")

    def test_comments_and_blanks_skipped(self) -> None:
        (self.home / ".rembric" / ".env").write_text(
            "# this is a comment\n"
            "\n"
            "REMBRIC_SERVER_URL=http://ok\n"
            "  # indented comment\n"
        )
        fresh_plugin(home=str(self.home))
        self.assertEqual(os.environ.get("REMBRIC_SERVER_URL"), "http://ok")


if __name__ == "__main__":
    unittest.main()
