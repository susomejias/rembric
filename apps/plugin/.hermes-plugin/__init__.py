"""Rembric memory provider for Hermes Agent.

Install with:

    curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.hermes-plugin/install.sh | sh
    hermes plugins install rembric   # answers requires_env prompts, writes ~/.hermes/.env
    hermes plugins enable rembric

Lifecycle (`initialize`, `on_pre_compress`, `on_session_end`) talks to
Rembric's HTTP session API (`/api/<slug>/sessions(*)`). Tool access flows
through the bundled MCP bridge registered separately in
``~/.hermes/config.yaml`` under ``mcp_servers.rembric`` — this provider
intentionally exposes no native tools so the surface cannot drift.

Credentials live in ``${HERMES_HOME:-~/.hermes}/.env``, written by
Hermes itself via the manifest's ``requires_env`` flow at install time.
Hermes pre-loads that file into ``os.environ`` before the plugin module
imports AND into every subprocess it spawns from ``mcp_servers.*`` —
single source of truth for both the in-process provider and the bridge.

Project slug cascade (first valid match wins): ``REMBRIC_PROJECT_SLUG``
env → ``<cwd>/.rembric`` ``PROJECT_SLUG`` → trailing path segment of
``REMBRIC_SERVER_URL`` if it ends in ``/mcp/<slug>`` → degraded silent
skip. Failures degrade silently (single-line stderr diagnostic) and
never abort the host session.
"""

from __future__ import annotations

import json
import os
import re
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


# Mirror of the slug regex enforced by ``plugin/bin/rembric-bridge.mjs`` and
# Rembric's project-slug validation: lowercase letters/digits/hyphens, 1–64
# chars, must not start or end with a hyphen.
_SLUG_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$")
_SUMMARY_MAX_CHARS = 20_000
_API_TIMEOUT_SEC = 3
_HEALTHZ_TIMEOUT_SEC = 2


# ---------------------------------------------------------------------------
# Dotenv parsing — used by `.rembric` files (per-cwd slug pinning)
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


# ---------------------------------------------------------------------------
# Slug resolution cascade
# ---------------------------------------------------------------------------


def _valid_slug(candidate: str | None) -> str | None:
    if not candidate:
        return None
    return candidate if _SLUG_RE.match(candidate) else None


def _slug_from_env() -> str | None:
    return _valid_slug(os.environ.get("REMBRIC_PROJECT_SLUG"))


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
    """Cascade through the four sources, returning the first valid slug."""
    for source in (
        _slug_from_env,
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
    ``sync_turn``, ``on_memory_write``) are no-ops — the agent uses the
    MCP bridge for memory tool access.

    Credentials come exclusively from ``os.environ``, which Hermes populates
    from ``${HERMES_HOME:-~/.hermes}/.env`` before this module imports (via
    the ``requires_env`` install flow). The provider does not manage
    credential storage — no ``get_config_schema``, no ``save_config``.
    """

    def __init__(self) -> None:
        self._base: str | None = None
        self._slug: str | None = None
        self._session_id: str | None = None
        self._cwd: str | None = None
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
        req = Request(
            url,
            method="GET",
            headers={"Authorization": f"Bearer {token}"},
        )
        try:
            with urlopen(req, timeout=_HEALTHZ_TIMEOUT_SEC) as resp:
                return 200 <= resp.status < 300
        except Exception:
            return False

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        self._base = os.environ.get("REMBRIC_SERVER_URL")
        cwd = kwargs.get("cwd") or os.getcwd()
        self._cwd = cwd
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

    def system_prompt_block(self) -> str:
        # Hermes does NOT consume the MCP server's initialize.instructions and
        # exposes no per-turn hook, so this is its ONLY nudging surface. It
        # returns the SAME unified nudge as the server's buildInstructions()
        # BASE (the SAVE/RECALL/SUMMARIZE flows) — one version for every
        # client. The text is duplicated across the TS/Python boundary (no
        # cross-language sharing is possible) and MUST be kept byte-identical
        # to instructions.ts::BASE; content tests on both sides guard drift.
        # No cap comes from Hermes (upstream build_system_prompt joins blocks
        # with no truncation); the ≤1000-char ceiling is our own token budget.
        return (
            "Rembric — persistent memory across sessions. Use these tools "
            "proactively, not only when asked; each tool's description has the "
            "exact mechanics.\n\n"
            "SAVE: the moment it happens — bug fix · decision · discovery · "
            "config change · pattern · preference — call memory.save (don't "
            "batch to session end). Evolving a prior topic? pass topic_key to "
            "supersede it; resolve candidates[] with memory.judge.\n"
            "RECALL: starting/resuming work, after /compact, or asked \"what "
            "did we do\"? Call memory.context (memory.search for keyword "
            "lookup) if you lack prior detail.\n"
            "SUMMARIZE: before ending any working turn, call "
            "memory.session_summary({title≤100 (the work, not cwd), "
            "summary≤2000}) — never end silent: Goal · Discoveries · "
            "Accomplished · Next Steps · Files.\n"
            "Update Rembric itself: memory.about."
        )

    def prefetch(self, query: str, **kwargs: Any) -> str:
        return ""

    def queue_prefetch(self, query: str, **kwargs: Any) -> None:
        return None

    def sync_turn(self, user: str, assistant: str, **kwargs: Any) -> None:
        return None

    def on_pre_compress(self, messages: list, **kwargs: Any) -> str:
        # Returning "" is the documented no-contribution signal; the
        # important effect is the side-effect POST below. Hermes feeds the
        # return value into the compressor prompt; we choose not to.
        if not self._initialized or not self._slug or not self._base or not self._session_id:
            return ""
        transcript = _format_transcript(messages)
        if not transcript:
            return ""
        _api_post(
            self._base,
            self._slug,
            f"/sessions/{self._session_id}/summary",
            {"summary": transcript, "final": False},
        )
        return ""

    def on_session_end(self, messages: list, **kwargs: Any) -> None:
        del kwargs
        _stderr(
            f"[rembric] on_session_end: session={self._session_id!r} "
            f"messages_count={len(messages) if messages else 0} "
            f"initialized={self._initialized} slug={self._slug!r}"
        )
        if not self._initialized or not self._slug or not self._base or not self._session_id:
            return
        transcript = _format_transcript(messages)
        title = _derive_title_from_messages(messages)
        body: dict[str, Any] = {}
        if transcript:
            body["summary"] = transcript
            body["final"] = False
        if title:
            body["title"] = title
            body.setdefault("final", False)
        _api_post(
            self._base,
            self._slug,
            f"/sessions/{self._session_id}/end",
            body,
        )

    def on_session_switch(
        self,
        new_session_id: str,
        *,
        parent_session_id: str = "",
        reset: bool = False,
        **kwargs: Any,
    ) -> None:
        # Hermes fires this on context compression, /resume, /branch,
        # /reset, /new — any path that reassigns AIAgent.session_id without
        # tearing the provider down. Without overriding, self._session_id
        # becomes stale and every subsequent lifecycle POST hits the wrong
        # row.
        #
        # Close the previously-cached session in ALL cases, not just when
        # Hermes passes a populated parent_session_id. /reset and /new use
        # parent_session_id="" by upstream contract (clean restart, no
        # continuation lineage) — if we keyed off parent_session_id alone,
        # the old session would stay `active` forever and never accumulate
        # its summary. Trust our own cached id instead.
        del kwargs
        _stderr(
            f"[rembric] on_session_switch: new={new_session_id} "
            f"parent={parent_session_id!r} reset={reset} "
            f"cached_session={self._session_id!r} "
            f"initialized={self._initialized}"
        )
        if not self._initialized:
            return
        old_id = self._session_id
        if self._slug and self._base and old_id and old_id != new_session_id:
            _api_post(
                self._base,
                self._slug,
                f"/sessions/{old_id}/end",
                {},
            )
        self._session_id = new_session_id
        if self._slug and self._base and new_session_id:
            _api_post(
                self._base,
                self._slug,
                "/sessions",
                {
                    "id": new_session_id,
                    "cwd": self._cwd or os.getcwd(),
                    "agent": "hermes",
                },
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


_TITLE_MAX_CHARS = 100


def _derive_title_from_messages(messages: list) -> str:
    """Return the first non-empty assistant message (≤100 chars) as a title.

    Used by on_session_end to seed a non-final title write. Returns empty
    string when no assistant message is found.
    """
    for msg in messages or []:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role", "")).strip()
        if role != "assistant":
            continue
        content = msg.get("content", "")
        if not isinstance(content, str):
            try:
                content = json.dumps(content, ensure_ascii=False)
            except (TypeError, ValueError):
                content = repr(content)
        text = content.strip()
        if not text:
            continue
        # Collapse newlines / tabs to spaces — titles are single-line.
        text = text.replace("\n", " ").replace("\r", " ").replace("\t", " ")
        if len(text) > _TITLE_MAX_CHARS:
            text = text[:_TITLE_MAX_CHARS]
        return text
    return ""


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def register(ctx: Any) -> None:
    """Hermes plugin entry point — register the memory provider only."""
    ctx.register_memory_provider(RembricMemoryProvider())
