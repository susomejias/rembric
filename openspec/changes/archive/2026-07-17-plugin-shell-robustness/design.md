## Context

Four independent bugs in the shared bash plumbing (`_api.sh`, `_transcript.sh`, `prompt-nudge.sh`), grouped because they're the same class of issue (silent data loss / silent split-brain in the shell layer) discovered in the same review pass, and all four are small, surgical, low-risk fixes to pure functions or a single conditional branch.

## Goals / Non-Goals

**Goals:**

- Close each of the four bugs with the minimal correct fix, verified empirically (unit tests for the pure functions, a real HTTP server for the transcript-discard fix, and a live `dev:docker:up` server for full end-to-end proof).
- Reconcile the spec text that either didn't cover the failure mode at all, or (for the nudge fail-safe case) was ambiguous enough to permit the buggy behavior.

**Non-Goals:**

- Not touching the Hermes (Python) or opencode (TS) implementations — they have their own dotenv/escaping code by design (`CLAUDE.md`: "cross-language wrapper costs more than the duplication"); any equivalent bugs there are out of scope for this change.
- Not adding a general-purpose JSON encoder to bash — `rembric_json_escape` remains "good enough for transcripts," now correctly covering the full mandatory-escape range, not aiming for RFC 8259 completeness beyond that (e.g. it still assumes valid UTF-8 input; it does not validate encoding).

## Decisions

### D1. Dotenv rtrim reuses the existing rtrim idiom already used for `key`

`rembric_parse_dotenv` already correctly right-trims `key` via `key="${key%"${key##*[![:space:]]}"}"` — the exact same idiom, applied to `val`, closes the bug. Verified empirically that bash's `[:space:]` POSIX character class includes `\r`, so this single addition handles both plain trailing whitespace and a CRLF-saved file's trailing carriage return — no separate CR-specific handling needed.

### D2. `rembric_json_escape`'s C0 loop, and why DEL is correctly left alone

JSON (RFC 8259 §7) mandates escaping every code point in U+0000–U+001F; it does not mandate escaping U+007F (DEL) or anything above. The fix adds a loop over 1–31 (skipping 9/10/13, already handled by their short forms) producing `\u00XX` for each. Verified: `\x7f` passes through untouched (correct — not in the mandated range), and a mixed string round-trips through a real JSON parser (Python's `json.loads`) byte-for-byte. Performance: ~9ms for a call with several control bytes present (dominated by per-iteration subshell spawns in the loop) — acceptable for a hook that fires once per session-lifecycle event, not a hot path.

### D3. The transcript-discard bug was in the caller, not the parser

The original issue framing ("make the jq programs line-tolerant") assumed jq itself needed to change. Verified empirically that jq already streams output as it parses and DOES print every well-formed line before a parse error — the actual bug is `out="$(_jq_variant "$path")" || out=""` in the calling bash function: command substitution assigns whatever jq already printed regardless of jq's exit code, but the `||` then unconditionally discards it because jq's exit code is non-zero. Removing the `||` is sufficient and strictly safer: on a _total_ failure (nothing printed before erroring), `out="$(cmd)"` already naturally yields `""` with no explicit fallback needed. Verified the fix does NOT apply to the sibling title-extraction functions, which pipe through `head -n1` — that pipeline's exit status is `head`'s (always 0 once it got its one line), so those call sites' `|| title=""` was already dead code and is left untouched (no bug there, no unjustified change).

### D4. Nudge counter: fail closed, not fail-implicit-zero

`case "$COUNT" in '' | *[!0-9]*) COUNT=0 ;; esac` treated an unreadable counter identically to "this is genuinely the first-ever read," which is wrong: a fresh session's first real read is `1` (post-increment), never `0` — `0` is an impossible value for a working counter and is unambiguously a signal that the read failed. Replacing `COUNT=0` with `exit 0` (before either modulo check runs) turns an impossible value into a clean no-op instead of a spam trigger.

## Verification

- **Unit-level** (`apps/plugin/test/api-sh.test.ts`, new): dotenv trailing-whitespace/CRLF trim (5 cases), `rembric_json_escape`'s existing short-form escapes unchanged (1 case) plus the new C0 range, DEL exclusion, and a full JSON round-trip (4 cases).
- **Real HTTP server** (`apps/plugin/test/stop-sync.test.ts`, extended): a torn-trailing-line transcript still produces a summary containing both good lines, asserted against the actual POST body a real in-process HTTP server received.
- **Fail-closed counter** (`apps/plugin/test/prompt-nudge.test.ts`, extended): `TMPDIR` pointed at a regular file (not a directory) so the counter can never be created; asserts empty stdout.
- **Live end-to-end** against `pnpm run dev:docker:up`: `session-start.sh` with a `.rembric` carrying trailing whitespace (slug resolved correctly, session created under the right project) → `stop-sync.sh` with a transcript containing a correctly-escaped control byte AND a torn trailing line → direct SQLite inspection of the persisted `sessions` row, confirming the summary contains both good lines and the control byte round-tripped intact. Full teardown (`docker compose down`, scratch files removed) after.

## Migration Plan

No migration — shell script fixes only, no schema/protocol change. Rollback is a plain revert.
