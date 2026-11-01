from __future__ import annotations

import os
import pty
import select
import sys
import tempfile
import time
import unittest
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[4]
_SOURCE = "https://github.com/susomejias/rembric.git#apps/plugin/.hermes-plugin"


class MigrationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.target = self.home / "plugins/rembric"
        self.target.mkdir(parents=True)
        for name in ("plugin.yaml", "__init__.py", "README.md"):
            (self.target / name).write_bytes((_ROOT / "apps/plugin/.hermes-plugin" / name).read_bytes())
        (self.target / "operator-file").write_text("keep local data")
        (self.home / "config.yaml").write_text("memory:\n  provider: rembric\nmcp_servers:\n  other: keep\n")
        (self.home / ".env").write_text("REMBRIC_API_TOKEN=synthetic-test-token\n")
        self.bin = self.home / "bin"
        self.bin.mkdir()
        self.executable("ps", '#!/bin/sh\nprintf "1 /sbin/init\\n%s python3 -\\n" "$PPID"\n')
        self.executable("curl", '#!/bin/sh\nfor arg do case "$arg" in https://raw.githubusercontent.com/susomejias/rembric/main/*) rel="${arg#https://raw.githubusercontent.com/susomejias/rembric/main/}" ;; esac; done\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then cp "' + str(_ROOT) + '/$rel" "$2"; exit; fi; shift; done\nexit 91\n')
        self.executable("hermes", f'''#!{sys.executable}
import json, os, sys
from pathlib import Path
h = Path(os.environ["HERMES_HOME"])
(h / "invoked").write_text(" ".join(sys.argv[1:]))
p = h / "plugins/rembric"
p.mkdir(exist_ok=True)
(p / "plugin.yaml").write_text("name: rembric\\nversion: 99.0.0\\n")
(p / "__init__.py").write_text("new provider")
record = {{"source": {_SOURCE!r}, "pinned": False, "revision": "a" * 40}}
(h / "plugins/.install-metadata.json").write_text(json.dumps({{"rembric": record}}))
mode = os.environ.get("FAKE_NATIVE", "success")
if mode != "success":
    (h / "config.yaml").write_text("changed by failed install")
    (h / ".env").write_text("changed credentials")
    if mode == "invalid":
        (h / "plugins/.install-metadata.json").write_text("{{}}")
    if mode in ("journal", "facts"):
        state = h / "installs/test"
        state.mkdir(parents=True)
        (state / ("publication.json" if mode == "journal" else "facts.json")).write_text("{{}}")
    sys.exit(0 if mode == "invalid" else 7)
''')
        self.env = {
            "HOME": str(self.home), "HERMES_HOME": str(self.home),
            "PATH": f"{self.bin}:{Path(sys.executable).parent}:/usr/bin:/bin",
            "REMBRIC_NONINTERACTIVE": "0", "REMBRIC_UPDATE_CHECK": "off", "NO_COLOR": "1",
        }
        self.command = ["/bin/sh", str(_ROOT / "install.sh"), "--agent=hermes", "--action=update", "--yes"]

    def executable(self, name: str, content: str) -> None:
        path = self.bin / name
        path.write_text(content)
        path.chmod(0o755)

    def run_tui(self, answer: str = "MIGRATE") -> tuple[int, str]:
        pid, fd = pty.fork()
        if pid == 0:
            os.execve(self.command[0], self.command, self.env)  # noqa: S606
        output = b""
        sent: set[str] = set()
        deadline = time.monotonic() + 15
        try:
            while time.monotonic() < deadline:
                if select.select([fd], [], [], 0.1)[0]:
                    try:
                        chunk = os.read(fd, 65536)
                    except OSError:
                        break
                    if not chunk:
                        break
                    output += chunk
                    for marker, keys in (
                        ("What do you want to do?", "\x1b[B\r"),
                        ("Which agent?", "\x1b[B\x1b[B\x1b[B\r"),
                        ("Action for hermes", "\x1b[B\r"),
                        ("Type MIGRATE", answer + "\n"),
                        ("Press Enter", "\n"),
                    ):
                        if marker.encode() in output and marker not in sent:
                            os.write(fd, keys.encode())
                            sent.add(marker)
                    if output.count(b"What do you want to do?") > 1 and "quit" not in sent:
                        os.write(fd, b"q")
                        sent.add("quit")
            else:
                os.kill(pid, 9)
                self.fail(f"TUI timed out: {output.decode(errors='replace')}")
        finally:
            os.close(fd)
            _, status = os.waitpid(pid, 0)
        return os.waitstatus_to_exitcode(status), output.decode(errors="replace")

    def assert_original(self) -> None:
        self.assertEqual((self.target / "operator-file").read_text(), "keep local data")
        self.assertEqual((self.home / ".env").read_text(), "REMBRIC_API_TOKEN=synthetic-test-token\n")
        self.assertEqual((self.home / "config.yaml").read_text(), "memory:\n  provider: rembric\nmcp_servers:\n  other: keep\n")
        self.assertFalse((self.home / "plugins/.install-metadata.json").exists())

    def test_migrates_through_tui_with_private_complete_backup(self) -> None:
        code, out = self.run_tui()
        self.assertEqual(code, 0, out)
        self.assertIn("Type MIGRATE", out)
        self.assertEqual((self.home / "invoked").read_text(), "plugins install susomejias/rembric/apps/plugin/.hermes-plugin --enable")
        backups = list(self.home.glob("rembric-backup-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].stat().st_mode & 0o777, 0o700)
        self.assertEqual((backups[0] / "rembric/operator-file").read_text(), "keep local data")
        self.assertEqual((backups[0] / ".env").read_bytes(), (self.home / ".env").read_bytes())
        self.assertFalse((self.target / "operator-file").exists())
        self.assertIn("Migration verified", out)

    def test_decline_does_not_modify_installation(self) -> None:
        code, out = self.run_tui("no")
        self.assertNotEqual(code, 0, out)
        self.assertIn("Type MIGRATE", out)
        self.assert_original()
        self.assertFalse((self.home / "invoked").exists())
        self.assertEqual(list(self.home.glob("rembric-backup-*")), [])

    def test_headless_yes_cannot_authorize_migration(self) -> None:
        self.env["REMBRIC_NONINTERACTIVE"] = "1"
        code, out = self.run_tui()
        self.assertNotEqual(code, 0, out)
        self.assertIn("interactive", out)
        self.assertNotIn("Type MIGRATE", out)
        self.assert_original()
        self.assertFalse((self.home / "invoked").exists())

    def test_active_or_uninspectable_host_is_unchanged(self) -> None:
        for ps in (
            'printf "1 /sbin/init\\n%s python3 -\\n2 /opt/hermes/.venv/bin/python /opt/hermes/hermes_cli/main.py gateway\\n" "$PPID"',
            'printf "1 /sbin/init\\n%s python3 -\\n2 python -m hermes_cli.main chat\\n" "$PPID"',
            'exit 1', 'printf ""',
        ):
            with self.subTest(ps=ps):
                self.executable("ps", "#!/bin/sh\n" + ps + "\n")
                code, out = self.run_tui()
                self.assertNotEqual(code, 0, out)
                self.assertIn("Hermes activity", out)
                self.assert_original()
                self.assertFalse((self.home / "invoked").exists())

    def test_native_failure_or_invalid_success_restores_previous_install(self) -> None:
        for mode in ("failure", "invalid"):
            with self.subTest(mode=mode):
                self.env["FAKE_NATIVE"] = mode
                code, out = self.run_tui()
                self.assertNotEqual(code, 0, out)
                self.assertIn("Previous installation restored", out)
                self.assertNotIn("gateway restart", out)
                self.assert_original()
                self.assertTrue((self.home / "invoked").exists())

    def test_rollback_preserves_configuration_ownership(self) -> None:
        config = self.home / "config.yaml"
        original = config.stat()
        groups = [group for group in os.getgroups() if group != original.st_gid]
        if not groups:
            self.skipTest("requires a supplementary group to expose copy2 ownership changes")
        os.chown(config, -1, groups[0])
        self.env["FAKE_NATIVE"] = "failure"
        code, out = self.run_tui()
        self.assertNotEqual(code, 0, out)
        self.assertIn("Previous installation restored", out)
        restored = config.stat()
        self.assertEqual((restored.st_uid, restored.st_gid), (original.st_uid, groups[0]))
        self.assert_original()

    def test_pending_publication_is_not_overwritten_by_rollback(self) -> None:
        self.env["FAKE_NATIVE"] = "journal"
        code, out = self.run_tui()
        self.assertNotEqual(code, 0, out)
        self.assertIn("Recovery incomplete", out)
        self.assertNotIn("Previous installation restored", out)
        self.assertTrue((self.home / ".rembric-migration.lock").is_dir())
        self.assertTrue((self.home / "installs/test/publication.json").exists())
        backup = next(self.home.glob("rembric-backup-*"))
        self.assertEqual((backup / "previous/operator-file").read_text(), "keep local data")
        self.assertEqual((self.target / "__init__.py").read_text(), "new provider")

    def test_changed_dependency_state_requires_manual_recovery(self) -> None:
        self.env["FAKE_NATIVE"] = "facts"
        code, out = self.run_tui()
        self.assertNotEqual(code, 0, out)
        self.assertIn("manual recovery required", out)
        self.assertNotIn("Previous installation restored", out)
        self.assertTrue((self.home / ".rembric-migration.lock").is_dir())

    def test_preexisting_journal_and_migration_lock_refuse_without_backup(self) -> None:
        state = self.home / "installs/test"
        state.mkdir(parents=True)
        journal = state / "publication.json"
        journal.write_text("{}")
        code, out = self.run_tui()
        self.assertNotEqual(code, 0, out)
        self.assertIn("pending Hermes publication", out)
        journal.unlink()
        (self.home / ".rembric-migration.lock").mkdir()
        code, out = self.run_tui()
        self.assertNotEqual(code, 0, out)
        self.assert_original()
        self.assertFalse((self.home / "invoked").exists())
        self.assertEqual(list(self.home.glob("rembric-backup-*")), [])

    def test_unrecognized_copy_is_not_offered_migration(self) -> None:
        for name, marker in (
            ("plugin.yaml", "name: rembric"),
            ("plugin.yaml", "homepage: https://github.com/susomejias/rembric"),
            ("__init__.py", "class RembricMemoryProvider(MemoryProvider):"),
        ):
            with self.subTest(marker=marker):
                path = self.target / name
                before = path.read_text()
                self.assertIn(marker, before)
                path.write_text(before.replace(marker, "foreign plugin"))
                code, out = self.run_tui()
                self.assertNotEqual(code, 0, out)
                self.assertNotIn("Type MIGRATE", out)
                self.assertFalse((self.home / "invoked").exists())
                path.write_text(before)

    def test_corrupt_backup_never_moves_the_original(self) -> None:
        injection = self.home / "fault"
        injection.mkdir()
        self.env["PYTHONPATH"] = str(injection)
        for damaged in ("operator-file", ".env"):
            with self.subTest(damaged=damaged):
                (injection / "sitecustomize.py").write_text(f'''import shutil
from pathlib import Path
original_copy = shutil.copy2
def corrupt_copy(src, dst, *args, **kwargs):
    result = original_copy(src, dst, *args, **kwargs)
    if "rembric-backup-" in str(dst) and Path(src).name == {damaged!r}:
        Path(result).write_text("corrupt backup")
    return result
shutil.copy2 = corrupt_copy
original_tree = shutil.copytree
def corrupt_tree(src, dst, *args, **kwargs):
    kwargs["copy_function"] = corrupt_copy
    return original_tree(src, dst, *args, **kwargs)
shutil.copytree = corrupt_tree
''')
                self.env["PYTHONDONTWRITEBYTECODE"] = "1"
                code, out = self.run_tui()
                self.assertNotEqual(code, 0, out)
                self.assertIn("backup verification failed", out)
                self.assert_original()
                self.assertFalse((self.home / "invoked").exists())

    def test_linked_unknown_plugin_data_is_refused(self) -> None:
        (self.target / "linked-data").symlink_to(self.home / ".env")
        code, out = self.run_tui()
        self.assertNotEqual(code, 0, out)
        self.assertIn("unsupported linked/special file", out)
        self.assert_original()
        self.assertFalse((self.home / "invoked").exists())

    def test_refuses_linked_configuration_before_native_install(self) -> None:
        envfile = self.home / ".env"
        external = self.home / "external-env"
        envfile.rename(external)
        envfile.symlink_to(external)
        code, out = self.run_tui()
        self.assertNotEqual(code, 0, out)
        self.assertFalse((self.home / "invoked").exists())
        self.assertEqual(external.read_text(), "REMBRIC_API_TOKEN=synthetic-test-token\n")


if __name__ == "__main__":
    unittest.main()
