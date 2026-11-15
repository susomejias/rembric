"""File-anchored recall (#489): the two Hermes result transforms and their once-per-file contract."""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

from _loader import fresh_plugin

_FIXTURES = Path(__file__).resolve().parents[2] / "test" / "file-recall-fixtures.json"


class _FakeJsonResponse:
    def __init__(self, body: dict) -> None:
        self.status = 200
        self._body = json.dumps(body).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False

    def read(self):
        return self._body


class CommandPathsFixtureTest(unittest.TestCase):
    def test_python_extractor_agrees_with_the_shared_fixture(self) -> None:
        mod = fresh_plugin()
        for case in json.loads(_FIXTURES.read_text(encoding="utf-8"))["commands"]:
            with self.subTest(command=case["command"]):
                self.assertEqual(mod._command_paths(case["command"]), case["paths"])


class FileRecallTest(unittest.TestCase):
    def setUp(self) -> None:
        # A git hook exports GIT_DIR, which would point every git call below at the real repository.
        env_patcher = patch.dict(os.environ)
        env_patcher.start()
        self.addCleanup(env_patcher.stop)
        for key in [k for k in os.environ if k.startswith("GIT_")]:
            del os.environ[key]
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)
        (root / "home").mkdir()
        self.cwd = root / "repo"
        for rel in ["src/app.ts", "lib/app.ts", "src/ünï.ts", "app/[ID]/page.ts", "app/I/page.ts"]:
            (self.cwd / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.cwd / rel).write_text("x\n", encoding="utf-8")
        (self.cwd / ".rembric").write_text("PROJECT_SLUG=myproj\n")
        subprocess.run(["git", "init", "-q"], cwd=self.cwd, check=True)
        subprocess.run(["git", "add", "-A"], cwd=self.cwd, check=True)
        self.mod = fresh_plugin(
            env={
                "REMBRIC_SERVER_URL": "http://server.example.com:8787",
                "REMBRIC_API_TOKEN": "tok-XXXX",
            },
            home=str(root / "home"),
        )
        self.recall_bodies: list[dict] = []
        self.respond: Any = lambda path: {"ok": True, "lines": [f"rembric: memories about {path}:"]}
        patcher = patch("rembric_hermes_plugin.urlopen", side_effect=self._urlopen)
        self.urlopen: MagicMock = patcher.start()
        self.addCleanup(patcher.stop)

    def _urlopen(self, request: Any, timeout: float = 0) -> Any:
        del timeout
        if request.full_url.endswith("/file-recall"):
            body = json.loads(request.data.decode("utf-8"))
            self.recall_bodies.append(body)
            answer = self.respond(body["path"])
            if isinstance(answer, Exception):
                raise answer
            return _FakeJsonResponse(answer)
        return _FakeJsonResponse({"ok": True, "created": True})

    def _provider(self, session_id: str = "s1") -> Any:
        provider = self.mod.RembricMemoryProvider()
        provider.initialize(session_id, cwd=str(self.cwd))
        return provider

    def test_a_read_file_result_gains_the_note_and_stays_valid_json(self) -> None:
        provider = self._provider()
        out = provider.transform_tool_result(
            tool_name="read_file",
            args={"path": "src/app.ts"},
            result=json.dumps({"content": "x"}),
            session_id="s1",
        )
        self.assertEqual(
            json.loads(out),
            {"content": "x", "rembric_memories": "rembric: memories about src/app.ts:"},
        )
        self.assertEqual(self.recall_bodies, [{"path": "src/app.ts", "siblings": ["lib/app.ts", "src/app.ts"]}])

    def test_each_file_is_asked_about_once_per_session(self) -> None:
        provider = self._provider()
        provider.transform_tool_result(tool_name="read_file", args={"path": "src/app.ts"}, result="{}")
        again = provider.transform_tool_result(
            tool_name="write_file", args={"path": str(self.cwd / "src/app.ts")}, result="{}"
        )
        self.assertIsNone(again)
        self.assertEqual(len(self.recall_bodies), 1)

    def test_a_terminal_read_gets_the_note_appended(self) -> None:
        provider = self._provider()
        out = provider.transform_terminal_output(command="sed -n 1,5p src/app.ts", output="x")
        self.assertEqual(out, "x\n\nrembric: memories about src/app.ts:")

    def test_the_terminal_tool_is_left_to_its_own_hook(self) -> None:
        provider = self._provider()
        self.assertIsNone(
            provider.transform_tool_result(
                tool_name="terminal", args={"command": "cat src/app.ts"}, result="{}"
            )
        )
        self.assertEqual(self.recall_bodies, [])

    def test_a_tool_that_is_not_a_file_tool_is_ignored_even_with_a_path(self) -> None:
        provider = self._provider()
        self.assertIsNone(
            provider.transform_tool_result(tool_name="search_files", args={"path": "src/app.ts"}, result="{}")
        )
        self.assertEqual(self.recall_bodies, [])

    def test_siblings_are_left_out_above_the_cap(self) -> None:
        for i in range(65):
            (self.cwd / f"d{i}").mkdir()
            (self.cwd / f"d{i}" / "many.ts").write_text("x\n", encoding="utf-8")
        subprocess.run(["git", "add", "-A"], cwd=self.cwd, check=True)
        provider = self._provider()
        provider.transform_tool_result(tool_name="read_file", args={"path": "d0/many.ts"}, result="{}")
        self.assertEqual(self.recall_bodies, [{"path": "d0/many.ts"}])

    def test_a_non_json_result_gets_the_note_appended(self) -> None:
        provider = self._provider()
        out = provider.transform_tool_result(tool_name="patch", args={"path": "src/app.ts"}, result="ok")
        self.assertEqual(out, "ok\n\nrembric: memories about src/app.ts:")

    def test_a_sub_agent_call_is_skipped(self) -> None:
        provider = self._provider()
        out = provider.transform_tool_result(
            tool_name="read_file", args={"path": "src/app.ts"}, result="{}", session_id="child"
        )
        self.assertIsNone(out)
        self.assertEqual(self.recall_bodies, [])

    def test_a_failed_request_leaves_the_result_unchanged_and_stops_the_firing(self) -> None:
        provider = self._provider()
        self.respond = lambda _path: OSError("down")
        out = provider.transform_terminal_output(command="cat src/app.ts lib/app.ts", output="x")
        self.assertIsNone(out)
        self.assertEqual([b["path"] for b in self.recall_bodies], ["src/app.ts"])

    def test_directories_globs_and_brackets_resolve_literally_and_names_stay_unquoted(self) -> None:
        provider = self._provider()
        provider.transform_terminal_output(command=f"grep -rn x {self.cwd}/src/ src/*.ts", output="x")
        self.assertEqual(self.recall_bodies, [])
        provider.transform_terminal_output(command='cat "app/[ID]/page.ts" src/ünï.ts', output="x")
        self.assertEqual([b["path"] for b in self.recall_bodies], ["app/[ID]/page.ts", "src/ünï.ts"])

    def test_the_server_saying_exhausted_stops_further_requests(self) -> None:
        provider = self._provider()
        self.respond = lambda path: {"ok": True, "lines": [path], "exhausted": True}
        provider.transform_terminal_output(command="cat src/app.ts lib/app.ts", output="x")
        provider.transform_tool_result(tool_name="read_file", args={"path": "src/ünï.ts"}, result="{}")
        self.assertEqual([b["path"] for b in self.recall_bodies], ["src/app.ts"])

    def test_forgetting_a_session_lets_it_ask_again(self) -> None:
        provider = self._provider()
        provider.transform_tool_result(tool_name="read_file", args={"path": "src/app.ts"}, result="{}")
        provider._forget_session_state("s1")
        provider.transform_tool_result(tool_name="read_file", args={"path": "src/app.ts"}, result="{}")
        self.assertEqual(len(self.recall_bodies), 2)


class RegisterTest(unittest.TestCase):
    def test_registers_the_provider_both_transforms_and_subagent_stop(self) -> None:
        mod = fresh_plugin()
        ctx = MagicMock()
        mod.register(ctx)
        provider = ctx.register_memory_provider.call_args.args[0]
        self.assertEqual(
            [c.args for c in ctx.register_hook.call_args_list],
            [
                ("transform_tool_result", provider.transform_tool_result),
                ("transform_terminal_output", provider.transform_terminal_output),
                ("subagent_stop", provider.subagent_stop),
            ],
        )

    def test_a_host_without_register_hook_still_gets_the_provider(self) -> None:
        mod = fresh_plugin()

        class _Ctx:
            def __init__(self) -> None:
                self.providers: list[Any] = []

            def register_memory_provider(self, provider: Any) -> None:
                self.providers.append(provider)

        ctx = _Ctx()
        mod.register(ctx)
        self.assertEqual(len(ctx.providers), 1)


if __name__ == "__main__":
    unittest.main()
