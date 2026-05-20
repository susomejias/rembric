"""Defensive ``handle_tool_call`` returns the documented JSON error string."""

from __future__ import annotations

import json
import unittest

from _loader import fresh_plugin


class HandleToolCallDefensiveTest(unittest.TestCase):
    def setUp(self) -> None:
        self.mod = fresh_plugin()

    def test_returns_documented_json_error(self) -> None:
        provider = self.mod.RembricMemoryProvider()
        result = provider.handle_tool_call("memory_save", {"foo": "bar"})
        parsed = json.loads(result)
        self.assertEqual(parsed["error"], "unknown_tool")
        self.assertIn("mcp_servers.rembric", parsed["hint"])

    def test_get_tool_schemas_is_empty(self) -> None:
        provider = self.mod.RembricMemoryProvider()
        self.assertEqual(provider.get_tool_schemas(), [])

    def test_name_is_rembric(self) -> None:
        provider = self.mod.RembricMemoryProvider()
        self.assertEqual(provider.name, "rembric")

    def test_provider_does_not_override_get_config_schema(self) -> None:
        # The default no-op from the ABC stub returns [].
        # Confirm the provider has not re-introduced a custom override.
        provider = self.mod.RembricMemoryProvider()
        self.assertEqual(provider.get_config_schema(), [])

    def test_provider_does_not_override_save_config(self) -> None:
        # Default no-op returns None and writes nothing.
        provider = self.mod.RembricMemoryProvider()
        self.assertIsNone(provider.save_config({"server_url": "x"}, "/tmp"))


if __name__ == "__main__":
    unittest.main()
