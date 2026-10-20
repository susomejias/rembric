"""``system_prompt_block`` carries the unified nudge content.

This block is the SAME text as the server's `buildInstructions()` BASE
(the SAVE/RECALL/SUMMARIZE flows) — one version for every client. Asserts
the proactive session-close protocol (memory.session_summary, bound to
ending a working turn — NOT the literal "done"), the recall/post-compact
clause (memory.context), and the SAVE flow. Self-imposed cap: ≤1000 chars
(Hermes itself applies no truncation; the ceiling is token-budget hygiene).
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
        for clause in (
            "memory.get_batch(creation)", "memory.session_get_batch(activity)",
            "ids OR from/to", "full current data/errors", "limit≤20",
            "offset=nextOffset until null", "all failed=isError",
            "Know your sessionId? Pass it; never guess.",
            "topic_key?", "memory.judge_batch({judgments:[…]})", "memory.about",
        ):
            self.assertIn(clause, block)
        self.assertIn("title", block)
        headings = [
            "## Goal",
            "## Accomplished",
            "## Decisions+why",
            "## Verified+how",
            "## Unfinished+why",
            "## Files",
        ]
        self.assertIn(
            "Use exactly these six Markdown level-2 headings, in this order, "
            "each on its own line (never one flat paragraph):\n"
            + "\n".join(headings),
            block,
        )
        self.assertNotIn("Goal · Accomplished · Decisions+why", block)

    def test_includes_the_proactive_recall_wording(self) -> None:
        provider = self.mod.RembricMemoryProvider()
        block = provider.system_prompt_block()
        self.assertIn(
            "RECALL: memory.context/memory.search if you lack prior detail.",
            block,
        )

    def test_includes_proactive_save_flow(self) -> None:
        provider = self.mod.RembricMemoryProvider()
        block = provider.system_prompt_block()
        self.assertIn("memory.save(title≤100, content, tags)", block)
        self.assertIn("normally 1–5 useful reusable lowercase ASCII kebab-case", block)
        for example in ("dashboard", "sqlite", "bug-fix"):
            self.assertIn(example, block)

    def test_session_summary_trigger_is_not_bound_to_the_word_done(self) -> None:
        provider = self.mod.RembricMemoryProvider()
        block = provider.system_prompt_block()
        self.assertIn("Before ending", block)
        self.assertNotIn('before declaring work done', block)

    def test_block_is_within_1000_char_cap(self) -> None:
        # Self-imposed token budget — Hermes itself applies no truncation
        # (upstream build_system_prompt joins blocks verbatim). Mirrors the
        # server's INSTRUCTIONS_MAX_LENGTH so the two surfaces stay in lock-step.
        provider = self.mod.RembricMemoryProvider()
        block = provider.system_prompt_block()
        self.assertLessEqual(len(block), 1000, msg=f"block is {len(block)} chars; cap is 1000")


if __name__ == "__main__":
    unittest.main()
