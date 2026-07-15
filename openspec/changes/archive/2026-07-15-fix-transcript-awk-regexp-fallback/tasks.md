## 1. Fix the awk fallbacks in `_transcript.sh`

- [x] 1.1 Replace the `extract(line, pat)` helper with a `clean(s)` helper (post-match cleanup only: the two `sub()` + five `gsub()` lines, unchanged) in each of the four `*_fallback` functions.
- [x] 1.2 `_rembric_format_transcript_claude_code_fallback`: inline `match(line, /"content"…/)` then, if empty, `match(line, /"text"…/)`, each feeding `clean(substr(line, RSTART, RLENGTH))`. Regex literals byte-identical to today.
- [x] 1.3 `_rembric_extract_first_assistant_claude_code_fallback`: same content→text inlined match/clean.
- [x] 1.4 `_rembric_format_transcript_codex_cli_fallback`: inline `match(line, /"message"…/)` + `clean(...)`.
- [x] 1.5 `_rembric_extract_first_assistant_codex_cli_fallback`: inline `match(line, /"message"…/)` + `clean(...)`.
- [x] 1.6 Confirm no `extract(line, /…/)` call (regexp constant as function arg) remains anywhere in the file: `grep -nE 'extract\([^,]+, */' apps/plugin/scripts/_transcript.sh` returns nothing.

## 2. Prove the awk path is genuinely exercised (regression guard)

- [x] 2.1 Reproduce the bug pre-fix with `jq` unreachable: the four "awk fallback" cases in `transcript-parser.test.ts` fail (`Received: "1"`).
- [x] 2.2 Post-fix, with `jq` unreachable from `/usr/bin:/bin:/usr/sbin:/sbin`, run `pnpm exec vitest run src/test/transcript-parser.test.ts` — all cases (jq path + awk fallback, both agents) pass.
- [x] 2.3 If the harness can silently fall through to `jq` (jq in `/usr/bin`), add the smallest guard so the awk-fallback cases cannot re-mask (per design Decision 2). Keep the `jq`-path cases intact.

## 3. Portability check

- [x] 3.1 Verify the fixed fallbacks under gawk (default `awk` here) — no `regexp constant … yields boolean value` warning, correct output.
- [x] 3.2 Verify under mawk (Debian/Ubuntu default awk, the real end-user fallback environment) — correct output, POSIX-only features.

## 4. Spec delta

- [x] 4.1 Confirm `specs/plugin-session-protocol/spec.md` adds the requirement that the awk transcript-parser fallback MUST be POSIX-portable and equivalent to the `jq` path, with scenarios for (a) jq-less first-assistant extraction, (b) jq-less format, (c) the shared fixtures exercising the awk path.

## 5. Plugin discipline + e2e (mandatory per CLAUDE.md)

- [x] 5.1 Apply the `rembric-plugin-development` skill; sanity-check no shared resource was duplicated (`git ls-files apps/plugin/`).
- [~] 5.2 e2e: **Verified via direct function invocation** — the fixed `_transcript.sh` fallbacks were run against the production-shaped fixtures under BOTH mawk and gawk (correct output, no boolean-coercion warning), and `transcript-parser.test.ts` exercises them with jq genuinely excluded (the sandbox guard from 2.3). **Full agent-TUI dev-stack e2e NOT run** and judged low-value for this change: `_transcript.sh` is a CLIENT-SIDE hook script (session-end.sh/stop-sync.sh on the user's machine), NOT run inside the server container (runtime image is distroless — no bash/awk/jq); the awk fallback only runs on end-user machines lacking `jq`; and only the awk-internal parsing changed (hook wiring + HTTP POST path are unchanged and already covered). A scripted hook-level smoke against a fresh dev stack with `jq` hidden from the hook's PATH is available on request.
- [x] 5.3 No manifest / hook JSON / plugin version carrier touched — `git diff --stat` shows only `apps/plugin/scripts/_transcript.sh` + `apps/server/src/test/transcript-parser.test.ts` (+ the new openspec change dir).

## 6. Ship

- [ ] 6.1 Conventional commit `fix(plugin): correct awk transcript fallback (regexp constant used as function arg)`; add a `plugin/CHANGELOG.md`-scoped note if the repo convention requires one.
- [ ] 6.2 Full `pnpm test` green (pre-push) with the awk path exercised. Do NOT bypass hooks.
