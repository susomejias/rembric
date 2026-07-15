## Why

`apps/plugin/scripts/_transcript.sh` ships a `jq` path and an `awk` fallback for each of the four transcript parsers (format + first-assistant, for Claude Code and Codex CLI). The `plugin-session-protocol` capability requires that, when the agent doesn't call `memory.session_summary`, the session still converges on a summary/title derived from the transcript by the plugin-side fallback (bash → awk when `jq` is absent).

The awk fallback is broken. Each `*_fallback` function defines a helper `extract(line, pat)` and calls it with a **regexp constant** as the argument:

```awk
content = extract(line, /"content"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"/)
```

In awk, a regexp constant used anywhere other than directly against a match operator is evaluated as `$0 ~ /re/` — a **boolean** `0`/`1`. So `pat` arrives as `1`, `match(line, "1")` matches the first literal `1`, and the parser emits `"1"` instead of the message text. gawk even warns: `regexp constant for parameter #2 yields boolean value`. This is not mawk-specific (gawk reproduces it) and not locale-related.

The defect is masked whenever `jq` is on the effective `PATH`: the public functions prefer `jq`, so the awk path never runs. CI and typical machines install `jq` into `/usr/bin`, which survives the test's deliberately-stripped `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), so `transcript-parser.test.ts`'s "awk fallback" cases silently exercise `jq` and pass. The bug only surfaces where `jq` is absent from that stripped PATH — i.e. real end-user machines without `jq` installed, exactly the environment the awk fallback exists to serve.

## What Changes

- **`apps/plugin/scripts/_transcript.sh`** — in all four `*_fallback` functions, stop threading the regex through a function parameter. Use the regexp constants **directly** at each `match()` call site (their correct context, no boolean coercion) and reduce the helper to substring cleanup only. The regex literals stay **byte-identical**; only where they are evaluated changes. This removes the boolean-coercion bug at its root and keeps POSIX-awk portability (mawk / BSD awk / gawk).
- **No behavioural change on the `jq` path.** The `jq` implementations are untouched; the awk fallback is brought into lock-step with them (validated by the existing shared fixtures).
- **No plugin version bump / no client-facing surface change.** This is an internal bug fix in an unversioned helper script; it does not alter any manifest, hook mapping, or public function signature. (Confirmed against the release-please contract during design.)

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `plugin-session-protocol`: adds an explicit requirement that the awk transcript-parser fallback MUST be POSIX-portable and produce output equivalent to the `jq` path, and that the shared fixtures MUST exercise the awk path (not silently fall through to `jq`). The session-convergence behaviour contract itself is unchanged — this closes the gap that let a non-functional fallback pass CI.

## Impact

- **Touched paths**: `apps/plugin/scripts/_transcript.sh` (four `*_fallback` functions refactored; regexes unchanged). Possibly `apps/server/src/test/transcript-parser.test.ts` **only if** the test harness needs to guarantee the awk path is genuinely exercised regardless of `jq`'s location (see design Decision 2).
- **No changes** to: the `jq` code paths, any manifest (`.claude-plugin`/`.codex-plugin`/`.hermes-plugin`/`.opencode-plugin`), hook JSON, plugin version carriers, server (`apps/server/src`), or the opencode/Hermes redaction siblings.
- **End-user impact**: agents running on machines **without `jq`** now get a correct transcript-derived summary/title on non-cooperating sessions instead of the literal string `"1"`. Machines with `jq` are unaffected (they already used the working path).
- **Validation**: run `transcript-parser.test.ts` with the awk path genuinely exercised (`jq` hidden) — the four currently-failing "awk fallback" cases MUST pass, and all "jq path" cases MUST stay green. Plus the mandatory `rembric-plugin-development` e2e against `pnpm run dev:docker:up` (session-end → summary/title on a jq-less path).
