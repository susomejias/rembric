#!/usr/bin/env bash
# Shared helper for the Rembric plugin hook scripts.
#
# Sourced by session-start.sh, pre-compact.sh, and stop-sync.sh. Exposes:
#   - rembric_parse_dotenv <path>     → echoes "KEY=VALUE\n..." pairs
#   - rembric_read_project_slug <cwd> → echoes the slug from <cwd>/.rembric or empty
#   - rembric_post <path> <body>      → POSTs $body (JSON) to ${REMBRIC_SERVER_URL}${path}
#                                       with Authorization: Bearer ${REMBRIC_API_TOKEN}
#
# Every function exits 0 on failure (at most a one-line stderr diagnostic) so
# a plugin-side problem NEVER aborts the host agent.

set -u
trap 'exit 0' ERR

rembric_parse_dotenv() {
  local file="${1:-}"
  [ -z "$file" ] || [ ! -f "$file" ] && return 0
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in
      ''|\#*) continue ;;
    esac
    case "$line" in
      *=*) key="${line%%=*}"; val="${line#*=}" ;;
      *) continue ;;
    esac
    key="${key%"${key##*[![:space:]]}"}"
    val="${val#"${val%%[![:space:]]*}"}"
    case "$val" in
      \"*\") val="${val#\"}"; val="${val%\"}" ;;
      \'*\') val="${val#\'}"; val="${val%\'}" ;;
    esac
    printf '%s=%s\n' "$key" "$val"
  done < "$file"
}

rembric_read_project_slug() {
  local cwd="${1:-${PWD}}"
  local file="${cwd}/.rembric"
  [ ! -f "$file" ] && return 0
  local pairs slug
  pairs="$(rembric_parse_dotenv "$file")"
  slug="$(printf '%s\n' "$pairs" | sed -n 's/^PROJECT_SLUG=//p' | head -n1)"
  # Mirror the bridge's slug regex: lowercase letters/digits/hyphens, 1–64 chars,
  # cannot begin or end with a hyphen.
  case "$slug" in
    '') return 0 ;;
    *[!a-z0-9-]*) return 0 ;;
    -*|*-) return 0 ;;
  esac
  [ "${#slug}" -gt 64 ] && return 0
  printf '%s' "$slug"
}

rembric_post() {
  local path="${1:-}" body="${2:-}"
  [ -z "$path" ] && return 0
  if [ -z "${REMBRIC_SERVER_URL:-}" ] || [ -z "${REMBRIC_API_TOKEN:-}" ]; then
    printf '[rembric] missing REMBRIC_SERVER_URL or REMBRIC_API_TOKEN; skipping POST %s\n' "$path" >&2
    return 0
  fi
  # Avoid the ${body:-{}} parameter-expansion trap: bash treats the literal
  # `{}` in the default branch as a single `{` followed by the closing `}`
  # of the expansion, leaving a stray `}` in the final string.
  [ -z "$body" ] && body='{}'
  local url="${REMBRIC_SERVER_URL%/}${path}"
  local rc=0 response="" status="" detail=""
  response="$(curl -s -X POST \
    -H "Authorization: Bearer ${REMBRIC_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --max-time 3 \
    -d "$body" \
    -w '\n%{http_code}' \
    "$url")" || rc=$?
  status="${response##*$'\n'}"
  detail="${response%$'\n'*}"
  if [ "$rc" -ne 0 ] || [ "$status" -lt 200 ] 2>/dev/null || [ "$status" -ge 300 ] 2>/dev/null; then
    printf '[rembric] POST %s failed (curl rc=%s status=%s) body=%s\n' "$path" "$rc" "$status" "$detail" >&2
  fi
  return 0
}

# Best-effort extraction of a session id from the hook stdin JSON. Prefers
# Claude Code's `session_id`; falls back to Codex's `sessionId`.
rembric_session_id_from_stdin_json() {
  local input="${1:-}"
  [ -z "$input" ] && return 0
  local id
  id="$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  if [ -z "$id" ]; then
    id="$(printf '%s' "$input" | sed -n 's/.*"sessionId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  fi
  printf '%s' "$id"
}

rembric_cwd_from_stdin_json() {
  local input="${1:-}"
  [ -z "$input" ] && return 0
  printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1
}

# Extract `prompt` from UserPromptSubmit hook stdin JSON (jq, sed fallback).
rembric_prompt_from_stdin_json() {
  local input="${1:-}"
  [ -z "$input" ] && return 0
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$input" | jq -r '.prompt // empty' 2>/dev/null
  else
    printf '%s' "$input" | sed -n 's/.*"prompt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1
  fi
}

# Extract `transcript_path` from a hook stdin JSON blob. Returns empty
# when missing or null. Used by session-end.sh, stop-sync.sh, and
# pre-compact.sh to find the JSONL conversation log on disk.
rembric_transcript_path_from_stdin_json() {
  local input="${1:-}"
  [ -z "$input" ] && return 0
  printf '%s' "$input" | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1
}

# Extract `compaction_summary` from a PostCompact hook stdin JSON blob.
# Prefers Claude Code's snake_case; falls back to camelCase in case Codex
# (or a future client) ships the same content under `compactionSummary`.
# Returns empty when missing.
#
# Prefers `jq` when available (correctly handles escaped quotes and any
# whitespace in the payload). Falls back to a sed regex that matches the
# same shape as the other stdin extractors — simple `"[^"]*"` value
# capture. The fallback cannot recover content past an unescaped quote
# inside the value, but in practice compaction summaries from Claude
# Code / Codex are JSON-encoded so embedded quotes appear as `\"` and
# the regex truncates at the first escape; for v1 this is the same
# trade-off as the other stdin extractors. jq is the recommended path.
rembric_compaction_summary_from_stdin_json() {
  local input="${1:-}"
  [ -z "$input" ] && return 0
  local s=""
  if command -v jq >/dev/null 2>&1; then
    s="$(printf '%s' "$input" | jq -r '.compaction_summary // .compactionSummary // empty' 2>/dev/null)"
  else
    s="$(printf '%s' "$input" | sed -n 's/.*"compaction_summary"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
    if [ -z "$s" ]; then
      s="$(printf '%s' "$input" | sed -n 's/.*"compactionSummary"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
    fi
    # The sed regex preserved JSON escape sequences (e.g. \n, \") literally.
    # Convert them back to real characters so callers handling plain text
    # see a readable summary; rembric_json_escape will re-encode on emit.
    if [ -n "$s" ]; then
      s="${s//\\n/$'\n'}"
      s="${s//\\r/$'\r'}"
      s="${s//\\t/$'\t'}"
      s="${s//\\\"/\"}"
      s="${s//\\\\/\\}"
    fi
  fi
  printf '%s' "$s"
}

# Escape a string for embedding in a JSON value: backslashes, double quotes,
# and control chars (\n \r \t). Good enough for transcripts captured from
# hook stdin; not a general-purpose JSON encoder.
rembric_json_escape() {
  local s="${1:-}"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}
