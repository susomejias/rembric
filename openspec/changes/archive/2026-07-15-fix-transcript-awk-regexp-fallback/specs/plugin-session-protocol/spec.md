## ADDED Requirements

### Requirement: The awk transcript-parser fallback MUST be POSIX-portable and equivalent to the jq path

`apps/plugin/scripts/_transcript.sh` provides, for each parser, a `jq` implementation and an `awk` fallback used when `jq` is not on `PATH`. The awk fallback SHALL be written in POSIX awk (it MUST run correctly under mawk, BSD awk, and gawk) and SHALL produce output byte-equivalent to the `jq` path for the shared transcript fixtures.

- The awk fallbacks SHALL NOT pass a regexp constant (`/re/`) as a function argument. A regexp constant used outside a direct match operator evaluates to a boolean in awk, which corrupts the parse (it yields the literal string `"1"` instead of the message). Regex literals SHALL be used directly in `match()` at the call site; helper functions SHALL receive only already-sliced strings.
- Applies to all four fallbacks: `_rembric_format_transcript_{claude_code,codex_cli}_fallback` and `_rembric_extract_first_assistant_{claude_code,codex_cli}_fallback`.
- The shared fixtures test (`apps/server/src/test/transcript-parser.test.ts`) SHALL genuinely exercise the awk fallback — its "awk fallback" cases MUST NOT silently fall through to `jq` when `jq` happens to be on the stripped test `PATH`.

#### Scenario: First-assistant extraction on a host without jq

- **WHEN** `rembric_extract_first_assistant_codex_cli` (or `_claude_code`) runs on a host where `jq` is not on `PATH`, against a transcript whose first assistant/agent message is non-empty (including non-ASCII text such as `¡Hola! ¿En qué te ayudo hoy?`)
- **THEN** the awk fallback SHALL return that message text verbatim (after un-escaping `\n \r \t \" \\`)
- **AND** it SHALL NOT return the literal string `"1"` or any boolean-coercion artifact

#### Scenario: Transcript formatting on a host without jq

- **WHEN** `rembric_format_transcript_codex_cli` (or `_claude_code`) runs without `jq` on `PATH` against a multi-message fixture
- **THEN** the awk fallback SHALL emit the same `role: content` lines, oldest-first, as the `jq` path for that fixture
- **AND** non-conversation/metadata rows SHALL be dropped exactly as on the `jq` path

#### Scenario: Shared fixtures exercise the awk path, not jq

- **WHEN** the transcript-parser test runs its "awk fallback" cases
- **THEN** the awk implementation SHALL be the code under test (jq unreachable for those cases)
- **AND** the awk output SHALL equal the expected fixture output, so a broken awk fallback fails the suite regardless of whether `jq` is installed in a standard location
