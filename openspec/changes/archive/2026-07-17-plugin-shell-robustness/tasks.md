## 1. Fixes (#260)

- [x] 1.1 `_api.sh::rembric_parse_dotenv` — trim trailing whitespace/CR from `val` (same rtrim idiom already used for `key`).
- [x] 1.2 `_api.sh::rembric_json_escape` — escape the remaining C0 control range (U+0000–U+001F minus `\n \r \t`) as `\u00XX`.
- [x] 1.3 `_transcript.sh` — remove `|| out=""` from the four format-function call sites (`rembric_format_transcript_claude_code`, `rembric_format_transcript_codex_cli`, both jq and fallback branches); leave the title-extraction call sites untouched (not exhibiting the bug — their pipelines end in `head -n1`/an awk `exit`, so the exit code they'd check is never jq's).
- [x] 1.4 `prompt-nudge.sh` — fail closed (`exit 0`, no output) instead of defaulting `COUNT=0` when the counter is unreadable.
- [x] 1.5 `bash -n` clean on all three touched scripts.

## 2. Testing

- [x] 2.1 `apps/plugin/test/api-sh.test.ts` (new): dotenv trim (trailing whitespace, CRLF, combined, leading-trim regression, clean value), `rembric_json_escape` (existing short forms unchanged, ANSI escape, other C0 bytes, DEL left alone, full JSON round-trip).
- [x] 2.2 `apps/plugin/test/stop-sync.test.ts`: a torn trailing JSONL line still produces a summary containing the good lines before it, asserted against the real POST body.
- [x] 2.3 `apps/plugin/test/prompt-nudge.test.ts`: an unwritable counter directory emits nothing (fail-closed), not a spam of both nudges.
- [x] 2.4 Full plugin test suite green.

## 3. End-to-end validation (`rembric-plugin-development` skill, mandatory)

- [x] 3.1 `pnpm run dev:docker:up`; confirm `[bootstrap] ... listening on`; capture the seeded token.
- [x] 3.2 `.rembric` with `PROJECT_SLUG=demo` plus trailing whitespace → `session-start.sh` → session created under the correct project (proves the dotenv fix against the live server, not just a unit test).
- [x] 3.3 A transcript with a correctly-escaped control byte AND a torn trailing line → `stop-sync.sh` → direct SQLite inspection of the persisted `sessions.summary`: contains both good lines, control byte round-trips intact.
- [x] 3.4 Teardown: sessions ended, scratch files removed, `docker compose down`.

## 4. Validation

- [x] 4.1 `pnpm run typecheck` and `pnpm run lint` clean.
- [x] 4.2 `pnpm test` full suite green.
- [x] 4.3 `openspec validate plugin-shell-robustness --strict` passes.
- [x] 4.4 Update issue #260 with the outcome after merge.
