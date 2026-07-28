#!/usr/bin/env bash
# Per-agent transcript parsers. Claude Code and Codex CLI emit JSONL
# transcripts in completely different shapes, so each client has its own
# parser pair. No unified function — divergence is kept explicit per
# agent so a quirk in one parser cannot leak into the other.
#
# Public API (each pair: jq path + awk fallback):
#
#   Claude Code (session-end.sh):
#     rembric_format_transcript_claude_code <path>
#       → echoes "role: content\n..." oldest-first, ≤19500 chars
#     rembric_extract_first_assistant_claude_code <path>
#       → echoes the first non-empty assistant message
#
#   Codex CLI (stop-sync.sh codex-cli):
#     rembric_format_transcript_codex_cli <path>
#       → same shape, parses Codex's event_msg envelope instead
#     rembric_extract_first_assistant_codex_cli <path>
#       → first agent_message text
#
# Both pairs:
#   - Return empty string on any failure (missing file, malformed JSONL,
#     no parsable messages).
#   - Exit 0 — plugin-side failure NEVER aborts the host agent.
#   - Prefer `jq` when available; fall back to a defensive awk parser
#     otherwise. awk is POSIX, ships with macOS BSD and Linux gawk/mawk.
#   - Redact <private>…</private> spans to [REDACTED] (case-insensitive,
#     spans newlines; an unclosed tag redacts through end-of-text) before
#     any payload-bound text leaves this file — see rembric_redact_private.

set -u
trap 'exit 0' ERR

# Wire upper bound, deliberately ABOVE the server's effective cap
# (SUMMARY_MAX_CHARS=10000): a client cannot know a given server's cap at
# runtime, so bounding to one version's value would silently under-deliver
# against a server whose cap is higher. The server stays the only authoritative
# trimmer and the only writer of the '…[truncated]' marker.
#
# What matters is that this cut and the server's keep the SAME SIDE. Both keep
# the tail. Two successive tail-cuts are idempotent — the result is the last
# min(bounds) chars — whereas this tail-cut followed by a head-cut on the server
# yielded a middle window, which is what it used to do. Guarded by
# apps/server/src/test/invariants.test.ts.
RBR_TRANSCRIPT_MAX_CHARS=19500
RBR_TITLE_MAX_CHARS=100

# ---------------------------------------------------------------------------
# Common post-processing applied to both agents.
# ---------------------------------------------------------------------------

# Mirrors stripPrivateTags in .opencode-plugin/plugin.ts and _redact_private
# in .hermes-plugin/__init__.py; the shared fixtures in ../test/ keep the
# three implementations in lock-step. POSIX awk only (BSD awk must pass).
rembric_redact_private() {
  printf '%s' "${1:-}" | awk '
    NR > 1 && !inpriv { printf "\n" }
    {
      line = $0
      while (length(line) > 0) {
        if (inpriv) {
          p = index(tolower(line), "</private>")
          if (p == 0) {
            line = ""
          } else {
            line = substr(line, p + 10)
            inpriv = 0
          }
        } else {
          p = index(tolower(line), "<private>")
          if (p == 0) {
            printf "%s", line
            line = ""
          } else {
            printf "%s[REDACTED]", substr(line, 1, p - 1)
            line = substr(line, p + 9)
            inpriv = 1
          }
        }
      }
    }
  '
}

_rembric_truncate_transcript() {
  local out="${1:-}"
  if [ -z "$out" ]; then
    return 0
  fi
  # Redact before tail-truncation: truncating first could cut off the opening
  # <private> tag and leak the span content.
  out="$(rembric_redact_private "$out")"
  if [ "${#out}" -gt "$RBR_TRANSCRIPT_MAX_CHARS" ]; then
    out="${out: -$RBR_TRANSCRIPT_MAX_CHARS}"
  fi
  printf '%s' "$out"
}

_rembric_finalize_title() {
  local title="${1:-}"
  title="$(rembric_redact_private "$title")"
  if [ "${#title}" -gt "$RBR_TITLE_MAX_CHARS" ]; then
    title="${title:0:$RBR_TITLE_MAX_CHARS}"
  fi
  # Collapse newlines/tabs to spaces — titles must be single-line.
  title="$(printf '%s' "$title" | tr '\n\r\t' '   ')"
  printf '%s' "$title"
}

# ===========================================================================
# CLAUDE CODE
# ===========================================================================
#
# Each line wraps the message as:
#   {type:"user"|"assistant", message:{role, content: string},  ...}
#   {type:"user"|"assistant", message:{role, content: [{type:"text", text}, ...]}, ...}
# Some lines are internal metadata (attachment, file-history-snapshot,
# permission-mode, last-prompt, queue-operation, ai-title, system, …) and
# must be dropped. The parser filters strictly to type ∈ {user, assistant}.

rembric_format_transcript_claude_code() {
  local path="${1:-}"
  if [ -z "$path" ] || [ ! -f "$path" ] || [ ! -s "$path" ]; then
    return 0
  fi
  local out
  # No `|| out=""` fallback: jq streams output as it parses, so a torn
  # trailing line (e.g. a Stop hook racing a mid-write append, or a crash)
  # makes jq exit non-zero but still leaves every GOOD line it already
  # printed in `out` via the command substitution. An `||` here would
  # discard that already-captured partial transcript instead of keeping
  # it — command substitution already yields "" on a total failure, so
  # no explicit fallback is needed for that case either.
  if command -v jq >/dev/null 2>&1; then
    out="$(_rembric_format_transcript_claude_code_jq "$path" 2>/dev/null)"
  else
    out="$(_rembric_format_transcript_claude_code_fallback "$path" 2>/dev/null)"
  fi
  _rembric_truncate_transcript "$out"
}

rembric_extract_first_assistant_claude_code() {
  local path="${1:-}"
  if [ -z "$path" ] || [ ! -f "$path" ] || [ ! -s "$path" ]; then
    return 0
  fi
  local title
  if command -v jq >/dev/null 2>&1; then
    title="$(_rembric_extract_first_assistant_claude_code_jq "$path" 2>/dev/null)" || title=""
  else
    title="$(_rembric_extract_first_assistant_claude_code_fallback "$path" 2>/dev/null)" || title=""
  fi
  _rembric_finalize_title "$title"
}

_rembric_format_transcript_claude_code_jq() {
  local path="$1"
  jq -r '
    select(.type == "user" or .type == "assistant")
    | (.message // .) as $m
    | ($m.content // "") as $c
    | (
        if ($c | type) == "array" then
          ( [ $c[] | select(.type? == "text" or (has("text"))) | .text ] | join(" ") )
        else
          $c
        end
      ) as $text
    | select($text != null and ($text | tostring | gsub("\\s"; "")) != "")
    | "\(.type): \($text)"
  ' "$path" 2>/dev/null
}

_rembric_extract_first_assistant_claude_code_jq() {
  local path="$1"
  jq -r '
    select(.type == "assistant")
    | (.message // .) as $m
    | ($m.content // "") as $c
    | (
        if ($c | type) == "array" then
          ( [ $c[] | select(.type? == "text" or (has("text"))) | .text ] | join(" ") )
        else
          $c
        end
      )
    | select(. != null and (tostring | gsub("\\s"; "")) != "")
  ' "$path" 2>/dev/null | head -n1
}

_rembric_format_transcript_claude_code_fallback() {
  local path="$1"
  awk '
    function clean(s) {
      sub(/.*:[[:space:]]*"/, "", s)
      sub(/"$/, "", s)
      gsub(/\\n/, " ", s)
      gsub(/\\r/, " ", s)
      gsub(/\\t/, " ", s)
      gsub(/\\"/, "\"", s)
      gsub(/\\\\/, "\\", s)
      return s
    }
    {
      line = $0
      if (match(line, /"type"[[:space:]]*:[[:space:]]*"(user|assistant)"/) == 0) next
      tag = substr(line, RSTART, RLENGTH)
      sub(/.*"type"[[:space:]]*:[[:space:]]*"/, "", tag)
      sub(/".*/, "", tag)
      role = tag
      content = ""
      if (match(line, /"content"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"/)) content = clean(substr(line, RSTART, RLENGTH))
      if (content == "" && match(line, /"text"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"/)) content = clean(substr(line, RSTART, RLENGTH))
      if (content == "") next
      stripped = content
      gsub(/[[:space:]]/, "", stripped)
      if (stripped == "") next
      printf "%s: %s\n", role, content
    }
  ' "$path"
}

_rembric_extract_first_assistant_claude_code_fallback() {
  local path="$1"
  awk '
    function clean(s) {
      sub(/.*:[[:space:]]*"/, "", s)
      sub(/"$/, "", s)
      gsub(/\\n/, " ", s)
      gsub(/\\r/, " ", s)
      gsub(/\\t/, " ", s)
      gsub(/\\"/, "\"", s)
      gsub(/\\\\/, "\\", s)
      return s
    }
    {
      line = $0
      if (line !~ /"type"[[:space:]]*:[[:space:]]*"assistant"/) next
      content = ""
      if (match(line, /"content"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"/)) content = clean(substr(line, RSTART, RLENGTH))
      if (content == "" && match(line, /"text"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"/)) content = clean(substr(line, RSTART, RLENGTH))
      if (content == "") next
      stripped = content
      gsub(/[[:space:]]/, "", stripped)
      if (stripped == "") next
      print content
      exit
    }
  ' "$path"
}

# ===========================================================================
# CODEX CLI
# ===========================================================================
#
# Codex wraps real conversation messages inside an event_msg envelope:
#   {timestamp, type:"event_msg", payload:{type:"user_message",  message:"...", ...}}
#   {timestamp, type:"event_msg", payload:{type:"agent_message", message:"...", phase:"final_answer"}}
#
# Codex JSONL also carries response_item / turn_context / session_meta /
# token_count / reasoning / mcp_tool_call_end / task_started / task_complete
# / function_call(_output) lines — all dropped. The response_item.message
# lines duplicate event_msg content but include developer-role system
# prompts; we prefer the event_msg path for cleanliness.

rembric_format_transcript_codex_cli() {
  local path="${1:-}"
  if [ -z "$path" ] || [ ! -f "$path" ] || [ ! -s "$path" ]; then
    return 0
  fi
  local out
  # See the identical comment in rembric_format_transcript_claude_code — no
  # `|| out=""` fallback, so a torn trailing line doesn't discard the good
  # lines jq already printed before hitting the parse error.
  if command -v jq >/dev/null 2>&1; then
    out="$(_rembric_format_transcript_codex_cli_jq "$path" 2>/dev/null)"
  else
    out="$(_rembric_format_transcript_codex_cli_fallback "$path" 2>/dev/null)"
  fi
  _rembric_truncate_transcript "$out"
}

rembric_extract_first_assistant_codex_cli() {
  local path="${1:-}"
  if [ -z "$path" ] || [ ! -f "$path" ] || [ ! -s "$path" ]; then
    return 0
  fi
  local title
  if command -v jq >/dev/null 2>&1; then
    title="$(_rembric_extract_first_assistant_codex_cli_jq "$path" 2>/dev/null)" || title=""
  else
    title="$(_rembric_extract_first_assistant_codex_cli_fallback "$path" 2>/dev/null)" || title=""
  fi
  _rembric_finalize_title "$title"
}

_rembric_format_transcript_codex_cli_jq() {
  local path="$1"
  jq -r '
    select(.type == "event_msg"
           and (.payload.type == "user_message" or .payload.type == "agent_message"))
    | {
        role: (if .payload.type == "user_message" then "user" else "assistant" end),
        text: (.payload.message // "")
      }
    | select(.text != null and (.text | tostring | gsub("\\s"; "")) != "")
    | "\(.role): \(.text)"
  ' "$path" 2>/dev/null
}

_rembric_extract_first_assistant_codex_cli_jq() {
  local path="$1"
  jq -r '
    select(.type == "event_msg" and .payload.type == "agent_message")
    | (.payload.message // "")
    | select(. != null and (tostring | gsub("\\s"; "")) != "")
  ' "$path" 2>/dev/null | head -n1
}

_rembric_format_transcript_codex_cli_fallback() {
  local path="$1"
  awk '
    function clean(s) {
      sub(/.*:[[:space:]]*"/, "", s)
      sub(/"$/, "", s)
      gsub(/\\n/, " ", s)
      gsub(/\\r/, " ", s)
      gsub(/\\t/, " ", s)
      gsub(/\\"/, "\"", s)
      gsub(/\\\\/, "\\", s)
      return s
    }
    {
      line = $0
      if (line !~ /"type"[[:space:]]*:[[:space:]]*"event_msg"/) next
      role = ""
      if (line ~ /"type"[[:space:]]*:[[:space:]]*"user_message"/) {
        role = "user"
      } else if (line ~ /"type"[[:space:]]*:[[:space:]]*"agent_message"/) {
        role = "assistant"
      }
      if (role == "") next
      content = ""
      if (match(line, /"message"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"/)) content = clean(substr(line, RSTART, RLENGTH))
      if (content == "") next
      stripped = content
      gsub(/[[:space:]]/, "", stripped)
      if (stripped == "") next
      printf "%s: %s\n", role, content
    }
  ' "$path"
}

_rembric_extract_first_assistant_codex_cli_fallback() {
  local path="$1"
  awk '
    function clean(s) {
      sub(/.*:[[:space:]]*"/, "", s)
      sub(/"$/, "", s)
      gsub(/\\n/, " ", s)
      gsub(/\\r/, " ", s)
      gsub(/\\t/, " ", s)
      gsub(/\\"/, "\"", s)
      gsub(/\\\\/, "\\", s)
      return s
    }
    {
      line = $0
      if (line !~ /"type"[[:space:]]*:[[:space:]]*"event_msg"/) next
      if (line !~ /"type"[[:space:]]*:[[:space:]]*"agent_message"/) next
      content = ""
      if (match(line, /"message"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"/)) content = clean(substr(line, RSTART, RLENGTH))
      if (content == "") next
      stripped = content
      gsub(/[[:space:]]/, "", stripped)
      if (stripped == "") next
      print content
      exit
    }
  ' "$path"
}
