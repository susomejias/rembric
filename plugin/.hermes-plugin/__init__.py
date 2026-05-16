"""Rembric memory provider for Hermes Agent.

Install with:

    curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin/install.sh | sh
    hermes plugins enable rembric

Lifecycle (`initialize`, `on_pre_compress`, `on_session_end`) talks to
Rembric's HTTP session API (`/api/<slug>/sessions(*)`). Tool access flows
through the bundled MCP bridge registered separately in
``~/.hermes/config.yaml`` under ``mcp_servers.rembric`` — this provider
intentionally exposes no native tools so the surface cannot drift.

Resolves project slug via cascade: ``REMBRIC_PROJECT_SLUG`` env →
``<hermes_home>/rembric.json`` (written by ``save_config``) →
``<cwd>/.rembric`` ``PROJECT_SLUG`` → trailing path segment of
``REMBRIC_SERVER_URL`` if it ends in ``/mcp/<slug>`` → degraded silent
skip. Failures degrade silently (single-line stderr diagnostic) and
never abort the host session.
"""

from __future__ import annotations

import json
import os
import sys
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


# ---------------------------------------------------------------------------
# Hermes ABC — defensive import
# ---------------------------------------------------------------------------

try:
    from agent.memory_provider import MemoryProvider  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - exercised only outside Hermes

    class MemoryProvider(ABC):
        @property
        @abstractmethod
        def name(self) -> str: ...

        @abstractmethod
        def is_available(self) -> bool: ...

        @abstractmethod
        def initialize(self, session_id: str, **kwargs: Any) -> None: ...

        @abstractmethod
        def get_tool_schemas(self) -> list[dict]: ...

        @abstractmethod
        def handle_tool_call(self, name: str, args: dict) -> str: ...

        def get_config_schema(self) -> list[dict]:
            return []

        def save_config(self, values: dict, hermes_home: str) -> None:
            pass

        def system_prompt_block(self) -> str:
            return ""

        def prefetch(self, query: str, **kwargs: Any) -> str:
            return ""

        def queue_prefetch(self, query: str, **kwargs: Any) -> None:
            pass

        def sync_turn(self, user: str, assistant: str, **kwargs: Any) -> None:
            pass

        def on_session_end(self, messages: list, **kwargs: Any) -> None:
            pass

        def on_pre_compress(self, messages: list, **kwargs: Any) -> None:
            pass

        def on_memory_write(
            self, action: str, target: str, content: str, **kwargs: Any
        ) -> None:
            pass

        def shutdown(self, **kwargs: Any) -> None:
            pass


# ---------------------------------------------------------------------------
# Module-level constants
# ---------------------------------------------------------------------------

# Mirror of the slug regex enforced by ``plugin/bin/rembric-bridge.mjs`` and
# Rembric's project-slug validation: lowercase letters/digits/hyphens, 1–64
# chars, must not start or end with a hyphen.
import re  # noqa: E402

_SLUG_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$")
_SUMMARY_MAX_CHARS = 20_000
_API_TIMEOUT_SEC = 3
_HEALTHZ_TIMEOUT_SEC = 2


# ---------------------------------------------------------------------------
# Dotenv preload (issue #250 parity with agentmemory)
# ---------------------------------------------------------------------------


def _parse_dotenv(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if (len(value) >= 2) and (value[0] == value[-1]) and value[0] in ("'", '"'):
            value = value[1:-1]
        if key:
            out[key] = value
    return out


def _preload_rembric_dotenv() -> None:
    """Pre-populate missing env values from ``~/.rembric/.env`` (best-effort).

    Uses ``os.environ.setdefault`` so a shell-set value ALWAYS wins. Silent
    on any failure (missing file, unreadable, malformed) — the provider
    falls back to whatever the process env carries.
    """
    candidates: list[Path] = []
    home = os.environ.get("HOME")
    if home:
        candidates.append(Path(home) / ".rembric" / ".env")
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        candidates.append(Path(xdg) / "rembric" / ".env")
    for path in candidates:
        try:
            if not path.is_file():
                continue
            for key, value in _parse_dotenv(path.read_text(encoding="utf-8")).items():
                os.environ.setdefault(key, value)
        except (OSError, UnicodeDecodeError):
            continue


_preload_rembric_dotenv()


# ---------------------------------------------------------------------------
# Slug resolution cascade
# ---------------------------------------------------------------------------


def _valid_slug(candidate: str | None) -> str | None:
    if not candidate:
        return None
    return candidate if _SLUG_RE.match(candidate) else None


def _slug_from_env() -> str | None:
    return _valid_slug(os.environ.get("REMBRIC_PROJECT_SLUG"))


def _slug_from_stored_config() -> str | None:
    hermes_home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    config_path = Path(hermes_home) / "rembric.json"
    try:
        if not config_path.is_file():
            return None
        data = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    return _valid_slug(data.get("project_slug"))


def _slug_from_dotrembric(cwd: str) -> str | None:
    rembric_path = Path(cwd) / ".rembric"
    try:
        if not rembric_path.is_file():
            return None
        pairs = _parse_dotenv(rembric_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError):
        return None
    return _valid_slug(pairs.get("PROJECT_SLUG"))


def _slug_from_url() -> str | None:
    url = os.environ.get("REMBRIC_SERVER_URL")
    if not url:
        return None
    try:
        parsed = urlparse(url)
    except ValueError:
        return None
    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) >= 2 and parts[-2] == "mcp":
        return _valid_slug(parts[-1])
    return None


def _resolve_slug(cwd: str) -> str | None:
    """Cascade through the five sources, returning the first valid slug."""
    for source in (
        _slug_from_env,
        _slug_from_stored_config,
        lambda: _slug_from_dotrembric(cwd),
        _slug_from_url,
    ):
        candidate = source()
        if candidate:
            return candidate
    return None


# ---------------------------------------------------------------------------
# HTTP helper
# ---------------------------------------------------------------------------


def _stderr(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def _api_post(
    base: str,
    slug: str,
    path: str,
    body: dict | None,
    timeout: int = _API_TIMEOUT_SEC,
) -> bool:
    """POST JSON to ``${base}/api/<slug>${path}``. Return True on 2xx."""
    token = os.environ.get("REMBRIC_API_TOKEN")
    if not base or not token or not slug:
        _stderr(f"[rembric] missing base/token/slug; skipping POST {path}")
        return False
    url = f"{base.rstrip('/')}/api/{slug}{path}"
    data = json.dumps(body or {}).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    req = Request(url, data=data, headers=headers, method="POST")
    try:
        with urlopen(req, timeout=timeout):
            return True
    except (URLError, TimeoutError) as err:
        _stderr(f"[rembric] POST {path} failed: {err}")
        return False
    except Exception as err:  # noqa: BLE001 — provider must not crash the host
        _stderr(f"[rembric] POST {path} failed: {err!r}")
        return False


# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------


class RembricMemoryProvider(MemoryProvider):
    """Lifecycle-only memory provider for Rembric.

    Sessions: initialize → POST /api/<slug>/sessions; on_pre_compress → POST
    /sessions/<id>/summary; on_session_end → POST /sessions/<id>/end.
    Memory-touching lifecycle methods (``prefetch``, ``system_prompt_block``,
    ``sync_turn``, ``on_memory_write``) are no-ops in v1 — the agent uses the
    MCP bridge for memory tool access.
    """

    def __init__(self) -> None:
        self._base: str | None = None
        self._slug: str | None = None
        self._session_id: str | None = None
        self._initialized: bool = False

    @property
    def name(self) -> str:
        return "rembric"

    def is_available(self) -> bool:
        base = os.environ.get("REMBRIC_SERVER_URL")
        token = os.environ.get("REMBRIC_API_TOKEN")
        if not base or not token:
            return False
        url = f"{base.rstrip('/')}/healthz"
        try:
            with urlopen(Request(url, method="GET"), timeout=_HEALTHZ_TIMEOUT_SEC) as resp:
                return 200 <= resp.status < 300
        except Exception:
            return False

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        self._base = os.environ.get("REMBRIC_SERVER_URL")
        cwd = kwargs.get("cwd") or os.getcwd()
        self._slug = _resolve_slug(cwd)
        self._session_id = session_id
        self._initialized = True
        if not self._slug:
            _stderr(
                f"[rembric] no project slug for session {session_id}; "
                "skipping session POST"
            )
            return
        if not self._base:
            _stderr("[rembric] REMBRIC_SERVER_URL is unset; skipping session POST")
            return
        _api_post(
            self._base,
            self._slug,
            "/sessions",
            {"id": session_id, "cwd": cwd, "agent": "hermes"},
        )

    def get_tool_schemas(self) -> list[dict]:
        return []

    def handle_tool_call(self, name: str, args: dict) -> str:
        return json.dumps(
            {
                "error": "unknown_tool",
                "hint": (
                    "register the rembric MCP bridge in mcp_servers.rembric to "
                    "access memory tools"
                ),
            }
        )

    def get_config_schema(self) -> list[dict]:
        return [
            {
                "key": "server_url",
                "description": "Rembric server base URL (WITHOUT /mcp suffix)",
                "env_var": "REMBRIC_SERVER_URL",
                "required": True,
            },
            {
                "key": "api_token",
                "description": "Bearer token issued by 'rembric token create'",
                "env_var": "REMBRIC_API_TOKEN",
                "secret": True,
                "required": True,
            },
            {
                "key": "project_slug",
                "description": (
                    "Default project slug; overridden by REMBRIC_PROJECT_SLUG "
                    "env or <cwd>/.rembric if present"
                ),
                "env_var": "REMBRIC_PROJECT_SLUG",
                "required": False,
            },
        ]

    def save_config(self, values: dict, hermes_home: str) -> None:
        config_path = Path(hermes_home) / "rembric.json"
        try:
            config_path.write_text(json.dumps(values, indent=2), encoding="utf-8")
        except OSError as err:
            _stderr(f"[rembric] failed to write {config_path}: {err}")

    def system_prompt_block(self) -> str:
        return ""

    def prefetch(self, query: str, **kwargs: Any) -> str:
        return ""

    def queue_prefetch(self, query: str, **kwargs: Any) -> None:
        return None

    def sync_turn(self, user: str, assistant: str, **kwargs: Any) -> None:
        return None

    def on_pre_compress(self, messages: list, **kwargs: Any) -> None:
        if not self._initialized or not self._slug or not self._base or not self._session_id:
            return
        transcript = _format_transcript(messages)
        if not transcript:
            return
        _api_post(
            self._base,
            self._slug,
            f"/sessions/{self._session_id}/summary",
            {"summary": transcript},
        )

    def on_session_end(self, messages: list, **kwargs: Any) -> None:
        if not self._initialized or not self._slug or not self._base or not self._session_id:
            return
        _api_post(
            self._base,
            self._slug,
            f"/sessions/{self._session_id}/end",
            {},
        )

    def on_memory_write(
        self, action: str, target: str, content: str, **kwargs: Any
    ) -> None:
        return None

    def shutdown(self, **kwargs: Any) -> None:
        return None


def _format_transcript(messages: list) -> str:
    """Serialize messages oldest-first; truncate from the head at 20k chars.

    Each message becomes ``role: content``. Non-string content is rendered
    via ``json.dumps`` so structured tool calls don't crash the serializer.
    """
    lines: list[str] = []
    for msg in messages or []:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role", "")).strip() or "unknown"
        content = msg.get("content", "")
        if not isinstance(content, str):
            try:
                content = json.dumps(content, ensure_ascii=False)
            except (TypeError, ValueError):
                content = repr(content)
        lines.append(f"{role}: {content}")
    transcript = "\n".join(lines)
    if len(transcript) > _SUMMARY_MAX_CHARS:
        transcript = transcript[-_SUMMARY_MAX_CHARS:]
    return transcript


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def register(ctx: Any) -> None:
    """Hermes plugin entry point — register the memory provider only."""
    ctx.register_memory_provider(RembricMemoryProvider())
