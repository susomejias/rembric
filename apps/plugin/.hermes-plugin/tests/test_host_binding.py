"""The provider publishes its own process's host binding, pinned to the shared layout."""

from __future__ import annotations

import json
import os
import re
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from _loader import fresh_plugin

_LAYOUT = json.loads(
    (Path(__file__).resolve().parents[2] / "test" / "host-binding-layout.json").read_text()
)

_RAW_START = "  Sat Nov 21  9:05:01   2026  "
_START = "Sat Nov 21 9:05:01 2026"
_SESSION = "hermes-session-0001"

_FAKE_PS = """#!/bin/sh
fields=""; pid=""
while [ $# -gt 0 ]; do
  case "$1" in
  -o) fields="$2"; shift 2 ;;
  -p) pid="$2"; shift 2 ;;
  *) shift ;;
  esac
done
printf '%s|%s|%s\\n' "$fields" "$pid" "${LC_ALL:-}" >>"$FAKE_PS_LOG"
[ -n "${FAKE_PS_FAIL:-}" ] && { printf '%s\\n' "$FAKE_PS_START"; exit 1; }
[ "$pid" = "$FAKE_PS_PID" ] || exit 1
printf '%s\\n' "$FAKE_PS_START"
"""


class _NoHttp:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False

    def read(self):
        return b'{"created": true}'


class HostBindingTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        self.home = self.tmp / "home"
        self.home.mkdir()
        (self.tmp / "cwd").mkdir()
        (self.tmp / "cwd" / ".rembric").write_text("PROJECT_SLUG=myproj\n")
        bin_dir = self.tmp / "bin"
        bin_dir.mkdir()
        (bin_dir / "ps").write_text(_FAKE_PS)
        (bin_dir / "ps").chmod(0o755)
        self.ps_log = self.tmp / "ps-log"
        self.ps_log.write_text("")
        self.held: list = []
        saved = dict(os.environ)
        self.addCleanup(lambda: (os.environ.clear(), os.environ.update(saved)))
        self.mod = fresh_plugin(
            env={
                "REMBRIC_SERVER_URL": "http://server.example.com:8787",
                "REMBRIC_API_TOKEN": "tok-XXXX",
                "PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}",
                "FAKE_PS_LOG": str(self.ps_log),
                "FAKE_PS_PID": str(os.getpid()),
                "FAKE_PS_START": _RAW_START,
            },
            home=str(self.home),
        )
        urlopen = patch.object(self.mod, "urlopen", return_value=_NoHttp())
        urlopen.start()
        self.addCleanup(urlopen.stop)

    def _dir(self) -> Path:
        return self.home.joinpath(*_LAYOUT["dir"])

    def _file(self, pid: int | None = None) -> Path:
        name = _LAYOUT["file"].replace("{pid}", str(os.getpid() if pid is None else pid))
        return self._dir() / name

    def _write(self, session_id: str) -> None:
        self._dir().mkdir(parents=True, mode=0o700, exist_ok=True)
        self._file().write_text(
            json.dumps({"pid": os.getpid(), "start": _START, "sessionId": session_id})
        )

    def _provider(self, session_id: str = _SESSION, **kwargs):
        provider = self.mod.RembricMemoryProvider()
        provider.initialize(session_id, cwd=str(self.tmp / "cwd"), **kwargs)
        self.held.append(provider)
        return provider

    def _listing(self) -> list[str]:
        return sorted(os.listdir(self._dir())) if self._dir().exists() else []

    def test_initialize_publishes_this_process_with_the_fixture_layout(self) -> None:
        self._provider()
        raw = self._file().read_text()
        data = json.loads(raw)
        self.assertEqual(list(data), _LAYOUT["keys"])
        self.assertEqual(data, {"pid": os.getpid(), "start": _START, "sessionId": _SESSION})
        self.assertEqual(raw, json.dumps(data, separators=(",", ":")))
        self.assertEqual(oct(stat.S_IMODE(self._dir().stat().st_mode)), "0o" + _LAYOUT["dirMode"][1:])
        self.assertEqual(oct(stat.S_IMODE(self._file().stat().st_mode)), "0o" + _LAYOUT["fileMode"][1:])
        self.assertEqual(self._listing(), [self._file().name])

    def test_start_token_runs_ps_with_the_fixture_command_and_locale(self) -> None:
        self._provider()
        calls = [line.split("|") for line in self.ps_log.read_text().splitlines()]
        self.assertTrue(calls)
        for fields, pid, locale in calls:
            self.assertEqual(fields, _LAYOUT["startCommand"][2])
            self.assertEqual(pid, str(os.getpid()))
            self.assertEqual(locale, _LAYOUT["startLocale"])

    def test_session_switch_republishes_the_new_session(self) -> None:
        provider = self._provider()
        provider.on_session_switch("hermes-session-0002", parent_session_id=_SESSION, reset=True)
        self.assertEqual(json.loads(self._file().read_text())["sessionId"], "hermes-session-0002")

    def test_ps_failure_publishes_nothing_even_with_output(self) -> None:
        os.environ["FAKE_PS_FAIL"] = "1"
        self._provider()
        self.assertEqual(self._listing(), [])

    def test_blank_start_publishes_nothing(self) -> None:
        os.environ["FAKE_PS_START"] = "   "
        self._provider()
        self.assertEqual(self._listing(), [])

    def test_session_id_outside_the_fixture_pattern_publishes_nothing(self) -> None:
        bad = "short"
        self.assertIsNone(re.fullmatch(_LAYOUT["sessionIdPattern"], bad))
        provider = self.mod.RembricMemoryProvider()
        provider.initialize(bad, cwd=str(self.tmp / "cwd"))
        self.assertEqual(self._listing(), [])

    def test_non_primary_context_publishes_nothing(self) -> None:
        self._provider(agent_context="subagent")
        self.assertEqual(self._listing(), [])

    def test_session_end_removes_the_binding_naming_the_ending_session(self) -> None:
        provider = self._provider()
        self.assertTrue(self._file().exists())
        provider.on_session_end([])
        self.assertFalse(self._file().exists())

    def test_session_end_keeps_a_binding_that_names_another_session(self) -> None:
        provider = self._provider()
        self._write("hermes-session-other")
        provider.on_session_end([])
        self.assertEqual(json.loads(self._file().read_text())["sessionId"], "hermes-session-other")
        self.assertEqual(self._listing(), [self._file().name])

    def test_shutdown_removes_only_its_own_session(self) -> None:
        provider = self._provider()
        self.assertTrue(self._file().exists())
        provider.shutdown()
        self.assertFalse(self._file().exists())
        provider = self._provider()
        self._write("hermes-session-other")
        provider.shutdown()
        self.assertTrue(self._file().exists())

    def _session(self) -> str | None:
        return json.loads(self._file().read_text())["sessionId"] if self._file().exists() else None

    def test_two_concurrent_sessions_in_one_process_publish_no_binding(self) -> None:
        self._provider()
        self.assertEqual(self._session(), _SESSION)
        self._provider("hermes-session-0002")
        self.assertEqual(self._listing(), [])

    def test_a_switch_while_another_session_is_live_publishes_nothing(self) -> None:
        first = self._provider()
        self._provider("hermes-session-0002")
        first.on_session_switch("hermes-session-0003", parent_session_id=_SESSION, reset=True)
        self.assertEqual(self._listing(), [])

    def test_back_to_one_live_session_republishes_it(self) -> None:
        self._provider()
        self._provider("hermes-session-0002").on_session_end([])
        self.assertEqual(self._session(), _SESSION)
        third = self._provider("hermes-session-0003")
        self.assertEqual(self._listing(), [])
        third.shutdown()
        self.assertEqual(self._session(), _SESSION)

    def test_the_same_session_in_two_providers_is_one_live_session(self) -> None:
        self._provider()
        self._provider(_SESSION)
        self.assertEqual(self._session(), _SESSION)

    def test_a_subagent_beside_the_primary_keeps_its_binding(self) -> None:
        self._provider()
        self._provider("hermes-subagent-01", agent_context="subagent")
        self.assertEqual(self._session(), _SESSION)

    def test_a_provider_dropped_without_shutdown_stops_counting(self) -> None:
        first = self._provider()
        self.mod.RembricMemoryProvider().initialize("hermes-session-0002", cwd=str(self.tmp / "cwd"))
        first.on_session_switch("hermes-session-0003", parent_session_id=_SESSION, reset=True)
        self.assertEqual(self._session(), "hermes-session-0003")

    def test_unwritable_home_never_raises(self) -> None:
        self.home.chmod(0o500)
        self.addCleanup(self.home.chmod, 0o700)
        self._provider()
        self.assertFalse(self._dir().exists())


if __name__ == "__main__":
    unittest.main()
