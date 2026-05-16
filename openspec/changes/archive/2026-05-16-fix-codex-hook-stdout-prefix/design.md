## Context

The previous change in this Codex follow-up sequence (`2026-05-16-document-codex-hooks-enablement`) documented two platform-required steps to make plugin-bundled hooks fire: `codex features enable plugin_hooks` and the `/hooks` trust review. With those two steps complete, all four Rembric hooks load and execute under Codex — but two of them (the ones with visible stdout, SessionStart and UserPromptSubmit) get rejected by Codex's hook output parser with `error: hook returned invalid ... JSON output`.

The error message is misleading. Reading `codex-rs/hooks/src/events/session_start.rs`, `user_prompt_submit.rs`, `compact.rs`, and `stop.rs`, the per-event handler does this:

```rust
match parse_event(&stdout) {
    Some(parsed) => { /* use structured output */ }
    None => {
        if stdout.is_empty() {
            /* silent OK */
        } else if output_parser::looks_like_json(&stdout) {
            // → Failure: "hook returned invalid ... JSON output"
        } else {
            // → treat stdout as plain-text additional_context
        }
    }
}
```

And `looks_like_json` (`codex-rs/hooks/src/engine/output_parser.rs`):

```rust
pub(crate) fn looks_like_json(stdout: &str) -> bool {
    let trimmed = stdout.trim_start();
    trimmed.starts_with('{') || trimmed.starts_with('[')
}
```

The contract is permissive: plain text works as `additional_context`, JSON works as structured output, the empty string works as no-op. **The only stdout shape that fails is "starts with `{` or `[` but doesn't parse as JSON".** That's our `[rembric] ...` badge.

The `[rembric]` prefix was adopted in the initial `claude-code-plugin` spec as a `console.log()`-style tag — visual grouping so hook output is easy to identify in `claude --debug` logs. It survived three plugin versions before Codex's heuristic caught it.

## Goals / Non-Goals

**Goals:**

- All four Rembric hooks succeed end-to-end under Codex with no agent-visible errors.
- Same shared scripts continue to work under Claude Code (no fork, no client-detection branches).
- Spec invariants for hook scripts explicitly prevent re-introducing a `{`/`[`-prefixed stdout in future hooks, with a citation to the Codex source line that enforces this so future maintainers can verify.
- Smallest possible diff. One character difference per script. No new dependencies, no helper changes, no JSON-encoding ceremony.

**Non-Goals:**

- Adopting structured JSON output for hook stdout. Out of scope here because:
  - Plain-text path already covers our current use case (the nudges are additional_context for the model, not block decisions).
  - JSON output adds shell-side complexity (escaping, quoting) the existing `_api.sh` doesn't currently need.
  - If a future hook genuinely needs to BLOCK an action or UPDATE the agent's input (PreToolUse decision, UserPromptSubmit block, etc.), we'd emit JSON for that specific hook then — not as a blanket protocol change for the four side-effecting hooks Rembric ships.
- Changing `pre-compact.sh` or `session-stop.sh`. They emit empty stdout already; empty is Codex's silent-OK case. No work needed.
- Changing the `_api.sh` helper or the HTTP POST contract. The Rembric server side has zero changes.
- Adopting a different badge style (e.g. Unicode middot, parens, `>>`). The simplest ASCII-only replacement (`rembric:`) wins; aesthetic preferences are not worth bike-shedding in this change.

## Decisions

### 1. Replace `[rembric]` with `rembric:` (colon-suffixed prefix, no brackets)

**Decision.** Two scripts change one literal each:

```diff
- echo '[rembric] If this is a continuation of recent work, call memory.context before responding.'
+ echo 'rembric: If this is a continuation of recent work, call memory.context before responding.'
```

```diff
- echo '[rembric] User intent: recall. Call memory.search with the user keywords before responding.'
+ echo 'rembric: User intent: recall. Call memory.search with the user keywords before responding.'
```

**Why `rembric:`** specifically:

- **No `[` or `{`**: passes `looks_like_json` as plain text under Codex.
- **ASCII-only**: portable across log viewers, terminals, etc. No Unicode dependencies.
- **Visible badge preserved**: `rembric:` is still recognizable as a Rembric-prefixed line in `claude --debug` and `~/.codex/log/codex-tui.log`.
- **Single character diff**: minimal review burden, minimal regression surface.

**Alternatives considered:**

- **`(rembric) ...`** — parens instead of brackets. Equally valid. Picked `rembric:` because the colon is universally recognized as a tag/value separator and reads more naturally for an info line.
- **`rembric · ...`** — Unicode middot. Pretty in modern terminals but introduces a non-ASCII char in stdout that could confuse old log scrapers or non-UTF8 viewers. Not worth the risk for a 1-char gain.
- **`>>> rembric ...`** — leading arrows. Visually heavy. Rejected.
- **Drop the badge entirely** (`If this is a continuation...`). Loses provenance — when multiple hooks fire concurrently in `--debug` logs, the badge is what tells the operator which plugin emitted the line. Keep the badge.
- **Emit JSON `{"hookSpecificOutput":{"additionalContext":"[rembric] ..."}}`**. Preserves the brackets. Cost: every plain-text echo becomes `printf` with manual JSON escaping (the message contains a period and an apostrophe-free string today, but future nudges might add quotes). The existing `rembric_json_escape` helper exists but using it for every echo line is ceremony. Plain text is the right abstraction level for what these scripts do.

### 2. Add an explicit invariant against `{` / `[` leading characters

**Decision.** Update `claude-code-plugin` spec's "Hook script invariants" section with one new bullet:

> _"The first non-whitespace character of hook stdout SHALL NOT be `{` or `[`. Codex's hook output parser (`codex-rs/hooks/src/engine/output_parser.rs::looks_like_json`) treats stdout starting with those characters as a malformed JSON attempt and fails the hook with `invalid ... JSON output`. Plain-text nudges are accepted under both clients as `additional_context` — keep nudges as plain text and avoid those two leading characters."_

**Why a new invariant.** Today's invariants list covers `#!/usr/bin/env bash`, `set -u`, `trap 'exit 0' ERR`, and exit-0-on-error. They don't say anything about output shape. The Codex constraint is platform-imposed and invisible from the script perspective unless the contributor reads Codex's source. A spec invariant documents it once so the trap doesn't fire again in three months when someone adds a new hook script that returns `JSON output looks neat let's prefix with [info]...`.

**Citation requirement.** The bullet MUST cite `codex-rs/hooks/src/engine/output_parser.rs::looks_like_json` by name so a future maintainer doubting the rule can trace back to the source and confirm.

### 3. Update the specific nudge string in the spec

**Decision.** Spec's SessionStart and UserPromptSubmit scenarios cite the exact literal nudge string today. Those literals change in lockstep with the scripts.

**Why.** If the spec keeps the old `[rembric] ...` literal and the scripts ship `rembric: ...`, the next contributor reading the spec while editing the scripts will see two truths and pick one — likely "spec says brackets, restore them". The literal in the spec is the contract; update it.

### 4. Version bump `0.2.2 → 0.2.3`

**Decision.** Both manifests bump to `0.2.3`. Patch, not minor — bug fix, no new behaviour.

**Why bump.** Per CLAUDE.md:

> _"any time you change something in `plugin/` that users need to see (scripts, hooks, mcp.json, bin/, manifests themselves), bump BOTH manifest versions in the same commit."_

Without the bump, `codex plugin marketplace upgrade rembric` and `claude plugin update rembric@rembric` both report "already at the latest version" and don't invalidate the cache. Users keep running 0.2.2's `[rembric]` scripts and the fix is silent.

### 5. No version bump for `_api.sh` or unchanged scripts

**Decision.** The helper and the two empty-stdout scripts are untouched. Per the version-bump rule, we bump because of the two scripts we DID change. We don't have per-file versioning; the bump applies to the plugin as a whole.

## Risks / Trade-offs

**[A new hook emerges that needs to BLOCK or UPDATE input]** → that hook will need JSON output, but the rest stay plain text.
Mitigation: the invariant only forbids `{`/`[` leading characters for plain-text hooks. Hooks that intentionally emit JSON will emit `{...` which Codex parses structurally — the parser branch we hit (`looks_like_json` + non-parseable) only fires when the stdout looks JSON-ish but isn't valid JSON. A real JSON object starting with `{"hookSpecificOutput":{...}}` parses fine. The invariant should be worded carefully to avoid forbidding intentional JSON.

Refinement: "stdout SHALL NOT begin with `{` or `[` UNLESS it is well-formed JSON for the relevant Codex hook event schema". This carve-out is implicit but worth stating so future contributors don't think "JSON forbidden" when the actual rule is "JSON-malformed-looking-text forbidden".

**[Existing log scrapers or dashboards that match on `[rembric]` exactly]** → would break.
Mitigation: unlikely (the badge is not documented as a stable string anywhere outside the plugin), but worth a heads-up in CHANGELOG. If someone has internal grep rules on `[rembric]`, the fix is `s/\[rembric\]/rembric:/`.

**[Spec literal drift with future docs]** — the `docs/agents.md` symptom-vs-cause table from the previous change mentions `[rembric] If this is a continuation...` as a recognizable nudge string. Does it?
Re-checking — the troubleshooting table in `docs/agents.md` does NOT cite the literal; it cites general "Codex says hook returned invalid JSON output" without naming the message text. Safe.

**[Bypass via `printf` instead of `echo`]** — both `printf` and `echo` produce the same output. No risk; we keep using `echo` for simplicity (no format-string interpretation needed for these fixed strings).

## Migration Plan

1. Apply the change. Land on `main`. Plugin version goes to `0.2.3` in both manifests.
2. Existing Codex users (the ones who already enabled `plugin_hooks` per the previous change): `codex plugin marketplace upgrade rembric`, restart Codex. Cache regenerates to `0.2.3`; the 4 hooks now fire and succeed. SessionStart POSTs a session row; `/dashboard/sessions` populates.
3. New Codex users: get `0.2.3` by default. They still need to enable `plugin_hooks` and approve the hooks (per `docs/agents.md` from the previous change); after that, hooks just work.
4. Existing Claude Code users: `claude plugin update rembric@rembric`. The visible nudge text changes from `[rembric] ...` to `rembric: ...` — same content, same agent behaviour. No reinstall needed.

Empirical smoke test post-push:

1. `git push origin main`.
2. `codex plugin marketplace upgrade rembric`.
3. Cold-restart `codex` from a project with `.rembric`.
4. Send any user message to the agent. Codex should NOT log any `invalid ... JSON output` error.
5. Check `/dashboard/sessions` on the Rembric server: a new row should appear with `agent=codex-cli` and `cwd=<project root>`.
6. If the user prompt matches the recall regex (`remember|recall|acordate|qué hicimos|what did we do`), check that the agent receives the `rembric: User intent: recall...` line as additional context (visible in the agent's reasoning if it follows the nudge and calls `memory.search`).

## Open Questions

- **Does Codex's `additional_context` injection have a separate token cost vs Claude Code's stdout-as-nudge?** Probably negligible — additional_context goes into the same user-visible message stream. No deeper investigation needed for this change.
- **Should we lock the `rembric:` prefix in the spec, or just say "a non-`{`/`[` prefix"?** Locking the exact string is stricter and easier to verify mechanically; loosening to "any non-JSON-looking prefix" gives future contributors latitude. Going with **lock the string** for now; can relax later if it turns out brittle.
- **Any future hook output schemas in Codex that might re-shift this contract?** Worth a quick peek at openai/codex's roadmap. Low priority; the dispatch code we read has been stable for several releases.
