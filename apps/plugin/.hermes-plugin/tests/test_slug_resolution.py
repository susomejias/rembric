"""Cascade behavior for ``_resolve_slug``.

Cascade is four steps, .rembric-first:

1. ``<cwd>/.rembric`` ``PROJECT_SLUG``
2. ``REMBRIC_PROJECT_SLUG`` env
3. trailing ``/mcp/<slug>`` segment of ``REMBRIC_SERVER_URL``
4. ``None`` (degraded)
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from _loader import fresh_plugin


class SlugCascadeTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp_path = Path(self._tmp.name)
        (self.tmp_path / "home").mkdir()
        (self.tmp_path / "cwd").mkdir()

    def _plugin(self, **env: str):
        return fresh_plugin(env=env, home=str(self.tmp_path / "home"))

    def test_dotrembric_wins_over_env(self) -> None:
        (self.tmp_path / "cwd" / ".rembric").write_text("PROJECT_SLUG=gamma\n")
        mod = self._plugin(REMBRIC_PROJECT_SLUG="alpha")
        self.assertEqual(mod._resolve_slug(str(self.tmp_path / "cwd")), "gamma")

    def test_env_wins_when_no_dotrembric(self) -> None:
        mod = self._plugin(
            REMBRIC_PROJECT_SLUG="alpha",
            REMBRIC_SERVER_URL="https://memory.example.com/mcp/delta",
        )
        self.assertEqual(mod._resolve_slug(str(self.tmp_path / "cwd")), "alpha")

    def test_dotrembric_wins_over_url(self) -> None:
        (self.tmp_path / "cwd" / ".rembric").write_text("PROJECT_SLUG=gamma\n")
        mod = self._plugin(
            REMBRIC_SERVER_URL="https://memory.example.com/mcp/delta",
        )
        self.assertEqual(mod._resolve_slug(str(self.tmp_path / "cwd")), "gamma")

    def test_url_parse_is_final_source(self) -> None:
        mod = self._plugin(
            REMBRIC_SERVER_URL="https://memory.example.com/mcp/delta",
        )
        self.assertEqual(mod._resolve_slug(str(self.tmp_path / "cwd")), "delta")

    def test_invalid_dotrembric_candidate_falls_through_to_env(self) -> None:
        (self.tmp_path / "cwd" / ".rembric").write_text(
            "PROJECT_SLUG=Has_Underscores\n"  # invalid: caps + underscore
        )
        mod = self._plugin(REMBRIC_PROJECT_SLUG="gamma")
        self.assertEqual(mod._resolve_slug(str(self.tmp_path / "cwd")), "gamma")

    def test_invalid_url_segment_falls_through_to_none(self) -> None:
        mod = self._plugin(
            REMBRIC_SERVER_URL="https://memory.example.com/mcp/Has_Underscores",
        )
        self.assertIsNone(mod._resolve_slug(str(self.tmp_path / "cwd")))

    def test_all_empty_returns_none(self) -> None:
        mod = self._plugin()
        self.assertIsNone(mod._resolve_slug(str(self.tmp_path / "cwd")))

    def test_url_without_mcp_segment_is_skipped(self) -> None:
        mod = self._plugin(REMBRIC_SERVER_URL="https://memory.example.com/")
        self.assertIsNone(mod._resolve_slug(str(self.tmp_path / "cwd")))

    def test_url_with_trailing_segments_after_mcp(self) -> None:
        mod = self._plugin(
            REMBRIC_SERVER_URL="https://memory.example.com/mcp/delta/extra",
        )
        # 'mcp' must be the second-to-last segment for the parse to succeed.
        self.assertIsNone(mod._resolve_slug(str(self.tmp_path / "cwd")))


if __name__ == "__main__":
    unittest.main()
