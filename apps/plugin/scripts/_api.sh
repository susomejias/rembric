#!/usr/bin/env bash
# Shared helper for the Rembric plugin hook scripts.
#
# Sourced by every hook script. Exposes:
#   - rembric_parse_dotenv <path>     → echoes "KEY=VALUE\n..." pairs
#   - rembric_read_project_slug <cwd> → echoes the slug from <cwd>/.rembric or empty
#   - rembric_post <path> <body>      → POSTs $body (JSON) to ${REMBRIC_SERVER_URL}${path}
#                                       with Authorization: Bearer ${REMBRIC_API_TOKEN}.
#                                       Budget defaults to 3s; REMBRIC_POST_MAX_TIME
#                                       tightens it for a host-imposed shorter one
#                                       (Codex's SessionEnd allows 3s for the WHOLE
#                                       handler, transcript read and diagnostic included).
#   - rembric_session_ensure <path> <body> → same, but echoes the response's
#                                       `created` field (`true`/`false`) — the
#                                       only function here that reads a body.
#   - rembric_turn_count <name> <id>  → echoes the atomic per-session turn count
#   - rembric_resumed_mark/_peek <id> → records/reads whether the FIRST ensure
#                                       for a session id reported created:false
#   - rembric_created_mark/_peek <id> → same, for created:true (session-opening)
#   - rembric_turn_report <path> <body> → POSTs, echoes the response's `lines`
#                                       array as one newline-separated block
#   - rembric_pending_write/_take <id> → the per-session notice cache; `_take`
#                                       prints and clears in one step
#   - rembric_scan_offset/_set <id>  → the per-session transcript byte offset
#                                       stop-report.sh scans forward from
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
    '' | \#*) continue ;;
    esac
    case "$line" in
    *=*)
      key="${line%%=*}"
      val="${line#*=}"
      ;;
    *) continue ;;
    esac
    key="${key%"${key##*[![:space:]]}"}"
    val="${val#"${val%%[![:space:]]*}"}"
    # rtrim: bash's [:space:] class includes \r, so this also strips a
    # trailing CR from a CRLF-saved .rembric file — without it, a value
    # with trailing whitespace or CRLF fails SLUG_RE and the hook silently
    # no-ops while the JS bridge (which trims both sides) reads it fine.
    val="${val%"${val##*[![:space:]]}"}"
    case "$val" in
    \"*\")
      val="${val#\"}"
      val="${val%\"}"
      ;;
    \'*\')
      val="${val#\'}"
      val="${val%\'}"
      ;;
    esac
    printf '%s=%s\n' "$key" "$val"
  done <"$file"
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
  -* | *-) return 0 ;;
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
    --max-time "${REMBRIC_POST_MAX_TIME:-3}" \
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

# POSTs the session-ensure body and echoes the response's `created` field
# verbatim (`true`/`false`), or nothing on failure or an absent field. This
# is the ONLY function in this file that reads a response body:
# session-start.sh uses it for the ensure call alone, never for
# session-end.sh's /summary or /end calls, which stay on rembric_post
# (body-free) above — the contract in plugin-session-protocol forbids
# reading a *summary* response to learn summary state, and keeping this a
# separate function is what keeps the two from ever converging into one.
rembric_session_ensure() {
  local path="${1:-}" body="${2:-}"
  [ -z "$path" ] && return 0
  if [ -z "${REMBRIC_SERVER_URL:-}" ] || [ -z "${REMBRIC_API_TOKEN:-}" ]; then
    printf '[rembric] missing REMBRIC_SERVER_URL or REMBRIC_API_TOKEN; skipping POST %s\n' "$path" >&2
    return 0
  fi
  [ -z "$body" ] && body='{}'
  local url="${REMBRIC_SERVER_URL%/}${path}"
  local rc=0 response="" status="" detail=""
  response="$(curl -s -X POST \
    -H "Authorization: Bearer ${REMBRIC_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --max-time "${REMBRIC_POST_MAX_TIME:-3}" \
    -d "$body" \
    -w '\n%{http_code}' \
    "$url")" || rc=$?
  status="${response##*$'\n'}"
  detail="${response%$'\n'*}"
  if [ "$rc" -ne 0 ] || [ "$status" -lt 200 ] 2>/dev/null || [ "$status" -ge 300 ] 2>/dev/null; then
    printf '[rembric] POST %s failed (curl rc=%s status=%s) body=%s\n' "$path" "$rc" "$status" "$detail" >&2
    return 0
  fi
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$detail" | jq -r 'if .created == true then "true" elif .created == false then "false" else "" end' 2>/dev/null
  else
    # Two expressions, not `\(true\|false\)`: BRE alternation is a GNU
    # extension, and a POSIX sed matches a LITERAL `|` there (measured with
    # `sed --posix`), so `created` came back empty and the session-opening
    # nudge never fired.
    printf '%s' "$detail" |
      sed -n -e 's/.*"created"[[:space:]]*:[[:space:]]*true.*/true/p' \
        -e 's/.*"created"[[:space:]]*:[[:space:]]*false.*/false/p' |
      head -n1
  fi
}

# Atomic per-session turn counter. `prompt-search.sh` is now its sole
# caller (the first-prompt relevance detection) — the only turn counter
# left in the plugin tree (session-nudges). `counter_name` picks the
# counter's directory. Append-and-count-bytes instead of
# read-increment-write: a single O_APPEND write is atomic even across
# concurrent invocations, so turns can never be lost to a race the way a
# read-modify-write counter could. Echoes the new count, or nothing if the
# counter is unreadable — callers MUST treat empty as fail-closed
# (defaulting to 0 would satisfy every equality check at once).
rembric_turn_count() {
  local counter_name="${1:-}" session_id="${2:-}"
  [ -z "$counter_name" ] && return 0
  local safe_id
  safe_id="$(printf '%s' "${session_id:-nosession}" | tr -c 'A-Za-z0-9_.-' '_')"
  local dir="${TMPDIR:-/tmp}/${counter_name}"
  mkdir -p "$dir" 2>/dev/null || true
  local file="${dir}/${safe_id}"
  printf '.' >>"$file" 2>/dev/null || true
  local count
  count="$(wc -c <"$file" 2>/dev/null | tr -d '[:space:]')"
  case "$count" in
  '' | *[!0-9]*) return 0 ;;
  esac
  printf '%s' "$count"
}

# Fires exactly once per (marker-dir, session id) via an atomic `mkdir` —
# `mkdir` fails when the directory already exists, so this is race-safe
# without a read-then-write. Used for the session-opening and resumed-read
# lines, each of which SHALL fire at most once per session.
rembric_once_claim() {
  local dir_name="${1:-}" session_id="${2:-}"
  { [ -z "$dir_name" ] || [ -z "$session_id" ]; } && return 1
  local safe_id
  safe_id="$(printf '%s' "$session_id" | tr -c 'A-Za-z0-9_.-' '_')"
  local dir="${TMPDIR:-/tmp}/${dir_name}"
  mkdir -p "$dir" 2>/dev/null || true
  mkdir "${dir}/${safe_id}" 2>/dev/null
}

# Records whether the FIRST session-ensure for this session id reported
# `created:false` (a resumed pre-existing session), using the same
# marker-directory mechanism as rembric_turn_count above. Write-once per
# session id: a LATER invocation (e.g. a `clear`/`compact` SessionStart,
# which re-ensures the same id) must not overwrite the first decision,
# because by then the row already exists and every later ensure reports
# `created:false` regardless of whether the session was originally fresh.
# `created` empty/unknown is recorded the same as `true` — "do not advise",
# never "advise anyway".
rembric_resumed_mark() {
  local session_id="${1:-}" created="${2:-}"
  [ -z "$session_id" ] && return 0
  local safe_id
  safe_id="$(printf '%s' "$session_id" | tr -c 'A-Za-z0-9_.-' '_')"
  local dir="${TMPDIR:-/tmp}/rembric-resumed"
  mkdir -p "$dir" 2>/dev/null || true
  local file="${dir}/${safe_id}"
  [ -e "$file" ] && return 0
  case "$created" in
  false) printf '1' >"$file" 2>/dev/null || true ;;
  *) printf '0' >"$file" 2>/dev/null || true ;;
  esac
}

# Peeked by prompt-nudge.sh — a LATER, separate process — to decide whether
# to emit the resumed-process read line. Fails closed: an absent or
# unreadable marker is treated as "not resumed", never as "resumed".
rembric_resumed_peek() {
  local session_id="${1:-}"
  [ -z "$session_id" ] && return 1
  local safe_id
  safe_id="$(printf '%s' "$session_id" | tr -c 'A-Za-z0-9_.-' '_')"
  local file="${TMPDIR:-/tmp}/rembric-resumed/${safe_id}"
  [ -f "$file" ] || return 1
  [ "$(cat "$file" 2>/dev/null)" = "1" ]
}

# The session-opening line's gate (session-nudges): records whether the
# FIRST ensure for this session id reported `created:true` — a genuinely
# NEW session. Deliberately the mirror of rembric_resumed_mark rather than
# its negation: an unclear outcome sets NEITHER file, so neither the
# opening nor the resumed-read line fires on an ensure whose result is
# unknown ("do not advise" beats a guess in either direction).
rembric_created_mark() {
  local session_id="${1:-}" created="${2:-}"
  [ -z "$session_id" ] && return 0
  local safe_id
  safe_id="$(printf '%s' "$session_id" | tr -c 'A-Za-z0-9_.-' '_')"
  local dir="${TMPDIR:-/tmp}/rembric-created"
  mkdir -p "$dir" 2>/dev/null || true
  local file="${dir}/${safe_id}"
  [ -e "$file" ] && return 0
  [ "$created" = "true" ] && { printf '1' >"$file" 2>/dev/null || true; }
  return 0
}

rembric_created_peek() {
  local session_id="${1:-}"
  [ -z "$session_id" ] && return 1
  local safe_id
  safe_id="$(printf '%s' "$session_id" | tr -c 'A-Za-z0-9_.-' '_')"
  local file="${TMPDIR:-/tmp}/rembric-created/${safe_id}"
  [ -f "$file" ] || return 1
  [ "$(cat "$file" 2>/dev/null)" = "1" ]
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

# Decode the escape sequences of a JSON string BODY (the text between the
# quotes), leaving the result in REMBRIC_JSON_DECODED. The ONE escape decoder
# in this file: the array walker below, the prompt extractor and the compaction
# extractor all route through it.
#
# A global rather than stdout because both of the callers that matter cannot
# afford `$(…)`: command substitution strips a trailing newline the value is
# entitled to keep, and it forks once per decoded string. A nameref would be
# tidier but needs bash 4.3, and macOS still ships 3.2.
#
# `\uXXXX` is passed through VERBATIM — decoding it needs printf's `\uHHHH`,
# which is bash 4.2+. jq remains the recommended path.
#
# Global substitutions rather than a scan: `${s//…}` is one C-level pass, while
# chunking the string escape-by-escape is O(n·k) and made this hook's
# UserPromptSubmit cost seconds on a long pasted prompt (measured 3.09s to
# decode 50 KB, 11.6s for 100 KB, against a 60s hook budget shared with
# prompt-search.sh, which parses the same prompt again).
rembric_json_decode_string() {
  local s="${1:-}"
  # Prose carries no escape at all, and then there is nothing to do.
  case "$s" in
  *\\*) ;;
  *)
    REMBRIC_JSON_DECODED="$s"
    return 0
    ;;
  esac
  # `\\` and `\u` are hidden behind U+0001/U+0002 first, so no later pattern
  # can claim the backslash they own — without that, `\\n` on the wire decodes
  # to a newline, and the bare-backslash sweep below would eat `\uXXXX`'s.
  # PRECONDITION: the body carries no raw U+0001/U+0002, or the restore below
  # mistakes it for a stand-in. JSON requires every C0 byte escaped, and both
  # jq and `JSON.parse` reject a body that breaks that, so the input this
  # loses is input the jq path already refuses outright.
  s="${s//\\\\/$'\x01'}"
  s="${s//\\u/$'\x02'}"
  s="${s//\\\"/\"}"
  s="${s//\\\//\/}"
  s="${s//\\n/$'\n'}"
  s="${s//\\r/$'\r'}"
  s="${s//\\t/$'\t'}"
  s="${s//\\b/$'\b'}"
  s="${s//\\f/$'\f'}"
  # Every escape the grammar defines is now consumed or hidden, so a surviving
  # backslash introduces one JSON does not define. Dropping it keeps the
  # character it swallowed, which is what the escape-by-escape scan did.
  s="${s//\\/}"
  s="${s//$'\x02'/\\u}"
  REMBRIC_JSON_DECODED="${s//$'\x01'/\\}"
}

# Capture the raw (still-escaped) body of a JSON string value. Unlike the
# bare `"\([^"]*\)"` the other extractors use, this admits `\"` inside the
# value — a prompt containing a quoted word was otherwise truncated at it,
# which is how `say "hi"` reached the server as `say \`.
#
# Not sed: the BRE that expresses "quote not preceded by an odd number of
# backslashes" needs `\|`, which is a GNU extension, and the portable
# `[^"]*\(\\"[^"]*\)*` form does not backtrack into the escaped quote here
# (measured: still `say \`).
rembric_json_raw_string_field() {
  local input="${1:-}" key="${2:-}"
  { [ -z "$input" ] || [ -z "$key" ]; } && return 0
  local rest="$input" body probe
  while :; do
    case "$rest" in
    *"\"${key}\""*) ;;
    *) return 0 ;;
    esac
    rest="${rest#*\"${key}\"}"
    # A later occurrence is tried when this one is not a `"key": "…"` pair —
    # the key's own name can appear inside an earlier string value.
    body="$rest"
    # Guarded because the trim itself is the expensive part: it re-scans the
    # whole remaining document, and JSON here almost never pads the colon.
    case "$body" in [[:space:]]*) body="${body#"${body%%[![:space:]]*}"}" ;; esac
    case "$body" in :*) ;; *) continue ;; esac
    body="${body#:}"
    case "$body" in [[:space:]]*) body="${body#"${body%%[![:space:]]*}"}" ;; esac
    case "$body" in \"*) ;; *) continue ;; esac
    body="${body#\"}"
    # Hiding every escaped backslash and quote behind a TWO-character stand-in
    # leaves the first surviving `"` at the same offset the value's closing
    # quote occupies in `body`, so one slice recovers the raw body. Walking the
    # quotes instead re-copied the tail once per escaped quote — O(n·k), and
    # 1.2s of a 50 KB prompt.
    probe="${body//\\\\/$'\x01\x01'}"
    probe="${probe//\\\"/$'\x02\x02'}"
    case "$probe" in
    *\"*) ;;
    *) return 0 ;; # unterminated string — treat as absent
    esac
    # `${x/"*/}` and not `${x%%"*}`: the suffix form retries the match at every
    # split point, which is quadratic in the value's length (measured 97.9ms
    # against 1.0ms on a 100 KB prompt).
    probe="${probe/\"*/}"
    printf '%s' "${body:0:${#probe}}"
    return 0
  done
}

# Extract `prompt` from UserPromptSubmit hook stdin JSON (jq, sed fallback).
rembric_prompt_from_stdin_json() {
  local input="${1:-}"
  [ -z "$input" ] && return 0
  if command -v jq >/dev/null 2>&1; then
    # `|| true` for the same reason as rembric_turn_report's: `jq` exits 5 on a
    # body that is not a JSON object, this pipeline is the branch's LAST
    # statement, and the `trap 'exit 0' ERR` above then kills the CALLER at its
    # `PROMPT="$(…)"` assignment.
    printf '%s' "$input" | jq -r '.prompt // empty' 2>/dev/null || true
  else
    local raw
    raw="$(rembric_json_raw_string_field "$input" prompt)"
    [ -z "$raw" ] && return 0
    rembric_json_decode_string "$raw"
    printf '%s' "$REMBRIC_JSON_DECODED"
  fi
}

# Extract `transcript_path` from a hook stdin JSON blob. Returns empty
# when missing or null. Used by session-end.sh, stop-report.sh, and
# pre-compact.sh to find the JSONL conversation log on disk.
rembric_transcript_path_from_stdin_json() {
  local input="${1:-}"
  [ -z "$input" ] && return 0
  printf '%s' "$input" | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1
}

# Extract `stop_hook_active` from a Stop hook stdin JSON blob. Callers MUST
# treat an empty result the same as `false`.
rembric_stop_hook_active_from_stdin_json() {
  local input="${1:-}"
  [ -z "$input" ] && return 0
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$input" | jq -r 'if .stop_hook_active == true then "true" elif .stop_hook_active == false then "false" else "" end' 2>/dev/null
  else
    # Same GNU-only `\|` as in rembric_session_ensure: under a POSIX sed the
    # result was empty, which stop-report.sh reads as "not a continuation" —
    # the recursion guard never cut and the hook went on to the report.
    printf '%s' "$input" |
      sed -n -e 's/.*"stop_hook_active"[[:space:]]*:[[:space:]]*true.*/true/p' \
        -e 's/.*"stop_hook_active"[[:space:]]*:[[:space:]]*false.*/false/p' |
      head -n1
  fi
}

# Extract `compaction_summary` from a PostCompact hook stdin JSON blob.
# Prefers Claude Code's snake_case; falls back to camelCase in case Codex
# (or a future client) ships the same content under `compactionSummary`.
# Returns empty when missing.
#
# Prefers `jq` when available. The fallback goes through the SAME raw-body
# capture and escape decoder as the prompt extractor: the chain of
# `${s//…}` substitutions it used before applied `\n` BEFORE `\\`, so a
# literal backslash followed by `n` (`"a\\nb"` on the wire) decoded to a
# real newline. jq is still the recommended path — `\uXXXX` is the one
# escape neither fallback decodes.
rembric_compaction_summary_from_stdin_json() {
  local input="${1:-}"
  [ -z "$input" ] && return 0
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$input" | jq -r '.compaction_summary // .compactionSummary // empty' 2>/dev/null
    return 0
  fi
  local raw
  raw="$(rembric_json_raw_string_field "$input" compaction_summary)"
  [ -z "$raw" ] && raw="$(rembric_json_raw_string_field "$input" compactionSummary)"
  [ -z "$raw" ] && return 0
  rembric_json_decode_string "$raw"
  printf '%s' "$REMBRIC_JSON_DECODED"
}

# Escape a string for embedding in a JSON value: backslashes, double quotes,
# and control chars (\n \r \t plus the remaining C0 range). Good enough for
# transcripts captured from hook stdin; not a general-purpose JSON encoder.
rembric_json_escape() {
  local s="${1:-}"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  # JSON requires every U+0000-U+001F control char escaped, not just \n \r
  # \t. A transcript containing e.g. an ANSI escape (\x1b, from pasted
  # colored terminal output) would otherwise produce an invalid JSON body
  # that the server's JSON.parse rejects outright — silently dropping the
  # whole POST (session-end fallback summary, stop-report turn, or
  # pre-compact snapshot) for the rest of the session.
  # `printf -v` rather than `$(printf …)`: the substitution form forks twice
  # per iteration (56 forks for 28 constant bytes) and this runs inside the
  # synchronous Stop hook — measured 9.19ms vs 0.198ms per call.
  local i hex c
  i=1
  while [ "$i" -le 31 ]; do
    case "$i" in 9 | 10 | 13)
      i=$((i + 1))
      continue
      ;;
    esac
    printf -v hex '%02x' "$i"
    printf -v c "\\x$hex"
    s="${s//$c/\\u00$hex}"
    i=$((i + 1))
  done
  printf '%s' "$s"
}

# POSTs the body and echoes the response's `lines` array as one
# newline-separated block — nothing on a non-2xx status, a timeout, or an
# empty array. Shared by the two body-reading callers: the per-turn report
# (session-nudges) and the turn-START recall-hints call
# (proactive-entity-recall). Still separate from `rembric_post`, and
# `plugin-session-protocol` forbids ever pointing this reader at a
# `/summary` response.
rembric_post_lines() {
  local path="${1:-}" body="${2:-}"
  [ -z "$path" ] && return 0
  if [ -z "${REMBRIC_SERVER_URL:-}" ] || [ -z "${REMBRIC_API_TOKEN:-}" ]; then
    printf '[rembric] missing REMBRIC_SERVER_URL or REMBRIC_API_TOKEN; skipping POST %s\n' "$path" >&2
    return 0
  fi
  [ -z "$body" ] && body='{}'
  local url="${REMBRIC_SERVER_URL%/}${path}"
  local rc=0 response="" status="" detail=""
  response="$(curl -s -X POST \
    -H "Authorization: Bearer ${REMBRIC_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --max-time "${REMBRIC_POST_MAX_TIME:-3}" \
    -d "$body" \
    -w '\n%{http_code}' \
    "$url")" || rc=$?
  status="${response##*$'\n'}"
  detail="${response%$'\n'*}"
  if [ "$rc" -ne 0 ] || [ "$status" -lt 200 ] 2>/dev/null || [ "$status" -ge 300 ] 2>/dev/null; then
    printf '[rembric] POST %s failed (curl rc=%s status=%s) body=%s\n' "$path" "$rc" "$status" "$detail" >&2
    return 0
  fi
  # The gate fires at most once per floor (25 min), so the overwhelming
  # majority of responses carry an empty array. Answering those from the raw
  # body costs 0.0044ms against the 1.18ms fork measured for `jq`.
  case "$detail" in *'"lines":[]'*) return 0 ;; esac
  if command -v jq >/dev/null 2>&1; then
    # `|| true`: `jq` exits 5 on a body that is not JSON at all, and this
    # pipeline is the last statement of the branch — the ERR trap is not
    # inherited by functions (no `set -E`), so the non-zero surfaces at the
    # CALLER's `LINES="$(…)"` assignment and kills the hook there.
    printf '%s' "$detail" | jq -r '(.lines // [])[]' 2>/dev/null || true
  else
    local inner
    inner="$(printf '%s' "$detail" | sed -n 's/.*"lines"[[:space:]]*:[[:space:]]*\[\(.*\)\].*/\1/p')"
    # `if`, not `[ -n "$inner" ] && …`: the `&&` form is the function's LAST
    # statement, so an empty `inner` made it return 1, and the `trap 'exit 0'
    # ERR` at the top of this file then killed the CALLER at its assignment —
    # stop-report.sh never reached `_emit_nothing` and Codex lost its `{}`.
    if [ -n "$inner" ]; then
      rembric_json_string_array_items "$inner"
    fi
  fi
}

rembric_turn_report() {
  rembric_post_lines "${1:-}" "${2:-}"
}

# Echoes the recall-hints endpoint's `lines` for the turn-START push
# (proactive-entity-recall). Same reader contract as the turn report.
rembric_recall_hints() {
  rembric_post_lines "${1:-}" "${2:-}"
}

# Decode the elements of a JSON array of strings, one per output line —
# what `jq -r '.[]'` prints. Walks the string grammar rather than splitting
# on `","`: the notice is ONE element carrying embedded `\n` and `\"`, which
# a split-and-strip fallback emitted with the escapes still literal. This
# walk only finds the element BOUNDARIES; the escapes inside one are decoded
# by `rembric_json_decode_string`, the single decoder shared with the prompt
# and compaction extractors.
rembric_json_string_array_items() {
  local inner="${1:-}"
  local n=${#inner} i=0 ch in_str=0 esc=0 cur=""
  while [ "$i" -lt "$n" ]; do
    ch="${inner:i:1}"
    i=$((i + 1))
    if [ "$in_str" -eq 0 ]; then
      if [ "$ch" = '"' ]; then
        in_str=1
        cur=""
      fi
      continue
    fi
    if [ "$esc" -eq 1 ]; then
      esc=0
      cur="${cur}\\${ch}"
      continue
    fi
    case "$ch" in
    '\') esc=1 ;;
    '"')
      in_str=0
      rembric_json_decode_string "$cur"
      printf '%s\n' "$REMBRIC_JSON_DECODED"
      ;;
    *) cur="${cur}${ch}" ;;
    esac
  done
}

# The per-session notice cache (session-nudges). `_write` SHALL NOT
# overwrite a non-empty cache with an empty value — a second report within
# one turn must not swallow a pending notice. `_take` prints and removes
# the file in one step, so a notice is printed exactly once.
rembric_pending_write() {
  local session_id="${1:-}" text="${2:-}"
  [ -z "$session_id" ] && return 0
  [ -z "$text" ] && return 0
  local safe_id
  safe_id="$(printf '%s' "$session_id" | tr -c 'A-Za-z0-9_.-' '_')"
  local dir="${TMPDIR:-/tmp}/rembric-pending"
  mkdir -p "$dir" 2>/dev/null || true
  printf '%s' "$text" >"${dir}/${safe_id}" 2>/dev/null || true
}

rembric_pending_take() {
  local session_id="${1:-}"
  [ -z "$session_id" ] && return 0
  local safe_id
  safe_id="$(printf '%s' "$session_id" | tr -c 'A-Za-z0-9_.-' '_')"
  local file="${TMPDIR:-/tmp}/rembric-pending/${safe_id}"
  [ -f "$file" ] || return 0
  cat "$file" 2>/dev/null || true
  rm -f "$file" 2>/dev/null || true
}

# The provisional title (design D12): prompt-nudge.sh records the session's
# first user prompt (already redacted, ≤100 chars) here exactly once;
# stop-report.sh consumes it for its first report. Write-once rather than
# "never overwrite non-empty with empty" — a SECOND prompt must never replace
# the FIRST one this records.
#
# Consumption leaves a `<id>.done` tombstone rather than removing the file,
# and `_write` treats the tombstone as "already recorded". Deleting the file
# outright re-armed `_write` on the very next prompt, so the title travelled
# on EVERY turn instead of "at most once per session" (session-nudges).
rembric_first_prompt_recorded() {
  local session_id="${1:-}"
  [ -z "$session_id" ] && return 1
  local safe_id
  safe_id="$(printf '%s' "$session_id" | tr -c 'A-Za-z0-9_.-' '_')"
  local file="${TMPDIR:-/tmp}/rembric-first-prompt/${safe_id}"
  [ -e "$file" ] || [ -e "${file}.done" ]
}

rembric_first_prompt_write() {
  local session_id="${1:-}" text="${2:-}"
  { [ -z "$session_id" ] || [ -z "$text" ]; } && return 0
  local safe_id
  safe_id="$(printf '%s' "$session_id" | tr -c 'A-Za-z0-9_.-' '_')"
  local dir="${TMPDIR:-/tmp}/rembric-first-prompt"
  mkdir -p "$dir" 2>/dev/null || true
  local file="${dir}/${safe_id}"
  { [ -e "$file" ] || [ -e "${file}.done" ]; } && return 0
  printf '%s' "$text" >"$file" 2>/dev/null || true
}

rembric_first_prompt_take() {
  local session_id="${1:-}"
  [ -z "$session_id" ] && return 0
  local safe_id
  safe_id="$(printf '%s' "$session_id" | tr -c 'A-Za-z0-9_.-' '_')"
  local file="${TMPDIR:-/tmp}/rembric-first-prompt/${safe_id}"
  [ -f "$file" ] || return 0
  cat "$file" 2>/dev/null || true
  # Tombstone BEFORE removing: if the write fails the file survives and the
  # worst case is the old behaviour, never a silently re-armed title.
  : >"${file}.done" 2>/dev/null && rm -f "$file" 2>/dev/null
  return 0
}

# The per-session transcript byte offset stop-report.sh's delta scan reads
# from and advances past each report — the mechanism that keeps the scan
# off the ~0.5s-per-firing cost curve a full re-parse sits on.
rembric_scan_offset() {
  local session_id="${1:-}"
  [ -z "$session_id" ] && return 0
  local safe_id
  safe_id="$(printf '%s' "$session_id" | tr -c 'A-Za-z0-9_.-' '_')"
  local file="${TMPDIR:-/tmp}/rembric-scan/${safe_id}"
  [ -f "$file" ] || return 0
  local n
  n="$(cat "$file" 2>/dev/null | tr -d '[:space:]')"
  case "$n" in
  '' | *[!0-9]*) return 0 ;;
  esac
  printf '%s' "$n"
}

rembric_scan_offset_set() {
  local session_id="${1:-}" bytes="${2:-}"
  [ -z "$session_id" ] && return 0
  local safe_id
  safe_id="$(printf '%s' "$session_id" | tr -c 'A-Za-z0-9_.-' '_')"
  local dir="${TMPDIR:-/tmp}/rembric-scan"
  mkdir -p "$dir" 2>/dev/null || true
  printf '%s' "$bytes" >"${dir}/${safe_id}" 2>/dev/null || true
}
