"""``system_prompt_block`` carries the documented nudge content.

Asserts both the session-close protocol (memory.session_summary + title +
Goal/Discoveries/Accomplished/Next Steps/Files structure) AND the
post-compact recovery clause (memory.context). Hard cap: ≤300 chars.
"""

from __future__ import annotations

import unittest

from _loader import fresh_plugin


class SystemPromptBlockTest(unittest.TestCase):
    def setUp(self) -> None:
        self.mod = fresh_plugin()

    def test_includes_session_summary_protocol(self) -> None:
        provider = self.mod.RembricMemoryProvider()
        block = provider.system_prompt_block()
        self.assertIn("memory.session_summary", block)
        self.assertIn("title", block)
        self.assertIn("Goal", block)
        self.assertIn("Discoveries", block)
        self.assertIn("Accomplished", block)
        self.assertIn("Next Steps", block)
        self.assertIn("Files", block)

    def test_includes_memory_context_post_compact_clause(self) -> None:
        provider = self.mod.RembricMemoryProvider()
        block = provider.system_prompt_block()
        self.assertIn("memory.context", block)

    def test_block_is_within_300_char_cap(self) -> None:
        provider = self.mod.RembricMemoryProvider()
        block = provider.system_prompt_block()
        self.assertLessEqual(len(block), 300, msg=f"block is {len(block)} chars; cap is 300")


if __name__ == "__main__":
    unittest.main()
