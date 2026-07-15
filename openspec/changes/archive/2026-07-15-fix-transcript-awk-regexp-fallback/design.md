## Context

`_transcript.sh` keeps a `jq` path and a POSIX-awk fallback per parser so the plugin can still derive a session summary/title on hosts without `jq`. Line 50 of the file states the intent explicitly: "POSIX awk only (BSD awk must pass)". The four fallbacks share the same shape: a helper `extract(line, pat)` runs `match(line, pat)`, slices `substr(line, RSTART, RLENGTH)`, then strips the JSON key prefix / closing quote and un-escapes `\n \r \t \" \\`.

The helper is called with a regexp **constant**:

```awk
content = extract(line, /"content"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"/)
```

Per POSIX awk semantics (and every real implementation — gawk, mawk, BSD awk), a `/re/` literal in a non-match context is shorthand for `$0 ~ /re/`, i.e. it evaluates to a boolean. So `pat` is `1` (or `0`), `match(line, "1")` matches a literal `1`, and the cleanup then returns `"1"`. gawk surfaces this at runtime: `warning: regexp constant for parameter #2 yields boolean value`.

The parser has three implementations kept in lock-step (this awk/bash, the opencode `plugin.ts` `stripPrivateTags`, the Hermes `_format_transcript`) with shared fixtures under `apps/server/src/test/fixtures/transcripts/`. Only the awk path carries this bug; `jq`, opencode, and Hermes are correct.

The bug reached `main` because `transcript-parser.test.ts` forces the awk path by stripping `PATH` to `/usr/bin:/bin:/usr/sbin:/sbin` — but `jq` on CI and most dev boxes lives in `/usr/bin`, survives the strip, and the "awk fallback" cases silently run `jq`. The bug is only observable where `jq` is not on that stripped PATH.

## Goals / Non-Goals

**Goals:**

- Make all four awk fallbacks produce output byte-equivalent to their `jq` counterparts for the shared fixtures, on POSIX awk (mawk / BSD / gawk).
- Fix at the root cause (regexp constant used as a value), not by masking (installing `jq`).
- Keep the regex literals byte-identical so the change carries zero risk of altering what gets matched.
- Guarantee the test suite genuinely exercises the awk path so this class of bug cannot silently regress.

**Non-Goals:**

- Any change to the `jq` code paths or their output.
- Any change to the opencode / Hermes redaction siblings (already correct).
- Rewriting the parsers to a single unified implementation — divergence per agent is deliberate (file header, lines 2–5).
- A plugin version bump — this helper is unversioned and no client-facing surface changes.
- Windows-specific behaviour (no Windows tests exist today).

## Decisions

### 1. Use the regexp constants directly in `match()`; helper does cleanup only

**Decision.** Replace the `extract(line, pat)` helper with a `clean(s)` helper containing only the post-match string cleanup, and inline each `match()` with its regexp constant at the call site:

```awk
function clean(s) {
  sub(/.*:[[:space:]]*"/, "", s)
  sub(/"$/, "", s)
  gsub(/\\n/, " ", s); gsub(/\\r/, " ", s); gsub(/\\t/, " ", s)
  gsub(/\\"/, "\"", s); gsub(/\\\\/, "\\", s)
  return s
}
# ... call site (claude_code format/extract has the content→text fallback):
content = ""
if (match(line, /"content"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"/)) content = clean(substr(line, RSTART, RLENGTH))
if (content == "" && match(line, /"text"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"/)) content = clean(substr(line, RSTART, RLENGTH))
```

**Why.** `match()` is the one context where a regexp constant is used as a pattern, so no boolean coercion occurs. The regex literals are copied verbatim from today's code — nothing about _what_ matches changes, only _where_ the literal lives. This is the smallest faithful fix.

**Alternative rejected — pass the regex as a string param.** `match(line, pat)` accepts a dynamic-regex string, so `extract(line, "\"content\"[[:space:]]*:…")` would also work. Rejected: converting the `\\`/`\.` regex escapes into awk string-literal escapes (doubling backslashes) is error-prone and would silently change matching if mis-escaped — exactly the failure mode we're fixing. Keeping the literals as regexp constants removes that hazard.

### 2. Ensure the test genuinely exercises the awk path

**Decision.** The fix is validated by running `transcript-parser.test.ts` with `jq` unreachable from the stripped PATH, so the four "awk fallback" cases actually run awk. During implementation, confirm the awk path is hit (e.g. verify the cases fail before the fix and pass after, with `jq` absent from `/usr/bin:/bin:/usr/sbin:/sbin`). If the harness cannot reliably guarantee awk is exercised across environments, add a minimal guard so a future `jq`-in-`/usr/bin` cannot re-mask the fallback (options: assert the fallback function output directly, or neutralise `jq` for the fallback cases). Prefer the smallest change that makes the awk path non-optional in the test.

**Why.** The bug survived precisely because the "awk fallback" test could fall through to `jq`. Closing that hole is what turns this from a one-off fix into a regression guard.

### 3. No plugin version bump

**Decision.** Do not touch any `plugin.json` / `plugin.yaml` / `plugin.ts` version carrier. `_transcript.sh` is an internal helper with no versioned surface; the CHANGELOG entry (scoped by the conventional commit `fix(plugin):`) records the fix. release-please bumps the unified `plugin` version off the commit type regardless.

**Why.** The CLAUDE.md lockstep rule applies to _user-visible_ version carriers; this is a behind-the-scenes correctness fix, and the conventional-commit-driven release track already captures it.

## Risks

- **Low.** Regexes unchanged; only 4 functions, all following one template. The shared fixtures + jq-vs-awk equivalence give a direct pass/fail oracle.
- **POSIX portability**: validate on gawk (this box's default `awk`) and, ideally, mawk (Debian/Ubuntu default) since end users hit the fallback on exactly those. The `clean()` helper and inlined `match()` use only POSIX awk features.
