## Why

Four independent robustness bugs in the shared shell plumbing (`apps/plugin/scripts/_api.sh`, `_transcript.sh`, `prompt-nudge.sh`) cause silent data loss or hook/MCP split-brain: a `.rembric` file with trailing whitespace or CRLF line endings resolves to a different slug in the bash hooks than in the JS bridge; a transcript containing a C0 control byte (e.g. an ANSI escape from pasted colored terminal output) produces an invalid outbound JSON body that the server rejects, silently dropping the session summary; a single torn trailing line in a transcript (a Stop hook racing an in-progress write, or a crash) discarded the entire transcript instead of the good lines already parsed before it; and an unwritable per-session nudge counter defaulted to a value that mathematically fires every nudge on every turn instead of firing none. All four were reproduced empirically before fixing and are now covered by tests run against the real scripts (unit-level for the pure functions, a real HTTP server for the transcript path) and verified end-to-end against a live `dev:docker:up` server.

## What Changes

- **`rembric_parse_dotenv` (`_api.sh`)** now trims trailing whitespace from a value, not just leading — bash's `[:space:]` class includes `\r`, so this closes both the plain-trailing-space case and the CRLF (Windows-saved `.rembric`) case in one fix.
- **`rembric_json_escape` (`_api.sh`)** now escapes every remaining C0 control character (U+0000–U+001F) as `\u00XX`, not just `\n \r \t`, matching what JSON actually requires.
- **`rembric_format_transcript_claude_code`/`_codex_cli` (`_transcript.sh`)** no longer discard jq's already-printed partial output when a torn trailing line makes jq exit non-zero — the `|| out=""` fallback was the actual bug (jq streams output as it parses; the bash wrapper was throwing away good data because of an exit code, not because the data was bad).
- **`prompt-nudge.sh`** now fails closed (emits nothing) when its per-session counter file is unreadable/unwritable, instead of defaulting the count to `0` — which satisfies both firing thresholds (`0 % 5 == 0` and `0 % 10 == 0`) and spams every nudge on every turn.

No breaking changes. No flag/env/protocol changes — same inputs, same outputs for every well-formed case; only the malformed-input handling changes.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `claude-code-plugin`: MODIFY the `_api.sh` helper requirement — `rembric_json_escape` now covers the full C0 control range, and the dotenv parser trims both sides of a value. MODIFY the `UserPromptSubmit` nudge-hook requirement — "fail safe" is sharpened to mean "emit nothing," and now explicitly covers an unwritable counter file, not just unreadable stdin.
- `plugin-session-protocol`: ADD a scenario to the summary-convergence requirement covering a torn trailing transcript line — the good lines before it must still contribute to the summary.

## Impact

- `apps/plugin/scripts/_api.sh` — `rembric_parse_dotenv`, `rembric_json_escape`.
- `apps/plugin/scripts/_transcript.sh` — the four format-function call sites (both clients, jq and fallback branches).
- `apps/plugin/scripts/prompt-nudge.sh` — the counter-read failure branch.
- `apps/plugin/test/api-sh.test.ts` (new), `apps/plugin/test/prompt-nudge.test.ts`, `apps/plugin/test/stop-sync.test.ts` — regression tests.
- Verified end-to-end against a live `pnpm run dev:docker:up` server: real session lifecycle (`session-start.sh` → `stop-sync.sh` → inspection of the persisted row) with a `.rembric` file carrying trailing whitespace and a transcript carrying both a properly-escaped control byte and a torn trailing line.
- Issue: #260.
