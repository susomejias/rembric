"""Shared test-side helper: import the Hermes plugin module without Hermes installed.

The plugin lives at ``apps/plugin/.hermes-plugin/__init__.py``. Hermes's
loader expects a flat directory, so we cannot rely on a normal package
import. Tests load the module via ``importlib`` from its absolute path
so they work no matter what cwd ``python -m unittest discover`` runs from.

A supported single-profile host double resolves secrets from the controlled
process environment and copies contextvars into worker threads.
"""

from __future__ import annotations

import contextvars
import importlib.util
import os
import sys
import threading
import types
from pathlib import Path
from typing import Any

_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
_PLUGIN_INIT = _PLUGIN_ROOT / "__init__.py"


def fresh_plugin(env: dict[str, str] | None = None, home: str | None = None) -> Any:
    """Import a pristine plugin with a supported single-profile Hermes double."""
    for k in list(os.environ):
        if k.startswith("REMBRIC_"):
            del os.environ[k]
    for k in ("HERMES_HOME", "XDG_CONFIG_HOME"):
        os.environ.pop(k, None)
    if home is not None:
        os.environ["HOME"] = home
    if env:
        os.environ.update(env)
    secret = types.ModuleType("agent.secret_scope")
    secret.__dict__["get_secret"] = os.environ.get
    memory = types.ModuleType("agent.memory_provider")

    def spawn_context_thread(target, *, name, daemon=True, args=(), kwargs=None):
        context = contextvars.copy_context()
        return threading.Thread(
            target=context.run, args=(lambda: target(*args, **(kwargs or {})),),
            name=name, daemon=daemon,
        )

    memory.__dict__["spawn_context_thread"] = spawn_context_thread
    sys.modules["agent"] = types.ModuleType("agent")
    sys.modules["agent.secret_scope"] = secret
    sys.modules["agent.memory_provider"] = memory
    sys.modules.pop("rembric_hermes_plugin", None)
    spec = importlib.util.spec_from_file_location("rembric_hermes_plugin", _PLUGIN_INIT)
    assert spec and spec.loader, f"cannot load {_PLUGIN_INIT}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sys.modules["rembric_hermes_plugin"] = module
    return module
