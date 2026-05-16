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

    def test_config_schema_shape(self) -> None:
        provider = self.mod.RembricMemoryProvider()
        schema = provider.get_config_schema()
        self.assertEqual([e["key"] for e in schema], ["server_url", "api_token", "project_slug"])
        self.assertTrue(schema[1]["secret"])
        self.assertFalse(schema[2]["required"])


if __name__ == "__main__":
    unittest.main()
