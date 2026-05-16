"""Cascade behavior for ``_resolve_slug``."""

from __future__ import annotations

import json
import os
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
        (self.tmp_path / "hermes").mkdir()
        (self.tmp_path / "cwd").mkdir()

    def _plugin(self, **env: str):
        return fresh_plugin(env=env, home=str(self.tmp_path / "home"))

    def test_env_wins_over_stored_and_dotrembric(self) -> None:
        (self.tmp_path / "hermes" / "rembric.json").write_text(
            json.dumps({"project_slug": "beta"})
        )
        (self.tmp_path / "cwd" / ".rembric").write_text("PROJECT_SLUG=gamma\n")
        mod = self._plugin(
            REMBRIC_PROJECT_SLUG="alpha",
            HERMES_HOME=str(self.tmp_path / "hermes"),
        )
        self.assertEqual(mod._resolve_slug(str(self.tmp_path / "cwd")), "alpha")

    def test_stored_config_wins_over_dotrembric(self) -> None:
        (self.tmp_path / "hermes" / "rembric.json").write_text(
            json.dumps({"project_slug": "beta"})
        )
        (self.tmp_path / "cwd" / ".rembric").write_text("PROJECT_SLUG=gamma\n")
        mod = self._plugin(HERMES_HOME=str(self.tmp_path / "hermes"))
        self.assertEqual(mod._resolve_slug(str(self.tmp_path / "cwd")), "beta")

    def test_dotrembric_wins_over_url(self) -> None:
        (self.tmp_path / "cwd" / ".rembric").write_text("PROJECT_SLUG=gamma\n")
        mod = self._plugin(
            HERMES_HOME=str(self.tmp_path / "hermes"),
            REMBRIC_SERVER_URL="https://memory.example.com/mcp/delta",
        )
        self.assertEqual(mod._resolve_slug(str(self.tmp_path / "cwd")), "gamma")

    def test_url_parse_is_final_source(self) -> None:
        mod = self._plugin(
            HERMES_HOME=str(self.tmp_path / "hermes"),
            REMBRIC_SERVER_URL="https://memory.example.com/mcp/delta",
        )
        self.assertEqual(mod._resolve_slug(str(self.tmp_path / "cwd")), "delta")

    def test_invalid_env_candidate_falls_through(self) -> None:
        (self.tmp_path / "cwd" / ".rembric").write_text("PROJECT_SLUG=gamma\n")
        mod = self._plugin(
            HERMES_HOME=str(self.tmp_path / "hermes"),
            REMBRIC_PROJECT_SLUG="Has_Underscores",  # invalid: caps + underscore
        )
        self.assertEqual(mod._resolve_slug(str(self.tmp_path / "cwd")), "gamma")

    def test_invalid_url_segment_falls_through_to_none(self) -> None:
        mod = self._plugin(
            HERMES_HOME=str(self.tmp_path / "hermes"),
            REMBRIC_SERVER_URL="https://memory.example.com/mcp/Has_Underscores",
        )
        self.assertIsNone(mod._resolve_slug(str(self.tmp_path / "cwd")))

    def test_all_empty_returns_none(self) -> None:
        mod = self._plugin(HERMES_HOME=str(self.tmp_path / "hermes"))
        self.assertIsNone(mod._resolve_slug(str(self.tmp_path / "cwd")))

    def test_url_without_mcp_segment_is_skipped(self) -> None:
        mod = self._plugin(
            HERMES_HOME=str(self.tmp_path / "hermes"),
            REMBRIC_SERVER_URL="https://memory.example.com/",
        )
        self.assertIsNone(mod._resolve_slug(str(self.tmp_path / "cwd")))

    def test_url_with_trailing_segments_after_mcp(self) -> None:
        mod = self._plugin(
            HERMES_HOME=str(self.tmp_path / "hermes"),
            REMBRIC_SERVER_URL="https://memory.example.com/mcp/delta/extra",
        )
        # 'delta' is the segment AFTER 'mcp' only when 'mcp' is parts[-2].
        # With 'extra' as parts[-1], parts[-2] is 'delta', not 'mcp' → no match.
        self.assertIsNone(mod._resolve_slug(str(self.tmp_path / "cwd")))


if __name__ == "__main__":
    unittest.main()
