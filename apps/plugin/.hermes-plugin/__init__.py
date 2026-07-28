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
import threading
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
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

        def on_turn_start(self, turn_number: int, message: Any, **kwargs: Any) -> None:
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
_RECALL_LIMIT = 5
_SAVE_HINT_EVERY = 5
_SUMMARY_HINT_EVERY = 10
_COMPACTION_TOKEN_FLOOR = 20_000
_NON_PRIMARY_AGENT_CONTEXTS = {"subagent", "cron", "flush"}
_SAVE_HINT = (
    "<memory-hint>if recent work produced a decision, fix, or discovery, "
    "you MUST call memory.save now (title ≤100 + content).</memory-hint>"
)
_SAVE_HINT_URGENT = (
    "<memory-hint>Context is about to compact — save anything important "
    "with memory.save NOW before it is lost.</memory-hint>"
)
_SUMMARY_HINT = (
    "<memory-hint>did real work happen this turn? You MUST call "
    "memory.session_summary({title, summary}) now — title ≤100 chars (the "
    "work, not cwd); summary: Goal · Accomplished · Decisions+why · "
    "Verified+how · Unfinished+why · Files. Nothing memorable? "
    "Skip.</memory-hint>"
)
_SESSION_ID_HINT_TEMPLATE = (
    '<memory-hint>sessionId="{{SESSION_ID}}" — pass it explicitly to '
    "memory.save/memory.session_summary/memory.save_prompt now, to "
    "guarantee correct attachment; never guess a different one.</memory-hint>"
)
_RELEVANCE_HINT = (
    "<memory-hint>New session — call memory.context with focus set to this "
    "prompt before responding, to surface relevant prior work.</memory-hint>"
)


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
    """Cascade through the four sources, returning the first valid slug.

    .rembric wins over the env var so a per-repo file overrides the global
    default set once via the install flow, matching plugin.yaml's own
    "Overridden per-cwd if a .rembric file is present" wording.
    """
    for source in (
        lambda: _slug_from_dotrembric(cwd),
        _slug_from_env,
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


def _api_request(
    base: str,
    slug: str,
    path: str,
    body: dict | None,
    timeout: int = _API_TIMEOUT_SEC,
) -> dict | None:
    """POST JSON to ``${base}/api/<slug>${path}``, returning the parsed JSON
    response body on 2xx, or ``None`` on any failure (never raises — the
    provider must not crash the host session)."""
    token = os.environ.get("REMBRIC_API_TOKEN")
    if not base or not token or not slug:
        _stderr(f"[rembric] missing base/token/slug; skipping POST {path}")
        return None
    url = f"{base.rstrip('/')}/api/{slug}{path}"
    data = json.dumps(body or {}).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    req = Request(url, data=data, headers=headers, method="POST")
    try:
        with urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except HTTPError as err:
        detail = ""
        try:
            detail = err.read().decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001 — body read is best-effort
            pass
        _stderr(f"[rembric] POST {path} failed: {err} body={detail}")
        return None
    except (URLError, TimeoutError) as err:
        _stderr(f"[rembric] POST {path} failed: {err}")
        return None
    except Exception as err:  # noqa: BLE001 — provider must not crash the host
        _stderr(f"[rembric] POST {path} failed: {err!r}")
        return None
    # urlopen already raised on non-2xx; a non-JSON body still counts as success ({}).
    if not raw:
        return {}
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def _api_post(
    base: str,
    slug: str,
    path: str,
    body: dict | None,
    timeout: int = _API_TIMEOUT_SEC,
) -> bool:
    """POST JSON to ``${base}/api/<slug>${path}``. Return True on 2xx."""
    return _api_request(base, slug, path, body, timeout) is not None


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
        # queue_prefetch warms this per-session; prefetch reads it back inline.
        self._prefetch_cache: dict[str, str] = {}
        self._sync_lock: threading.Lock = threading.Lock()
        self._suppressed: bool = False
        self._turn_number: int = 0
        self._compaction_imminent: bool = False
        self._compaction_warned: bool = False

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
        # Only a primary context creates a session row, so subagent/cron runs
        # don't inflate the dashboard. Cached for the session's lifetime —
        # every later lifecycle HTTP call must skip too, not just this POST.
        agent_context = kwargs.get("agent_context", "primary")
        self._suppressed = agent_context in _NON_PRIMARY_AGENT_CONTEXTS
        if not self._slug:
            _stderr(
                f"[rembric] no project slug for session {session_id}; "
                "skipping session POST"
            )
        elif not self._base:
            _stderr("[rembric] REMBRIC_SERVER_URL is unset; skipping session POST")
        elif agent_context in _NON_PRIMARY_AGENT_CONTEXTS:
            _stderr(
                f"[rembric] agent_context={agent_context!r} is non-primary; "
                "skipping session POST"
            )
        else:
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
        # MUST stay byte-identical to instructions.ts::BASE — Hermes never consumes the server block.
        return (
            "Rembric — persistent memory across sessions. Use the tools "
            "proactively.\n\n"
            "SAVE: the moment it happens — bug fix · decision · discovery · "
            "config · pattern · preference — call memory.save with a title≤100 "
            "headline + content (don't batch). Evolving a prior topic? pass "
            "topic_key; resolve candidates[] with memory.judge.\n"
            "RECALL: starting/resuming work, after /compact, or asked \"what "
            "did we do\"? Call memory.context (memory.search for keyword "
            "lookup) if you lack prior detail.\n"
            "SUMMARIZE: did real work happen? Before ending, you MUST call "
            "memory.session_summary({title≤100 (the work, not cwd), "
            "summary≤10000}) — Goal · Accomplished · Decisions+why · "
            "Verified+how · Unfinished+why · Files.\n"
            "Know your sessionId? Pass it — never guess it.\n"
            "Update Rembric: memory.about."
        )

    def on_turn_start(self, turn_number: int, message: Any, **kwargs: Any) -> None:
        del message
        self._turn_number = turn_number
        remaining = kwargs.get("remaining_tokens")
        if (
            isinstance(remaining, int)
            and remaining < _COMPACTION_TOKEN_FLOOR
            and not self._compaction_warned
        ):
            self._compaction_imminent = True
        # Only diagnostic evidence that Hermes calls this hook at all — see
        # prefetch()'s matching line for whether its return value is ever seen.
        _stderr(f"[rembric] on_turn_start: turn={turn_number} session={self._session_id!r}")
        return None

    def prefetch(self, query: str, **kwargs: Any) -> str:
        # Inline on the turn path — read the cache only, never a network call.
        del query
        session_id = kwargs.get("session_id") or self._session_id
        recalled = self._prefetch_cache.get(session_id or "", "")
        hints: list[str] = []
        hint_tags: list[str] = []
        if self._turn_number == 1:
            hints.append(_RELEVANCE_HINT)
            hint_tags.append("relevance")
        if self._compaction_imminent:
            self._compaction_imminent = False
            self._compaction_warned = True
            hints.append(_SAVE_HINT_URGENT)
            hint_tags.append("save_urgent")
        elif self._turn_number > 0 and self._turn_number % _SAVE_HINT_EVERY == 0:
            hints.append(_SAVE_HINT)
            hint_tags.append("save")
        if self._turn_number > 0 and (
            self._turn_number == 1 or self._turn_number % _SUMMARY_HINT_EVERY == 0
        ):
            hints.append(_SUMMARY_HINT)
            hint_tags.append("summary")
        if hints and session_id:
            hints.insert(
                0, _SESSION_ID_HINT_TEMPLATE.replace("{{SESSION_ID}}", session_id)
            )
            hint_tags.insert(0, "session_id")
        # Whether Hermes actually surfaces this return value to the model is
        # otherwise unobservable from the host side; this line is the only way
        # to confirm a hint was even offered.
        _stderr(
            f"[rembric] prefetch: turn={self._turn_number} session={session_id!r} "
            f"hints={'+'.join(hint_tags) if hint_tags else 'none'}"
        )
        if not hints:
            return recalled
        hint = "\n".join(hints)
        return f"{recalled}\n{hint}" if recalled else hint

    def queue_prefetch(self, query: str, **kwargs: Any) -> None:
        session_id = kwargs.get("session_id") or self._session_id
        if not query or not session_id or not self._slug or not self._base:
            return None
        response = _api_request(
            self._base,
            self._slug,
            "/memory/recall",
            {"query": query, "limit": _RECALL_LIMIT},
        )
        if response is None:
            return None
        formatted = response.get("formatted")
        if isinstance(formatted, str) and formatted:
            self._prefetch_cache[session_id] = formatted
        return None

    def sync_turn(self, user: str, assistant: str, **kwargs: Any) -> None:
        if (
            not self._initialized
            or not self._slug
            or not self._base
            or not self._session_id
            or self._suppressed
        ):
            return None
        messages = kwargs.get("messages")
        if not isinstance(messages, list):
            messages = [
                {"role": "user", "content": user},
                {"role": "assistant", "content": assistant},
            ]
        base, slug, session_id = self._base, self._slug, self._session_id

        def _sync() -> None:
            # Bounded so a hung POST can't wedge the lock forever.
            acquired = self._sync_lock.acquire(timeout=5.0)
            if not acquired:
                # A prior POST is still in flight past the timeout — the
                # next sync_turn resends the full transcript, so skipping
                # this write loses nothing but avoids racing it.
                return
            try:
                transcript = _format_transcript(messages)
                if not transcript:
                    return
                body: dict[str, Any] = {"summary": transcript, "final": False}
                title = _derive_title_from_messages(messages)
                if title:
                    body["title"] = title
                _api_post(
                    base,
                    slug,
                    f"/sessions/{session_id}/summary",
                    body,
                )
            finally:
                if acquired:
                    self._sync_lock.release()

        threading.Thread(target=_sync, daemon=True).start()
        return None

    def on_pre_compress(self, messages: list, **kwargs: Any) -> str:
        # Returning "" is the documented no-contribution signal; the
        # important effect is the side-effect POST below. Hermes feeds the
        # return value into the compressor prompt; we choose not to.
        if (
            not self._initialized
            or not self._slug
            or not self._base
            or not self._session_id
            or self._suppressed
        ):
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
        if (
            not self._initialized
            or not self._slug
            or not self._base
            or not self._session_id
            or self._suppressed
        ):
            return
        # A late sync_turn write would be rejected once /end flips status.
        if self._sync_lock.acquire(timeout=5.0):
            self._sync_lock.release()
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
        self._prefetch_cache.pop(self._session_id, None)
        self._reset_turn_state()

    def _reset_turn_state(self) -> None:
        self._turn_number = 0
        self._compaction_imminent = False
        self._compaction_warned = False

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
        if (
            self._slug
            and self._base
            and old_id
            and old_id != new_session_id
            and not self._suppressed
        ):
            # Same drain as on_session_end.
            if self._sync_lock.acquire(timeout=5.0):
                self._sync_lock.release()
            _api_post(
                self._base,
                self._slug,
                f"/sessions/{old_id}/end",
                {},
            )
        if old_id and old_id != new_session_id:
            self._prefetch_cache.pop(old_id, None)
            self._reset_turn_state()
        self._session_id = new_session_id
        if self._slug and self._base and new_session_id and not self._suppressed:
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


# Mirrors stripPrivateTags in .opencode-plugin/plugin.ts and
# rembric_redact_private in scripts/_transcript.sh; the shared fixtures in
# ../test/redaction-fixtures.json keep the three implementations in lock-step.
_PRIVATE_SPAN_RE = re.compile(r"<private>.*?</private>", re.IGNORECASE | re.DOTALL)
_PRIVATE_UNCLOSED_RE = re.compile(r"<private>.*", re.IGNORECASE | re.DOTALL)


def _redact_private(text: str) -> str:
    if not text:
        return ""
    redacted = _PRIVATE_SPAN_RE.sub("[REDACTED]", text)
    # Unclosed tag redacts through end-of-text: fail closed for a privacy marker.
    return _PRIVATE_UNCLOSED_RE.sub("[REDACTED]", redacted)


def _format_transcript(messages: list) -> str:
    """Serialize messages oldest-first; truncate from the head at 20k chars.

    Each message becomes ``role: content``. Non-string content is rendered
    via ``json.dumps`` so structured tool calls don't crash the serializer.
    """
    lines: list[str] = []
    for msg in messages or []:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role", "")).strip()
        if role not in ("user", "assistant"):
            continue
        content = msg.get("content", "")
        if not isinstance(content, str):
            try:
                content = json.dumps(content, ensure_ascii=False)
            except (TypeError, ValueError):
                content = repr(content)
        lines.append(f"{role}: {content}")
    # Redact before tail-truncation: truncating first could cut off the
    # opening <private> tag and leak the span content.
    transcript = _redact_private("\n".join(lines))
    if len(transcript) > _SUMMARY_MAX_CHARS:
        transcript = transcript[-_SUMMARY_MAX_CHARS:]
    return transcript


_TITLE_MAX_CHARS = 100


def _derive_title_from_messages(messages: list) -> str:
    """Return the first non-empty assistant message (≤100 chars) as a title.

    Used by sync_turn (every turn) and on_session_end to seed non-final
    title writes. Returns empty string when no assistant message is found.
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
        text = _redact_private(content.strip())
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
