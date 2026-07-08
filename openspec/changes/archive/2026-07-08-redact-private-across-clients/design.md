# Design — redact-private-across-clients

## Context

Redaction exists only in `apps/plugin/.opencode-plugin/plugin.ts` (`text.replace(/<private>[\s\S]*?<\/private>/gi, '[REDACTED]')`). Bash clients assemble transcript text in `_transcript.sh` (tail-limited extraction consumed by session-end/stop/pre-compact) and POST via `_api.sh`. Hermes formats transcript entries in `_format_transcript` before its HTTP POST. The server intentionally stays out of this: redaction is a client-side promise (content the user marked private must never reach the wire).

## Goals / Non-Goals

**Goals:**

- Identical observable semantics in all four clients: `<private>…</private>` (case-insensitive, spans newlines, non-greedy per span) → `[REDACTED]`.
- One choke point per language, exercised by every upload path of that client.

**Non-Goals:**

- Server-side defense-in-depth stripping (would legitimize sending the content over the wire; the contract is client-side).
- Redacting other markers or configurable patterns (YAGNI; the tag is the established convention).
- Retroactive scrubbing of already-stored rows (append-only; operator can purge via existing maintenance paths if needed).

## Decisions

### D1: Redact at extraction time, not at POST time

Bash: apply redaction inside `_transcript.sh` where transcript text is extracted/assembled — every consumer (session-end, session-stop, pre-compact, title derivation) inherits it, and `_api.sh` stays a dumb transport. Python: apply in `_format_transcript` (the single place raw entries become upload text). Alternative — redacting in `_api.sh`/`_post` just before the HTTP call — rejected: those helpers also send non-transcript payloads (status pings) and would re-scan every payload; extraction is the semantic boundary where "user content" appears.

### D2: POSIX awk state machine for bash, `re.sub` for Python

The bash implementation uses awk with an in-span flag (handles spans crossing lines without GNU-only flags and without adding a perl dependency; matches non-greedily per span by closing at the first `</private>`). Python uses `re.sub(r'<private>.*?</private>', '[REDACTED]', text, flags=re.I | re.S)`. Both MUST reproduce the opencode reference semantics; an unclosed `<private>` redacts through end-of-text (fail closed — matching how `[\s\S]*?` with no close simply doesn't match would LEAK, so the bash/python implementations deliberately redact to EOF on unclosed tags and opencode is updated to do the same).

**Note:** this is the one deliberate semantic improvement over the current opencode regex (which leaves an unclosed span untouched). Fail-closed beats fail-open for a privacy feature; the opencode helper gains the same EOF fallback.

### D3: Cross-language duplication is accepted, lock-step enforced by tests

Same policy as `parseDotenv`: bash and Python keep their own implementations. A shared fixture set (tag pairs, nested-looking tags, case variants, multiline spans, unclosed tag) is exercised against all three implementations from vitest (shelling out for bash, via the existing Hermes test harness for Python) so drift fails CI.

## Risks / Trade-offs

- [Risk] awk portability quirks (BSD vs GNU). → Mitigation: POSIX-only constructs; fixture tests run on macOS (dev) and Linux (CI).
- [Trade-off] Unclosed-tag fail-closed may redact more than the user intended. → Accepted because under-redaction is the strictly worse failure for a privacy marker.
- [Risk] Title derivation could surface redacted text oddly (`[REDACTED]` as title). → Mitigation: acceptable; titles are transcript-derived text like any other.

## Migration Plan

Plugin-track release; users pick it up via the TUI installer update. No server change, no DB change.

## Open Questions

(none)
