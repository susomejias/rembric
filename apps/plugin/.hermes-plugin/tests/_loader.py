"""Shared test-side helper: import the Hermes plugin module without Hermes installed.

The plugin lives at ``apps/plugin/.hermes-plugin/__init__.py``. Hermes's
loader expects a flat directory, so we cannot rely on a normal package
import. Tests load the module via ``importlib`` from its absolute path
so they work no matter what cwd ``python -m unittest discover`` runs from.

We also reset ``REMBRIC_*`` env vars + ``HOME`` ``XDG_CONFIG_HOME``
``HERMES_HOME`` per call so the module-level ``_preload_rembric_dotenv``
side-effect cannot leak between tests.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path
from typing import Any

_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
_PLUGIN_INIT = _PLUGIN_ROOT / "__init__.py"


def fresh_plugin(env: dict[str, str] | None = None, home: str | None = None) -> Any:
    """Import a pristine copy of the plugin module with controlled env.

    Strips any prior REMBRIC_* / HERMES_HOME / XDG_CONFIG_HOME / HOME
    overrides from the process env before re-import so the module-level
    dotenv preload starts from a known baseline.
    """
    for k in list(os.environ):
        if k.startswith("REMBRIC_"):
            del os.environ[k]
    for k in ("HERMES_HOME", "XDG_CONFIG_HOME"):
        os.environ.pop(k, None)
    if home is not None:
        os.environ["HOME"] = home
    if env:
        os.environ.update(env)
    sys.modules.pop("rembric_hermes_plugin", None)
    spec = importlib.util.spec_from_file_location("rembric_hermes_plugin", _PLUGIN_INIT)
    assert spec and spec.loader, f"cannot load {_PLUGIN_INIT}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sys.modules["rembric_hermes_plugin"] = module
    return module
