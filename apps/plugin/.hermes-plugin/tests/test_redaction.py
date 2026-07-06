"""``_redact_private`` against the shared cross-client fixture set.

The fixtures in ``apps/plugin/test/redaction-fixtures.json`` are the
lock-step contract shared with the bash (``scripts/_transcript.sh``) and
opencode (``.opencode-plugin/plugin.ts``) implementations — drift in any
of the three fails its suite.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from _loader import fresh_plugin

_FIXTURES = json.loads(
    (Path(__file__).resolve().parent.parent.parent / "test" / "redaction-fixtures.json").read_text()
)


class RedactPrivateTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.mod = fresh_plugin(home=self._tmp.name)

    def test_shared_fixtures(self) -> None:
        for fixture in _FIXTURES:
            with self.subTest(fixture["name"]):
                self.assertEqual(
                    self.mod._redact_private(fixture["input"]), fixture["expected"]
                )

    def test_format_transcript_redacts_before_upload(self) -> None:
        messages = [
            {"role": "user", "content": "use <private>postgres://u:p@h/db</private> now"},
            {"role": "assistant", "content": "noted <PRIVATE>sk-live-123"},
        ]
        transcript = self.mod._format_transcript(messages)
        self.assertIn("[REDACTED]", transcript)
        self.assertNotIn("postgres://u:p@h/db", transcript)
        self.assertNotIn("sk-live-123", transcript)

    def test_derive_title_redacts(self) -> None:
        messages = [
            {"role": "assistant", "content": "key is <private>sk-live-123</private> saved"},
        ]
        title = self.mod._derive_title_from_messages(messages)
        self.assertEqual(title, "key is [REDACTED] saved")


if __name__ == "__main__":
    unittest.main()
