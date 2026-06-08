"""``uninstall.sh`` removes only plugin-owned files, is idempotent, and never
touches credentials or project markers."""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
_UNINSTALL = _PLUGIN_ROOT / "uninstall.sh"


def _run(hermes_home: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["sh", str(_UNINSTALL)],
        env={"HERMES_HOME": str(hermes_home), "PATH": "/usr/bin:/bin"},
        capture_output=True,
        text=True,
        check=False,
    )


class UninstallTest(unittest.TestCase):
    def test_removes_plugin_files_and_preserves_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            plugin_dir = home / "plugins" / "rembric"
            plugin_dir.mkdir(parents=True)
            for f in ("plugin.yaml", "__init__.py", "README.md"):
                (plugin_dir / f).write_text("x")
            env_file = home / ".env"
            env_file.write_text("REMBRIC_API_TOKEN=secret")

            result = _run(home)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(plugin_dir.exists(), "plugin dir should be removed")
            self.assertTrue(env_file.exists(), ".env must be preserved")
            self.assertEqual(env_file.read_text(), "REMBRIC_API_TOKEN=secret")
            self.assertIn("NOT removed", result.stdout)
            self.assertIn(".env", result.stdout)

    def test_idempotent_on_clean_system(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            first = _run(home)
            second = _run(home)
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertIn("already absent", second.stdout)


if __name__ == "__main__":
    unittest.main()
