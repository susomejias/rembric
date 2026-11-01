from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
_UNINSTALL = _PLUGIN_ROOT / "uninstall.sh"


def _run(home: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["sh", str(_UNINSTALL)],
        env={"HERMES_HOME": str(home), "PATH": f"{home}/bin:/usr/bin:/bin"},
        capture_output=True,
        text=True,
        check=False,
    )


class UninstallTest(unittest.TestCase):
    def test_copied_install_is_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            plugin = home / "plugins/rembric"
            plugin.mkdir(parents=True)
            (plugin / "plugin.yaml").write_text("name: rembric\nversion: 0.0.1\n")
            (plugin / "operator-file").write_text("keep")
            result = _run(home)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("backup", result.stderr)
            self.assertEqual((plugin / "operator-file").read_text(), "keep")
            self.assertTrue((plugin / "plugin.yaml").exists())

    def test_native_remove_is_delegated_without_touching_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            plugin = home / "plugins/rembric"
            plugin.mkdir(parents=True)
            (plugin / "plugin.yaml").write_text("name: rembric\nversion: 0.0.1\n")
            (home / "plugins/.install-metadata.json").write_text(json.dumps({"rembric": {
                "source": "https://github.com/susomejias/rembric.git#apps/plugin/.hermes-plugin",
                "pinned": False,
                "revision": "a" * 40,
            }}))
            (home / "config.yaml").write_text("unrelated: keep\n")
            (home / ".env").write_text("REMBRIC_API_TOKEN=synthetic-test-token\n")
            binary = home / "bin/hermes"
            binary.parent.mkdir()
            binary.write_text('#!/bin/sh\nprintf "RAN:hermes %s %s %s\\n" "$1" "$2" "$3"\n')
            binary.chmod(0o755)
            result = _run(home)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("RAN:hermes plugins remove rembric", result.stdout)
            self.assertEqual((home / "config.yaml").read_text(), "unrelated: keep\n")
            self.assertEqual((home / ".env").read_text(), "REMBRIC_API_TOKEN=synthetic-test-token\n")

    def test_idempotent_on_clean_system_without_binary(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            for _ in range(2):
                result = _run(home)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("already absent", result.stdout)


if __name__ == "__main__":
    unittest.main()
