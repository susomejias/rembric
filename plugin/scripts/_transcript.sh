#!/usr/bin/env bash
# Shared helper for parsing Claude Code / Codex transcript JSONL files.
#
# Exposes:
#   rembric_format_transcript <path> → echoes "role: content\n..." oldest-first,
#                                        truncated to ~19500 chars from the head
#                                        (keeps the tail = most recent messages)
#   rembric_extract_first_assistant <path> → echoes the first non-empty assistant
#                                              message (suitable as a title seed)
#
# Both helpers return empty string on any failure (missing file, malformed
# JSONL, no parsable messages). Both exit 0 — plugin-side failure NEVER
# aborts the host agent.
#
# Implementation strategy:
#   1. Prefer `jq` when available (cleanest path).
#   2. Fall back to a defensive sed/awk parser otherwise (Claude Code
#      transcript files live in JSONL; each line is loosely `{type, message:
#      {role, content}, ...}` — `content` may be a string OR an array of
#      content blocks. The fallback handles both shapes best-effort.)

set -u
trap 'exit 0' ERR

# Conservative tail size — server caps summary at 20000 chars
# (sessionSummarySchema.max). Leave 500 chars of headroom for JSON escapes.
RBR_TRANSCRIPT_MAX_CHARS=19500
RBR_TITLE_MAX_CHARS=100

rembric_format_transcript() {
  local path="${1:-}"
  if [ -z "$path" ] || [ ! -f "$path" ]; then
    return 0
  fi
  if [ ! -s "$path" ]; then
    return 0
  fi
  local out
  if command -v jq >/dev/null 2>&1; then
    out="$(_rembric_format_transcript_jq "$path" 2>/dev/null)" || out=""
  else
    out="$(_rembric_format_transcript_fallback "$path" 2>/dev/null)" || out=""
  fi
  if [ -z "$out" ]; then
    return 0
  fi
  # Truncate from the head — keep the tail (most recent messages).
  if [ "${#out}" -gt "$RBR_TRANSCRIPT_MAX_CHARS" ]; then
    out="${out: -$RBR_TRANSCRIPT_MAX_CHARS}"
  fi
  printf '%s' "$out"
}

rembric_extract_first_assistant() {
  local path="${1:-}"
  if [ -z "$path" ] || [ ! -f "$path" ] || [ ! -s "$path" ]; then
    return 0
  fi
  local title
  if command -v jq >/dev/null 2>&1; then
    title="$(_rembric_extract_first_assistant_jq "$path" 2>/dev/null)" || title=""
  else
    title="$(_rembric_extract_first_assistant_fallback "$path" 2>/dev/null)" || title=""
  fi
  # Truncate at the title cap.
  if [ "${#title}" -gt "$RBR_TITLE_MAX_CHARS" ]; then
    title="${title:0:$RBR_TITLE_MAX_CHARS}"
  fi
  # Collapse newlines and tabs to spaces — titles must be single-line.
  title="$(printf '%s' "$title" | tr '\n\r\t' '   ')"
  printf '%s' "$title"
}

_rembric_format_transcript_jq() {
  local path="$1"
  # Claude Code's transcript JSONL interleaves real conversation messages
  # with internal metadata events (attachment, file-history-snapshot,
  # permission-mode, last-prompt, queue-operation, ai-title, system, ...).
  # We only want the actual conversation, so we filter to role/type ∈
  # {user, assistant}. Then we extract content (string OR array of
  # {type:"text", text}) and skip any line whose extracted content is
  # empty/whitespace.
  #
  # Three shapes Claude Code uses:
  #   1. {type:"user"|"assistant", message: {role, content: string}, ...}
  #   2. {type:"user"|"assistant", message: {role, content: [{type:"text", text:"..."}, ...]}, ...}
  #   3. {role, content}  — Codex / fallback shape
  jq -r '
    (.message // .) as $m
    | ($m.role // .type // "unknown") as $role
    | select($role == "user" or $role == "assistant")
    | ($m.content // "") as $c
    | (
        if ($c | type) == "array" then
          ( [ $c[] | select(.type? == "text" or (has("text"))) | .text ] | join(" ") )
        else
          $c
        end
      ) as $text
    | select($text != null and ($text | tostring | gsub("\\s"; "")) != "")
    | "\($role): \($text)"
  ' "$path" 2>/dev/null
}

_rembric_extract_first_assistant_jq() {
  local path="$1"
  # Same filter as the format function — only consider real assistant
  # messages, never metadata events whose .type happens to be "assistant"
  # at a wrapping layer but whose .message.role is something else.
  jq -r '
    (.message // .) as $m
    | ($m.role // .type // "unknown") as $role
    | select($role == "assistant")
    | ($m.content // "") as $c
    | (
        if ($c | type) == "array" then
          ( [ $c[] | select(.type? == "text" or (has("text"))) | .text ] | join(" ") )
        else
          $c
        end
      ) as $text
    | select($text != null and ($text | tostring | gsub("\\s"; "")) != "")
    | $text
  ' "$path" 2>/dev/null | head -n1
}

_rembric_format_transcript_fallback() {
  # No-jq parser. Restricts role to {user, assistant} and skips lines
  # whose extracted content is blank/whitespace. This drops Claude Code's
  # internal-metadata events (attachment, file-history-snapshot,
  # permission-mode, last-prompt, queue-operation, ai-title, system) that
  # share the same JSONL stream.
  #
  # Role is read from "role":"<x>" first; if absent, falls back to
  # "type":"<x>" — but only matches user|assistant either way, so unknown
  # event types are dropped.
  local path="$1"
  awk '
    {
      line = $0
      role = ""
      if (match(line, /"role"[[:space:]]*:[[:space:]]*"(user|assistant)"/)) {
        s = substr(line, RSTART, RLENGTH)
        sub(/.*"role"[[:space:]]*:[[:space:]]*"/, "", s)
        sub(/".*/, "", s)
        role = s
      } else if (match(line, /"type"[[:space:]]*:[[:space:]]*"(user|assistant)"/)) {
        s = substr(line, RSTART, RLENGTH)
        sub(/.*"type"[[:space:]]*:[[:space:]]*"/, "", s)
        sub(/".*/, "", s)
        role = s
      }
      if (role != "user" && role != "assistant") next

      content = ""
      if (match(line, /"content"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"/)) {
        s = substr(line, RSTART, RLENGTH)
        sub(/.*"content"[[:space:]]*:[[:space:]]*"/, "", s)
        sub(/"$/, "", s)
        gsub(/\\n/, " ", s)
        gsub(/\\"/, "\"", s)
        gsub(/\\\\/, "\\", s)
        content = s
      } else if (match(line, /"text"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"/)) {
        s = substr(line, RSTART, RLENGTH)
        sub(/.*"text"[[:space:]]*:[[:space:]]*"/, "", s)
        sub(/"$/, "", s)
        gsub(/\\n/, " ", s)
        gsub(/\\"/, "\"", s)
        gsub(/\\\\/, "\\", s)
        content = s
      }
      # Skip blank / whitespace-only content (covers empty user/assistant
      # placeholders Claude Code emits between turns).
      stripped = content
      gsub(/[[:space:]]/, "", stripped)
      if (stripped == "") next
      printf "%s: %s\n", role, content
    }
  ' "$path"
}

_rembric_extract_first_assistant_fallback() {
  local path="$1"
  awk '
    {
      line = $0
      role = ""
      if (match(line, /"role"[[:space:]]*:[[:space:]]*"assistant"/) > 0) role = "assistant"
      else if (match(line, /"type"[[:space:]]*:[[:space:]]*"assistant"/) > 0) role = "assistant"
      if (role != "assistant") next

      content = ""
      if (match(line, /"content"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"/)) {
        s = substr(line, RSTART, RLENGTH)
        sub(/.*"content"[[:space:]]*:[[:space:]]*"/, "", s)
        sub(/"$/, "", s)
        gsub(/\\n/, " ", s)
        gsub(/\\"/, "\"", s)
        gsub(/\\\\/, "\\", s)
        content = s
      } else if (match(line, /"text"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"/)) {
        s = substr(line, RSTART, RLENGTH)
        sub(/.*"text"[[:space:]]*:[[:space:]]*"/, "", s)
        sub(/"$/, "", s)
        gsub(/\\n/, " ", s)
        gsub(/\\"/, "\"", s)
        gsub(/\\\\/, "\\", s)
        content = s
      }
      # Skip blank lines (placeholder assistant: lines between real turns).
      stripped = content
      gsub(/[[:space:]]/, "", stripped)
      if (stripped == "") next
      print content
      exit
    }
  ' "$path"
}
